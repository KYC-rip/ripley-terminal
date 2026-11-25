//! Pure-Rust Nostr BIP-340 Schnorr signer & RipleyOS `ros-kv` vault reader for
//! Android NIP-55 (`nostrsigner:` Activity + `${applicationId}.SIGN_EVENT` ContentProvider).
//!
//! Reads the exact Nostr key storage maintained by RipleyOS (`src/os/nostrSigner.ts`):
//!   - `ripleyos:chat:sk`            — active 64-hex secret key (plaintext or RosSession AES-GCM)
//!   - `ripleyos:nostr:accounts:v1`  — JSON array of `{ id, sk, label }` (plaintext or RosSession AES-GCM)
//!   - `ripleyos:nostr:active`       — active account id
//!   - `ripleyos:lock:meta`          — `{ salt, idleMs, hasDuress }` (PBKDF2-HMAC-SHA256 150k)
//!   - `ripleyos:lock:verify`        — AES-256-GCM verifier (`{"v":1,"ripley":true}`)
//!
//! Secret key bytes are held in `Zeroizing` buffers and dropped immediately after signing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::Engine as _;
use k256::schnorr::{Signature, SigningKey, VerifyingKey};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::commands::ros_kv;

const SK_KEY: &str = "ripleyos:chat:sk";
const ACCOUNTS_KEY: &str = "ripleyos:nostr:accounts:v1";
const ACTIVE_KEY: &str = "ripleyos:nostr:active";
const LOCK_META_KEY: &str = "ripleyos:lock:meta";
const LOCK_VERIFY_KEY: &str = "ripleyos:lock:verify";
const ROS_SESSION_PBKDF2_ITERS: u32 = 150_000;
const MAX_EVENT_JSON_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Deserialize)]
struct LockMeta {
    salt: String,
}

