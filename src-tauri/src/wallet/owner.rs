//! "Whose address is this?" — which of my wallets owns a pasted Monero address, and at
//! which (account, index). Pure: callers hand in each wallet's public spend point and
//! private view scalar; nothing here opens, writes or logs anything.
//!
//! Ownership is decided without a table: a primary / integrated address is ours iff its
//! keys ARE (B, a·G); a subaddress (D, C) is ours iff C == a·D (C = a·D holds for every
//! subaddress of view key a, and for no other address short of a key collision). The
//! index is then found by walking the issued range + the scan lookahead.

use std::collections::HashMap;

use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
use curve25519_dalek::{EdwardsPoint, Scalar as DalekScalar};
use monero_address::{MoneroAddress, Network, SubaddressIndex};
use monero_oxide::ed25519::{CompressedPoint, Point, Scalar};
use monero_wallet::ViewPair;
use zeroize::Zeroizing;

use super::keys;
use super::state::lookahead_indices;
use super::storage::WalletFileData;

/// Where in a wallet an owned address sits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Spot {
    /// The wallet's primary address (account 0, index 0); integrated addresses carry their payment id.
    Primary { payment_id: Option<[u8; 8]> },
    /// A subaddress at (account, index).
    Sub { account: u32, index: u32 },
    /// Provably this wallet's subaddress, but past the issued range + lookahead.
    BeyondWindow,
}

/// An owned address plus the labels the wallet gave it (`labels_read` = false when only a
/// view pair was readable, so labels are unknown rather than absent).
#[derive(Debug, Clone)]
pub struct Located {
    pub spot: Spot,
    pub account_label: Option<String>,
    pub label: Option<String>,
    pub labels_read: bool,
}

/// The account a spot sits in (None when past the window).
pub fn spot_account(spot: &Spot) -> Option<u32> {
    match spot {
        Spot::Primary { .. } => Some(0),
        Spot::Sub { account, .. } => Some(*account),
        Spot::BeyondWindow => None,
    }
}

/// `locate` against a decrypted vault, with the vault's labels.
pub fn locate_in_vault(addr: &MoneroAddress, wd: &WalletFileData, net: Network) -> Result<Option<Located>, String> {
    let keys = keys_from_vault(wd)?;
    Ok(locate(addr, &keys, &next_from_vault(wd), net).map(|spot| {
        let account = spot_account(&spot);
        Located {
            account_label: account.and_then(|a| wd.accounts.iter().find(|x| x.index == a).map(|x| x.label.clone())),
            label: match spot {
                Spot::Sub { account, index } => wd
                    .subaddress_labels
                    .iter()
                    .find(|s| s.account == account && s.index == index)
                    .map(|s| s.label.clone()),
                _ => None,
            },
            labels_read: true,
            spot,
        }
    }))
}

/// One wallet's public spend point B + private view scalar a.
pub struct OwnerKeys {
    pub spend: Point,
    pub view: Zeroizing<Scalar>,
}

impl OwnerKeys {
    fn dalek_view(&self) -> Zeroizing<DalekScalar> {
        Zeroizing::new((*self.view).into())
    }
}

/// Keys from a decrypted vault: full vaults derive them from the seed entropy, view-only
/// vaults carry B + a directly. The spend SECRET is dropped (zeroized) before returning.
pub fn keys_from_vault(wd: &WalletFileData) -> Result<OwnerKeys, String> {
    if let Some(vo) = &wd.view_only {
        let spend_bytes: [u8; 32] = hex::decode(&vo.spend_public_hex)
            .ok()
            .and_then(|v| v.try_into().ok())
            .ok_or("bad public spend point")?;
        let spend = CompressedPoint::from(spend_bytes).decompress().ok_or("bad public spend point")?;
        let view_bytes: Zeroizing<[u8; 32]> = Zeroizing::new(
            hex::decode(&vo.view_key_hex).ok().and_then(|v| v.try_into().ok()).ok_or("bad view key")?,
        );
        let view = Zeroizing::new(Scalar::from(DalekScalar::from_bytes_mod_order(*view_bytes)));
        return Ok(OwnerKeys { spend, view });
    }
    let entropy: Zeroizing<[u8; 32]> = Zeroizing::new(
        hex::decode(&wd.seed_entropy).ok().and_then(|v| v.try_into().ok()).ok_or("bad seed entropy")?,
    );
    let (spend_key, view) = keys::keys_from_entropy(&entropy)?;
    let s: Zeroizing<DalekScalar> = Zeroizing::new((*spend_key).into());
    let spend = Point::from(&*s * ED25519_BASEPOINT_POINT);
    Ok(OwnerKeys { spend, view })
}

/// Per-account next-minor counters from a vault's labels (as `WalletState::unlock` seeds them).
pub fn next_from_vault(wd: &WalletFileData) -> HashMap<u32, u32> {
    let mut next = HashMap::from([(0u32, 1u32)]);
    for a in &wd.accounts {
        next.entry(a.index).or_insert(1);
    }
    for s in &wd.subaddress_labels {
        let e = next.entry(s.account).or_insert(1);
        if s.index + 1 > *e {
            *e = s.index + 1;
        }
    }
    next
}

fn pt(p: Point) -> EdwardsPoint {
    p.into()
}

