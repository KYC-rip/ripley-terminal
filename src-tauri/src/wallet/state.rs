use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tauri::AppHandle;
use tauri::Manager;

use zeroize::Zeroizing;

use monero_wallet::{ViewPair, Scanner, WalletOutput};
use monero_oxide::ed25519::{Scalar, Point};
use monero_address::{Network, MoneroAddress};

use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;

use super::keys;
use super::storage::{self, WalletFileData, AccountLabel};
use super::types::*;

/// Core wallet state — holds keys, scanned outputs, accounts, sync progress.
pub struct WalletState {
    app: AppHandle,
    inner: Arc<RwLock<WalletInner>>,
}

struct WalletInner {
    is_locked: bool,
    active_identity: Option<String>,
    password: Option<String>,
    accounts: Vec<MoneroAccount>,
    sync_status: SyncStatus,

    // Cryptographic material (cleared on lock)
    spend_key: Option<Zeroizing<Scalar>>,
    view_key: Option<Zeroizing<Scalar>>,
    mnemonic: Option<Zeroizing<String>>,
    scanner: Option<Scanner>,

    // Tracked state from scanning
    scanned_outputs: Vec<WalletOutput>,
    scan_height: u64,

    // Data dir for wallet files
    data_dir: PathBuf,
}

impl WalletState {
    pub fn new(app: AppHandle) -> Self {
        let data_dir = app.path().app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));

        Self {
            app,
            inner: Arc::new(RwLock::new(WalletInner {
                is_locked: true,
                active_identity: None,
                password: None,
                accounts: vec![],
                sync_status: SyncStatus {
                    status: "OFFLINE".to_string(),
                    height: 0,
                    daemon_height: 0,
                    sync_percent: 0.0,
                },
                spend_key: None,
                view_key: None,
                mnemonic: None,
                scanner: None,
                scanned_outputs: vec![],
                scan_height: 0,
                data_dir,
            })),
        }
    }

    pub async fn is_locked(&self) -> bool {
        self.inner.read().await.is_locked
    }

    /// Create a new wallet from scratch or restore from mnemonic.
    pub async fn create_wallet(
        &self,
        identity_id: &str,
        password: &str,
        seed_phrase: Option<&str>,
        restore_height: Option<u64>,
    ) -> Result<String, String> {
        let (mnemonic, spend_key, view_key) = if let Some(seed) = seed_phrase {
            // Restore from existing mnemonic
            let (sk, vk) = keys::keys_from_mnemonic(seed)?;
            (seed.to_string(), sk, vk)
        } else {
            // Generate new wallet
            keys::generate_mnemonic()
        };

        // Save encrypted wallet file
        let inner = self.inner.read().await;
        let entropy_hex = hex::encode(<[u8; 32]>::from(*spend_key));
        let wallet_data = WalletFileData {
            seed_entropy: entropy_hex,
            scan_height: restore_height.unwrap_or(0),
            accounts: vec![AccountLabel { index: 0, label: "Primary".into() }],
            subaddress_labels: vec![],
        };
        storage::save_wallet(&inner.data_dir, identity_id, &wallet_data, password)?;
        drop(inner);

        log::info!("Wallet created for identity: {}", identity_id);
        Ok(mnemonic)
    }

    /// Open an existing wallet with password.
    pub async fn unlock(&self, identity_id: &str, password: &str) -> Result<(), String> {
        let mut inner = self.inner.write().await;

        // Load and decrypt wallet file
        let wallet_data = storage::load_wallet(&inner.data_dir, identity_id, password)?;

        // Derive keys from stored entropy
        let entropy_bytes: [u8; 32] = hex::decode(&wallet_data.seed_entropy)
            .map_err(|e| format!("Invalid seed entropy: {}", e))?
            .try_into()
            .map_err(|_| "Seed entropy must be 32 bytes".to_string())?;

        let (spend_key, view_key) = keys::keys_from_entropy(&entropy_bytes)?;

        // Derive public spend key: G * spend_key
        let dalek_scalar: curve25519_dalek::Scalar = (*spend_key).into();
        let spend_point = Point::from(&dalek_scalar * ED25519_BASEPOINT_POINT);

        // Create ViewPair and Scanner
        let view_pair = ViewPair::new(spend_point, view_key.clone())
            .map_err(|e| format!("Failed to create ViewPair: {:?}", e))?;
        let scanner = Scanner::new(view_pair.clone());

        // Derive primary address for display
        let primary_address = view_pair.legacy_address(Network::Mainnet);

        // Set up accounts from saved labels
        let accounts: Vec<MoneroAccount> = wallet_data.accounts.iter().map(|a| {
            MoneroAccount {
                index: a.index,
                label: a.label.clone(),
                balance: "0.000000000000".to_string(),
                unlocked_balance: "0.000000000000".to_string(),
                base_address: if a.index == 0 {
                    primary_address.to_string()
                } else {
                    String::new() // TODO: derive per-account addresses
                },
            }
        }).collect();

        inner.spend_key = Some(spend_key);
        inner.view_key = Some(view_key);
        inner.scanner = Some(scanner);
        inner.is_locked = false;
        inner.active_identity = Some(identity_id.to_string());
        inner.password = Some(password.to_string());
        inner.scan_height = wallet_data.scan_height;
        inner.accounts = accounts;
        inner.sync_status.status = "SYNCING".to_string();

        log::info!("Wallet unlocked for identity: {} (resume from height {})", identity_id, wallet_data.scan_height);
        Ok(())
    }

    /// Get mnemonic seed (for backup).
    pub async fn get_mnemonic(&self) -> Result<String, String> {
        let inner = self.inner.read().await;
        let spend_key = inner.spend_key.as_ref()
            .ok_or("Wallet is locked")?;

        // Convert spend key back to mnemonic via entropy
        let entropy: [u8; 32] = <[u8; 32]>::from(**spend_key);
        let seed = monero_seed::Seed::from_entropy(
            monero_seed::Language::English,
            Zeroizing::new(entropy),
        ).ok_or("Failed to convert key to mnemonic")?;

        Ok((*seed.to_string()).clone())
    }

    pub async fn lock(&self) {
        let mut inner = self.inner.write().await;

        // Save scan progress before locking
        if let (Some(identity_id), Some(password)) = (&inner.active_identity, &inner.password) {
            if let Some(spend_key) = &inner.spend_key {
                let entropy_hex = hex::encode(<[u8; 32]>::from(**spend_key));
                let wallet_data = WalletFileData {
                    seed_entropy: entropy_hex,
                    scan_height: inner.scan_height,
                    accounts: inner.accounts.iter().map(|a| AccountLabel {
                        index: a.index,
                        label: a.label.clone(),
                    }).collect(),
                    subaddress_labels: vec![],
                };
                let _ = storage::save_wallet(&inner.data_dir, identity_id, &wallet_data, password);
            }
        }

        inner.is_locked = true;
        inner.accounts.clear();
        inner.scanned_outputs.clear();
        inner.spend_key = None;
        inner.view_key = None;
        inner.mnemonic = None;
        inner.scanner = None;
        inner.password = None;
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

    /// Compute total balance from scanned outputs (in atomic units / piconero).
    pub async fn compute_balance(&self) -> u64 {
        let inner = self.inner.read().await;
        inner.scanned_outputs.iter()
            .map(|o| o.commitment().amount)
            .sum()
    }

    /// Format piconero to XMR string.
    pub fn format_xmr(atomic: u64) -> String {
        let whole = atomic / 1_000_000_000_000;
        let frac = atomic % 1_000_000_000_000;
        format!("{}.{:012}", whole, frac)
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }

    /// Get the number of scanned outputs.
    pub async fn output_count(&self) -> usize {
        self.inner.read().await.scanned_outputs.len()
    }
}
