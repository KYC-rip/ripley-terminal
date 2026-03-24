use tauri::State;
use crate::wallet::{WalletState, MoneroAccount, SubaddressInfo, Transaction, WalletOutput, PreparedTx, SyncStatus, TxDestination};

// ── Wallet Lifecycle ──

#[tauri::command]
pub async fn create_wallet(
    state: State<'_, WalletState>,
    name: String,
    password: String,
    seed: Option<String>,
    restore_height: Option<u64>,
) -> Result<serde_json::Value, String> {
    let mnemonic = state.create_wallet(&name, &password, seed.as_deref(), restore_height).await?;
    Ok(serde_json::json!({ "success": true, "seed": mnemonic }))
}

#[tauri::command]
pub async fn open_wallet(
    state: State<'_, WalletState>,
    name: String,
    password: String,
) -> Result<serde_json::Value, String> {
    state.unlock(&name, &password).await?;
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn close_wallet(state: State<'_, WalletState>) -> Result<(), String> {
    state.lock().await;
    Ok(())
}

#[tauri::command]
pub async fn get_mnemonic(state: State<'_, WalletState>) -> Result<String, String> {
    state.get_mnemonic().await
}

// ── Account Operations ──

#[tauri::command]
pub async fn get_accounts(state: State<'_, WalletState>) -> Result<Vec<MoneroAccount>, String> {
    Ok(state.get_accounts().await)
}

#[tauri::command]
pub async fn create_account(
    _state: State<'_, WalletState>,
    label: String,
) -> Result<serde_json::Value, String> {
    // TODO: Derive new account keypair
    log::info!("create_account: {}", label);
    Ok(serde_json::json!({ "index": 1, "address": "" }))
}

#[tauri::command]
pub async fn rename_account(
    _state: State<'_, WalletState>,
    account_index: u32,
    new_label: String,
) -> Result<(), String> {
    // TODO: Update account label in state
    log::info!("rename_account: {} -> {}", account_index, new_label);
    Ok(())
}

#[tauri::command]
pub async fn get_balance(
    _state: State<'_, WalletState>,
    _account_index: u32,
) -> Result<serde_json::Value, String> {
    // TODO: Compute from tracked outputs
    Ok(serde_json::json!({
        "total": "0.000000000000",
        "unlocked": "0.000000000000"
    }))
}

#[tauri::command]
pub async fn get_height(state: State<'_, WalletState>) -> Result<u64, String> {
    let status = state.get_sync_status().await;
    Ok(status.height)
}

// ── Address Operations ──

#[tauri::command]
pub async fn get_subaddresses(
    _state: State<'_, WalletState>,
    _account_index: u32,
) -> Result<Vec<SubaddressInfo>, String> {
    // TODO: Derive subaddresses from account keys
    Ok(vec![])
}

#[tauri::command]
pub async fn create_subaddress(
    _state: State<'_, WalletState>,
    _label: Option<String>,
    _account_index: Option<u32>,
) -> Result<String, String> {
    // TODO: Derive next subaddress
    Err("Not yet implemented".into())
}

#[tauri::command]
pub async fn set_subaddress_label(
    _state: State<'_, WalletState>,
    _index: u32,
    _label: String,
    _account_index: u32,
) -> Result<(), String> {
    // TODO: Update label in state
    Ok(())
}

// ── Transaction Operations ──

#[tauri::command]
pub async fn prepare_transfer(
    _state: State<'_, WalletState>,
    _destinations: Vec<TxDestination>,
    _account_index: u32,
    _priority: Option<u8>,
) -> Result<PreparedTx, String> {
    // TODO: Use monero-wallet to construct transaction
    // - Select outputs from tracked UTXOs
    // - Fetch decoys from daemon
    // - Build ring signatures
    // - Return prepared (unsigned for relay) tx
    //
    // This is the core operation that replaces:
    //   RPC transfer { do_not_relay: true }
    //
    // With monero-wallet, this becomes a direct function call.
    // No HTTP. No RPC mutex. No polling. Just Rust.

    Err("Not yet implemented — awaiting monero-wallet integration".into())
}

#[tauri::command]
pub async fn relay_transfer(
    _state: State<'_, WalletState>,
    _tx_metadata: Vec<u8>,
) -> Result<String, String> {
    // TODO: Broadcast prepared tx to daemon
    // Use reqwest (with optional Tor socks proxy) to POST to daemon's /sendrawtransaction
    Err("Not yet implemented".into())
}

#[tauri::command]
pub async fn get_transactions(
    _state: State<'_, WalletState>,
    _account_index: u32,
) -> Result<Vec<Transaction>, String> {
    // TODO: Return from scanned transaction history
    Ok(vec![])
}

#[tauri::command]
pub async fn get_outputs(
    _state: State<'_, WalletState>,
    _account_index: u32,
) -> Result<Vec<WalletOutput>, String> {
    // TODO: Return tracked unspent outputs
    Ok(vec![])
}

// ── Proof Operations ──

#[tauri::command]
pub async fn get_tx_key(
    _state: State<'_, WalletState>,
    _txid: String,
) -> Result<String, String> {
    // TODO: Return tx key from wallet state
    Err("Not yet implemented".into())
}

#[tauri::command]
pub async fn get_tx_proof(
    _state: State<'_, WalletState>,
    _txid: String,
    _address: String,
    _message: Option<String>,
) -> Result<String, String> {
    // TODO: Generate tx proof using monero-wallet
    Err("Not yet implemented".into())
}

#[tauri::command]
pub async fn check_tx_key(
    _state: State<'_, WalletState>,
    _txid: String,
    _tx_key: String,
    _address: String,
) -> Result<serde_json::Value, String> {
    // TODO: Verify tx key
    Err("Not yet implemented".into())
}

#[tauri::command]
pub async fn check_tx_proof(
    _state: State<'_, WalletState>,
    _txid: String,
    _address: String,
    _message: String,
    _signature: String,
) -> Result<serde_json::Value, String> {
    // TODO: Verify tx proof
    Err("Not yet implemented".into())
}

// ── Sync ──

#[tauri::command]
pub async fn get_sync_status(state: State<'_, WalletState>) -> Result<SyncStatus, String> {
    Ok(state.get_sync_status().await)
}

#[tauri::command]
pub async fn refresh(_state: State<'_, WalletState>) -> Result<(), String> {
    // TODO: Trigger immediate scan cycle
    Ok(())
}
