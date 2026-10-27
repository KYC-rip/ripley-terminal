//! Monero message signing (`SigV2`, plus `SigV1` for compatibility) — the primitive behind
//! "Sign in with Ripley" / NKIP-0003 Sign-In with Monero.
//!
//! Checked against official Monero (2026-10-27, NKIP-0003 vectors): monero-wallet-rpc
//! v0.18.4.5 `verify` reports good / version 2 / spend for our SigV2 on a primary address
//! and a subaddress, and our verifiers accept wallet-rpc's own SigV2 and a SigV1 it
//! verified (tests below, offline). Not independently audited.
//!
//! Both forms are Monero's Schnorr signature (`crypto.cpp generate_signature`) by the
//! address's spend key (`sec`; subaddress-derived for a subaddress) over a 32-byte hash H:
//!   k random, comm = k·G
//!   c = hash_to_scalar( H ‖ pub ‖ comm )      (s_comm layout: h ‖ key ‖ comm)
//!   r = k − c·sec
//!   signature = "SigV1"/"SigV2" + base58_monero( c[32] ‖ r[32] )
//! SigV1: H = keccak256(message). SigV2 (wallet-rpc's default since 0.17, what NKIP-0003
//! wallets SHOULD make): H = keccak256("MoneroMessageSignature\0" ‖ spend_pub ‖ view_pub ‖
//! mode ‖ varint(len) ‖ message) over the signing address's own public keys, mode 0 =
//! spend — so a signature is bound to the address and can't pass as a view-key one.

use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
use curve25519_dalek::traits::Identity;
use curve25519_dalek::{EdwardsPoint, Scalar};
use rand_core::OsRng;

use super::base58_monero;

const SIG_PREFIX: &str = "SigV1";
const SIG_V2_PREFIX: &str = "SigV2";

fn keccak256(data: &[u8]) -> [u8; 32] {
    use tiny_keccak::{Hasher, Keccak};
    let mut k = Keccak::v256();
    let mut out = [0u8; 32];
    k.update(data);
    k.finalize(&mut out);
    out
}

/// hash_to_scalar = reduce(keccak256(data)) mod l — Monero's `hash_to_scalar`.
fn hash_to_scalar(data: &[u8]) -> Scalar {
    Scalar::from_bytes_mod_order(keccak256(data))
}

/// Monero subaddress private spend key derivation:
/// `b_i = b + Hs("SubAddr\0" || a || major || minor)`.
/// This is the key `monero-wallet-rpc sign {address}` uses for a subaddress.
pub fn subaddress_spend_key(
    spend_sec: &Scalar,
    view_sec: &Scalar,
    account: u32,
    address: u32,
) -> Scalar {
    let mut buf = Vec::with_capacity(8 + 32 + 8);
    buf.extend_from_slice(b"SubAddr\0");
    buf.extend_from_slice(view_sec.as_bytes());
    buf.extend_from_slice(&account.to_le_bytes());
    buf.extend_from_slice(&address.to_le_bytes());
    spend_sec + hash_to_scalar(&buf)
}

/// The Schnorr challenge `c = Hs(H ‖ pub ‖ comm)` — Monero's `s_comm` struct
/// (`hash h; public_key key; ec_point comm;`), each field 32 bytes, in that order.
fn challenge(h: &[u8; 32], pub_key: &EdwardsPoint, comm: &EdwardsPoint) -> Scalar {
    let mut buf = [0u8; 96];
    buf[0..32].copy_from_slice(h);
    buf[32..64].copy_from_slice(&pub_key.compress().to_bytes());
    buf[64..96].copy_from_slice(&comm.compress().to_bytes());
    hash_to_scalar(&buf)
}