#[derive(Debug, Clone, Deserialize)]
struct LockVerifyToken {
    #[serde(default)]
    ripley: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredNostrAccount {
    id: String,
    sk: String,
    label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicNostrAccount {
    pub id: String,
    pub label: String,
    pub pubkey: String,
    pub npub: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInspection {
    /// "ready" | "locked" | "bad_passcode" | "no_identity"
    pub status: String,
    pub has_passcode: bool,
    pub active_pubkey: Option<String>,
    pub active_npub: Option<String>,
    pub accounts: Vec<PublicNostrAccount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedEventResult {
    pub id: String,
    pub pubkey: String,
    pub sig: String,
    /// Complete NIP-01 signed event JSON string: `{id, pubkey, created_at, kind, tags, content, sig}`.
    pub event: String,
    pub kind: u32,
}

struct ResolvedAccount {
    id: String,
    label: String,
    pubkey: String,
    sk_hex: Zeroizing<String>,
}

// ── NIP-19 Bech32 (`npub1...`) encode / decode ──

const BECH32_CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

fn bech32_polymod(values: &[u8]) -> u32 {
    const GEN: [u32; 5] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let mut chk: u32 = 1;
    for &v in values {
        let b = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ (v as u32);
        for (i, g) in GEN.iter().enumerate() {
            if ((b >> i) & 1) != 0 {
                chk ^= g;
            }
        }
    }
    chk
}

fn bech32_hrp_expand(hrp: &str) -> Vec<u8> {
    let mut ret = Vec::with_capacity(hrp.len() * 2 + 1);
    for b in hrp.bytes() {
        ret.push(b >> 5);
    }
    ret.push(0);
    for b in hrp.bytes() {
        ret.push(b & 31);
    }
    ret
}

fn convert_bits(data: &[u8], from: u32, to: u32, pad: bool) -> Result<Vec<u8>, String> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut ret = Vec::new();
    let maxv = (1u32 << to) - 1;
    for &value in data {
        let v = value as u32;
        if (v >> from) != 0 {
            return Err("invalid bech32 value".into());
        }
        acc = (acc << from) | v;
        bits += from;
        while bits >= to {
            bits -= to;
            ret.push(((acc >> bits) & maxv) as u8);
        }
    }
    if pad {
        if bits > 0 {
            ret.push(((acc << (to - bits)) & maxv) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & maxv) != 0 {
        return Err("invalid bech32 padding".into());
    }
    Ok(ret)
}

pub fn hex_to_npub(pubkey_hex: &str) -> Result<String, String> {
    let raw = decode_32_hex(pubkey_hex)?;
    let data = convert_bits(&raw[..], 8, 5, true)?;
    let mut combined = bech32_hrp_expand("npub");
    combined.extend_from_slice(&data);
    combined.extend_from_slice(&[0u8; 6]);
    let polymod = bech32_polymod(&combined) ^ 1;
    let mut out = String::with_capacity(63);
    out.push_str("npub1");
    for &d in &data {
        out.push(BECH32_CHARSET[d as usize] as char);
    }
    for i in 0..6 {
        let idx = ((polymod >> (5 * (5 - i))) & 31) as usize;
        out.push(BECH32_CHARSET[idx] as char);
    }
    Ok(out)
}

pub fn npub_to_hex(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let has_lower = trimmed.bytes().any(|b| b.is_ascii_lowercase());
    let has_upper = trimmed.bytes().any(|b| b.is_ascii_uppercase());
    if has_lower && has_upper {
        return Err("mixed-case bech32".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    let pos = lower.rfind('1').ok_or("missing bech32 separator")?;
    let hrp = &lower[..pos];
    if hrp != "npub" {
        return Err("bech32 HRP must be npub".into());
    }
    let data_part = &lower[pos + 1..];
    if data_part.len() < 6 {
        return Err("bech32 payload too short".into());
    }
    let mut data = Vec::with_capacity(data_part.len());
    for b in data_part.bytes() {
        let idx = BECH32_CHARSET
            .iter()
            .position(|&c| c == b)
            .ok_or("invalid bech32 character")?;
        data.push(idx as u8);
    }
    let mut chk = bech32_hrp_expand(hrp);
    chk.extend_from_slice(&data);
    if bech32_polymod(&chk) != 1 {
        return Err("invalid bech32 checksum".into());
    }
    let payload = &data[..data.len() - 6];
    let bytes = convert_bits(payload, 5, 8, false)?;
    if bytes.len() != 32 {
        return Err("npub payload must be 32 bytes".into());
    }
    Ok(hex::encode(bytes))
}

/// Normalize a 64-char hex pubkey or NIP-19 `npub1...` to 64-char lowercase hex.
pub fn normalize_pubkey_hex(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(s.to_ascii_lowercase());
    }
    if s.to_ascii_lowercase().starts_with("npub1") {
        return npub_to_hex(s);
    }
    Err("expected 64-char hex pubkey or npub1...".into())
}

// ── Secp256k1 / BIP-340 Schnorr Helpers ──

fn decode_32_hex(s: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let trimmed = s.trim();
    if trimmed.len() != 64 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("expected 64-character hex string".into());
    }
    let bytes = hex::decode(trimmed).map_err(|_| "invalid hex")?;
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&bytes);
    Ok(out)
}

pub fn pubkey_from_sk_hex(sk_hex: &str) -> Result<String, String> {
    let sk_bytes = decode_32_hex(sk_hex)?;
    let signing_key =
        SigningKey::from_bytes(&sk_bytes[..]).map_err(|_| "invalid secp256k1 secret key")?;
    let vk: VerifyingKey = *signing_key.verifying_key();
    Ok(hex::encode(vk.to_bytes()))
}

fn is_plaintext_sk_hex(s: &str) -> bool {
    let t = s.trim();
    t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Sign an unsigned NIP-01 event JSON string using BIP-340 Schnorr (`k256::schnorr`).
pub fn sign_event_json(sk_hex: &str, unsigned_event_json: &str) -> Result<SignedEventResult, String> {
    if unsigned_event_json.len() > MAX_EVENT_JSON_BYTES {
        return Err("event JSON exceeds 256 KiB limit".into());
    }
    let parsed: Value =
        serde_json::from_str(unsigned_event_json).map_err(|e| format!("invalid event JSON: {e}"))?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| "event JSON must be an object".to_string())?;

    let kind_u64 = obj
        .get("kind")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "event missing integer kind".to_string())?;
    if kind_u64 > 65535 {
        return Err("event kind out of NIP-01 range (0..65535)".into());
    }
    let kind = kind_u64 as u32;

    let created_at: i64 = match obj.get("created_at").and_then(|v| v.as_i64()) {
        Some(ts) if ts > 0 => ts,
        _ => chrono::Utc::now().timestamp(),
    };

    let content = match obj.get("content") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return Err("event content must be a string".into()),
    };

    let mut tags: Vec<Vec<String>> = Vec::new();
    if let Some(raw_tags) = obj.get("tags") {
        let arr = raw_tags
            .as_array()
            .ok_or_else(|| "event tags must be an array".to_string())?;
        for tag in arr {
            let elems = tag
                .as_array()
                .ok_or_else(|| "each event tag must be an array of strings".to_string())?;
            let mut row = Vec::with_capacity(elems.len());
            for el in elems {
                let s = el
                    .as_str()
                    .ok_or_else(|| "event tag elements must be strings".to_string())?;
                row.push(s.to_string());
            }
            tags.push(row);
        }
    }

    let sk_bytes = decode_32_hex(sk_hex)?;
    let signing_key =
        SigningKey::from_bytes(&sk_bytes[..]).map_err(|_| "invalid secp256k1 secret key")?;
    let verifying_key: VerifyingKey = *signing_key.verifying_key();
    let pubkey = hex::encode(verifying_key.to_bytes());

    // NIP-01 canonical commitment: [0, <pubkey>, <created_at>, <kind>, <tags>, <content>]
    let serialized = serde_json::to_string(&json!([0, pubkey, created_at, kind, tags, content]))
        .map_err(|e| format!("serialize error: {e}"))?;
    let digest = Sha256::digest(serialized.as_bytes());
    let mut id_bytes = [0u8; 32];
    id_bytes.copy_from_slice(&digest);
    let id_hex = hex::encode(id_bytes);

    let mut aux_rand = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(&mut *aux_rand);
    let sig: Signature = signing_key
        .sign_raw(&id_bytes, &aux_rand)
        .map_err(|_| "BIP-340 Schnorr signing failed")?;

    // Belt-and-suspenders verification before returning to caller.
    verifying_key
        .verify_raw(&id_bytes, &sig)
        .map_err(|_| "self-verification of BIP-340 signature failed")?;

    let sig_hex = hex::encode(sig.to_bytes());
    let signed_event = json!({
        "id": id_hex,
        "pubkey": pubkey,
        "created_at": created_at,
        "kind": kind,
        "tags": tags,
        "content": content,
        "sig": sig_hex,
    });
    let event_json =
        serde_json::to_string(&signed_event).map_err(|e| format!("event serialize error: {e}"))?;

    Ok(SignedEventResult {
        id: id_hex,
        pubkey,
        sig: sig_hex,
        event: event_json,
        kind,
    })
}

pub fn sign_with_raw_sk(
    sk_hex: &str,
    expected_pubkey: Option<&str>,
    unsigned_event_json: &str,
) -> Result<SignedEventResult, String> {
    if let Some(exp_raw) = expected_pubkey {
        let exp = exp_raw.trim();
        if !exp.is_empty() {
            let expected = normalize_pubkey_hex(exp)?;
            let actual = pubkey_from_sk_hex(sk_hex)?;
            if actual != expected {
                return Err("Sealed key does not match requested public key".into());
            }
        }
    }
    sign_event_json(sk_hex, unsigned_event_json)
}

// ── RosSession PBKDF2-150k + AES-256-GCM Decryption ──

fn derive_ros_session_key(passcode: &str, salt: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0u8; 32]);
    pbkdf2_hmac::<Sha256>(passcode.as_bytes(), salt, ROS_SESSION_PBKDF2_ITERS, &mut *key);
    key
}

