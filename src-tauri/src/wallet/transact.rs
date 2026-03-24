//! Transaction construction, signing, and broadcasting.
//!
//! Uses monero-wallet's SignableTransaction for construction + signing,
//! and MoneroDaemon's publish_transaction for broadcasting.

use zeroize::Zeroizing;
use rand_core::OsRng;

use monero_wallet::{OutputWithDecoys, WalletOutput, ViewPair};
use monero_wallet::send::{Change, SignableTransaction};
use monero_oxide::ringct::RctType;
use monero_oxide::transaction::Transaction;
use monero_oxide::ed25519::Scalar;
use monero_address::MoneroAddress;
use monero_daemon_rpc::prelude::*;

/// Prepared transaction ready for signing.
pub struct PreparedTransaction {
    pub signable: SignableTransaction,
    pub fee: u64,
    pub amount: u64,
    pub destinations: Vec<(String, u64)>,
}

/// Construct a transaction (select decoys, compute fee), but don't sign yet.
/// Returns a PreparedTransaction that can be reviewed before signing.
pub async fn prepare_transaction(
    daemon: &(impl ProvidesDecoys + ProvidesBlockchainMeta + ProvidesFeeRates + Sync),
    view_pair: &ViewPair,
    inputs: Vec<WalletOutput>,
    payments: Vec<(MoneroAddress, u64)>,
    priority: FeePriority,
) -> Result<PreparedTransaction, String> {
    let mut rng = OsRng;

    // Get current block number for decoy selection
    let block_number = daemon.latest_block_number().await
        .map_err(|e| format!("Failed to get block number: {:?}", e))?;

    // Select decoys for each input
    let ring_len = 16u8; // Monero's current ring size
    let mut inputs_with_decoys = Vec::with_capacity(inputs.len());
    for input in inputs {
        let owd = OutputWithDecoys::new(
            &mut rng,
            daemon,
            ring_len,
            block_number,
            input,
        ).await.map_err(|e| format!("Decoy selection failed: {:?}", e))?;
        inputs_with_decoys.push(owd);
    }

    // Get fee rate from daemon
    // max_per_weight: safety cap to prevent absurd fees from a malicious node
    // 500_000 pico per weight unit is generous (~0.05 XMR for a typical tx)
    let fee_rate = daemon.fee_rate(priority, 500_000).await
        .map_err(|e| format!("Failed to get fee rate: {:?}", e))?;

    // Outgoing view key — used to seed deterministic RNGs for transaction construction.
    // We use a hash of the spend point as a deterministic but unique value.
    let spend_compressed = view_pair.spend().compress();
    let outgoing_view_key = Zeroizing::new(spend_compressed.to_bytes());

    // Set change to go back to our primary address
    let change = Change::new(view_pair.clone(), None);

    // Destination info for display
    let destinations: Vec<(String, u64)> = payments.iter()
        .map(|(addr, amt)| (addr.to_string(), *amt))
        .collect();

    let total_amount: u64 = payments.iter().map(|(_, a)| a).sum();

    // Construct signable transaction
    let signable = SignableTransaction::new(
        RctType::ClsagBulletproofPlus,
        outgoing_view_key,
        inputs_with_decoys,
        payments,
        change,
        vec![], // no extra data
        fee_rate,
    ).map_err(|e| format!("Transaction construction failed: {:?}", e))?;

    let fee = signable.necessary_fee();

    Ok(PreparedTransaction {
        signable,
        fee,
        amount: total_amount,
        destinations,
    })
}

/// Sign a prepared transaction with the spend key.
pub fn sign_transaction(
    prepared: PreparedTransaction,
    spend_key: &Zeroizing<Scalar>,
) -> Result<Transaction, String> {
    let mut rng = OsRng;
    prepared.signable.sign(&mut rng, spend_key)
        .map_err(|e| format!("Transaction signing failed: {:?}", e))
}

/// Broadcast a signed transaction to the daemon.
pub async fn broadcast_transaction(
    daemon: &impl PublishTransaction,
    tx: &Transaction,
) -> Result<(), String> {
    daemon.publish_transaction(tx).await
        .map_err(|e| format!("Broadcast failed: {:?}", e))
}
