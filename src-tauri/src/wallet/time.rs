// Shared pure timestamp fallback, previously in commands/wallet.rs.
pub(crate) fn estimate_block_time(height: u64) -> u64 {
    const ANCHOR_HEIGHT: u64 = 3_709_104;
    const ANCHOR_TS: u64 = 1_782_950_400;
    const BLOCK_SECS: u64 = 120;
    if height >= ANCHOR_HEIGHT {
        ANCHOR_TS + (height - ANCHOR_HEIGHT) * BLOCK_SECS
    } else {
        ANCHOR_TS.saturating_sub((ANCHOR_HEIGHT - height) * BLOCK_SECS)
    }
}

/// When a send detected on chain happened: its block's header time, else (no header
/// time known) the anchor estimate, never in the future.
pub(crate) fn sent_time(block_ts: u64, height: u64, now: u64) -> u64 {
    if block_ts > 0 {
        block_ts.min(now)
    } else {
        estimate_block_time(height).min(now)
    }
}
