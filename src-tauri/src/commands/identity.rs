use crate::wallet::Identity;

#[tauri::command]
pub async fn get_identities() -> Result<Vec<Identity>, String> {
    // TODO: Read identities from app data dir
    Ok(vec![])
}

#[tauri::command]
pub async fn create_identity(name: String) -> Result<Identity, String> {
    let id = format!("vault_{}_{}", chrono::Utc::now().timestamp(), &name[..3.min(name.len())]);
    // TODO: Persist identity to disk
    Ok(Identity {
        id,
        name,
        created: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64,
    })
}

#[tauri::command]
pub async fn delete_identity(id: String) -> Result<(), String> {
    // TODO: Delete wallet files for this identity
    log::info!("delete_identity: {}", id);
    Ok(())
}

#[tauri::command]
pub async fn switch_identity(id: String) -> Result<(), String> {
    // TODO: Close current wallet, open new identity's wallet
    log::info!("switch_identity: {}", id);
    Ok(())
}

#[tauri::command]
pub async fn rename_identity(id: String, name: String) -> Result<(), String> {
    // TODO: Update identity name in persisted list
    log::info!("rename_identity: {} -> {}", id, name);
    Ok(())
}
