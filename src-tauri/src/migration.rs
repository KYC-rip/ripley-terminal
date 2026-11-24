//! Sovereign Device Migration Engine (`Mac ↔ Pixel` / `Android ↔ Android`).
//!
//! Transfers the complete Ripley Terminal + RipleyOS state in one encrypted shot:
//!   - All native Monero `.vault` files (`wallets/<id>.vault`) + `identities.json` + `active_identity`
//!   - All portable `ros-kv` records (unified 24-word seed, Solana, Bitcoin, EVM burners,
//!     Nostr, Mail, PGP, Contacts, Vault, Notes, Settings, and lock passcode verifier),
//!     strictly excluding device-local hardware keys (`lock:bio:*`, `passkey:*`, `custody`, etc.).
//!
//! Two transport modes, both zero-server and zero-cloud:
//!   1. Offline `.ripley-migrate` encrypted archive (`RPLYMIG1` + Argon2id + ChaCha20-Poly1305 + zstd)
//!   2. Direct LAN QR transfer (`RPLYMIG1` + ephemeral 32-byte key in QR + 6-char SAS + local-only HTTP)

use std::collections::{HashMap, HashSet};
use std::fs;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use argon2::Argon2;
use base64::Engine as _;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use hkdf::Hkdf;
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use crate::commands::ros_kv;
use crate::wallet::storage::valid_identity_id;
use crate::wallet::Identity;