/// Is `addr` (already parsed on the wallet's network) this wallet's, and where?
/// `next` = per-account next minor index (issued range); the walk covers it + the lookahead.
pub fn locate(addr: &MoneroAddress, keys: &OwnerKeys, next: &HashMap<u32, u32>, net: Network) -> Option<Spot> {
    let a = keys.dalek_view();
    let d = pt(addr.spend());
    let c = pt(addr.view());
    if !addr.is_subaddress() {
        let ours = d == pt(keys.spend) && c == &*a * ED25519_BASEPOINT_POINT;
        return ours.then(|| Spot::Primary { payment_id: addr.payment_id() });
    }
    if c != &*a * d {
        return None;
    }
    let vp = ViewPair::new(keys.spend, keys.view.clone()).ok()?;
    let want = d.compress();
    let mut idx: Vec<(u32, u32)> = (1..next.get(&0).copied().unwrap_or(1)).map(|i| (0, i)).collect();
    idx.extend(lookahead_indices(next));
    for (account, index) in idx {
        if let Some(si) = SubaddressIndex::new(account, index) {
            if pt(vp.subaddress(net, si).spend()).compress() == want {
                return Some(Spot::Sub { account, index });
            }
        }
    }
    Some(Spot::BeyondWindow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::storage::{AccountLabel, SubaddressLabel, WatchOnlyVault};

    fn vault(entropy: [u8; 32]) -> WalletFileData {
        WalletFileData {
            seed_entropy: hex::encode(entropy),
            scan_height: 0,
            accounts: vec![AccountLabel { index: 3, label: "Exchange".into() }],
            subaddress_labels: vec![SubaddressLabel { account: 3, index: 17, label: "Kraken".into() }],
            view_only: None,
        }
    }
    fn ent(b: u8) -> [u8; 32] {
        let mut e = [0u8; 32];
        e[0] = b;
        e[1] = 7;
        e
    }
    fn vp_of(k: &OwnerKeys) -> ViewPair {
        ViewPair::new(k.spend, k.view.clone()).unwrap()
    }
    fn sub(k: &OwnerKeys, a: u32, i: u32) -> MoneroAddress {
        vp_of(k).subaddress(Network::Mainnet, SubaddressIndex::new(a, i).unwrap())
    }

    #[test]
    fn finds_primary_integrated_and_subaddresses() {
        let wd = vault(ent(1));
        let k = keys_from_vault(&wd).unwrap();
        let next = next_from_vault(&wd);
        let primary = vp_of(&k).legacy_address(Network::Mainnet);
        assert_eq!(locate(&primary, &k, &next, Network::Mainnet), Some(Spot::Primary { payment_id: None }));
        let integ = primary.with_payment_id([9u8; 8]).unwrap();
        assert_eq!(locate(&integ, &k, &next, Network::Mainnet), Some(Spot::Primary { payment_id: Some([9u8; 8]) }));
        assert_eq!(locate(&sub(&k, 0, 5), &k, &next, Network::Mainnet), Some(Spot::Sub { account: 0, index: 5 }));
        assert_eq!(locate(&sub(&k, 3, 17), &k, &next, Network::Mainnet), Some(Spot::Sub { account: 3, index: 17 }));
        assert_eq!(locate(&sub(&k, 3, 0), &k, &next, Network::Mainnet), Some(Spot::Sub { account: 3, index: 0 }));
    }

    #[test]
    fn a_vault_gives_the_labels_and_only_with_its_password() {
        use crate::wallet::storage::{decrypt_wallet, encrypt_wallet};
        let wd = vault(ent(1));
        let k = keys_from_vault(&wd).unwrap();
        let sealed = encrypt_wallet(&wd, "right");
        assert!(decrypt_wallet(&sealed, "wrong").is_err());
        let opened = decrypt_wallet(&sealed, "right").unwrap();
        let l = locate_in_vault(&sub(&k, 3, 17), &opened, Network::Mainnet).unwrap().unwrap();
        assert_eq!(l.spot, Spot::Sub { account: 3, index: 17 });
        assert_eq!(l.account_label.as_deref(), Some("Exchange"));
        assert_eq!(l.label.as_deref(), Some("Kraken"));
        assert!(l.labels_read);
        let p = locate_in_vault(&vp_of(&k).legacy_address(Network::Mainnet), &opened, Network::Mainnet).unwrap().unwrap();
        assert_eq!((p.spot, p.label), (Spot::Primary { payment_id: None }, None));
    }

    #[test]
    fn another_wallets_addresses_are_not_mine() {
        let k1 = keys_from_vault(&vault(ent(1))).unwrap();
        let k2 = keys_from_vault(&vault(ent(2))).unwrap();
        let next = HashMap::from([(0u32, 1u32)]);
        assert_eq!(locate(&sub(&k2, 0, 5), &k1, &next, Network::Mainnet), None);
        assert_eq!(locate(&vp_of(&k2).legacy_address(Network::Mainnet), &k1, &next, Network::Mainnet), None);
    }

    #[test]
    fn owned_past_the_window_still_names_the_wallet() {
        let k = keys_from_vault(&vault(ent(1))).unwrap();
        let next = HashMap::from([(0u32, 1u32)]);
        assert_eq!(locate(&sub(&k, 0, 5000), &k, &next, Network::Mainnet), Some(Spot::BeyondWindow));
    }

    #[test]
    fn a_view_only_vault_matches_like_its_full_twin() {
        let full = keys_from_vault(&vault(ent(1))).unwrap();
        let mut wd = vault([0u8; 32]);
        wd.seed_entropy = String::new();
        wd.view_only = Some(WatchOnlyVault {
            spend_public_hex: hex::encode(full.spend.compress().to_bytes()),
            view_key_hex: hex::encode(<[u8; 32]>::from(*full.view)),
        });
        let vo = keys_from_vault(&wd).unwrap();
        assert_eq!(locate(&sub(&full, 3, 17), &vo, &next_from_vault(&wd), Network::Mainnet), Some(Spot::Sub { account: 3, index: 17 }));
    }
}