fn decrypt_session_blob<T: for<'de> Deserialize<'de>>(
    b64: &str,
    key: &[u8; 32],
) -> Result<T, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|_| "invalid base64")?;
    if raw.len() < 12 + 16 {
        return Err("ciphertext too short".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "cipher init error")?;
    let nonce = Nonce::from_slice(&raw[..12]);
    let pt = Zeroizing::new(
        cipher
            .decrypt(nonce, &raw[12..])
            .map_err(|_| "decryption failed")?,
    );
    serde_json::from_slice::<T>(&pt).map_err(|_| "decrypted JSON parse failed".into())
}

// ── RipleyOS `ros-kv` Vault Reader ──

fn kv_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("ros-kv")
}

fn load_kv_map(app_data_dir: &Path) -> Result<HashMap<String, String>, String> {
    ros_kv::load(&kv_dir(app_data_dir))
}

enum VaultReadOutcome {
    Ready {
        has_passcode: bool,
        active_pubkey: String,
        accounts: Vec<ResolvedAccount>,
    },
    Locked,
    BadPasscode,
    NoIdentity {
        has_passcode: bool,
    },
}

fn read_vault_accounts(
    app_data_dir: &Path,
    passcode: Option<&str>,
) -> Result<VaultReadOutcome, String> {
    let map = load_kv_map(app_data_dir)?;
    let lock_meta_raw = map.get(LOCK_META_KEY);
    let lock_verify_raw = map.get(LOCK_VERIFY_KEY);
    let has_passcode = lock_meta_raw.is_some();

    let sk_raw = map.get(SK_KEY);
    let accounts_raw = map.get(ACCOUNTS_KEY);
    let active_id = map.get(ACTIVE_KEY).map(|s| s.trim()).unwrap_or("");

    // Fast path: if plaintext keys exist on disk (no passcode, or not-yet-migrated),
    // read them directly unless a passcode is required to unlock ciphertext.
    let sk_is_plain = sk_raw.map(|s| is_plaintext_sk_hex(s)).unwrap_or(false);
    let accounts_plain: Option<Vec<StoredNostrAccount>> = accounts_raw
        .and_then(|raw| serde_json::from_str::<Vec<StoredNostrAccount>>(raw).ok());

    let needs_decrypt = (sk_raw.is_some() && !sk_is_plain)
        || (accounts_raw.is_some() && accounts_plain.is_none());

    let mut session_key: Option<Zeroizing<[u8; 32]>> = None;
    if needs_decrypt || (has_passcode && passcode.is_some()) {
        let Some(pass) = passcode.filter(|p| !p.is_empty()) else {
            return Ok(VaultReadOutcome::Locked);
        };
        let meta_str = lock_meta_raw.ok_or("vault encrypted but lock metadata missing")?;
        let verify_str = lock_verify_raw.ok_or("vault encrypted but lock verifier missing")?;
        let meta: LockMeta =
            serde_json::from_str(meta_str).map_err(|_| "corrupt lock metadata")?;
        let salt = base64::engine::general_purpose::STANDARD
            .decode(meta.salt.trim())
            .map_err(|_| "corrupt lock salt")?;
        let derived = derive_ros_session_key(pass, &salt);
        let ok = decrypt_session_blob::<LockVerifyToken>(verify_str, &derived)
            .map(|t| t.ripley)
            .unwrap_or(false);
        if !ok {
            return Ok(VaultReadOutcome::BadPasscode);
        }
        session_key = Some(derived);
    }

    // Resolve accounts list (encrypted or plaintext).
    let stored_accounts: Vec<StoredNostrAccount> = if let Some(list) = accounts_plain {
        list
    } else if let (Some(raw), Some(key)) = (accounts_raw, session_key.as_ref()) {
        decrypt_session_blob::<Vec<StoredNostrAccount>>(raw, key).unwrap_or_default()
    } else {
        Vec::new()
    };

    // Resolve active SK (encrypted or plaintext).
    let active_sk_opt: Option<Zeroizing<String>> = if sk_is_plain {
        sk_raw.map(|s| Zeroizing::new(s.trim().to_ascii_lowercase()))
    } else if let (Some(raw), Some(key)) = (sk_raw, session_key.as_ref()) {
        decrypt_session_blob::<String>(raw, key)
            .ok()
            .filter(|s| is_plaintext_sk_hex(s))
            .map(|s| Zeroizing::new(s.trim().to_ascii_lowercase()))
    } else {
        None
    };

    let mut resolved: Vec<ResolvedAccount> = Vec::new();
    for acc in stored_accounts {
        if !is_plaintext_sk_hex(&acc.sk) {
            continue;
        }
        let sk_clean = Zeroizing::new(acc.sk.trim().to_ascii_lowercase());
        if let Ok(pk) = pubkey_from_sk_hex(&sk_clean) {
            if !resolved.iter().any(|r| r.pubkey == pk) {
                resolved.push(ResolvedAccount {
                    id: acc.id,
                    label: acc.label,
                    pubkey: pk,
                    sk_hex: sk_clean,
                });
            }
        }
    }

    let mut active_pubkey: Option<String> = None;
    if let Some(sk) = active_sk_opt {
        if let Ok(pk) = pubkey_from_sk_hex(&sk) {
            active_pubkey = Some(pk.clone());
            if !resolved.iter().any(|r| r.pubkey == pk) {
                resolved.insert(
                    0,
                    ResolvedAccount {
                        id: if active_id.is_empty() {
                            "default".to_string()
                        } else {
                            active_id.to_string()
                        },
                        label: "Account 1".to_string(),
                        pubkey: pk,
                        sk_hex: sk,
                    },
                );
            }
        }
    }

    if resolved.is_empty() {
        return Ok(VaultReadOutcome::NoIdentity { has_passcode });
    }

    let final_active_pk = active_pubkey
        .or_else(|| {
            resolved
                .iter()
                .find(|a| a.id == active_id)
                .map(|a| a.pubkey.clone())
        })
        .unwrap_or_else(|| resolved[0].pubkey.clone());

    Ok(VaultReadOutcome::Ready {
        has_passcode,
        active_pubkey: final_active_pk,
        accounts: resolved,
    })
}