const MAGIC: &[u8; 8] = b"RPLYMIG1";
const CACHE_SEAL_MAGIC: &[u8; 5] = b"RIPC1";
const CACHE_KEY_FILE: &str = "device.key";
const CACHE_HKDF_INFO: &[u8] = b"ripley/cache-v1";
const MODE_PASSPHRASE: u8 = 0x01;
const MODE_RAW_KEY: u8 = 0x02;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const MAX_BUNDLE_BYTES: usize = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES: usize = 128 * 1024 * 1024;
const LAN_TTL_SECS: u64 = 300;
const MAX_LAN_SERVES: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultEntry {
    pub id: String,
    pub data_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    pub id: String,
    /// Unsealed OutputCache JSON bytes (zstd-compressed + ChaCha20-Poly1305 encrypted inside RPLYMIG1,
    /// then re-sealed under the target device's own `device.key` on import so zero rescan is needed).
    pub json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SovereignBundle {
    pub version: u32,
    pub created_at: u64,
    pub source_os: String,
    pub identities: Vec<Identity>,
    #[serde(default)]
    pub active_identity: Option<String>,
    pub vaults: Vec<VaultEntry>,
    /// Synced Monero output caches (`scan_height`, outputs, spent/frozen coin-control, outgoing tx_keys).
    #[serde(default)]
    pub caches: Vec<CacheEntry>,
    /// Optional XMR402 receipts (`xmr402_payments.json`) and swap tags (`ghost_trades.json`).
    #[serde(default)]
    pub xmr402_payments: Option<String>,
    #[serde(default)]
    pub ghost_trades: Option<String>,
    pub ros_kv: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPreview {
    pub source_os: String,
    pub created_at: u64,
    pub monero_wallets: Vec<String>,
    pub monero_vault_count: usize,
    pub synced_cache_count: usize,
    pub has_unified_seed: bool,
    pub has_bitcoin: bool,
    pub has_solana: bool,
    pub has_evm_burners: bool,
    pub has_nostr: bool,
    pub has_mail: bool,
    pub has_passcode: bool,
    pub kv_count: usize,
    pub bundle_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanSessionInfo {
    pub uri: String,
    pub sas: String,
    pub ip: String,
    pub port: u16,
    pub expires_in_secs: u64,
    pub preview: MigrationPreview,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanFetchedTransfer {
    pub transfer_id: String,
    pub sas: String,
    pub preview: MigrationPreview,
}

/// Keys strictly tied to a single physical device's hardware keystore, companion pairing,
/// launcher alias, or ephemeral sync watermarks — never migrated across devices.
pub fn is_device_local_kv_key(key: &str) -> bool {
    matches!(
        key,
        "ripleyos:keys:custody:v1" | "ripleyos:keys:companion:v1" | "ripleyos:__backend"
    ) || key.starts_with("ripleyos:lock:bio:")
        || key.starts_with("ripleyos:passkey:")
        || key.starts_with("ripleyos:trade:")
        || key.starts_with("ripleyos:sync:state")
        || key.starts_with("ripleyos:sync:floor")
        || key.starts_with("ripleyos:launcher:icon")
}

fn current_source_os() -> String {
    #[cfg(target_os = "android")]
    {
        "android".to_string()
    }
    #[cfg(target_os = "macos")]
    {
        "macos".to_string()
    }
    #[cfg(target_os = "linux")]
    {
        "linux".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "windows".to_string()
    }
    #[cfg(not(any(
        target_os = "android",
        target_os = "macos",
        target_os = "linux",
        target_os = "windows"
    )))]
    {
        "unknown".to_string()
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn derive_cache_subkey(root: &[u8; 32]) -> Option<Zeroizing<[u8; 32]>> {
    let hk = Hkdf::<Sha256>::new(None, root);
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(CACHE_HKDF_INFO, out.as_mut()).ok()?;
    Some(out)
}

/// Read an existing `<app_data_dir>/device.key` (read-only, never creates one).
fn read_cache_key(app_data_dir: &Path) -> Option<Zeroizing<[u8; 32]>> {
    let bytes = fs::read(app_data_dir.join(CACHE_KEY_FILE)).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut root = Zeroizing::new([0u8; 32]);
    root.copy_from_slice(&bytes);
    derive_cache_subkey(&root)
}

/// Read or create `<app_data_dir>/device.key` so imported `.cache` files are sealed under the
/// target device's own local key (matching `wallet::device_key::init_file_key`).
fn load_or_create_cache_key(app_data_dir: &Path) -> Option<Zeroizing<[u8; 32]>> {
    if let Some(k) = read_cache_key(app_data_dir) {
        return Some(k);
    }
    let path = app_data_dir.join(CACHE_KEY_FILE);
    let mut root = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(root.as_mut());
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::write(&path, root.as_ref()).is_err() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    derive_cache_subkey(&root)
}

fn unseal_cache_bytes(data: &[u8], cache_key: Option<&[u8; 32]>) -> Option<String> {
    let plain = if let Some(body) = data.strip_prefix(CACHE_SEAL_MAGIC.as_slice()) {
        if body.len() <= NONCE_LEN {
            return None;
        }
        let key = cache_key?;
        let (nonce, ct) = body.split_at(NONCE_LEN);
        let cipher = ChaCha20Poly1305::new_from_slice(key).ok()?;
        cipher.decrypt(Nonce::from_slice(nonce), ct).ok()?
    } else {
        data.to_vec()
    };
    let s = String::from_utf8(plain).ok()?;
    // Sanity-check it parses as JSON object (OutputCache) before packing.
    let val: serde_json::Value = serde_json::from_str(&s).ok()?;
    if !val.is_object() {
        return None;
    }
    Some(s)
}

fn seal_cache_bytes(plain: &[u8], cache_key: Option<&[u8; 32]>) -> Vec<u8> {
    let Some(key) = cache_key else {
        return plain.to_vec();
    };
    let cipher = ChaCha20Poly1305::new_from_slice(key).expect("valid key");
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plain)
        .expect("ChaCha20Poly1305 encrypt");
    let mut out = Vec::with_capacity(CACHE_SEAL_MAGIC.len() + NONCE_LEN + ct.len());
    out.extend_from_slice(CACHE_SEAL_MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

/// Pack all Monero vaults, synced `.cache` files (unsealed from source device key), identities,
/// active identity, XMR402/swap metadata, and portable `ros-kv` records from `app_data_dir`.
pub fn pack_bundle(app_data_dir: &Path) -> Result<SovereignBundle, String> {
    // 1. Read identities.json
    let identities_path = app_data_dir.join("identities.json");
    let identities: Vec<Identity> = match fs::read_to_string(&identities_path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => vec![],
    };

    // 2. Read active_identity
    let active_identity = fs::read_to_string(app_data_dir.join("active_identity"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| valid_identity_id(s));

    // 3. Read all valid wallets/*.vault and unseal wallets/*.cache (synced outputs + tx history!)
    let mut vaults = Vec::new();
    let mut caches = Vec::new();
    let src_cache_key = read_cache_key(app_data_dir);
    let wallets_dir = app_data_dir.join("wallets");
    if wallets_dir.is_dir() {
        let mut vault_entries: Vec<(String, PathBuf)> = Vec::new();
        let mut cache_entries: Vec<(String, PathBuf)> = Vec::new();
        for entry in fs::read_dir(&wallets_dir).map_err(|e| format!("read wallets dir: {e}"))? {
            let entry = entry.map_err(|e| format!("read wallets entry: {e}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !valid_identity_id(stem) {
                continue;
            }
            match path.extension().and_then(|s| s.to_str()) {
                Some("vault") => vault_entries.push((stem.to_string(), path)),
                Some("cache") => cache_entries.push((stem.to_string(), path)),
                _ => {}
            }
        }
        vault_entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (id, path) in vault_entries {
            let bytes = fs::read(&path).map_err(|e| format!("read vault {id}: {e}"))?;
            if bytes.is_empty() {
                continue;
            }
            vaults.push(VaultEntry {
                id,
                data_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
            });
        }
        cache_entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (id, path) in cache_entries {
            if let Ok(bytes) = fs::read(&path) {
                if let Some(json) = unseal_cache_bytes(&bytes, src_cache_key.as_deref()) {
                    caches.push(CacheEntry { id, json });
                }
            }
        }
    }

    // 4. Optional XMR402 receipts & ghost trade tags
    let xmr402_payments = fs::read_to_string(app_data_dir.join("xmr402_payments.json")).ok();
    let ghost_trades = fs::read_to_string(app_data_dir.join("ghost_trades.json")).ok();

    // 5. Read portable ros-kv entries
    let kv_dir = app_data_dir.join("ros-kv");
    let raw_kv = if kv_dir.is_dir() {
        ros_kv::load(&kv_dir)?
    } else {
        HashMap::new()
    };
    let ros_kv: HashMap<String, String> = raw_kv
        .into_iter()
        .filter(|(k, _)| !is_device_local_kv_key(k))
        .collect();

    Ok(SovereignBundle {
        version: 1,
        created_at: now_unix(),
        source_os: current_source_os(),
        identities,
        active_identity,
        vaults,
        caches,
        xmr402_payments,
        ghost_trades,
        ros_kv,
    })
}

pub fn preview_bundle(bundle: &SovereignBundle, bundle_bytes: usize) -> MigrationPreview {
    let id_names: HashMap<&str, &str> = bundle
        .identities
        .iter()
        .map(|i| (i.id.as_str(), i.name.as_str()))
        .collect();
    let mut monero_wallets = Vec::with_capacity(bundle.vaults.len());
    for v in &bundle.vaults {
        let label = id_names
            .get(v.id.as_str())
            .copied()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(v.id.as_str());
        monero_wallets.push(label.to_string());
    }

    let has_key = |pred: &dyn Fn(&str) -> bool| bundle.ros_kv.keys().any(|k| pred(k));

    MigrationPreview {
        source_os: bundle.source_os.clone(),
        created_at: bundle.created_at,
        monero_wallets,
        monero_vault_count: bundle.vaults.len(),
        synced_cache_count: bundle.caches.len(),
        has_unified_seed: has_key(&|k| {
            k.contains(":wallet:seed:") || k == "ripleyos:wallet:seed" || k.starts_with("ripleyos:seed:")
        }),
        has_bitcoin: has_key(&|k| k.starts_with("ripleyos:btc:") || k.starts_with("ripleyos:wallet:btc")),
        has_solana: has_key(&|k| k.starts_with("ripleyos:wallet:sol") || k.starts_with("ripleyos:sol:")),
        has_evm_burners: has_key(&|k| k.starts_with("ripleyos:evm:burner")),
        has_nostr: has_key(&|k| k.starts_with("ripleyos:nostr:")),
        has_mail: has_key(&|k| k.starts_with("ripleyos:mail:")),
        has_passcode: has_key(&|k| k.starts_with("ripleyos:lock:")),
        kv_count: bundle.ros_kv.len(),
        bundle_bytes,
    }
}

fn derive_passphrase_key(passphrase: &str, salt: &[u8; SALT_LEN]) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|e| format!("Argon2 KDF failed: {e}"))?;
    Ok(key)
}

fn compress_bundle(bundle: &SovereignBundle) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(bundle).map_err(|e| format!("serialize bundle: {e}"))?;
    let compressed =
        zstd::encode_all(json.as_slice(), 3).map_err(|e| format!("compress bundle: {e}"))?;
    if compressed.len() > MAX_BUNDLE_BYTES {
        return Err(format!(
            "Migration bundle exceeds {} MiB limit",
            MAX_BUNDLE_BYTES / (1024 * 1024)
        ));
    }
    Ok(compressed)
}

fn decompress_bundle(compressed: &[u8]) -> Result<SovereignBundle, String> {
    let mut decoder =
        zstd::stream::Decoder::new(compressed).map_err(|e| format!("zstd init failed: {e}"))?;
    let mut limited = std::io::Read::take(&mut decoder, (MAX_DECOMPRESSED_BYTES + 1) as u64);
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut limited, &mut out)
        .map_err(|e| format!("decompress bundle failed: {e}"))?;
    if out.len() > MAX_DECOMPRESSED_BYTES {
        return Err("Decompressed migration bundle exceeds 64 MiB safety cap".into());
    }
    let bundle: SovereignBundle =
        serde_json::from_slice(&out).map_err(|e| format!("invalid migration bundle JSON: {e}"))?;
    if bundle.version != 1 {
        return Err(format!("Unsupported migration bundle version {}", bundle.version));
    }
    Ok(bundle)
}

pub fn encrypt_with_passphrase(bundle: &SovereignBundle, passphrase: &str) -> Result<Vec<u8>, String> {
    if passphrase.len() < 8 {
        return Err("Migration passphrase must be at least 8 characters".into());
    }
    let compressed = compress_bundle(bundle)?;
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let key = derive_passphrase_key(passphrase, &salt)?;
    let cipher = ChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|_| "cipher init failed".to_string())?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), compressed.as_slice())
        .map_err(|_| "encryption failed".to_string())?;

    let mut out = Vec::with_capacity(MAGIC.len() + 1 + SALT_LEN + NONCE_LEN + ct.len());
    out.extend_from_slice(MAGIC);
    out.push(MODE_PASSPHRASE);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt_with_passphrase(bytes: &[u8], passphrase: &str) -> Result<SovereignBundle, String> {
    if bytes.len() > MAX_BUNDLE_BYTES + 1024 {
        return Err("Migration file exceeds size limit".into());
    }
    let header_len = MAGIC.len() + 1 + SALT_LEN + NONCE_LEN;
    if bytes.len() <= header_len || &bytes[..MAGIC.len()] != MAGIC {
        return Err("Not a valid .ripley-migrate file".into());
    }
    if bytes[MAGIC.len()] != MODE_PASSPHRASE {
        return Err("File is not a passphrase-encrypted migration archive".into());
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&bytes[MAGIC.len() + 1..MAGIC.len() + 1 + SALT_LEN]);
    let nonce_start = MAGIC.len() + 1 + SALT_LEN;
    let nonce = Nonce::from_slice(&bytes[nonce_start..nonce_start + NONCE_LEN]);
    let ct = &bytes[header_len..];

    let key = derive_passphrase_key(passphrase, &salt)?;
    let cipher = ChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|_| "cipher init failed".to_string())?;
    let compressed = cipher
        .decrypt(nonce, ct)
        .map_err(|_| "Wrong passphrase or corrupted migration file".to_string())?;
    decompress_bundle(&compressed)
}

