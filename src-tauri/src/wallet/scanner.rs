//! Background blockchain scanner.
//!
//! Connects to a Monero daemon, fetches blocks in batches, and scans each block
//! for outputs belonging to the wallet's ViewPair using monero-wallet's Scanner.

use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::sleep;

use monero_daemon_rpc::prelude::*;
use monero_simple_request_rpc::SimpleRequestTransport;

use crate::emit_log;
use super::state::WalletState;
use super::types::SyncStatus;

/// Node list for rotation on failure.
const NODES: &[(&str, &str)] = &[
    ("plowsof", "http://node.monerodevs.org:18089"),
    ("ravfx", "http://ravfx.its-a-node.org:18081"),
    ("rucknium", "http://rucknium.me:18081"),
    ("selsta", "http://selsta1.featherwallet.net:18081"),
    ("xmr.rocks", "http://node.xmr.rocks:18089"),
    ("baz", "http://node3-us.monero.love:18081"),
];

/// Background blockchain scanner.
pub struct BlockScanner;

impl BlockScanner {
    /// Try connecting to nodes in rotation until one works, then start scanning.
    pub async fn start(
        app: AppHandle,
        _daemon_url: &str,
        _node_label: &str,
        from_height: u64,
    ) -> Result<(), String> {
        let app_clone = app.clone();
        tokio::spawn(async move {
            let mut node_idx = rand::random::<usize>() % NODES.len();

            loop {
                let (label, url) = NODES[node_idx % NODES.len()];
                emit_log(&app_clone, "Network", "info", &format!("🔗 Connecting to {}...", label));

                match SimpleRequestTransport::new(url.to_string()).await {
                    Ok(daemon) => {
                        emit_log(&app_clone, "Network", "success", &format!("✅ Connected to {} ({})", label, url));

                        match scan_loop(app_clone.clone(), daemon, from_height, url.to_string(), label.to_string()).await {
                            Ok(()) => break, // Clean exit
                            Err(e) => {
                                emit_log(&app_clone, "Sync", "error", &format!("⚠️ Node {} failed: {}", label, e));
                                // Rotate to next node
                                node_idx += 1;
                                emit_log(&app_clone, "Network", "info", "🔄 Rotating to next node...");
                                sleep(Duration::from_secs(2)).await;
                            }
                        }
                    }
                    Err(e) => {
                        emit_log(&app_clone, "Network", "error", &format!("❌ {} failed: {:?}", label, e));
                        node_idx += 1;
                        sleep(Duration::from_secs(2)).await;
                    }
                }
            }
        });

        Ok(())
    }
}

async fn scan_loop(
    app: AppHandle,
    daemon: monero_daemon_rpc::MoneroDaemon<monero_simple_request_rpc::SimpleRequestTransport>,
    mut scan_height: u64,
    node_url: String,
    node_label: String,
) -> Result<(), String> {
    let batch_size: u64 = 50;

    emit_log(&app, "Sync", "info", &format!("🔍 Scan loop started from height {}", scan_height));

    loop {
        // Get daemon height
        let daemon_height = match daemon.latest_block_number().await {
            Ok(h) => h as u64,
            Err(e) => {
                emit_log(&app, "Sync", "error", &format!("⚠️ Failed to get daemon height: {:?}", e));
                sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        if scan_height == 0 || scan_height > daemon_height {
            // Invalid scan height — start from near current
            emit_log(&app, "Sync", "info", &format!("📦 Daemon at height {}, adjusting scan start", daemon_height));
            scan_height = daemon_height.saturating_sub(10);
        }

        if scan_height >= daemon_height {
            let _ = app.emit("sync-update", SyncStatus {
                status: "SYNCED".to_string(),
                height: scan_height,
                daemon_height,
                sync_percent: 100.0, node_label: node_label.clone(), node_url: node_url.clone(),
            });
            sleep(Duration::from_secs(10)).await;
            continue;
        }

        // Fetch blocks in batches
        let batch_end = (scan_height + batch_size).min(daemon_height);
        let range = (scan_height as usize)..=(batch_end as usize);

        emit_log(&app, "Sync", "info", &format!("📥 Fetching blocks {}-{} / {}", scan_height, batch_end, daemon_height));

        match ProvidesScannableBlocks::contiguous_scannable_blocks(&daemon, range).await {
            Ok(blocks) => {
                emit_log(&app, "Sync", "info", &format!("✅ Got {} blocks", blocks.len()));
                // Scan each block with the wallet's Scanner
                let wallet_state = app.state::<WalletState>();
                if let Some(mut scanner) = wallet_state.get_scanner().await {
                    let mut new_output_count = 0u64;
                    let mut new_amount = 0u64;

                    for block in &blocks {
                        match scanner.scan(block.clone()) {
                            Ok(timelocked) => {
                                let outputs = timelocked.ignore_additional_timelock();
                                if !outputs.is_empty() {
                                    for output in &outputs {
                                        new_amount += output.commitment().amount;
                                    }
                                    new_output_count += outputs.len() as u64;
                                    wallet_state.add_outputs(outputs).await;
                                }
                            }
                            Err(e) => {
                                log::warn!("Scan error at height ~{}: {:?}", scan_height, e);
                            }
                        }
                    }

                    if new_output_count > 0 {
                        log::info!(
                            "Found {} new outputs ({} piconero) in blocks {}-{}",
                            new_output_count, new_amount, scan_height, batch_end
                        );
                        // Emit balance update
                        let total = wallet_state.compute_balance().await;
                        let _ = app.emit("balance-changed", serde_json::json!({
                            "balance": total,
                            "unlocked": total,
                        }));
                    }
                }

                scan_height = batch_end + 1;

                // Update scan height in state
                let wallet_state = app.state::<WalletState>();
                wallet_state.update_sync_status(scan_height, daemon_height).await;

                // Persist output cache every 500 blocks
                if scan_height % 500 < batch_size {
                    wallet_state.save_output_cache().await;
                }
            }
            Err(e) => {
                emit_log(&app, "Sync", "error", &format!("⚠️ Block fetch failed ({}-{}): {:?}", scan_height, batch_end, e));
                sleep(Duration::from_secs(5)).await;
                continue;
            }
        }

        // Emit sync progress
        let percent = if daemon_height > 0 {
            (scan_height as f64 / daemon_height as f64) * 100.0
        } else {
            0.0
        };
        let _ = app.emit("sync-update", SyncStatus {
            status: "SYNCING".to_string(),
            height: scan_height,
            daemon_height,
            sync_percent: percent, node_label: node_label.clone(), node_url: node_url.clone(),
        });
    }
}
