use tauri::{AppHandle, Manager, State};
use crate::emit_log;
use crate::wallet::{WalletState, BlockScanner, MoneroAccount, SubaddressInfo, Transaction, WalletOutput, PreparedTx, SyncStatus, TxDestination};
use crate::wallet::transact;
use monero_simple_request_rpc::SimpleRequestTransport;
use monero_daemon_rpc::prelude::*;
use monero_address::MoneroAddress;

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
    app: AppHandle,
    state: State<'_, WalletState>,
    name: String,
    password: String,
) -> Result<serde_json::Value, String> {
    emit_log(&app, "Wallet", "info", &format!("🔓 Unlocking vault: {}...", name));
    state.unlock(&name, &password).await?;
    emit_log(&app, "Wallet", "success", "✅ Vault unlocked. Deriving keys...");

    let scan_height = state.get_scan_height().await;
    if scan_height == u64::MAX {
        emit_log(&app, "Sync", "info", "📦 New wallet — starting scanner near daemon tip...");
    } else {
        emit_log(&app, "Sync", "info", &format!("📦 Resuming scan from height {}...", scan_height));
    }

    let app_clone = app.clone();
    BlockScanner::start(app_clone, "", "", scan_height).await?;

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
    state: State<'_, WalletState>,
    _account_index: u32,
) -> Result<serde_json::Value, String> {
    let total = state.compute_balance().await;
    let formatted = WalletState::format_xmr(total);
    Ok(serde_json::json!({
        "total": formatted,
        "unlocked": formatted
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
    state: State<'_, WalletState>,
    _account_index: u32,
) -> Result<Vec<SubaddressInfo>, String> {
    Ok(state.get_subaddresses().await)
}

#[tauri::command]
pub async fn create_subaddress(
    state: State<'_, WalletState>,
    label: Option<String>,
    _account_index: Option<u32>,
) -> Result<String, String> {
    let info = state.create_subaddress(label.as_deref().unwrap_or("Payment")).await?;
    Ok(info.address)
}

#[tauri::command]
pub async fn set_subaddress_label(
    state: State<'_, WalletState>,
    index: u32,
    label: String,
    _account_index: u32,
) -> Result<(), String> {
    state.set_subaddress_label(index, &label).await;
    Ok(())
}

// ── Transaction Operations ──

/// Step 1: Prepare transaction — select inputs, fetch decoys, compute fee.
/// Returns a PreparedTx with fee details for user review. No signing yet.
#[tauri::command]
pub async fn prepare_transfer(
    app: AppHandle,
    state: State<'_, WalletState>,
    destinations: Vec<TxDestination>,
    _account_index: u32,
    priority: Option<u8>,
) -> Result<PreparedTx, String> {
    emit_log(&app, "Tx", "info", "🔧 Preparing transaction...");

    // Get daemon connection
    let daemon_url = state.get_daemon_url().await
        .ok_or("No daemon connected. Wait for sync to complete.")?;

    let view_pair = state.get_view_pair().await
        .ok_or("Wallet is locked")?;

    let outputs = state.get_spendable_outputs().await;
    if outputs.is_empty() {
        return Err("No spendable outputs. Wait for sync to complete.".into());
    }

    // Parse destination addresses
    let network = state.get_network().await;
    let payments: Vec<(MoneroAddress, u64)> = destinations.iter().map(|d| {
        let addr = MoneroAddress::from_str(network, &d.address)
            .map_err(|e| format!("Invalid address {}: {:?}", d.address, e))?;
        let amount: u64 = d.amount.parse()
            .map_err(|_| format!("Invalid amount: {}", d.amount))?;
        Ok((addr, amount))
    }).collect::<Result<Vec<_>, String>>()?;

    let total_amount: u64 = payments.iter().map(|(_, a)| a).sum();
    emit_log(&app, "Tx", "info", &format!("💰 Sending {} piconero to {} destination(s)", total_amount, payments.len()));

    // Connect to daemon for decoy selection
    emit_log(&app, "Tx", "info", "🔗 Connecting to daemon for decoy selection...");
    let daemon = SimpleRequestTransport::new(daemon_url).await
        .map_err(|e| format!("Failed to connect to daemon: {:?}", e))?;

    let fee_priority = match priority.unwrap_or(0) {
        0 => FeePriority::Normal,
        1 => FeePriority::Unimportant,
        2 => FeePriority::Normal,
        3 => FeePriority::Elevated,
        4 => FeePriority::Priority,
        p => FeePriority::Custom { priority: p as u32 },
    };

    // Prepare the transaction (decoy selection + fee computation)
    emit_log(&app, "Tx", "info", "🎲 Selecting decoys and computing fee...");
    let prepared = transact::prepare_transaction(
        &daemon,
        &view_pair,
        outputs,
        payments,
        fee_priority,
    ).await?;

    let fee_formatted = WalletState::format_xmr(prepared.fee);
    let amount_formatted = WalletState::format_xmr(prepared.amount);
    emit_log(&app, "Tx", "success", &format!("✅ Transaction prepared: {} XMR + {} XMR fee", amount_formatted, fee_formatted));

    // Serialize the SignableTransaction for the relay step
    let tx_metadata = prepared.signable.serialize();

    Ok(PreparedTx {
        fee: fee_formatted,
        amount: amount_formatted,
        tx_hash: String::new(), // Hash not known until signed
        tx_metadata,
        destinations: prepared.destinations.iter().map(|(addr, amt)| TxDestination {
            address: addr.clone(),
            amount: amt.to_string(),
        }).collect(),
    })
}

/// Step 2: Sign and broadcast — called after user confirms + enters password.
#[tauri::command]
pub async fn relay_transfer(
    app: AppHandle,
    state: State<'_, WalletState>,
    tx_metadata: Vec<u8>,
) -> Result<String, String> {
    emit_log(&app, "Tx", "info", "🔐 Signing transaction...");

    let spend_key = state.get_spend_key().await
        .ok_or("Wallet is locked")?;

    let daemon_url = state.get_daemon_url().await
        .ok_or("No daemon connected")?;

    // Deserialize the prepared transaction
    let signable = monero_wallet::send::SignableTransaction::read(&mut tx_metadata.as_slice())
        .map_err(|e| format!("Invalid transaction data: {:?}", e))?;

    // Sign it
    let prepared = transact::PreparedTransaction {
        signable,
        fee: 0,
        amount: 0,
        destinations: vec![],
    };
    let signed_tx = transact::sign_transaction(prepared, &spend_key)?;

    emit_log(&app, "Tx", "info", "📡 Broadcasting to network...");

    // Connect and broadcast
    let daemon = SimpleRequestTransport::new(daemon_url).await
        .map_err(|e| format!("Failed to connect to daemon: {:?}", e))?;

    transact::broadcast_transaction(&daemon, &signed_tx).await?;

    let tx_hash = hex::encode(signed_tx.hash());
    emit_log(&app, "Tx", "success", &format!("✅ Transaction broadcast! Hash: {}", tx_hash));

    Ok(tx_hash)
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

/// Reset scan height and restart the scanner from the given height.
#[tauri::command]
pub async fn rescan(
    app: AppHandle,
    state: State<'_, WalletState>,
    height: u64,
) -> Result<(), String> {
    emit_log(&app, "Sync", "info", &format!("🔄 Rescan requested from height {}...", height));

    // Reset scan height and clear cached outputs
    state.reset_scan(height).await;

    // Restart the scanner
    let app_clone = app.clone();
    BlockScanner::start(app_clone, "", "", height).await?;

    emit_log(&app, "Sync", "success", &format!("✅ Rescan started from height {}", height));
    Ok(())
}
