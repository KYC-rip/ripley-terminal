//! Per-node block-fetch health: how many fast-sync streams a node takes at once, and
//! how long to wait after failed fetches. Lives outside the scan loop so a re-race to
//! the same node keeps what was learned (the 2026-10-23 loop reset everything on each
//! re-race and re-downloaded ~21 GB of discarded batches overnight).
//!
//! Keyed by scheme://host:port — never the path, so an authenticating proxy's token
//! (rpc.mnr.network/v1/<token>) is neither stored nor a way around the backoff.

use std::collections::HashMap;
use std::sync::Mutex;

/// Marks a transport error as the node refusing for rate/concurrency (HTTP 429).
pub const RATE_LIMITED: &str = "RATE_LIMITED";

pub fn is_rate_limited(err: &str) -> bool {
    err.contains(RATE_LIMITED)
}

/// Fast-sync streams for a fresh node: 4, or 3 on mnr.network (its Pro tokens allow 3
/// concurrent .bin streams; Free 1 — the controller walks down to it on the first 429).
pub fn initial_streams(url: &str) -> usize {
    if host_of(url) == "rpc.mnr.network" {
        3
    } else {
        4
    }
}

/// Clean batches before one more stream is tried again.
const STREAM_REGROW_STREAK: u32 = 6;
/// Backoff after the 2nd consecutive failure, doubling, capped.
const BACKOFF_BASE_SECS: u64 = 15;
const BACKOFF_CAP_SECS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeHealth {
    /// Consecutive failed fetches with no progress in between.
    pub fails: u32,
    pub streams: usize,
    start_streams: usize,
    clean: u32,
}

impl NodeHealth {
    pub fn new(start_streams: usize) -> Self {
        let s = start_streams.max(1);
        Self { fails: 0, streams: s, start_streams: s, clean: 0 }
    }

    /// Blocks arrived (a whole batch or a prefix of one).
    pub fn progress(&mut self) {
        self.fails = 0;
        self.clean += 1;
        if self.clean >= STREAM_REGROW_STREAK && self.streams < self.start_streams {
            self.streams += 1;
            self.clean = 0;
        }
    }

    /// Part of a batch arrived, a later stream failed. That's progress (no backoff), but
    /// not a clean batch (no stream regrowth); a 429 also drops a stream.
    pub fn partial(&mut self, rate_limited: bool) {
        self.fails = 0;
        if rate_limited {
            self.rate_limited();
        }
        self.clean = 0;
    }

    /// The node turned down one of our concurrent streams (429): one fewer from now on.
    pub fn rate_limited(&mut self) {
        self.streams = self.streams.saturating_sub(1).max(1);
        self.clean = 0;
    }

    /// A fetch failed with nothing to show for it. Returns the seconds to wait first.
    pub fn failed(&mut self, rate_limited: bool) -> u64 {
        if rate_limited {
            self.rate_limited();
        }
        self.clean = 0;
        self.fails = self.fails.saturating_add(1);
        backoff_secs(self.fails)
    }
}

/// 0 for a first failure (the caller's own shrink/retry handles a blip), then
/// 15 s, 30 s, 60 s … up to 10 min.
pub fn backoff_secs(fails: u32) -> u64 {
    if fails <= 1 {
        return 0;
    }
    let shift = (fails - 2).min(16);
    (BACKOFF_BASE_SECS << shift).min(BACKOFF_CAP_SECS)
}

static HEALTH: Mutex<Option<HashMap<String, NodeHealth>>> = Mutex::new(None);

/// Run `f` on `url`'s health record (created on first use).
pub fn with<R>(url: &str, f: impl FnOnce(&mut NodeHealth) -> R) -> R {
    let mut g = HEALTH.lock().unwrap_or_else(|p| p.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    let h = map
        .entry(node_key(url))
        .or_insert_with(|| NodeHealth::new(initial_streams(url)));
    f(h)
}

/// scheme://host:port of a node URL, path (and any token in it) dropped.
pub fn node_key(url: &str) -> String {
    let (scheme, rest) = match url.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => (String::new(), url),
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority).to_ascii_lowercase();
    format!("{scheme}://{authority}")
}

fn host_of(url: &str) -> String {
    let key = node_key(url);
    let authority = key.split_once("://").map(|(_, a)| a).unwrap_or(&key);
    if let Some(rest) = authority.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("").to_string();
    }
    authority.split(':').next().unwrap_or("").to_string()
}

/// A node address as typed (Settings or the node list) → a clearnet URL. An explicit
/// scheme is kept; a bare `host:443` means TLS (`https://`); any other bare host gets
/// `http://` (monerod's plain RPC ports).
pub fn clearnet_url(addr: &str) -> String {
    let a = addr.trim();
    if a.starts_with("http://") || a.starts_with("https://") {
        return a.to_string();
    }
    let authority = a.split('/').next().unwrap_or(a);
    if authority.ends_with(":443") {
        format!("https://{a}")
    } else {
        format!("http://{a}")
    }
}

