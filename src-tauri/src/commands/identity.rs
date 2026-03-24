use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use crate::wallet::Identity;

fn identities_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("identities.json")
}

fn active_identity_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("active_identity")
}

fn load_identities(app: &AppHandle) -> Vec<Identity> {
    let path = identities_path(app);
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => vec![],
    }
}

fn save_identities_to_disk(app: &AppHandle, ids: &[Identity]) -> Result<(), String> {
    let path = identities_path(app);
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|e| format!("Failed to create dir: {}", e))?;
    let data = serde_json::to_string_pretty(ids)
        .map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(&path, data)
        .map_err(|e| format!("Write error: {}", e))
}

#[tauri::command]
pub async fn get_identities(app: AppHandle) -> Result<Vec<Identity>, String> {
    Ok(load_identities(&app))
}

#[tauri::command]
pub async fn create_identity(app: AppHandle, name: String) -> Result<Identity, String> {
    let id = format!("vault_{}_{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
        &name.chars().take(3).collect::<String>());

    let identity = Identity {
        id,
        name,
        created: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
    };

    let mut ids = load_identities(&app);
    ids.push(identity.clone());
    save_identities_to_disk(&app, &ids)?;

    // Set as active if first identity
    if ids.len() == 1 {
        std::fs::write(active_identity_path(&app), &identity.id).ok();
    }

    Ok(identity)
}

#[tauri::command]
pub async fn delete_identity(app: AppHandle, id: String) -> Result<(), String> {
    let mut ids = load_identities(&app);
    ids.retain(|i| i.id != id);
    save_identities_to_disk(&app, &ids)?;

    // Delete wallet files
    let data_dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let wallet_file = data_dir.join("wallets").join(format!("{}.vault", id));
    let cache_file = data_dir.join("wallets").join(format!("{}.cache", id));
    std::fs::remove_file(wallet_file).ok();
    std::fs::remove_file(cache_file).ok();

    log::info!("Identity deleted: {}", id);
    Ok(())
}

#[tauri::command]
pub async fn switch_identity(app: AppHandle, id: String) -> Result<(), String> {
    std::fs::write(active_identity_path(&app), &id)
        .map_err(|e| format!("Failed to set active identity: {}", e))
}

#[tauri::command]
pub async fn rename_identity(app: AppHandle, id: String, name: String) -> Result<(), String> {
    let mut ids = load_identities(&app);
    if let Some(identity) = ids.iter_mut().find(|i| i.id == id) {
        identity.name = name;
    } else {
        return Err("Identity not found".into());
    }
    save_identities_to_disk(&app, &ids)
}
