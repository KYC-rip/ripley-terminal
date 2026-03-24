use tauri::State;
use crate::tor::TorState;

#[tauri::command]
pub async fn get_tor_status(state: State<'_, TorState>) -> Result<serde_json::Value, String> {
    let status = state.get_status().await;
    Ok(serde_json::to_value(status).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn restart_tor(state: State<'_, TorState>) -> Result<String, String> {
    state.disconnect().await;
    state.connect().await
}
