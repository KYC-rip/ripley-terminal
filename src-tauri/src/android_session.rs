//! A wallet-operation fence independent of scanner generations (which can change
//! during a canonical rollback). Old completions must never affect a new wallet.
use std::sync::atomic::{AtomicU64, Ordering};
#[derive(Default)]
pub struct Session(AtomicU64);
impl Session {
    pub fn current(&self) -> u64 { self.0.load(Ordering::SeqCst) }
    pub fn invalidate(&self) -> u64 { self.0.fetch_add(1, Ordering::SeqCst) + 1 }
    pub fn accepts(&self, ticket: u64) -> bool { self.current() == ticket }
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn late_network_error_cannot_quarantine_replacement_wallet(){let s=Session::default();let old=s.current();s.invalidate();assert!(!s.accepts(old));assert!(s.accepts(s.current()));}
 #[test] fn failed_unlock_invalidates_old_wallet_response(){let s=Session::default();let old=s.current();s.invalidate();assert!(!s.accepts(old));}
 #[test] fn late_background_lock_cannot_lock_reopened_wallet(){let s=Session::default();let background=s.invalidate();s.invalidate();assert!(!s.accepts(background));}
 #[test] fn scanner_rollback_does_not_invalidate_wallet_session(){let s=Session::default();let ticket=s.current();let mut generation=10;generation+=1;assert_eq!(generation,11);assert!(s.accepts(ticket));}
 #[test] fn overlapping_task_stress(){let s=std::sync::Arc::new(Session::default());let old=s.current();let jobs:Vec<_>=(0..64).map(|_|{let s=s.clone();std::thread::spawn(move||{s.invalidate();})}).collect();for j in jobs{j.join().unwrap()}assert_eq!(s.current(),64);assert!(!s.accepts(old));}
}
