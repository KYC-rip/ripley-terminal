use std::sync::Arc;
use tokio::sync::RwLock;
use tauri::AppHandle;

use zeroize::Zeroizing;

use monero_wallet::{ViewPair, Scanner, WalletOutput};
use monero_oxide::ed25519::{Scalar, Point};

#[cfg(feature = "compile-time-generators")]
use curve25519_dalek::constants::ED25519_BASEPOINT_TABLE;
#[cfg(not(feature = "compile-time-generators"))]
use curve25519_dalek::constants::ED25519_BASEPOINT_POINT as ED25519_BASEPOINT_TABLE;

use super::types::*;

/// Core wallet state — holds keys, scanned outputs, accounts, sync progress.
/// This is the "wallet layer" that monero-wallet intentionally doesn't provide.
pub struct WalletState {
    _app: AppHandle,
    inner: Arc<RwLock<WalletInner>>,
}

struct WalletInner {
    is_locked: bool,
    active_identity: Option<String>,
    accounts: Vec<MoneroAccount>,
    sync_status: SyncStatus,

    // Cryptographic material (cleared on lock)
    spend_key: Option<Zeroizing<Scalar>>,
    view_key: Option<Zeroizing<Scalar>>,
    scanner: Option<Scanner>,

    // Tracked state from scanning
    scanned_outputs: Vec<WalletOutput>,
    scan_height: u64,
}

impl WalletState {
    pub fn new(app: AppHandle) -> Self {
        Self {
            _app: app,
            inner: Arc::new(RwLock::new(WalletInner {
                is_locked: true,
                active_identity: None,
                accounts: vec![],
                sync_status: SyncStatus {
                    status: "OFFLINE".to_string(),
                    height: 0,
                    daemon_height: 0,
                    sync_percent: 0.0,
                },
                spend_key: None,
                view_key: None,
                scanner: None,
                scanned_outputs: vec![],
                scan_height: 0,
            })),
        }
    }

    pub async fn is_locked(&self) -> bool {
        self.inner.read().await.is_locked
    }

    /// Derive Monero keys from a mnemonic seed and initialize the scanner.
    pub async fn unlock(&self, identity_id: &str, _password: &str) -> Result<(), String> {
        let mut inner = self.inner.write().await;

        // TODO: Load encrypted seed from disk using password
        // For now, this is a placeholder — real implementation needs:
        // 1. Read encrypted .keys file from app data dir
        // 2. Decrypt with password (argon2 KDF)
        // 3. Extract spend key bytes

        // Placeholder: derive keys (will be replaced with actual key loading)
        // let spend_scalar = Scalar::from_bytes_mod_order(seed_bytes);
        // let view_scalar = Scalar::from_bytes_mod_order(keccak256(&spend_scalar.to_bytes()));

        inner.is_locked = false;
        inner.active_identity = Some(identity_id.to_string());
        inner.sync_status.status = "SYNCING".to_string();

        log::info!("Wallet unlocked for identity: {}", identity_id);
        Ok(())
    }

    /// Initialize the scanner with actual keys.
    /// Called after keys are derived from seed/password.
    pub async fn init_scanner(&self, spend_key: Zeroizing<Scalar>, view_key: Zeroizing<Scalar>) -> Result<(), String> {
        let mut inner = self.inner.write().await;

        // Derive public spend key: G * spend_key
        let dalek_scalar: curve25519_dalek::Scalar = (*spend_key).into();
        let spend_point = Point::from(&dalek_scalar * ED25519_BASEPOINT_TABLE);

        // Create ViewPair for scanning
        let view_pair = ViewPair::new(spend_point, view_key.clone())
            .map_err(|e| format!("Failed to create ViewPair: {:?}", e))?;

        // Initialize scanner
        let scanner = Scanner::new(view_pair);

        inner.spend_key = Some(spend_key);
        inner.view_key = Some(view_key);
        inner.scanner = Some(scanner);

        log::info!("Scanner initialized with view keypair");
        Ok(())
    }

    pub async fn lock(&self) {
        let mut inner = self.inner.write().await;
        inner.is_locked = true;
        inner.accounts.clear();
        inner.scanned_outputs.clear();
        inner.spend_key = None;
        inner.view_key = None;
        inner.scanner = None;
        inner.sync_status = SyncStatus {
            status: "OFFLINE".to_string(),
            height: 0,
            daemon_height: 0,
            sync_percent: 0.0,
        };
        log::info!("Wallet locked — keys zeroed");
    }

    pub async fn get_accounts(&self) -> Vec<MoneroAccount> {
        self.inner.read().await.accounts.clone()
    }

    pub async fn get_sync_status(&self) -> SyncStatus {
        self.inner.read().await.sync_status.clone()
    }

    pub async fn update_sync_status(&self, height: u64, daemon_height: u64) {
        let mut inner = self.inner.write().await;
        inner.scan_height = height;
        inner.sync_status.height = height;
        inner.sync_status.daemon_height = daemon_height;
        if daemon_height > 0 {
            inner.sync_status.sync_percent = (height as f64 / daemon_height as f64) * 100.0;
            inner.sync_status.status = if daemon_height - height <= 5 {
                "SYNCED".to_string()
            } else {
                "SYNCING".to_string()
            };
        }
    }

    pub async fn get_scanner(&self) -> Option<Scanner> {
        self.inner.read().await.scanner.clone()
    }

    pub async fn get_scan_height(&self) -> u64 {
        self.inner.read().await.scan_height
    }

    pub async fn add_outputs(&self, outputs: Vec<WalletOutput>) {
        let mut inner = self.inner.write().await;
        inner.scanned_outputs.extend(outputs);
    }

    pub async fn get_spend_key(&self) -> Option<Zeroizing<Scalar>> {
        self.inner.read().await.spend_key.clone()
    }
}