pub fn encrypt_with_raw_key(bundle: &SovereignBundle, key: &[u8; KEY_LEN]) -> Result<Vec<u8>, String> {
    let compressed = compress_bundle(bundle)?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "cipher init failed".to_string())?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), compressed.as_slice())
        .map_err(|_| "encryption failed".to_string())?;

    let mut out = Vec::with_capacity(MAGIC.len() + 1 + NONCE_LEN + ct.len());
    out.extend_from_slice(MAGIC);
    out.push(MODE_RAW_KEY);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt_with_raw_key(bytes: &[u8], key: &[u8; KEY_LEN]) -> Result<SovereignBundle, String> {
    if bytes.len() > MAX_BUNDLE_BYTES + 1024 {
        return Err("LAN migration payload exceeds size limit".into());
    }
    let header_len = MAGIC.len() + 1 + NONCE_LEN;
    if bytes.len() <= header_len || &bytes[..MAGIC.len()] != MAGIC {
        return Err("Invalid LAN migration payload".into());
    }
    if bytes[MAGIC.len()] != MODE_RAW_KEY {
        return Err("Unexpected migration cipher mode".into());
    }
    let nonce = Nonce::from_slice(&bytes[MAGIC.len() + 1..header_len]);
    let ct = &bytes[header_len..];

    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "cipher init failed".to_string())?;
    let compressed = cipher
        .decrypt(nonce, ct)
        .map_err(|_| "Decryption failed — QR code mismatch or corrupted transfer".to_string())?;
    decompress_bundle(&compressed)
}

