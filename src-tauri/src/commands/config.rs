
#[tauri::command]
pub async fn get_config() -> Result<serde_json::Value, String> {
    // TODO: Read config from app data dir
    // Use directories crate: dirs::config_dir() / "ripley-terminal" / "config.json"
    Ok(serde_json::json!({
        "routingMode": "clearnet",
        "network": "mainnet",
        "customNodeAddress": "",
        "autoLockMinutes": 10
    }))
}

#[tauri::command]
pub async fn save_config(_config: serde_json::Value) -> Result<(), String> {
    // TODO: Write config to app data dir
    log::info!("save_config called");
    Ok(())
}
