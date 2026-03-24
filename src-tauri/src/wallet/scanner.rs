
/// Background blockchain scanner.
/// Connects to a Monero daemon, fetches blocks, and scans for outputs
/// belonging to the wallet's view keypair using monero-wallet crate.
///
/// Emits events to the frontend:
/// - "sync-update" { height, daemonHeight, percent }
/// - "balance-changed" { balance, unlocked }
/// - "new-transaction" { tx }
pub struct BlockScanner {
    // TODO: When monero-wallet is integrated:
    // daemon_rpc: DaemonRpcClient,
    // view_pair: ViewPair,
    // tracked_outputs: Vec<TrackedOutput>,
    // scan_height: u64,
}

impl BlockScanner {
    pub fn new() -> Self {
        Self {}
    }

    /// Start scanning from a given height. Runs as a background tokio task.
    /// Emits Tauri events as new data is found.
    pub async fn start(&self, _app: tauri::AppHandle, _from_height: u64) {
        // TODO: Implementation with monero-wallet:
        //
        // loop {
        //     // 1. Get daemon height
        //     let daemon_h = self.daemon_rpc.get_height().await?;
        //
        //     // 2. Fetch next batch of blocks
        //     let blocks = self.daemon_rpc.get_blocks(scan_height, batch_size).await?;
        //
        //     // 3. Scan each block for our outputs using monero_wallet::Scanner
        //     for block in blocks {
        //         let received = monero_wallet::scan(&self.view_pair, &block);
        //         for output in received {
        //             self.tracked_outputs.push(output);
        //             app.emit("new-output", &output).ok();
        //         }
        //         scan_height = block.height + 1;
        //     }
        //
        //     // 4. Emit sync progress
        //     app.emit("sync-update", SyncStatus {
        //         height: scan_height,
        //         daemon_height: daemon_h,
        //         sync_percent: (scan_height as f64 / daemon_h as f64) * 100.0,
        //         status: if scan_height >= daemon_h - 5 { "SYNCED" } else { "SYNCING" },
        //     }).ok();
        //
        //     // 5. If caught up, sleep before checking again
        //     if scan_height >= daemon_h - 1 {
        //         tokio::time::sleep(Duration::from_secs(10)).await;
        //     }
        // }

        log::info!("BlockScanner: scanning not yet implemented (awaiting monero-wallet integration)");
    }
}