pub fn inspect_vault(app_data_dir: &Path, passcode: Option<&str>) -> VaultInspection {
    match read_vault_accounts(app_data_dir, passcode) {
        Ok(VaultReadOutcome::Ready {
            has_passcode,
            active_pubkey,
            accounts,
        }) => {
            let active_npub = hex_to_npub(&active_pubkey).ok();
            let pub_accounts = accounts
                .into_iter()
                .filter_map(|a| {
                    let npub = hex_to_npub(&a.pubkey).ok()?;
                    Some(PublicNostrAccount {
                        id: a.id,
                        label: a.label,
                        pubkey: a.pubkey,
                        npub,
                    })
                })
                .collect();
            VaultInspection {
                status: "ready".into(),
                has_passcode,
                active_pubkey: Some(active_pubkey),
                active_npub,
                accounts: pub_accounts,
                error: None,
            }
        }
        Ok(VaultReadOutcome::Locked) => VaultInspection {
            status: "locked".into(),
            has_passcode: true,
            active_pubkey: None,
            active_npub: None,
            accounts: Vec::new(),
            error: None,
        },
        Ok(VaultReadOutcome::BadPasscode) => VaultInspection {
            status: "bad_passcode".into(),
            has_passcode: true,
            active_pubkey: None,
            active_npub: None,
            accounts: Vec::new(),
            error: Some("Incorrect RipleyOS passcode".into()),
        },
        Ok(VaultReadOutcome::NoIdentity { has_passcode }) => VaultInspection {
            status: "no_identity".into(),
            has_passcode,
            active_pubkey: None,
            active_npub: None,
            accounts: Vec::new(),
            error: None,
        },
        Err(e) => VaultInspection {
            status: "error".into(),
            has_passcode: false,
            active_pubkey: None,
            active_npub: None,
            accounts: Vec::new(),
            error: Some(e),
        },
    }
}