/// The Schnorr signature over a 32-byte hash `h` with `sec` (whose public key is `pub_key`),
/// as Monero `crypto.cpp generate_signature`: 64 bytes `c ‖ r`.
fn sign_hash(h: &[u8; 32], sec: &Scalar, pub_key: &EdwardsPoint) -> [u8; 64] {
    // Retry loop matches crypto.cpp: c and r must both be non-zero (astronomically
    // rare to fail even once), so a bounded loop is a formality.
    loop {
        let k: Scalar = monero_oxide::ed25519::Scalar::random(&mut OsRng).into();
        let comm = k * ED25519_BASEPOINT_POINT; // comm = k·G
        let c = challenge(h, pub_key, &comm);
        if c == Scalar::ZERO {
            continue;
        }
        let r = k - c * sec; // r = k − c·sec
        if r == Scalar::ZERO {
            continue;
        }
        let mut chunk = [0u8; 64];
        chunk[0..32].copy_from_slice(c.as_bytes());
        chunk[32..64].copy_from_slice(r.as_bytes());
        return chunk;
    }
}

/// Monero `check_signature` over hash `h`: recompute `comm = c·pub + r·G`, re-hash,
/// confirm it equals the embedded `c`.
fn verify_hash(h: &[u8; 32], pub_key: &EdwardsPoint, body: &str) -> Result<bool, String> {
    let bytes = base58_monero::decode(body)?;
    if bytes.len() != 64 {
        return Err(format!("expected 64 signature bytes, got {}", bytes.len()));
    }
    let c: Scalar = Option::from(Scalar::from_canonical_bytes(
        bytes[0..32].try_into().unwrap(),
    ))
    .ok_or("non-canonical c")?;
    let r: Scalar = Option::from(Scalar::from_canonical_bytes(
        bytes[32..64].try_into().unwrap(),
    ))
    .ok_or("non-canonical r")?;
    if c == Scalar::ZERO {
        return Ok(false);
    }
    // comm = c·pub + r·G  (== k·G for an honest signature, since pub = sec·G).
    // Variable-time is fine here: verification touches only public inputs (pub, c, r),
    // never secret key material, so there's no timing side-channel to leak.
    let comm = EdwardsPoint::vartime_double_scalar_mul_basepoint(&c, pub_key, &r);
    if comm == EdwardsPoint::identity() {
        return Ok(false); // identity point → reject (matches crypto.cpp infinity check)
    }
    Ok(challenge(h, pub_key, &comm) == c)
}

/// Sign `message` with `spend_sec` such that Monero's `verify(message, <addr whose
/// spend key is spend_pub>, signature)` returns Good. `spend_pub` MUST equal
/// `spend_sec·G` (the address's spend public key). Returns `"SigV1<base58>"`.
pub fn sign_message_v1(message: &str, spend_sec: &Scalar, spend_pub: &EdwardsPoint) -> String {
    let chunk = sign_hash(&keccak256(message.as_bytes()), spend_sec, spend_pub);
    format!("{}{}", SIG_PREFIX, base58_monero::encode(&chunk))
}

/// Verify a `SigV1` message signature against `spend_pub`. Used for self-consistency
/// tests and to check golden vectors produced by real Monero. (The production verifier
/// is monero-wallet-rpc; this is our independent reference.)
pub fn verify_message_v1(
    message: &str,
    spend_pub: &EdwardsPoint,
    signature: &str,
) -> Result<bool, String> {
    let body = signature
        .strip_prefix(SIG_PREFIX)
        .ok_or("not a SigV1 signature")?;
    verify_hash(&keccak256(message.as_bytes()), spend_pub, body)
}

/// Monero's varint (7 bits per byte, little-endian, high bit = more).
fn varint(mut n: usize) -> Vec<u8> {
    let mut out = Vec::new();
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
    out
}

/// wallet2 `get_message_hash`: keccak256("MoneroMessageSignature\0" ‖ spend_pub ‖
/// view_pub ‖ mode ‖ varint(len) ‖ message), where spend_pub / view_pub are the SIGNING
/// ADDRESS's own public keys (a subaddress's for a subaddress) and mode 0 = spend key,
/// 1 = view key. Binding both keys and the mode is what SigV1 lacks.
fn message_hash_v2(message: &str, addr_spend_pub: &EdwardsPoint, addr_view_pub: &EdwardsPoint, mode: u8) -> [u8; 32] {
    let mut buf = Vec::with_capacity(23 + 65 + 10 + message.len());
    buf.extend_from_slice(b"MoneroMessageSignature\0");
    buf.extend_from_slice(&addr_spend_pub.compress().to_bytes());
    buf.extend_from_slice(&addr_view_pub.compress().to_bytes());
    buf.push(mode);
    buf.extend_from_slice(&varint(message.len()));
    buf.extend_from_slice(message.as_bytes());
    keccak256(&buf)
}

