//! Shared Tauri IPC commands for Sovereign Full-Device Migration (Desktop & Android).
//!
//! Zero-cloud, zero-CLI device-to-device transfer of all Monero vaults + synced `.cache`
//! files + identities + XMR402/swap metadata + portable `ros-kv` records.

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::migration::{self, LanFetchedTransfer, LanSessionInfo, MigrationPreview};
use crate::wallet::WalletState;

#[cfg(target_os = "android")]
fn check_origin(webview: &WebviewWindow) -> Result<(), String> {
    crate::require_local(webview)
}

#[cfg(not(target_os = "android"))]
fn check_origin(webview: &WebviewWindow) -> Result<(), String> {
    // Only main / ros windows may invoke migration — never child embeds (ros-embed / xapp).
    if matches!(webview.label(), "main" | "ros") {
        Ok(())
    } else {
        Err("Migration is only allowed from the primary RipleyOS window".into())
    }
}

#[tauri::command]
pub async fn migration_export_bundle(
    app: AppHandle,
    webview: WebviewWindow,
    passphrase: String,
) -> Result<Value, String> {
    check_origin(&webview)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = migration::pack_bundle(&data_dir)?;
        let encrypted = migration::encrypt_with_passphrase(&bundle, &passphrase)?;
        let preview = migration::preview_bundle(&bundle, encrypted.len());
        let b64 = base64::engine::general_purpose::STANDARD.encode(&encrypted);
        let ts = chrono::Utc::now().format("%Y%m%d-%H%M");
        Ok::<Value, String>(json!({
            "filename": format!("ripley-device-{ts}.ripley-migrate"),
            "base64": b64,
            "preview": preview,
        }))
    })
    .await
    .map_err(|_| "migration worker failed".to_string())?
}

#[tauri::command]
pub async fn migration_inspect_bundle(
    webview: WebviewWindow,
    base64_data: String,
    passphrase: String,
) -> Result<MigrationPreview, String> {
    check_origin(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(base64_data.trim())
            .map_err(|e| format!("invalid archive encoding: {e}"))?;
        let bundle = migration::decrypt_with_passphrase(&raw, &passphrase)?;
        Ok(migration::preview_bundle(&bundle, raw.len()))
    })
    .await
    .map_err(|_| "migration worker failed".to_string())?
}

#[tauri::command]
pub async fn migration_import_bundle(
    app: AppHandle,
    webview: WebviewWindow,
    base64_data: String,
    passphrase: String,
) -> Result<MigrationPreview, String> {
    check_origin(&webview)?;
    if let Some(ws) = app.try_state::<WalletState>() {
        ws.lock().await;
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(base64_data.trim())
            .map_err(|e| format!("invalid archive encoding: {e}"))?;
        let bundle = migration::decrypt_with_passphrase(&raw, &passphrase)?;
        let mut preview = migration::apply_bundle(&data_dir, &bundle)?;
        preview.bundle_bytes = raw.len();
        Ok(preview)
    })
    .await
    .map_err(|_| "migration worker failed".to_string())?
}

#[tauri::command]
pub async fn migration_lan_start(
    app: AppHandle,
    webview: WebviewWindow,
) -> Result<LanSessionInfo, String> {
    check_origin(&webview)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    migration::start_managed_lan_sender(&data_dir).await
}

#[tauri::command]
pub async fn migration_lan_stop(webview: WebviewWindow) -> Result<Value, String> {
    check_origin(&webview)?;
    migration::stop_managed_lan_sender();
    Ok(json!({ "stopped": true }))
}

#[tauri::command]
pub async fn migration_lan_fetch(
    webview: WebviewWindow,
    uri: String,
) -> Result<LanFetchedTransfer, String> {
    check_origin(&webview)?;
    migration::fetch_and_stage_lan(&uri).await
}

#[tauri::command]
pub async fn migration_lan_apply(
    app: AppHandle,
    webview: WebviewWindow,
    transfer_id: String,
) -> Result<MigrationPreview, String> {
    check_origin(&webview)?;
    if let Some(ws) = app.try_state::<WalletState>() {
        ws.lock().await;
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        migration::apply_staged_lan(&data_dir, &transfer_id)
    })
    .await
    .map_err(|_| "migration worker failed".to_string())?
}