/// Generate a fresh Nostr identity in `$APPDATA/ros-kv/` ONLY when no Nostr key and
/// no passcode lock exist yet. Never overwrites existing or encrypted identities.
pub fn create_identity_in_vault(app_data_dir: &Path) -> Result<PublicNostrAccount, String> {
    let dir = kv_dir(app_data_dir);
    let map = ros_kv::load(&dir)?;
    if map.contains_key(SK_KEY) || map.contains_key(ACCOUNTS_KEY) || map.contains_key(LOCK_META_KEY) {
        return Err("Refusing to create identity: vault already contains keys or lock".into());
    }
    let mut sk_bytes = Zeroizing::new([0u8; 32]);
    let signing_key = loop {
        rand::rngs::OsRng.fill_bytes(&mut *sk_bytes);
        if let Ok(k) = SigningKey::from_bytes(&sk_bytes[..]) {
            break k;
        }
    };
    let sk_hex = Zeroizing::new(hex::encode(&sk_bytes[..]));
    let pubkey = hex::encode(signing_key.verifying_key().to_bytes());
    let npub = hex_to_npub(&pubkey)?;
    let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
    let id = format!("a{:x}", now_ms);
    let accounts = vec![StoredNostrAccount {
        id: id.clone(),
        sk: sk_hex.to_string(),
        label: "Account 1".to_string(),
    }];
    let accounts_json = serde_json::to_string(&accounts).map_err(|e| format!("json: {e}"))?;
    ros_kv::put(&dir, SK_KEY, &sk_hex)?;
    ros_kv::put(&dir, ACCOUNTS_KEY, &accounts_json)?;
    ros_kv::put(&dir, ACTIVE_KEY, &id)?;
    Ok(PublicNostrAccount {
        id,
        label: "Account 1".to_string(),
        pubkey,
        npub,
    })
}