fn atomic_write_file(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let tmp = path.with_extension(format!(
        "mig-{}.tmp",
        std::process::id()
    ));
    fs::write(&tmp, data).map_err(|e| format!("write tmp: {e}"))?;
    if let Ok(f) = fs::File::open(&tmp) {
        let _ = f.sync_all();
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename file: {e}"));
    }
    Ok(())
}

/// Apply a decrypted `SovereignBundle` to `app_data_dir`.
/// Writes all `.vault` files, merges `identities.json` (imported wins on ID collision),
/// updates `active_identity`, and writes all portable `ros-kv` entries.
pub fn apply_bundle(app_data_dir: &Path, bundle: &SovereignBundle) -> Result<MigrationPreview, String> {
    fs::create_dir_all(app_data_dir).map_err(|e| format!("mkdir app_data_dir: {e}"))?;

    // 1. Validate every vault ID and base64 payload BEFORE writing anything to disk.
    let mut decoded_vaults: Vec<(String, Vec<u8>)> = Vec::with_capacity(bundle.vaults.len());
    for v in &bundle.vaults {
        if !valid_identity_id(&v.id) {
            return Err(format!("Refused unsafe wallet identity id: {}", v.id));
        }
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&v.data_b64)
            .map_err(|e| format!("invalid vault payload for {}: {e}", v.id))?;
        if raw.len() < 40 {
            return Err(format!("vault payload for {} is truncated", v.id));
        }
        decoded_vaults.push((v.id.clone(), raw));
    }

    // 2. Write each .vault file atomically, and re-seal each synced .cache under the target device's own cache key!
    let wallets_dir = app_data_dir.join("wallets");
    fs::create_dir_all(&wallets_dir).map_err(|e| format!("mkdir wallets: {e}"))?;
    for (id, raw) in &decoded_vaults {
        let path = wallets_dir.join(format!("{id}.vault"));
        atomic_write_file(&path, raw)?;
    }
    if !bundle.caches.is_empty() {
        let dst_cache_key = load_or_create_cache_key(app_data_dir);
        for c in &bundle.caches {
            if !valid_identity_id(&c.id) {
                continue;
            }
            if serde_json::from_str::<serde_json::Value>(&c.json)
                .map(|v| v.is_object())
                .unwrap_or(false)
            {
                let sealed = seal_cache_bytes(c.json.as_bytes(), dst_cache_key.as_deref());
                let path = wallets_dir.join(format!("{}.cache", c.id));
                atomic_write_file(&path, &sealed)?;
            }
        }
    }

    // 2b. Optional XMR402 receipts & ghost trade tags (validate JSON before writing)
    if let Some(ref raw) = bundle.xmr402_payments {
        if serde_json::from_str::<serde_json::Value>(raw)
            .map(|v| v.is_object())
            .unwrap_or(false)
        {
            let _ = atomic_write_file(&app_data_dir.join("xmr402_payments.json"), raw.as_bytes());
        }
    }
    if let Some(ref raw) = bundle.ghost_trades {
        if serde_json::from_str::<serde_json::Value>(raw)
            .map(|v| v.is_object())
            .unwrap_or(false)
        {
            let _ = atomic_write_file(&app_data_dir.join("ghost_trades.json"), raw.as_bytes());
        }
    }

    // 3. Merge identities.json (imported identities first, keeping any non-conflicting local ones).
    let identities_path = app_data_dir.join("identities.json");
    let existing: Vec<Identity> = fs::read_to_string(&identities_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut merged: Vec<Identity> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for id in &bundle.identities {
        if valid_identity_id(&id.id) && seen.insert(id.id.clone()) {
            merged.push(id.clone());
        }
    }
    // Ensure every imported vault has an identity entry even if identities.json was missing one.
    for (vid, _) in &decoded_vaults {
        if seen.insert(vid.clone()) {
            merged.push(Identity {
                id: vid.clone(),
                name: vid.clone(),
                created: bundle.created_at,
            });
        }
    }
    for id in existing {
        if valid_identity_id(&id.id) && seen.insert(id.id.clone()) {
            merged.push(id);
        }
    }
    let ids_json =
        serde_json::to_string_pretty(&merged).map_err(|e| format!("serialize identities: {e}"))?;
    atomic_write_file(&identities_path, ids_json.as_bytes())?;

    // 4. Active identity
    if let Some(ref active) = bundle.active_identity {
        if valid_identity_id(active) {
            let _ = atomic_write_file(&app_data_dir.join("active_identity"), active.as_bytes());
        }
    } else if let Some(first) = merged.first() {
        let _ = atomic_write_file(&app_data_dir.join("active_identity"), first.id.as_bytes());
    }

    // 5. Write portable ros-kv entries. If the bundle brings a lock passcode, drop stale
    //    device-local biometric wrapper keys so the target cleanly unlocks with the imported passcode.
    let kv_dir = app_data_dir.join("ros-kv");
    fs::create_dir_all(&kv_dir).map_err(|e| format!("mkdir ros-kv: {e}"))?;
    let brings_passcode = bundle
        .ros_kv
        .keys()
        .any(|k| k.starts_with("ripleyos:lock:") && !k.starts_with("ripleyos:lock:bio:"));
    if brings_passcode {
        if let Ok(existing_kv) = ros_kv::load(&kv_dir) {
            for k in existing_kv.keys() {
                if k.starts_with("ripleyos:lock:bio:") || k.starts_with("ripleyos:passkey:") {
                    let _ = ros_kv::remove_key(&kv_dir, k);
                }
            }
        }
    }
    for (k, v) in &bundle.ros_kv {
        if !k.starts_with("ripleyos:") || is_device_local_kv_key(k) {
            continue;
        }
        ros_kv::put(&kv_dir, k, v)?;
    }

    Ok(preview_bundle(bundle, 0))
}

