use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::wallet::{BlockScanner, WalletState};

fn config_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("config.json")
}

#[tauri::command]
pub async fn get_config(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = config_path(&app);
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data)
            .map_err(|e| format!("Config parse error: {}", e)),
        Err(_) => {
            // Return defaults. Keep these in sync with the renderer's
            // SettingsView controls so it never reads `undefined`.
            Ok(default_config())
        }
    }
}

/// Default config shape. Mirrors the controls SettingsView renders.
pub fn default_config() -> serde_json::Value {
    serde_json::json!({
        "routingMode": "clearnet",
        "useSystemProxy": true,
        "systemProxyAddress": "",
        "network": "mainnet",
        "customNodeAddress": "",
        "autoLockMinutes": 10,
        "show_scanlines": true,
        "hide_zero_balances": false,
        "include_prereleases": false,
        "shortcuts": {
            "LOCK": "Mod+L",
            "SEND": "Mod+S",
            "RECEIVE": "Mod+R",
            "CHURN": "Mod+Alt+C",
            "SPLIT": "Mod+Alt+S",
            "SYNC": "Mod+U",
            "SETTINGS": "Mod+,",
            "TERMINAL": "Mod+Shift+T"
        }
    })
}

#[tauri::command]
pub async fn save_config(app: AppHandle, config: serde_json::Value) -> Result<(), String> {
    let path = config_path(&app);
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|e| format!("Failed to create config dir: {}", e))?;
    let data = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&path, data)
        .map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

/// Save config for UI-only preferences (scanlines, auto-lock, theme). Does NOT
/// touch the network uplink — use this when nothing about routing changed.
#[tauri::command]
pub async fn save_config_only(app: AppHandle, config: serde_json::Value) -> Result<(), String> {
    save_config(app, config).await
}

/// Save config AND apply network-affecting changes live. If a wallet is
/// unlocked, restart the block scanner so a new routingMode / proxy / node /
/// network takes effect without re-login. BlockScanner::start bumps the scanner
/// generation, so the running scanner is cleanly superseded after its current
/// batch and the new one re-races nodes (re-reading config + re-running Tor
/// bootstrap as needed). The scanner resumes from the current scan height, so
/// no progress is lost.
#[tauri::command]
pub async fn save_config_and_reload(app: AppHandle, config: serde_json::Value) -> Result<(), String> {
    save_config(app.clone(), config).await?;

    let state = app.state::<WalletState>();
    if !state.is_locked().await {
        let height = state.get_scan_height().await;
        crate::emit_log(
            &app,
            "Network",
            "info",
            "♻️ Routing changed — restarting uplink with the new configuration...",
        );
        BlockScanner::start(app.clone(), "", "", height).await?;
    }
    Ok(())
}
