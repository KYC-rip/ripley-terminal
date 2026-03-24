mod commands;
mod wallet;
mod tor;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Initialize wallet state manager
            let wallet_state = wallet::WalletState::new(app.handle().clone());
            app.manage(wallet_state);

            // Initialize Tor client
            let tor_state = tor::TorState::new();
            app.manage(tor_state);

            log::info!("Ripley Terminal v2 initialized");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Wallet lifecycle
            commands::wallet::create_wallet,
            commands::wallet::open_wallet,
            commands::wallet::close_wallet,
            commands::wallet::get_mnemonic,
            // Account operations
            commands::wallet::get_accounts,
            commands::wallet::create_account,
            commands::wallet::rename_account,
            commands::wallet::get_balance,
            commands::wallet::get_height,
            // Address operations
            commands::wallet::get_subaddresses,
            commands::wallet::create_subaddress,
            commands::wallet::set_subaddress_label,
            // Transaction operations
            commands::wallet::prepare_transfer,
            commands::wallet::relay_transfer,
            commands::wallet::get_transactions,
            commands::wallet::get_outputs,
            // Proof operations
            commands::wallet::get_tx_key,
            commands::wallet::get_tx_proof,
            commands::wallet::check_tx_key,
            commands::wallet::check_tx_proof,
            // Sync
            commands::wallet::get_sync_status,
            commands::wallet::refresh,
            // Config
            commands::config::get_config,
            commands::config::save_config,
            // Identity
            commands::identity::get_identities,
            commands::identity::create_identity,
            commands::identity::delete_identity,
            commands::identity::switch_identity,
            commands::identity::rename_identity,
            // Tor
            commands::tor::get_tor_status,
            commands::tor::restart_tor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