// ── Direct LAN QR Transfer (local Wi-Fi / hotspot only, zero internet, bypasses Tor) ──

pub fn compute_sas(key: &[u8; KEY_LEN], token_hex: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ripley-migrate-sas-v1");
    hasher.update(key);
    hasher.update(token_hex.as_bytes());
    let digest = hasher.finalize();
    let hex_str = hex::encode_upper(&digest[..3]); // 6 uppercase hex chars
    format!("{}-{}", &hex_str[..3], &hex_str[3..6])
}

pub fn is_private_lan_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            let private = o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168);
            #[cfg(test)]
            {
                private || v4.is_loopback()
            }
            #[cfg(not(test))]
            {
                private
            }
        }
        IpAddr::V6(v6) => {
            let seg0 = v6.segments()[0];
            let ula = (seg0 & 0xfe00) == 0xfc00;
            #[cfg(test)]
            {
                ula || v6.is_loopback()
            }
            #[cfg(not(test))]
            {
                ula
            }
        }
    }
}

/// Detect the device's primary local LAN IPv4 address without sending any network packets.
pub fn detect_lan_ip() -> Result<IpAddr, String> {
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("udp bind: {e}"))?;
    sock.connect("1.1.1.1:80")
        .or_else(|_| sock.connect("192.168.1.1:80"))
        .or_else(|_| sock.connect("10.0.0.1:80"))
        .map_err(|_| "Not connected to a local Wi-Fi or hotspot network".to_string())?;
    let local = sock.local_addr().map_err(|e| format!("local_addr: {e}"))?.ip();
    if !is_private_lan_ip(local) {
        return Err(format!(
            "Local address {local} is not a private LAN IP — connect both devices to the same Wi-Fi or hotspot"
        ));
    }
    Ok(local)
}

pub struct ParsedLanUri {
    pub ip: IpAddr,
    pub port: u16,
    pub token_hex: String,
    pub key: Zeroizing<[u8; KEY_LEN]>,
}