/// Sign `message` as monero-wallet-rpc `sign` does by default (SigV2, spend mode): the
/// key is the address's spend secret (subaddress-derived for a subaddress), and the hash
/// binds the address's public spend + view keys. `spend_sec·G` MUST equal
/// `addr_spend_pub`. Returns `"SigV2<base58>"`.
pub fn sign_message_v2(
    message: &str,
    spend_sec: &Scalar,
    addr_spend_pub: &EdwardsPoint,
    addr_view_pub: &EdwardsPoint,
) -> String {
    let h = message_hash_v2(message, addr_spend_pub, addr_view_pub, 0);
    let chunk = sign_hash(&h, spend_sec, addr_spend_pub);
    format!("{}{}", SIG_V2_PREFIX, base58_monero::encode(&chunk))
}

/// Verify a spend-mode `SigV2` signature for the address with these public keys. A
/// view-mode signature (made with the view key, mode 1) does NOT verify here.
pub fn verify_message_v2(
    message: &str,
    addr_spend_pub: &EdwardsPoint,
    addr_view_pub: &EdwardsPoint,
    signature: &str,
) -> Result<bool, String> {
    let body = signature
        .strip_prefix(SIG_V2_PREFIX)
        .ok_or("not a SigV2 signature")?;
    verify_hash(&message_hash_v2(message, addr_spend_pub, addr_view_pub, 0), addr_spend_pub, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keypair() -> (Scalar, EdwardsPoint) {
        let sec: Scalar = monero_oxide::ed25519::Scalar::random(&mut OsRng).into();
        let pubk = sec * ED25519_BASEPOINT_POINT;
        (sec, pubk)
    }

    #[test]
    fn sign_then_verify_roundtrips() {
        let (sec, pubk) = keypair();
        let msg =
            "xmr.bio wants you to sign in with your Monero address:\n4Abc...\n\nNonce: deadbeef";
        let sig = sign_message_v1(msg, &sec, &pubk);
        assert!(sig.starts_with("SigV1"));
        assert!(
            verify_message_v1(msg, &pubk, &sig).unwrap(),
            "honest signature must verify"
        );
    }

    #[test]
    fn verifier_rejects_forgeries() {
        let (sec, pubk) = keypair();
        let msg = "sign in message";
        let sig = sign_message_v1(msg, &sec, &pubk);

        // Baseline passes.
        assert!(verify_message_v1(msg, &pubk, &sig).unwrap());
        // Tampered message → reject.
        assert!(!verify_message_v1("sign in messagE", &pubk, &sig).unwrap());
        // Wrong public key → reject.
        let (_s2, pub2) = keypair();
        assert!(!verify_message_v1(msg, &pub2, &sig).unwrap());
        // Tampered signature body (flip a base58 char region) → decode-or-verify fail.
        let mut bad = sig.clone();
        let last = bad.pop().unwrap();
        bad.push(if last == 'A' { 'B' } else { 'A' });
        assert!(matches!(
            verify_message_v1(msg, &pubk, &bad),
            Ok(false) | Err(_)
        ));
    }

    #[test]
    fn empty_message_signs_and_verifies() {
        let (sec, pubk) = keypair();
        let sig = sign_message_v1("", &sec, &pubk);
        assert!(verify_message_v1("", &pubk, &sig).unwrap());
    }

    #[test]
    fn subaddress_spend_key_matches_monero_address_derivation() {
        use monero_address::{Network, SubaddressIndex};
        use monero_wallet::ViewPair;
        use zeroize::Zeroizing;

        let spend_sec: Scalar = monero_oxide::ed25519::Scalar::random(&mut OsRng).into();
        let view_sec: Scalar = monero_oxide::ed25519::Scalar::random(&mut OsRng).into();
        let spend_pub = monero_oxide::ed25519::Point::from(&spend_sec * ED25519_BASEPOINT_POINT);
        let view = Zeroizing::new(monero_oxide::ed25519::Scalar::from(view_sec));
        let vp = ViewPair::new(spend_pub, view).expect("view pair");
        let idx = SubaddressIndex::new(0, 1).unwrap();
        let addr = vp.subaddress(Network::Mainnet, idx);

        let sub_sec = subaddress_spend_key(&spend_sec, &view_sec, 0, 1);
        let sub_pub = sub_sec * ED25519_BASEPOINT_POINT;
        let target_spend: EdwardsPoint = addr.spend().into();
        assert_eq!(sub_pub, target_spend);

        let sig = sign_message_v1("subaddress siwr", &sub_sec, &sub_pub);
        assert!(verify_message_v1("subaddress siwr", &sub_pub, &sig).unwrap());
        let root_pub = spend_sec * ED25519_BASEPOINT_POINT;
        assert!(!verify_message_v1("subaddress siwr", &root_pub, &sig).unwrap());
    }

    // GOLDEN VECTOR — the byte-compat gate against OFFICIAL Monero. Paste a real
    // `monero-wallet-cli`/`monero-wallet-rpc sign` output here (its `verify` reports
    // Good) and un-`ignore` this test: our independent `verify_message_v1` MUST also
    // accept it, proving our H / s_comm layout / SigV1 encoding are byte-identical.
    // Until then this primitive is UNAUDITED (see module header) and the live
    // monero-wallet-rpc `verify` in the SIWR callback is the production gate.
    // ── Real Monero vectors (NKIP-0003 vectors/v1.json; offline, no network) ──
    // A throwaway test wallet whose keys are published there. The SigV2 signatures
    // were made by monero-wallet-rpc v0.18.4.5 `sign`; the SigV1 one was checked with
    // its `verify` (good, version 1).
    const PRIMARY: &str = "497raTyHwdNFVqt247QKVoPWgCLCDRj22CBY6zgP6Xoh6xuqR3Nncv4ejV819yTvzScMopZz65fmBc5abGkpKAkxDUs5zvf";
    const SUB_0_1: &str = "89oGX4G9ydvdiegCper9ULee5tUjzqrrhKApwoac2tgDPBzJCW8nt5bRRcFV4E1i4c6JCrjurGy9UQZXxSdVr9yq1g7ya56";
    const SPEND_SEC: &str = "048b6263a32d7f03b7630797bb74d877570d5ba371fddf2ed69e04be8d832e0a";
    const VIEW_SEC: &str = "01ba78a651365d1c9245fea64df6eea73c899d18922df6918a556be589181c01";
    const RPC_V2_PRIMARY: &str = "SigV2AHz7AcpLYkKS7L5zY75TMQPfk4dQdrwty7o9i6vCH3CpBfDc49FqMmQ4kNWo8V8kysaSNfDnLKWbwJPPWr8ytfEX";
    const RPC_V2_SUB: &str = "SigV2ikkj6E9skqvDRun6ALjMh4WxFvs45bszk5esz9rzsrtPhtbG31TcmnZAyH4rLfYvFLFRq1oTuREHRBfZ6SZtnADG";
    const V1_PRIMARY: &str = "SigV1XQ9BkcMCp1BWExrV8UT68t1dgSnQNTnhc1dRTdJdgSj4X3fEGWq5VxzEonm59La9TZRdDPL9Ks8vVK1gReZTgAu5";

    fn vector_message(address: &str) -> String {
        format!(
            "example.org wants you to sign in with your Monero address:\n{address}\n\nSign in to example.org as @alice. This proves you control this address. No funds move.\n\nPurpose: login\nHandle: alice\nNonce: 9f86d081884c7d659a2feaa0c55ad015\nDevice-Key: 9ee202a85da63321\nIssued-At: 2026-10-27T12:00:00.000Z\nExpiration-Time: 2026-10-27T12:03:00.000Z\nVersion: 1"
        )
    }
    fn keys_of(address: &str) -> (EdwardsPoint, EdwardsPoint) {
        use monero_address::{MoneroAddress, Network};
        let a = MoneroAddress::from_str(Network::Mainnet, address).expect("address");
        (a.spend().into(), a.view().into())
    }
    fn scalar(hex_str: &str) -> Scalar {
        let b: [u8; 32] = hex::decode(hex_str).unwrap().try_into().unwrap();
        Option::from(Scalar::from_canonical_bytes(b)).expect("canonical")
    }

    #[test]
    fn validates_against_real_monero_signature() {
        let (spend, _) = keys_of(PRIMARY);
        assert!(
            verify_message_v1(&vector_message(PRIMARY), &spend, V1_PRIMARY).unwrap(),
            "our verifier disagrees with official Monero — SigV1 layout is off"
        );
    }

    #[test]
    fn verifies_wallet_rpc_sigv2_for_primary_and_subaddress() {
        for (addr, sig) in [(PRIMARY, RPC_V2_PRIMARY), (SUB_0_1, RPC_V2_SUB)] {
            let (spend, view) = keys_of(addr);
            assert!(verify_message_v2(&vector_message(addr), &spend, &view, sig).unwrap(), "{addr}");
            // one changed byte, or the other address's keys → fails
            assert!(!verify_message_v2(&(vector_message(addr) + "\n"), &spend, &view, sig).unwrap());
        }
        let (ps, pv) = keys_of(PRIMARY);
        assert!(!verify_message_v2(&vector_message(SUB_0_1), &ps, &pv, RPC_V2_SUB).unwrap(), "subaddress sig must not verify for the primary");
        // the wrong view key changes the hash
        let (ss, _) = keys_of(SUB_0_1);
        assert!(!verify_message_v2(&vector_message(SUB_0_1), &ss, &pv, RPC_V2_SUB).unwrap());
    }

    #[test]
    fn our_sigv2_matches_the_wallet_for_primary_and_subaddress() {
        let (b, a) = (scalar(SPEND_SEC), scalar(VIEW_SEC));
        // primary: key = b
        let (ps, pv) = keys_of(PRIMARY);
        assert_eq!(b * ED25519_BASEPOINT_POINT, ps);
        let sig = sign_message_v2(&vector_message(PRIMARY), &b, &ps, &pv);
        assert!(sig.starts_with("SigV2"));
        assert!(verify_message_v2(&vector_message(PRIMARY), &ps, &pv, &sig).unwrap());
        // subaddress 0/1: key = b + Hs("SubAddr\0" ‖ a ‖ 0 ‖ 1), hashed with the subaddress's keys
        let (ss, sv) = keys_of(SUB_0_1);
        let b1 = subaddress_spend_key(&b, &a, 0, 1);
        assert_eq!(b1 * ED25519_BASEPOINT_POINT, ss);
        let sig = sign_message_v2(&vector_message(SUB_0_1), &b1, &ss, &sv);
        assert!(verify_message_v2(&vector_message(SUB_0_1), &ss, &sv, &sig).unwrap());
        // the primary key signing for the subaddress does not verify
        let wrong = sign_message_v2(&vector_message(SUB_0_1), &b, &ps, &sv);
        assert!(!verify_message_v2(&vector_message(SUB_0_1), &ss, &sv, &wrong).unwrap());
    }

    #[test]
    fn a_view_mode_signature_is_not_a_spend_signature() {
        // mode 1 (view key) over the same message: our spend-mode verifier refuses it
        let (a, (ps, pv)) = (scalar(VIEW_SEC), keys_of(PRIMARY));
        let h = message_hash_v2(&vector_message(PRIMARY), &ps, &pv, 1);
        let sig = format!("SigV2{}", base58_monero::encode(&sign_hash(&h, &a, &pv)));
        assert!(!verify_message_v2(&vector_message(PRIMARY), &ps, &pv, &sig).unwrap());
    }

    #[test]
    fn varint_matches_monero() {
        assert_eq!(varint(0), vec![0]);
        assert_eq!(varint(127), vec![0x7f]);
        assert_eq!(varint(128), vec![0x80, 0x01]);
        assert_eq!(varint(300), vec![0xac, 0x02]);
    }
}
