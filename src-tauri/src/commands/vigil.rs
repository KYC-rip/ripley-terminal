//! Vigil (limit-order) persistence — the Tauri side of the Electron
//! VigilHandler. Stores the strike-wallet key as an OPAQUE encrypted blob
//! (AES-GCM ciphertext produced in the renderer; the backend never decrypts)
//! plus armed-session snapshots that carry NO key material. Retired keys are
//! archived, never deleted, so a mistaken rotation can never strand funds.
//!
//! Mirrors VigilHandler.ts validation: identity id charset, blob shape/size,
//! session version/mode/phase, and a defense-in-depth key-material scan.

use std::path::PathBuf;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const MAX_SESSION_BYTES: usize = 16 * 1024;
const VIGIL_SESSION_VERSION: u64 = 1;

fn vigil_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("vigil.json")
}

fn load(app: &AppHandle) -> Value {
    match std::fs::read_to_string(vigil_path(app)) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_else(|_| default_store()),
        Err(_) => default_store(),
    }
}

fn default_store() -> Value {
    json!({ "strike_keys": {}, "strike_keys_retired": {}, "sessions": {} })
}

fn persist(app: &AppHandle, store: &Value) -> Result<(), String> {
    let path = vigil_path(app);
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|e| format!("Failed to create data dir: {}", e))?;
    std::fs::write(&path, serde_json::to_string_pretty(store).unwrap())
        .map_err(|e| format!("Failed to write vigil store: {}", e))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_b64(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=')
}

/// Strike-key blob shape: { v: 1, salt, iv, ct } (all base64).
fn valid_key_blob(blob: &Value) -> bool {
    blob.get("v").and_then(|v| v.as_u64()) == Some(1)
        && blob.get("salt").and_then(|v| v.as_str()).map(|s| is_b64(s, 64)).unwrap_or(false)
        && blob.get("iv").and_then(|v| v.as_str()).map(|s| is_b64(s, 64)).unwrap_or(false)
        && blob.get("ct").and_then(|v| v.as_str()).map(|s| is_b64(s, 4096)).unwrap_or(false)
}

fn valid_session(session: &Value) -> Result<(), String> {
    if !session.is_object() {
        return Err("Session must be an object".into());
    }
    if session.get("version").and_then(|v| v.as_u64()) != Some(VIGIL_SESSION_VERSION) {
        return Err("Unsupported session version".into());
    }
    let mode = session.get("mode").and_then(|v| v.as_str()).unwrap_or("");
    if mode != "SNIPE" && mode != "EJECT" {
        return Err("Invalid mode".into());
    }
    let phase = session.get("phase").and_then(|v| v.as_str()).unwrap_or("");
    if !["ARMED", "EXECUTING", "POLLING"].contains(&phase) {
        return Err("Invalid phase".into());
    }
    let serialized = session.to_string();
    if serialized.len() > MAX_SESSION_BYTES {
        return Err("Session too large".into());
    }
    // Defense in depth: sessions must never carry key material
    let lower = serialized.to_lowercase();
    if lower.contains("privatekey") || lower.contains("mnemonic") || lower.contains("seed") {
        return Err("Session must not contain key material".into());
    }
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── Strike key blobs (opaque ciphertext) ──

#[tauri::command]
pub async fn vigil_save_strike_key(app: AppHandle, identity_id: String, blob: Value) -> Result<(), String> {
    if !valid_id(&identity_id) { return Err("Invalid identity id".into()); }
    if !valid_key_blob(&blob) { return Err("Invalid key blob".into()); }
    let mut store = load(&app);
    store["strike_keys"][&identity_id] = blob;
    persist(&app, &store)
}

#[tauri::command]
pub async fn vigil_get_strike_key(app: AppHandle, identity_id: String) -> Result<Value, String> {
    if !valid_id(&identity_id) { return Ok(Value::Null); }
    Ok(load(&app)["strike_keys"].get(&identity_id).cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn vigil_delete_strike_key(app: AppHandle, identity_id: String) -> Result<(), String> {
    if !valid_id(&identity_id) { return Err("Invalid identity id".into()); }
    let mut store = load(&app);
    if let Some(obj) = store["strike_keys"].as_object_mut() { obj.remove(&identity_id); }
    persist(&app, &store)
}

/// Move the current blob to a timestamped retired archive (never deleted) so
/// a mistaken rotation can never permanently strand funds.
#[tauri::command]
pub async fn vigil_archive_strike_key(app: AppHandle, identity_id: String) -> Result<(), String> {
    if !valid_id(&identity_id) { return Err("Invalid identity id".into()); }
    let mut store = load(&app);
    if let Some(blob) = store["strike_keys"].get(&identity_id).cloned() {
        if !store["strike_keys_retired"].get(&identity_id).map(|v| v.is_array()).unwrap_or(false) {
            store["strike_keys_retired"][&identity_id] = json!([]);
        }
        let mut retired_blob = blob;
        if let Some(obj) = retired_blob.as_object_mut() {
            obj.insert("retiredAt".into(), json!(now_ms()));
        }
        store["strike_keys_retired"][&identity_id].as_array_mut().unwrap().push(retired_blob);
        if let Some(obj) = store["strike_keys"].as_object_mut() { obj.remove(&identity_id); }
    }
    persist(&app, &store)
}

// ── Session snapshots (no key material) ──

#[tauri::command]
pub async fn vigil_save_session(app: AppHandle, identity_id: String, session: Value) -> Result<(), String> {
    if !valid_id(&identity_id) { return Err("Invalid identity id".into()); }
    valid_session(&session)?;
    let mut store = load(&app);
    store["sessions"][&identity_id] = session;
    persist(&app, &store)
}

#[tauri::command]
pub async fn vigil_get_session(app: AppHandle, identity_id: String) -> Result<Value, String> {
    if !valid_id(&identity_id) { return Ok(Value::Null); }
    Ok(load(&app)["sessions"].get(&identity_id).cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn vigil_clear_session(app: AppHandle, identity_id: String) -> Result<(), String> {
    if !valid_id(&identity_id) { return Err("Invalid identity id".into()); }
    let mut store = load(&app);
    if let Some(obj) = store["sessions"].as_object_mut() { obj.remove(&identity_id); }
    persist(&app, &store)
}
