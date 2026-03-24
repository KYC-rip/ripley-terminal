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
    network: Network,

    // Cryptographic material (cleared on lock)
    spend_key: Option<Zeroizing<Scalar>>,
    view_key: Option<Zeroizing<Scalar>>,
    view_pair: Option<ViewPair>,
    mnemonic: Option<Zeroizing<String>>,
    scanner: Option<Scanner>,

    // Subaddress tracking
    next_subaddress_index: u32, // next unused subaddress index for account 0
    subaddress_labels: Vec<(u32, String)>, // (index, label)

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
                    sync_percent: 0.0, node_label: String::new(), node_url: String::new(),
                },
                network: Network::Mainnet,
                spend_key: None,
                view_key: None,
                view_pair: None,
                mnemonic: None,
                scanner: None,
                next_subaddress_index: 1,
                subaddress_labels: vec![],
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
            // For new wallets, use u64::MAX as sentinel — scanner auto-adjusts to daemon tip.
            // For restores, use provided height (or 0 for full scan).
            scan_height: restore_height.unwrap_or(if seed_phrase.is_some() { 0 } else { u64::MAX }),
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
        let mut scanner = Scanner::new(view_pair.clone());

        // Derive primary address for display
        let network = inner.network;
        let primary_address = view_pair.legacy_address(network);

        // Register existing subaddresses with the scanner so it can detect them
        let num_subaddresses = wallet_data.subaddress_labels.len().max(20) as u32;
        for i in 1..=num_subaddresses {
            if let Some(idx) = monero_address::SubaddressIndex::new(0, i) {
                scanner.register_subaddress(idx);
            }
        }

        // Set up accounts from saved labels
        let addr_str = primary_address.to_string();
        log::info!("Primary address derived: {}", addr_str);

        let accounts: Vec<MoneroAccount> = wallet_data.accounts.iter().map(|a| {
            MoneroAccount {
                index: a.index,
                label: a.label.clone(),
                balance: "0".to_string(),
                unlocked_balance: "0".to_string(),
                base_address: if a.index == 0 {
                    addr_str.clone()
                } else {
                    String::new()
                },
            }
        }).collect();

        // Restore subaddress labels
        let subaddress_labels: Vec<(u32, String)> = wallet_data.subaddress_labels.iter()
            .map(|s| (s.index, s.label.clone()))
            .collect();

        inner.spend_key = Some(spend_key);
        inner.view_key = Some(view_key);
        inner.view_pair = Some(view_pair);
        inner.scanner = Some(scanner);
        inner.is_locked = false;
        inner.active_identity = Some(identity_id.to_string());
        inner.password = Some(password.to_string());
        inner.scan_height = wallet_data.scan_height;
        inner.accounts = accounts;
        inner.next_subaddress_index = (num_subaddresses + 1).max(1);
        inner.subaddress_labels = subaddress_labels;
        inner.sync_status.status = "SYNCING".to_string();

        // Load cached outputs (avoids full rescan on relaunch)
        let cache = storage::load_output_cache(&inner.data_dir, identity_id);
        if !cache.outputs.is_empty() {
            log::info!("Loaded {} cached outputs from disk", cache.outputs.len());
            // Restore WalletOutputs from serialized cache
            for cached in &cache.outputs {
                if let Ok(output) = monero_wallet::WalletOutput::read(&mut cached.data.as_slice()) {
                    inner.scanned_outputs.push(output);
                }
            }
            // Use cached scan height if it's ahead of what's in the wallet file
            if cache.scan_height > inner.scan_height {
                inner.scan_height = cache.scan_height;
            }
        }

        log::info!("Wallet unlocked for identity: {} (resume from height {}, {} subaddresses, {} cached outputs)",
            identity_id, inner.scan_height, num_subaddresses, inner.scanned_outputs.len());
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
        // Save output cache before taking exclusive lock
        self.save_output_cache().await;

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
                    subaddress_labels: inner.subaddress_labels.iter().map(|(idx, label)| {
                        storage::SubaddressLabel { account: 0, index: *idx, label: label.clone() }
                    }).collect(),
                };
                let _ = storage::save_wallet(&inner.data_dir, identity_id, &wallet_data, password);
            }
        }

        inner.is_locked = true;
        inner.accounts.clear();
        inner.scanned_outputs.clear();
        inner.spend_key = None;
        inner.view_key = None;
        inner.view_pair = None;
        inner.mnemonic = None;
        inner.scanner = None;
        inner.password = None;
        inner.subaddress_labels.clear();
        inner.next_subaddress_index = 1;
        inner.sync_status = SyncStatus {
            status: "OFFLINE".to_string(),
            height: 0,
            daemon_height: 0,
            sync_percent: 0.0, node_label: String::new(), node_url: String::new(),
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
            inner.sync_status.status = if daemon_height.saturating_sub(height) <= 5 {
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

    /// Derive the primary (legacy) address.
    pub async fn get_primary_address(&self) -> Option<String> {
        let inner = self.inner.read().await;
        inner.view_pair.as_ref().map(|vp| vp.legacy_address(inner.network).to_string())
    }

    /// Create a new subaddress and register it with the scanner.
    pub async fn create_subaddress(&self, label: &str) -> Result<SubaddressInfo, String> {
        let mut inner = self.inner.write().await;

        let view_pair = inner.view_pair.as_ref().ok_or("Wallet is locked")?;
        let idx = inner.next_subaddress_index;

        let sub_idx = monero_address::SubaddressIndex::new(0, idx)
            .ok_or("Invalid subaddress index")?;

        // Derive the subaddress
        let address = view_pair.subaddress(inner.network, sub_idx);

        // Register with scanner so future scans detect outputs to this subaddress
        if let Some(scanner) = inner.scanner.as_mut() {
            scanner.register_subaddress(sub_idx);
        }

        inner.subaddress_labels.push((idx, label.to_string()));
        inner.next_subaddress_index = idx + 1;

        Ok(SubaddressInfo {
            index: idx,
            address: address.to_string(),
            label: label.to_string(),
            balance: "0".to_string(),
            unlocked_balance: "0".to_string(),
            is_used: false,
        })
    }

    /// Get all subaddresses (primary + derived).
    pub async fn get_subaddresses(&self) -> Vec<SubaddressInfo> {
        let inner = self.inner.read().await;
        let view_pair = match inner.view_pair.as_ref() {
            Some(vp) => vp,
            None => return vec![],
        };

        let mut result = vec![];

        // Index 0 = primary address
        result.push(SubaddressInfo {
            index: 0,
            address: view_pair.legacy_address(inner.network).to_string(),
            label: "Primary".to_string(),
            balance: "0".to_string(),
            unlocked_balance: "0".to_string(),
            is_used: true,
        });

        // Derived subaddresses
        for i in 1..inner.next_subaddress_index {
            if let Some(sub_idx) = monero_address::SubaddressIndex::new(0, i) {
                let address = view_pair.subaddress(inner.network, sub_idx);
                let label = inner.subaddress_labels.iter()
                    .find(|(idx, _)| *idx == i)
                    .map(|(_, l)| l.clone())
                    .unwrap_or_else(|| format!("Subaddress #{}", i));

                result.push(SubaddressInfo {
                    index: i,
                    address: address.to_string(),
                    label,
                    balance: "0".to_string(),
                    unlocked_balance: "0".to_string(),
                    is_used: false,
                });
            }
        }

        result
    }

    /// Set a label for a subaddress.
    /// Persist scanned outputs to disk cache.
    pub async fn save_output_cache(&self) {
        let inner = self.inner.read().await;
        if let Some(identity_id) = &inner.active_identity {
            let cached_outputs: Vec<storage::CachedOutput> = inner.scanned_outputs.iter().map(|o| {
                storage::CachedOutput {
                    data: o.serialize(),
                    amount: o.commitment().amount,
                    tx_hash: hex::encode(o.transaction()),
                    tx_index: o.index_in_transaction(),
                    subaddress: o.subaddress().map(|s| s.address()),
                }
            }).collect();

            let cache = storage::OutputCache {
                scan_height: inner.scan_height,
                outputs: cached_outputs,
            };

            if let Err(e) = storage::save_output_cache(&inner.data_dir, identity_id, &cache) {
                log::warn!("Failed to save output cache: {}", e);
            } else {
                log::info!("Output cache saved: {} outputs at height {}", cache.outputs.len(), cache.scan_height);
            }
        }
    }

    pub async fn set_subaddress_label(&self, index: u32, label: &str) {
        let mut inner = self.inner.write().await;
        if let Some(entry) = inner.subaddress_labels.iter_mut().find(|(idx, _)| *idx == index) {
            entry.1 = label.to_string();
        } else {
            inner.subaddress_labels.push((index, label.to_string()));
        }
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
