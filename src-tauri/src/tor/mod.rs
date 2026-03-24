use std::sync::Arc;
use tokio::sync::RwLock;

use arti_client::{TorClient, TorClientConfig};
use tor_rtcompat::PreferredRuntime;

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
    pub async fn connect(&self) -> Result<(), String> {
        let mut inner = self.inner.write().await;
        inner.status = TorStatus::Bootstrapping { percent: 0 };

        // Use default arti config (downloads consensus, builds circuits)
        let config = TorClientConfig::default();

        match TorClient::create_bootstrapped(config).await {
            Ok(client) => {
                inner.client = Some(client);
                inner.status = TorStatus::Connected;
                log::info!("Tor connected via arti (pure Rust)");
                Ok(())
            }
            Err(e) => {
                let msg = format!("Tor bootstrap failed: {}", e);
                inner.status = TorStatus::Error { message: msg.clone() };
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
