use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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
            // Return defaults
            Ok(serde_json::json!({
                "routingMode": "clearnet",
                "network": "mainnet",
                "customNodeAddress": "",
                "autoLockMinutes": 10,
                "show_scanlines": true,
                "hide_zero_balances": false
            }))
        }
    }
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