pub fn parse_lan_uri(raw: &str) -> Result<ParsedLanUri, String> {
    let trimmed = raw.trim();
    let rest = trimmed
        .strip_prefix("ripley-migrate://v1/")
        .ok_or_else(|| "Not a Ripley LAN migration QR code".to_string())?;
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() != 3 {
        return Err("Malformed Ripley LAN migration QR code".into());
    }
    let addr_str = parts[0];
    let token_hex = parts[1].to_string();
    let key_b64 = parts[2];

    let sock: SocketAddr = addr_str
        .parse()
        .map_err(|_| "Invalid LAN address in migration QR".to_string())?;
    if !is_private_lan_ip(sock.ip()) {
        return Err("Refused non-LAN address in migration QR (only local Wi-Fi IPs allowed)".into());
    }
    if sock.port() == 0 {
        return Err("Invalid port in migration QR".into());
    }
    if token_hex.len() != 32 || !token_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid session token in migration QR".into());
    }
    let key_vec = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(key_b64)
        .map_err(|_| "Invalid encryption key in migration QR".to_string())?;
    if key_vec.len() != KEY_LEN {
        return Err("Invalid encryption key length in migration QR".into());
    }
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    key.copy_from_slice(&key_vec);

    Ok(ParsedLanUri {
        ip: sock.ip(),
        port: sock.port(),
        token_hex,
        key,
    })
}