fn select_account<'a>(
    accounts: &'a [ResolvedAccount],
    active_pubkey: &str,
    target_pubkey: Option<&str>,
) -> Result<&'a ResolvedAccount, String> {
    if let Some(raw_target) = target_pubkey.map(str::trim).filter(|s| !s.is_empty()) {
        let wanted = normalize_pubkey_hex(raw_target)?;
        accounts
            .iter()
            .find(|a| a.pubkey == wanted)
            .ok_or_else(|| "Requested public key not found in Ripley Vault".to_string())
    } else {
        accounts
            .iter()
            .find(|a| a.pubkey == active_pubkey)
            .or_else(|| accounts.first())
            .ok_or_else(|| "No Nostr identity found in Ripley Vault".to_string())
    }
}

pub fn sign_with_vault(
    app_data_dir: &Path,
    passcode: Option<&str>,
    target_pubkey: Option<&str>,
    unsigned_event_json: &str,
) -> Result<SignedEventResult, String> {
    match read_vault_accounts(app_data_dir, passcode)? {
        VaultReadOutcome::Ready {
            active_pubkey,
            accounts,
            ..
        } => {
            let acc = select_account(&accounts, &active_pubkey, target_pubkey)?;
            sign_event_json(&acc.sk_hex, unsigned_event_json)
        }
        VaultReadOutcome::Locked => Err("LOCKED".into()),
        VaultReadOutcome::BadPasscode => Err("BAD_PASSCODE".into()),
        VaultReadOutcome::NoIdentity { .. } => Err("NO_IDENTITY".into()),
    }
}

