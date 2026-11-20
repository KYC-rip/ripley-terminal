// Pure scanner cursor/batch contract used by the Android runtime.
pub const BATCH: u64 = 8;
pub fn start(cursor: u64, target: u64) -> Result<u64, &'static str> {
    if target == 0 {
        return Err("Node has no canonical genesis");
    }
    if cursor == u64::MAX {
        return Ok(target.saturating_sub(BATCH));
    }
    if cursor > target {
        return Err("Node tip is behind committed cursor; rescan/reorg handling required");
    }
    Ok(cursor)
}
pub fn batch_end(cursor: u64, target: u64) -> u64 {
    cursor.saturating_add(BATCH).min(target)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn genesis_is_one_block() {
        assert_eq!(start(0, 1), Ok(0));
        assert_eq!(batch_end(0, 1), 1);
    }
    #[test]
    fn full_multibatch() {
        let mut n = start(0, 33).unwrap();
        let mut ranges = vec![];
        while n < 33 {
            let e = batch_end(n, 33);
            ranges.push((n, e));
            n = e;
        }
        assert_eq!(ranges, vec![(0, 8), (8, 16), (16, 24), (24, 32), (32, 33)]);
    }
    #[test]
    fn resume_does_not_replay_committed_blocks() {
        let a: Vec<_> = (0..11).collect();
        let b: Vec<_> = (start(11, 33).unwrap()..33).collect();
        let mut all = a;
        all.extend(b);
        assert_eq!(all, (0..33).collect::<Vec<_>>());
    }
    #[test]
    fn new_native_wallet_bounds_initial_scan() {
        assert_eq!(start(u64::MAX, 33), Ok(25));
    }
    #[test]
    fn cursor_ahead_of_tip_fails_closed() {
        assert!(start(34, 33).is_err());
    }
    #[test]
    fn empty_node_is_not_synced() {
        assert!(start(0, 0).is_err());
    }
    #[test]
    fn cursor_at_tip_is_idempotent() {
        assert_eq!(start(33, 33), Ok(33));
    }
    #[test]
    fn range_addition_cannot_overflow() {
        assert_eq!(batch_end(u64::MAX - 2, u64::MAX), u64::MAX);
    }
}