/// The contiguous run of successful sub-range results from the start, and the first
/// error. Results are in height order; anything after a failed sub-range is dropped
/// (it isn't contiguous with what we can scan) and fetched again next round.
pub fn ok_prefix<T, E>(results: Vec<Result<Vec<T>, E>>) -> (Vec<T>, Option<E>) {
    let mut out = Vec::new();
    for r in results {
        match r {
            Ok(v) => out.extend(v),
            Err(e) => return (out, Some(e)),
        }
    }
    (out, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_caps() {
        let s: Vec<u64> = (1..=9).map(backoff_secs).collect();
        assert_eq!(s, vec![0, 15, 30, 60, 120, 240, 480, 600, 600]);
        assert_eq!(backoff_secs(u32::MAX), 600);
    }

    #[test]
    fn a_429_drops_a_stream_and_progress_resets_the_backoff() {
        let mut h = NodeHealth::new(4);
        assert_eq!(h.failed(true), 0);
        assert_eq!(h.streams, 3);
        assert_eq!(h.failed(true), 15);
        assert_eq!(h.failed(true), 30);
        assert_eq!(h.failed(true), 60);
        assert_eq!(h.streams, 1); // floor
        assert_eq!(h.failed(false), 120);
        assert_eq!(h.streams, 1); // a non-429 failure leaves the streams alone
        h.progress();
        assert_eq!(h.fails, 0);
        assert_eq!(h.failed(false), 0);
    }

    #[test]
    fn streams_grow_back_after_clean_batches_up_to_the_start() {
        let mut h = NodeHealth::new(3);
        h.rate_limited();
        assert_eq!(h.streams, 2);
        for _ in 0..5 {
            h.progress();
        }
        assert_eq!(h.streams, 2);
        h.progress();
        assert_eq!(h.streams, 3);
        for _ in 0..20 {
            h.progress();
        }
        assert_eq!(h.streams, 3);
    }

    #[test]
    fn a_partial_batch_is_progress_but_not_clean() {
        let mut h = NodeHealth::new(3);
        h.failed(false);
        h.failed(false);
        for _ in 0..5 {
            h.progress();
        }
        // 3 good + 1 × 429: no backoff, one stream fewer, and the clean streak restarts.
        h.partial(true);
        assert_eq!((h.fails, h.streams), (0, 2));
        for _ in 0..5 {
            h.progress();
        }
        assert_eq!(h.streams, 2);
        // ok,ok,502: progress, streams kept, still not clean.
        h.partial(false);
        assert_eq!(h.streams, 2);
        for _ in 0..5 {
            h.progress();
        }
        assert_eq!(h.streams, 2);
        h.progress();
        assert_eq!(h.streams, 3);
    }

    #[test]
    fn health_is_per_node_and_ignores_the_token_path() {
        let a = "https://rpc.mnr.network/v1/tokenA";
        let b = "https://rpc.mnr.network/v1/tokenB";
        let other = "https://node.kyc.rip-test-health";
        assert_eq!(node_key(a), node_key(b));
        assert!(!node_key(a).contains("token"));
        assert_eq!(with(a, |h| h.streams), 3);
        with(a, |h| h.rate_limited());
        assert_eq!(with(b, |h| h.streams), 2); // a new token doesn't reset what mnr taught us
        assert_eq!(with(other, |h| h.streams), 4); // another node is unaffected
        with(other, |h| h.progress());
        assert_eq!(with(a, |h| h.streams), 2);
    }

    #[test]
    fn bare_443_means_https() {
        assert_eq!(clearnet_url("node.kyc.rip:443"), "https://node.kyc.rip:443");
        assert_eq!(clearnet_url("[::1]:443"), "https://[::1]:443");
        assert_eq!(clearnet_url("1.2.3.4:18081"), "http://1.2.3.4:18081");
        assert_eq!(clearnet_url("node.example:4430"), "http://node.example:4430");
        assert_eq!(clearnet_url("http://host:443"), "http://host:443"); // explicit wins
        assert_eq!(clearnet_url("https://rpc.mnr.network/v1/t"), "https://rpc.mnr.network/v1/t");
        assert_eq!(clearnet_url(" rpc.mnr.network:443/v1/t "), "https://rpc.mnr.network:443/v1/t");
    }

    #[test]
    fn only_the_contiguous_prefix_survives() {
        let r: Vec<Result<Vec<u32>, &str>> = vec![Ok(vec![1, 2]), Ok(vec![3]), Err("429"), Ok(vec![9])];
        assert_eq!(ok_prefix(r), (vec![1, 2, 3], Some("429")));
        let first: Vec<Result<Vec<u32>, &str>> = vec![Err("429"), Ok(vec![2]), Ok(vec![3])];
        assert_eq!(ok_prefix(first), (vec![], Some("429")));
        let all: Vec<Result<Vec<u32>, &str>> = vec![Ok(vec![1]), Ok(vec![2])];
        assert_eq!(ok_prefix(all), (vec![1, 2], None));
    }

    #[test]
    fn rate_limit_marker() {
        assert!(is_rate_limited("InterfaceError(\"RATE_LIMITED: node returned HTTP 429\")"));
        assert!(!is_rate_limited("InterfaceError(\"returned HTTP 502 Bad Gateway\")"));
    }
}