pub struct ActiveLanServer {
    pub info: LanSessionInfo,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl ActiveLanServer {
    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Start a local-only HTTP server serving an encrypted `SovereignBundle` with an ephemeral key.
pub async fn start_lan_server(
    app_data_dir: &Path,
    override_ip: Option<IpAddr>,
) -> Result<ActiveLanServer, String> {
    let ip = match override_ip {
        Some(v) if is_private_lan_ip(v) => v,
        Some(v) => return Err(format!("Refused non-private IP {v}")),
        None => detect_lan_ip()?,
    };

    let bundle = pack_bundle(app_data_dir)?;
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    let mut token_bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(key.as_mut());
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token_hex = hex::encode(token_bytes);
    let key_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.as_ref());
    let sas = compute_sas(&key, &token_hex);

    let payload = Arc::new(encrypt_with_raw_key(&bundle, &key)?);
    let preview = preview_bundle(&bundle, payload.len());

    let bind_addr = if ip.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" };
    let listener = TcpListener::bind(bind_addr)
        .await
        .map_err(|e| format!("bind LAN listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("listener local_addr: {e}"))?
        .port();

    let host_fmt = match ip {
        IpAddr::V4(v4) => format!("{v4}:{port}"),
        IpAddr::V6(v6) => format!("[{v6}]:{port}"),
    };
    let uri = format!("ripley-migrate://v1/{host_fmt}/{token_hex}/{key_b64}");

    let (tx, mut rx) = oneshot::channel::<()>();
    let expected_query = Arc::new(format!("t={token_hex}"));
    let serves = Arc::new(Mutex::new(0usize));

    tokio::spawn(async move {
        let deadline = tokio::time::sleep(Duration::from_secs(LAN_TTL_SECS));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut rx => break,
                _ = &mut deadline => break,
                accepted = listener.accept() => {
                    let Ok((stream, _peer)) = accepted else { continue };
                    let io = TokioIo::new(stream);
                    let payload_c = Arc::clone(&payload);
                    let query_c = Arc::clone(&expected_query);
                    let serves_c = Arc::clone(&serves);
                    tokio::spawn(async move {
                        let svc = service_fn(move |req: Request<hyper::body::Incoming>| {
                            let payload_r = Arc::clone(&payload_c);
                            let query_r = Arc::clone(&query_c);
                            let serves_r = Arc::clone(&serves_c);
                            async move {
                                if req.method() == Method::GET && req.uri().path() == "/bundle" {
                                    let q = req.uri().query().unwrap_or("");
                                    if constant_time_eq(q.as_bytes(), query_r.as_bytes()) {
                                        let mut count = serves_r.lock().unwrap_or_else(|e| e.into_inner());
                                        if *count < MAX_LAN_SERVES {
                                            *count += 1;
                                            let body = Bytes::copy_from_slice(&payload_r);
                                            return Ok::<_, hyper::Error>(
                                                Response::builder()
                                                    .status(StatusCode::OK)
                                                    .header("Content-Type", "application/octet-stream")
                                                    .header("Cache-Control", "no-store")
                                                    .body(Full::new(body))
                                                    .unwrap(),
                                            );
                                        }
                                    }
                                }
                                Ok::<_, hyper::Error>(
                                    Response::builder()
                                        .status(StatusCode::NOT_FOUND)
                                        .body(Full::new(Bytes::new()))
                                        .unwrap(),
                                )
                            }
                        });
                        let _ = http1::Builder::new().serve_connection(io, svc).await;
                    });
                }
            }
        }
    });

    Ok(ActiveLanServer {
        info: LanSessionInfo {
            uri,
            sas,
            ip: ip.to_string(),
            port,
            expires_in_secs: LAN_TTL_SECS,
            preview,
        },
        shutdown_tx: Some(tx),
    })
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Fetch and decrypt a LAN migration bundle directly over local Wi-Fi (bypasses Tor/proxies).
pub async fn fetch_lan_bundle(uri: &str) -> Result<(SovereignBundle, String, usize), String> {
    let parsed = parse_lan_uri(uri)?;
    let host_fmt = match parsed.ip {
        IpAddr::V4(v4) => format!("{v4}:{}", parsed.port),
        IpAddr::V6(v6) => format!("[{v6}]:{}", parsed.port),
    };
    let url = format!("http://{host_fmt}/bundle?t={}", parsed.token_hex);

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("LAN HTTP client init: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Could not reach sender on LAN ({host_fmt}) — make sure both devices are on the same Wi-Fi/hotspot: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Sender rejected transfer (HTTP {}) — QR may have expired", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed reading LAN bundle: {e}"))?;
    let len = bytes.len();
    let bundle = decrypt_with_raw_key(&bytes, &parsed.key)?;
    let sas = compute_sas(&parsed.key, &parsed.token_hex);
    Ok((bundle, sas, len))
}

// ── Shared In-Memory State for Tauri Host Commands ──

pub struct StagedTransfer {
    pub transfer_id: String,
    pub bundle: SovereignBundle,
    pub bundle_bytes: usize,
}

static ACTIVE_SENDER: Mutex<Option<ActiveLanServer>> = Mutex::new(None);
static STAGED_TRANSFER: Mutex<Option<StagedTransfer>> = Mutex::new(None);

pub async fn start_managed_lan_sender(app_data_dir: &Path) -> Result<LanSessionInfo, String> {
    stop_managed_lan_sender();
    let srv = start_lan_server(app_data_dir, None).await?;
    let info = srv.info.clone();
    let mut slot = ACTIVE_SENDER.lock().unwrap_or_else(|e| e.into_inner());
    *slot = Some(srv);
    Ok(info)
}

pub fn stop_managed_lan_sender() {
    let mut slot = ACTIVE_SENDER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut srv) = slot.take() {
        srv.stop();
    }
}

pub async fn fetch_and_stage_lan(uri: &str) -> Result<LanFetchedTransfer, String> {
    let (bundle, sas, len) = fetch_lan_bundle(uri).await?;
    let preview = preview_bundle(&bundle, len);
    let mut tid = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut tid);
    let transfer_id = hex::encode(tid);
    let mut slot = STAGED_TRANSFER.lock().unwrap_or_else(|e| e.into_inner());
    *slot = Some(StagedTransfer {
        transfer_id: transfer_id.clone(),
        bundle,
        bundle_bytes: len,
    });
    Ok(LanFetchedTransfer {
        transfer_id,
        sas,
        preview,
    })
}

pub fn apply_staged_lan(app_data_dir: &Path, transfer_id: &str) -> Result<MigrationPreview, String> {
    let staged = {
        let mut slot = STAGED_TRANSFER.lock().unwrap_or_else(|e| e.into_inner());
        match slot.take() {
            Some(s) if s.transfer_id == transfer_id => s,
            Some(other) => {
                *slot = Some(other);
                return Err("Staged transfer ID mismatch — scan the QR code again".into());
            }
            None => return Err("No staged LAN transfer found — scan the QR code again".into()),
        }
    };
    let mut preview = apply_bundle(app_data_dir, &staged.bundle)?;
    preview.bundle_bytes = staged.bundle_bytes;
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut r = [0u8; 6];
        rand::thread_rng().fill_bytes(&mut r);
        let p = std::env::temp_dir().join(format!("ripley-mig-test-{tag}-{}", hex::encode(r)));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn seed_mac_fixture(dir: &Path) {
        fs::create_dir_all(dir.join("wallets")).unwrap();
        let ids: Vec<Identity> = (1..=5)
            .map(|i| Identity {
                id: format!("xmr_{i}"),
                name: format!("Monero Vault #{i}"),
                created: 1700000000 + i,
            })
            .collect();
        fs::write(
            dir.join("identities.json"),
            serde_json::to_string_pretty(&ids).unwrap(),
        )
        .unwrap();
        fs::write(dir.join("active_identity"), "xmr_1").unwrap();
        for i in 1..=5 {
            let fake_vault = vec![0xA0 + i as u8; 128];
            fs::write(dir.join("wallets").join(format!("xmr_{i}.vault")), fake_vault).unwrap();
        }
        // Seal synced OutputCache files under source device's own device.key (RIPC1)
        let src_key = load_or_create_cache_key(dir).unwrap();
        for i in 1..=5 {
            let cache_json = format!(
                r#"{{"scan_height":{},"outputs":[],"spent":[],"frozen":[],"sent":[{{"tx_hash":"tx{i}","amount":1000,"fee":10,"destinations":[],"height":3700000,"timestamp":1700000000,"tx_key":"secret_proof_{i}","account":0}}]}}"#,
                3700000 + i
            );
            let sealed = seal_cache_bytes(cache_json.as_bytes(), Some(&src_key));
            fs::write(dir.join("wallets").join(format!("xmr_{i}.cache")), sealed).unwrap();
        }
        let kv_dir = dir.join("ros-kv");
        ros_kv::put(&kv_dir, "ripleyos:wallet:seed:enc:v1", "{\"ct\":\"seed\"}").unwrap();
        ros_kv::put(&kv_dir, "ripleyos:wallet:sol:keys:v1", "{\"ct\":\"sol\"}").unwrap();
        ros_kv::put(&kv_dir, "ripleyos:btc:keys:enc:v1", "{\"ct\":\"btc\"}").unwrap();
        ros_kv::put(&kv_dir, "ripleyos:evm:burners:enc:v2", "{\"ct\":\"3burners\"}").unwrap();
        ros_kv::put(&kv_dir, "ripleyos:lock:v1", "{\"salt\":\"abc\"}").unwrap();
        // Device-local keys that MUST be excluded
        ros_kv::put(&kv_dir, "ripleyos:lock:bio:v1", "{\"bio\":\"mac-touchid\"}").unwrap();
        ros_kv::put(&kv_dir, "ripleyos:keys:custody:v1", "device-only").unwrap();
        ros_kv::put(&kv_dir, "ripleyos:passkey:cred", "mac-passkey").unwrap();
    }

    #[test]
    fn offline_bundle_roundtrip_5_monero_plus_multichain_and_filtering() {
        let src = temp_dir("src");
        let dst = temp_dir("dst");
        seed_mac_fixture(&src);
        // Pre-populate stale bio key on target to verify it gets cleaned up on passcode import
        ros_kv::put(&dst.join("ros-kv"), "ripleyos:lock:bio:v1", "old-pixel-bio").unwrap();

        let bundle = pack_bundle(&src).unwrap();
        assert_eq!(bundle.vaults.len(), 5);
        assert_eq!(bundle.identities.len(), 5);
        assert!(!bundle.ros_kv.contains_key("ripleyos:lock:bio:v1"));
        assert!(!bundle.ros_kv.contains_key("ripleyos:keys:custody:v1"));
        assert!(!bundle.ros_kv.contains_key("ripleyos:passkey:cred"));
        assert!(bundle.ros_kv.contains_key("ripleyos:evm:burners:enc:v2"));

        let enc = encrypt_with_passphrase(&bundle, "sovereign-passphrase-42").unwrap();
        assert!(decrypt_with_passphrase(&enc, "wrong-passphrase").is_err());

        let dec = decrypt_with_passphrase(&enc, "sovereign-passphrase-42").unwrap();
        let preview = preview_bundle(&dec, enc.len());
        assert_eq!(preview.monero_vault_count, 5);
        assert_eq!(preview.synced_cache_count, 5);
        assert_eq!(preview.monero_wallets[0], "Monero Vault #1");
        assert!(preview.has_unified_seed);
        assert!(preview.has_solana);
        assert!(preview.has_bitcoin);
        assert!(preview.has_evm_burners);
        assert!(preview.has_passcode);

        // Give target device a DIFFERENT device.key before applying!
        let dst_key = load_or_create_cache_key(&dst).unwrap();
        apply_bundle(&dst, &dec).unwrap();
        for i in 1..=5 {
            let p = dst.join("wallets").join(format!("xmr_{i}.vault"));
            assert!(p.is_file(), "missing imported vault {i}");
            assert_eq!(fs::read(&p).unwrap(), vec![0xA0 + i as u8; 128]);
            // Verify synced .cache was re-sealed under target device's OWN key with intact scan_height + tx_key!
            let cp = dst.join("wallets").join(format!("xmr_{i}.cache"));
            assert!(cp.is_file(), "missing imported cache {i}");
            let raw_cache = fs::read(&cp).unwrap();
            assert!(raw_cache.starts_with(CACHE_SEAL_MAGIC));
            let unsealed = unseal_cache_bytes(&raw_cache, Some(&dst_key)).unwrap();
            assert!(unsealed.contains(&format!("secret_proof_{i}")));
            assert!(unsealed.contains(&format!("{}", 3700000 + i)));
        }
        let dst_kv = ros_kv::load(&dst.join("ros-kv")).unwrap();
        assert_eq!(
            dst_kv.get("ripleyos:evm:burners:enc:v2").map(String::as_str),
            Some("{\"ct\":\"3burners\"}")
        );
        assert!(!dst_kv.contains_key("ripleyos:lock:bio:v1"));

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    #[tokio::test]
    async fn lan_transfer_roundtrip_and_sas_match() {
        let src = temp_dir("lan-src");
        let dst = temp_dir("lan-dst");
        seed_mac_fixture(&src);

        let mut srv = start_lan_server(&src, Some(IpAddr::V4(Ipv4Addr::LOCALHOST)))
            .await
            .unwrap();
        let uri = srv.info.uri.clone();
        let sender_sas = srv.info.sas.clone();

        let fetched = fetch_and_stage_lan(&uri).await.unwrap();
        assert_eq!(fetched.sas, sender_sas);
        assert_eq!(fetched.preview.monero_vault_count, 5);
        assert!(fetched.preview.has_evm_burners);

        let applied = apply_staged_lan(&dst, &fetched.transfer_id).unwrap();
        assert_eq!(applied.monero_vault_count, 5);
        assert!(dst.join("wallets/xmr_5.vault").is_file());

        srv.stop();
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }
}
