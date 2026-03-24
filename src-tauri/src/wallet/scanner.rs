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

const GITHUB_NODES_URL: &str = "https://raw.githubusercontent.com/KYC-rip/ripley-terminal/main/resources/nodes.json";

/// Parse clearnet nodes from a nodes.json value.
fn parse_clearnet_nodes(parsed: &serde_json::Value) -> Vec<(String, String)> {
    let mut nodes = vec![];
    if let Some(clearnet) = parsed.get("mainnet").and_then(|m| m.get("clearnet")).and_then(|c| c.as_object()) {
        for (label, addresses) in clearnet {
            if let Some(addrs) = addresses.as_array() {
                for addr in addrs {
                    if let Some(addr_str) = addr.as_str() {
                        // Skip HTTPS nodes — simple-request has TLS cert issues
                        if addr_str.starts_with("https://") {
                            continue;
                        }
                        let url = if addr_str.starts_with("http://") {
                            addr_str.to_string()
                        } else {
                            format!("http://{}", addr_str)
                        };
                        nodes.push((label.clone(), url));
                    }
                }
            }
        }
    }
    nodes
}

/// Load nodes: try cached → fetch from GitHub → fall back to bundled.
async fn load_nodes(app: &AppHandle) -> Vec<(String, String)> {
    let cache_path = app.path().app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("latest_nodes.json");

    // 1. Try fetching fresh nodes from GitHub
    if let Ok(response) = reqwest::Client::new()
        .get(GITHUB_NODES_URL)
        .timeout(Duration::from_secs(8))
        .send().await
    {
        if let Ok(text) = response.text().await {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                let nodes = parse_clearnet_nodes(&parsed);
                if !nodes.is_empty() {
                    // Cache to disk
                    let _ = std::fs::write(&cache_path, &text);
                    log::info!("Fetched {} nodes from GitHub, cached locally", nodes.len());
                    return nodes;
                }
            }
        }
    }

    // 2. Try cached nodes from disk
    if let Ok(text) = std::fs::read_to_string(&cache_path) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
            let nodes = parse_clearnet_nodes(&parsed);
            if !nodes.is_empty() {
                log::info!("Using {} cached nodes from disk", nodes.len());
                return nodes;
            }
        }
    }

    // 3. Fall back to bundled nodes.json
    let bundled = include_str!("../../../resources/nodes.json");
    let parsed: serde_json::Value = serde_json::from_str(bundled).unwrap_or_default();
    let nodes = parse_clearnet_nodes(&parsed);
    log::info!("Using {} bundled fallback nodes", nodes.len());
    nodes
}

/// Race ALL nodes — first to connect wins.
async fn race_nodes(app: &AppHandle) -> Option<(String, String, monero_daemon_rpc::MoneroDaemon<monero_simple_request_rpc::SimpleRequestTransport>)> {
    use tokio::sync::mpsc;

    let nodes = load_nodes(app).await;
    emit_log(app, "Network", "info", &format!("🏁 Racing {} nodes...", nodes.len()));

    let (tx, mut rx) = mpsc::channel(1);

    for (label, url) in nodes {
        let tx = tx.clone();
        tokio::spawn(async move {
            if let Ok(daemon) = SimpleRequestTransport::new(url.clone()).await {
                let _ = tx.send((label, url, daemon)).await;
            }
        });
    }
    drop(tx);

    tokio::select! {
        result = rx.recv() => result,
        _ = sleep(Duration::from_secs(15)) => None,
    }
}

/// Background blockchain scanner.
pub struct BlockScanner;

impl BlockScanner {
    /// Race all nodes for fastest connection, then start scanning.
    /// On scan failure, re-race and retry.
    pub async fn start(
        app: AppHandle,
        _daemon_url: &str,
        _node_label: &str,
        from_height: u64,
    ) -> Result<(), String> {
        let app_clone = app.clone();
        tokio::spawn(async move {
            loop {
                // Race all nodes
                let (label, url, daemon) = match race_nodes(&app_clone).await {
                    Some(result) => result,
                    None => {
                        emit_log(&app_clone, "Network", "error", "❌ All nodes failed. Retrying in 10s...");
                        sleep(Duration::from_secs(10)).await;
                        continue;
                    }
                };

                emit_log(&app_clone, "Network", "success", &format!("✅ Fastest node: {} ({})", label, url));

                // Store daemon URL so tx commands can connect
                let wallet_state = app_clone.state::<WalletState>();
                wallet_state.set_daemon_url(&url).await;

                // Run scan loop — if it fails, re-race
                match scan_loop(app_clone.clone(), daemon, from_height, url.clone(), label.clone()).await {
                    Ok(()) => break,
                    Err(e) => {
                        emit_log(&app_clone, "Sync", "error", &format!("⚠️ {} disconnected: {}. Re-racing...", label, e));
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
    // Dynamic batch size based on gap — bigger gap = bigger batches for speed.
    // Monero daemon limits response to ~100MB, so we cap at 1000 blocks.
    let base_batch: u64 = 50;

    if scan_height == u64::MAX {
        emit_log(&app, "Sync", "info", "🔍 New wallet — will sync from daemon tip");
    } else {
        emit_log(&app, "Sync", "info", &format!("🔍 Scan loop started from height {}", scan_height));
    }

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

        if scan_height == u64::MAX || scan_height > daemon_height {
            // New wallet sentinel (u64::MAX) or somehow ahead — start near tip
            emit_log(&app, "Sync", "info", &format!("📦 New wallet: starting near daemon tip ({})", daemon_height));
            scan_height = daemon_height.saturating_sub(10);
        }
        // scan_height == 0 is valid for restores — scan from genesis

        if scan_height >= daemon_height {
            crate::emit_sync_status(&app, "SYNCED", scan_height, daemon_height, 100.0, &node_label);
            sleep(Duration::from_secs(10)).await;
            continue;
        }

        // Dynamic batch size: bigger gap = bigger batches
        let gap = daemon_height - scan_height;
        let batch_size = if gap > 100_000 {
            1000  // Major catchup: 1000 blocks per request
        } else if gap > 10_000 {
            500   // Moderate catchup
        } else if gap > 1_000 {
            200   // Small catchup
        } else {
            base_batch // Near tip: small batches for responsiveness
        };

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
        crate::emit_sync_status(&app, "SYNCING", scan_height, daemon_height, percent, &node_label);
    }
}
