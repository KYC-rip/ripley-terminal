use std::sync::Arc;
use tokio::sync::RwLock;

use arti_client::{TorClient, TorClientConfig};
use tauri::AppHandle;
use tor_rtcompat::PreferredRuntime;

mod transport;
pub use transport::{ArtiTransport, SocksTransport};
// tor_get/socks_get route HTTPS GETs (nodes.json, price) over Tor / an external
// SOCKS proxy with TLS; tor_http is the shared hyper-over-arti helper.
#[allow(unused_imports)]
pub use transport::{socks_get, tor_get, tor_http};

/// Surface Tor bootstrap status to the renderer's status chip. Piggybacks on
/// core-log with source="TOR_STATUS" because Tauri v2 custom events don't reach
/// JS from background tokio tasks (same workaround as SYNC_DATA). The renderer
/// parses the message as "status|percent|message".
fn emit_tor_status(app: &AppHandle, status: &str, percent: Option<u8>, message: Option<&str>) {
    crate::emit_log(
        app,
        "TOR_STATUS",
        "info",
        &format!("{}|{}|{}", status, percent.unwrap_or(0), message.unwrap_or("")),
    );
}

/// Tor state manager using arti-client (pure Rust Tor implementation).
/// Replaces the bundled Tor binary entirely — no subprocess, no 61MB binary.
pub struct TorState {
    inner: Arc<RwLock<TorInner>>,
}

struct TorInner {
    status: TorStatus,
    client: Option<TorClient<PreferredRuntime>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum TorStatus {
    Disconnected,
    Bootstrapping { percent: u8 },
    Connected,
    Error { message: String },
}

impl TorState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(TorInner {
                status: TorStatus::Disconnected,
                client: None,
            })),
        }
    }

    pub async fn get_status(&self) -> TorStatus {
        self.inner.read().await.status.clone()
    }

    /// Bootstrap the Tor network connection using arti-client.
    ///
    /// After connecting, the daemon RPC transport (simple-request) can be
    /// configured to route through Tor by using arti's SOCKS proxy or
    /// by using the TorClient directly for stream isolation.
    pub async fn connect(&self, app: &AppHandle) -> Result<(), String> {
        {
            let mut inner = self.inner.write().await;
            inner.status = TorStatus::Bootstrapping { percent: 0 };
        }
        emit_tor_status(app, "bootstrapping", Some(0), None);

        // Build an UNBOOTSTRAPPED client so we can stream consensus-download /
        // circuit-build progress to the UI while bootstrap runs (first run can
        // take 30-120s). create_bootstrapped would block with no progress.
        let runtime = PreferredRuntime::current()
            .map_err(|e| format!("Tor needs an async runtime: {e}"))?;
        let client = TorClient::with_runtime(runtime)
            .config(TorClientConfig::default())
            .create_unbootstrapped()
            .map_err(|e| format!("Tor client init failed: {e}"))?;

        // Forward bootstrap progress to the UI until traffic-ready.
        let mut events = client.bootstrap_events();
        let inner = self.inner.clone();
        let app_clone = app.clone();
        let progress = tokio::spawn(async move {
            use futures::StreamExt;
            while let Some(status) = events.next().await {
                let percent = (status.as_frac() * 100.0).round() as u8;
                {
                    let mut g = inner.write().await;
                    // Don't clobber a terminal state set by the main task.
                    if matches!(g.status, TorStatus::Bootstrapping { .. }) {
                        g.status = TorStatus::Bootstrapping { percent };
                    }
                }
                emit_tor_status(&app_clone, "bootstrapping", Some(percent), None);
                if status.ready_for_traffic() {
                    break;
                }
            }
        });

        let result = client.bootstrap().await;
        progress.abort();

        match result {
            Ok(()) => {
                let mut inner = self.inner.write().await;
                inner.client = Some(client);
                inner.status = TorStatus::Connected;
                drop(inner);
                emit_tor_status(app, "connected", Some(100), None);
                log::info!("Tor connected via arti (pure Rust)");
                Ok(())
            }
            Err(e) => {
                let msg = format!("Tor bootstrap failed: {}", e);
                {
                    let mut inner = self.inner.write().await;
                    inner.status = TorStatus::Error { message: msg.clone() };
                }
                emit_tor_status(app, "error", None, Some(&msg));
                log::error!("{}", msg);
                Err(msg)
            }
        }
    }

    /// Get the arti TorClient for making connections.
    /// Used by the daemon RPC transport to route requests through Tor.
    pub async fn get_client(&self) -> Option<TorClient<PreferredRuntime>> {
        self.inner.read().await.client.clone()
    }

    pub async fn disconnect(&self) {
        let mut inner = self.inner.write().await;
        inner.client = None;
        inner.status = TorStatus::Disconnected;
        log::info!("Tor disconnected");
    }
}
