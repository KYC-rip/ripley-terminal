//! Monero key derivation from mnemonic seed.
//!
//! Standard Monero key derivation:
//!   seed (25 words) → entropy (32 bytes) → spend_key (Scalar) → view_key (keccak256(spend_key))

use zeroize::Zeroizing;
use tiny_keccak::{Hasher, Keccak};

use monero_oxide::ed25519::Scalar;
use monero_seed::{Language, Seed};

/// Derive spend and view keys from a 25-word mnemonic seed.
pub fn keys_from_mnemonic(mnemonic: &str) -> Result<(Zeroizing<Scalar>, Zeroizing<Scalar>), String> {
    let seed = Seed::from_string(Language::English, Zeroizing::new(mnemonic.to_string()))
        .map_err(|e| format!("Invalid mnemonic: {:?}", e))?;

    let entropy = seed.entropy();
    keys_from_entropy(&entropy)
}

/// Derive spend and view keys from 32-byte entropy.
pub fn keys_from_entropy(entropy: &[u8; 32]) -> Result<(Zeroizing<Scalar>, Zeroizing<Scalar>), String> {
    // For legacy Monero seeds, entropy IS the spend key (already a valid scalar).
    // Use from_canonical_bytes to match wallet2 behavior.
    // Fall back to from_bytes_mod_order for non-canonical entropy (shouldn't happen with valid seeds).
    let dalek_spend = Option::<curve25519_dalek::Scalar>::from(
        curve25519_dalek::Scalar::from_canonical_bytes(*entropy)
    ).unwrap_or_else(|| curve25519_dalek::Scalar::from_bytes_mod_order(*entropy));
    let spend_key = Scalar::from(dalek_spend);

    // view_key = keccak256(spend_key_bytes) reduced mod l
    // Use the canonical spend key bytes (not the original entropy) for the hash
    let spend_bytes: [u8; 32] = dalek_spend.to_bytes();
    let view_bytes = keccak256(&spend_bytes);
    let dalek_view = curve25519_dalek::Scalar::from_bytes_mod_order(view_bytes);
    let view_key = Scalar::from(dalek_view);

    log::info!("Key derivation: spend={}, view={}", hex::encode(spend_bytes), hex::encode(view_bytes));

    Ok((Zeroizing::new(spend_key), Zeroizing::new(view_key)))
}

/// Generate a new random mnemonic seed.
pub fn generate_mnemonic() -> (String, Zeroizing<Scalar>, Zeroizing<Scalar>) {
    let mut rng = rand::thread_rng();
    let seed = Seed::new(&mut rng, Language::English);

    let entropy = seed.entropy();
    let (spend_key, view_key) = keys_from_entropy(&entropy)
        .expect("freshly generated seed should always produce valid keys");

    let mnemonic = seed.to_string();
    ((*mnemonic).clone(), spend_key, view_key)
}

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak::v256();
    let mut output = [0u8; 32];
    hasher.update(data);
    hasher.finalize(&mut output);
    output
}
