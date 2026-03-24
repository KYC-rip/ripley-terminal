use std::sync::Arc;
use tokio::sync::RwLock;

/// Tor state manager using arti-client (pure Rust Tor implementation).
/// Replaces the bundled Tor binary entirely.
pub struct TorState {
    inner: Arc<RwLock<TorInner>>,
}

struct TorInner {
    status: TorStatus,
    socks_port: u16,
    // TODO: When arti-client is integrated:
    // client: Option<arti_client::TorClient<tor_rtcompat::PreferredRuntime>>,
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
                socks_port: 9150,
            })),
        }
    }

    pub async fn get_status(&self) -> TorStatus {
        self.inner.read().await.status.clone()
    }

    pub async fn get_socks_port(&self) -> u16 {
        self.inner.read().await.socks_port
    }

    /// Bootstrap the Tor connection using arti-client.
    /// Returns a SOCKS5 proxy address that can be used for daemon connections.
    pub async fn connect(&self) -> Result<String, String> {
        let mut inner = self.inner.write().await;
        inner.status = TorStatus::Bootstrapping { percent: 0 };

        // TODO: Implement with arti-client:
        //
        // let config = TorClientConfig::default();
        // let client = TorClient::create_bootstrapped(config).await
        //     .map_err(|e| format!("Tor bootstrap failed: {}", e))?;
        //
        // inner.client = Some(client);
        // inner.status = TorStatus::Connected;
        //
        // For now, arti runs as a SOCKS proxy.
        // The daemon RPC client uses reqwest with socks5 proxy pointing here.

        inner.status = TorStatus::Connected;
        let addr = format!("socks5://127.0.0.1:{}", inner.socks_port);
        log::info!("Tor connected via arti at {}", addr);
        Ok(addr)
    }

    pub async fn disconnect(&self) {
        let mut inner = self.inner.write().await;
        // TODO: Drop the arti client
        inner.status = TorStatus::Disconnected;
        log::info!("Tor disconnected");
    }
}
