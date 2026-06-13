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
    /// Output ids (txid:index) consumed as real inputs — recorded as spent once
    /// the tx is successfully broadcast.
    pub spent_ids: Vec<String>,
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

    // Record which owned outputs are being spent (every provided input is a real
    // spend; decoys are ring members, not inputs) before they're consumed.
    let spent_ids: Vec<String> = inputs.iter().map(crate::wallet::state::output_id).collect();

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
        spent_ids,
    })
}

/// Prepare a sweep: send ALL provided outputs to one address with no change
/// output (residual goes to fee via `Change::fingerprintable(None)`). The amount
/// is `total - necessary_fee`; we probe once to learn the fee for the
/// (N inputs, 1 output) structure, then rebuild at the exact amount.
pub async fn prepare_sweep(
    daemon: &(impl ProvidesDecoys + ProvidesBlockchainMeta + ProvidesFeeRates + Sync),
    view_pair: &ViewPair,
    inputs: Vec<WalletOutput>,
    destination: MoneroAddress,
    priority: FeePriority,
) -> Result<PreparedTransaction, String> {
    let mut rng = OsRng;
    if inputs.is_empty() {
        return Err("No spendable outputs to sweep".into());
    }
    let spent_ids: Vec<String> = inputs.iter().map(crate::wallet::state::output_id).collect();
    let total: u64 = inputs.iter().map(|o| o.commitment().amount).sum();

    let block_number = daemon.latest_block_number().await
        .map_err(|e| format!("Failed to get block number: {:?}", e))?;
    let ring_len = 16u8;
    let mut owds = Vec::with_capacity(inputs.len());
    for input in inputs {
        owds.push(
            OutputWithDecoys::new(&mut rng, daemon, ring_len, block_number, input)
                .await
                .map_err(|e| format!("Decoy selection failed: {:?}", e))?,
        );
    }
    let fee_rate = daemon.fee_rate(priority, 500_000).await
        .map_err(|e| format!("Failed to get fee rate: {:?}", e))?;
    let outgoing_view_key = Zeroizing::new(view_pair.spend().compress().to_bytes());

    let build = |amount: u64, owds: Vec<OutputWithDecoys>| {
        SignableTransaction::new(
            RctType::ClsagBulletproofPlus,
            outgoing_view_key.clone(),
            owds,
            vec![(destination, amount)],
            Change::fingerprintable(None), // no change output — sweep everything
            vec![],
            fee_rate,
        )
    };

    // Probe with a safe sub-total amount to read the necessary fee for this
    // (N inputs, 1 output, no change) shape, then rebuild at total - fee.
    let probe = build(total / 2, owds.clone())
        .map_err(|e| format!("Sweep probe failed: {:?}", e))?;
    let fee = probe.necessary_fee();
    if total <= fee {
        return Err(format!(
            "Balance ({}) is too small to cover the sweep fee ({})",
            format_atomic(total), format_atomic(fee)
        ));
    }
    let amount = total - fee;
    let signable = build(amount, owds)
        .map_err(|e| format!("Sweep construction failed: {:?}", e))?;

    Ok(PreparedTransaction {
        signable,
        fee,
        amount,
        destinations: vec![(destination.to_string(), amount)],
        spent_ids,
    })
}

/// Format atomic units to an XMR string (local helper to avoid a state dep).
fn format_atomic(atomic: u64) -> String {
    format!("{}.{:012}", atomic / 1_000_000_000_000, atomic % 1_000_000_000_000)
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