/// Extract `(pubkey_hex, sk_hex)` strictly for sealing into hardware-backed Android Keystore
/// after the user unlocks their passcode and explicitly approves background NIP-55 permissions.
pub fn export_for_keystore_seal(
    app_data_dir: &Path,
    passcode: Option<&str>,
    target_pubkey: Option<&str>,
) -> Result<(String, Zeroizing<String>), String> {
    match read_vault_accounts(app_data_dir, passcode)? {
        VaultReadOutcome::Ready {
            active_pubkey,
            accounts,
            ..
        } => {
            let acc = select_account(&accounts, &active_pubkey, target_pubkey)?;
            Ok((acc.pubkey.clone(), acc.sk_hex.clone()))
        }
        VaultReadOutcome::Locked => Err("LOCKED".into()),
        VaultReadOutcome::BadPasscode => Err("BAD_PASSCODE".into()),
        VaultReadOutcome::NoIdentity { .. } => Err("NO_IDENTITY".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch_app_dir() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let d = std::env::temp_dir().join(format!("nip55-signer-test-{n}"));
        fs::create_dir_all(d.join("ros-kv")).unwrap();
        d
    }

    fn encrypt_ros_session<T: Serialize>(obj: &T, key: &[u8; 32]) -> String {
        let cipher = Aes256Gcm::new_from_slice(key).unwrap();
        let mut iv = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut iv);
        let pt = serde_json::to_vec(obj).unwrap();
        let ct = cipher.encrypt(Nonce::from_slice(&iv), pt.as_slice()).unwrap();
        let mut out = Vec::with_capacity(12 + ct.len());
        out.extend_from_slice(&iv);
        out.extend_from_slice(&ct);
        base64::engine::general_purpose::STANDARD.encode(out)
    }

    #[test]
    fn bip340_pubkey_and_nip01_sign_verify() {
        // Known secp256k1 secret key = 1 -> G.x
        let sk_one = "0000000000000000000000000000000000000000000000000000000000000001";
        let pk = pubkey_from_sk_hex(sk_one).unwrap();
        assert_eq!(
            pk,
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        );

        let unsigned = r#"{"kind":27235,"created_at":1700000000,"tags":[["u","https://api.kyc.rip/v1/test"],["method","POST"]],"content":"hello \"nostr\"\nline2"}"#;
        let signed = sign_event_json(sk_one, unsigned).unwrap();
        assert_eq!(signed.pubkey, pk);
        assert_eq!(signed.id.len(), 64);
        assert_eq!(signed.sig.len(), 128);
        assert_eq!(signed.kind, 27235);

        // Verify returned JSON matches NIP-01 fields and verifies under k256 VerifyingKey.
        let ev: Value = serde_json::from_str(&signed.event).unwrap();
        assert_eq!(ev["id"].as_str().unwrap(), signed.id);
        assert_eq!(ev["pubkey"].as_str().unwrap(), pk);
        assert_eq!(ev["created_at"].as_i64().unwrap(), 1700000000);
        assert_eq!(ev["kind"].as_u64().unwrap(), 27235);
        assert_eq!(ev["sig"].as_str().unwrap(), signed.sig);

        let id_bytes = hex::decode(&signed.id).unwrap();
        let sig_bytes = hex::decode(&signed.sig).unwrap();
        let vk = VerifyingKey::from_bytes(&hex::decode(&pk).unwrap()).unwrap();
        let sig = Signature::try_from(sig_bytes.as_slice()).unwrap();
        vk.verify_raw(&id_bytes, &sig).unwrap();
    }

    #[test]
    fn nip19_npub_round_trip_and_validation() {
        // Official NIP-19 test vector:
        // hex: 3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d
        // npub: npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6
        let hex_pk = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
        let expected_npub = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";
        assert_eq!(hex_to_npub(hex_pk).unwrap(), expected_npub);
        assert_eq!(npub_to_hex(expected_npub).unwrap(), hex_pk);
        assert_eq!(normalize_pubkey_hex(expected_npub).unwrap(), hex_pk);
        assert_eq!(normalize_pubkey_hex(&hex_pk.to_uppercase()).unwrap(), hex_pk);

        // Corrupt checksum / wrong HRP / mixed case must fail
        assert!(npub_to_hex("npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w7").is_err());
        assert!(npub_to_hex("nsec180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6").is_err());
        assert!(npub_to_hex("Npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6").is_err());
    }

    #[test]
    fn plaintext_vault_multi_account_and_unknown_user_rejected() {
        let dir = scratch_app_dir();
        let kv = dir.join("ros-kv");
        let sk1 = "1111111111111111111111111111111111111111111111111111111111111111";
        let sk2 = "2222222222222222222222222222222222222222222222222222222222222222";
        let pk1 = pubkey_from_sk_hex(sk1).unwrap();
        let pk2 = pubkey_from_sk_hex(sk2).unwrap();
        let accounts = json!([
            { "id": "a1", "sk": sk1, "label": "Primary" },
            { "id": "a2", "sk": sk2, "label": "Alt" }
        ]);
        ros_kv::put(&kv, SK_KEY, sk1).unwrap();
        ros_kv::put(&kv, ACCOUNTS_KEY, &accounts.to_string()).unwrap();
        ros_kv::put(&kv, ACTIVE_KEY, "a1").unwrap();

        let info = inspect_vault(&dir, None);
        assert_eq!(info.status, "ready");
        assert_eq!(info.active_pubkey.as_deref(), Some(pk1.as_str()));
        assert_eq!(info.accounts.len(), 2);

        // Sign targeting account 2 by npub
        let npub2 = hex_to_npub(&pk2).unwrap();
        let res = sign_with_vault(
            &dir,
            None,
            Some(&npub2),
            r#"{"kind":24242,"created_at":1700000001,"tags":[],"content":"blossom"}"#,
        )
        .unwrap();
        assert_eq!(res.pubkey, pk2);

        // Unknown target pubkey MUST fail closed
        let unknown = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assert!(sign_with_vault(
            &dir,
            None,
            Some(unknown),
            r#"{"kind":0,"created_at":1700000001,"tags":[],"content":"{}"}"#
        )
        .is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn passcode_encrypted_ros_session_vault_decrypts_and_never_overwrites() {
        let dir = scratch_app_dir();
        let kv = dir.join("ros-kv");
        let pass = "correct-horse-battery-staple";
        let salt = [0x42u8; 16];
        let key = derive_ros_session_key(pass, &salt);

        let sk = "3333333333333333333333333333333333333333333333333333333333333333";
        let pk = pubkey_from_sk_hex(sk).unwrap();
        let accounts = vec![StoredNostrAccount {
            id: "a1".into(),
            sk: sk.into(),
            label: "Vault".into(),
        }];

        let meta = json!({
            "salt": base64::engine::general_purpose::STANDARD.encode(salt),
            "idleMs": 300000,
            "hasDuress": false
        });
        ros_kv::put(&kv, LOCK_META_KEY, &meta.to_string()).unwrap();
        ros_kv::put(
            &kv,
            LOCK_VERIFY_KEY,
            &encrypt_ros_session(&json!({ "v": 1, "ripley": true }), &key),
        )
        .unwrap();
        ros_kv::put(&kv, SK_KEY, &encrypt_ros_session(&sk, &key)).unwrap();
        ros_kv::put(&kv, ACCOUNTS_KEY, &encrypt_ros_session(&accounts, &key)).unwrap();

        // Locked without passcode
        assert_eq!(inspect_vault(&dir, None).status, "locked");
        assert!(create_identity_in_vault(&dir).is_err());
        assert_eq!(
            sign_with_vault(&dir, None, None, r#"{"kind":1,"content":"hi"}"#).unwrap_err(),
            "LOCKED"
        );

        // Wrong passcode rejected
        assert_eq!(inspect_vault(&dir, Some("wrong-pass")).status, "bad_passcode");

        // Correct passcode unlocks and signs cleanly
        let ok = inspect_vault(&dir, Some(pass));
        assert_eq!(ok.status, "ready");
        assert_eq!(ok.active_pubkey.as_deref(), Some(pk.as_str()));

        let signed = sign_with_vault(
            &dir,
            Some(pass),
            Some(&pk),
            r#"{"kind":1,"created_at":1700000100,"tags":[],"content":"sovereign"}"#,
        )
        .unwrap();
        assert_eq!(signed.pubkey, pk);
        assert_eq!(signed.sig.len(), 128);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_identity_on_empty_vault_then_refuses_overwrite() {
        let dir = scratch_app_dir();
        assert_eq!(inspect_vault(&dir, None).status, "no_identity");

        let created = create_identity_in_vault(&dir).unwrap();
        assert_eq!(created.pubkey.len(), 64);
        assert!(created.npub.starts_with("npub1"));

        // Second call must refuse to overwrite
        assert!(create_identity_in_vault(&dir).is_err());

        // Inspect now returns ready with the same pubkey
        let after = inspect_vault(&dir, None);
        assert_eq!(after.status, "ready");
        assert_eq!(after.active_pubkey.as_deref(), Some(created.pubkey.as_str()));

        let _ = fs::remove_dir_all(&dir);
    }
}
