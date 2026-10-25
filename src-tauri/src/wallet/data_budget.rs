//! Per-launch download cap for wallet sync. Every wallet daemon transport records the
//! response bytes it receives; both scan loops check `exhausted()` before each fetch and
//! idle once the cap is reached, until the user presses Re-select node (or starts a
//! rescan), which allows one more step. 2026-10-24: a background wallet pool pulled
//! ~25 GB in 5 hours with nothing visible — this bounds any future runaway.
//!
//! Checked before a fetch, not per byte: the batch in flight when the cap is crossed
//! still completes (one batch ≲ 50 MB). The counter starts at 0 on every launch.

use std::sync::atomic::{AtomicU64, Ordering};

/// Bytes allowed per step: the first 5 GiB, then 5 GiB more per explicit extend.
pub const STEP_BYTES: u64 = 5 * 1024 * 1024 * 1024;

static USED: AtomicU64 = AtomicU64::new(0);
static LIMIT: AtomicU64 = AtomicU64::new(STEP_BYTES);

/// A transport received `n` response bytes.
pub fn record(n: usize) {
    let _ = USED.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |u| Some(u.saturating_add(n as u64)));
}

pub fn used() -> u64 {
    USED.load(Ordering::Relaxed)
}

pub fn limit() -> u64 {
    LIMIT.load(Ordering::Relaxed)
}

pub fn exhausted() -> bool {
    is_exhausted(used(), limit())
}

/// Allow one more step from what's been used so far. Returns (used, new limit).
pub fn extend() -> (u64, u64) {
    let u = used();
    let l = extended_limit(u);
    LIMIT.store(l, Ordering::Relaxed);
    (u, l)
}

fn is_exhausted(used: u64, limit: u64) -> bool {
    used >= limit
}

fn extended_limit(used: u64) -> u64 {
    used.saturating_add(STEP_BYTES)
}

/// Bytes as "1.2 GB" (GiB, one decimal).
pub fn fmt_gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exhausted_at_the_limit_and_extend_adds_a_step_from_used() {
        assert!(!is_exhausted(0, STEP_BYTES));
        assert!(!is_exhausted(STEP_BYTES - 1, STEP_BYTES));
        assert!(is_exhausted(STEP_BYTES, STEP_BYTES));
        assert!(is_exhausted(STEP_BYTES + 7, STEP_BYTES));
        assert_eq!(extended_limit(STEP_BYTES + 7), 2 * STEP_BYTES + 7);
        assert!(!is_exhausted(STEP_BYTES + 7, extended_limit(STEP_BYTES + 7)));
        assert_eq!(extended_limit(u64::MAX), u64::MAX);
    }

    #[test]
    fn record_accumulates() {
        let before = used();
        record(1234);
        assert!(used() >= before + 1234);
    }

    #[test]
    fn gb_format() {
        assert_eq!(fmt_gb(0), "0.0 GB");
        assert_eq!(fmt_gb(STEP_BYTES), "5.0 GB");
        assert_eq!(fmt_gb(3 * 1024 * 1024 * 1024 / 2), "1.5 GB");
    }
}
