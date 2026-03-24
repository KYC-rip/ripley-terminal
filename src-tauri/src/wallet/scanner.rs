use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

use monero_daemon_rpc::prelude::*;
use monero_simple_request_rpc::SimpleRequestTransport;

use super::types::SyncStatus;

/// Background blockchain scanner.
/// Connects to a Monero daemon, fetches blocks, and scans for outputs
/// belonging to the wallet's view keypair using monero-wallet.
pub struct BlockScanner;

impl BlockScanner {
    /// Connect to daemon and start scanning.
    /// Returns the daemon connection for reuse, or spawns a background task.
    pub async fn start(
        app: AppHandle,
        daemon_url: &str,
        from_height: u64,
    ) -> Result<(), String> {
        // SimpleRequestTransport::new returns MoneroDaemon<SimpleRequestTransport> directly
        let daemon = SimpleRequestTransport::new(daemon_url.to_string()).await
            .map_err(|e| format!("Failed to connect to daemon: {:?}", e))?;

        log::info!("BlockScanner connected to daemon: {}", daemon_url);

        // Spawn the scanning loop as a background task
        tokio::spawn(async move {
            if let Err(e) = scan_loop(app, daemon, from_height).await {
                log::error!("BlockScanner error: {}", e);
            }
        });

        Ok(())
    }
}

async fn scan_loop(
    app: AppHandle,
    daemon: monero_daemon_rpc::MoneroDaemon<monero_simple_request_rpc::SimpleRequestTransport>,
    mut scan_height: u64,
) -> Result<(), String> {
    loop {
        // Get daemon height
        let daemon_height = daemon.latest_block_number().await
            .map_err(|e| format!("Failed to get daemon height: {:?}", e))? as u64;

        if scan_height >= daemon_height {
            // Caught up — emit synced status and sleep
            let _ = app.emit("sync-update", SyncStatus {
                status: "SYNCED".to_string(),
                height: scan_height,
                daemon_height,
                sync_percent: 100.0,
            });
            sleep(Duration::from_secs(10)).await;
            continue;
        }

        // Fetch and scan blocks in batches
        let batch_end = (scan_height + 100).min(daemon_height);

        match ProvidesScannableBlocks::contiguous_scannable_blocks(
            &daemon,
            (scan_height as usize)..=(batch_end as usize),
        ).await {
            Ok(blocks) => {
                // TODO: Scan each block with wallet's Scanner
                // The scanning is commented out until we wire up key loading:
                //
                // let wallet_state = app.state::<WalletState>();
                // if let Some(mut scanner) = wallet_state.get_scanner().await {
                //     for block in &blocks {
                //         match scanner.scan(block.clone()) {
                //             Ok(timelocked) => {
                //                 let outputs = timelocked.ignore_additional_timelock();
                //                 if !outputs.is_empty() {
                //                     wallet_state.add_outputs(outputs).await;
                //                 }
                //             }
                //             Err(e) => log::warn!("Scan error: {:?}", e),
                //         }
                //     }
                // }

                let _ = blocks; // suppress unused warning
                scan_height = batch_end + 1;
                log::info!("Scanned blocks {}-{}/{}", scan_height - 100, scan_height, daemon_height);
            }
            Err(e) => {
                log::warn!("Failed to fetch blocks {}-{}: {:?}", scan_height, batch_end, e);
                sleep(Duration::from_secs(5)).await;
                continue;
            }
        }

        // Emit progress
        let percent = if daemon_height > 0 {
            (scan_height as f64 / daemon_height as f64) * 100.0
        } else {
            0.0
        };

        let _ = app.emit("sync-update", SyncStatus {
            status: "SYNCING".to_string(),
            height: scan_height,
            daemon_height,
            sync_percent: percent,
        });
    }
}
