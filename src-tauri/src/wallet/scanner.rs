//! Background blockchain scanner.
//!
//! Connects to a Monero daemon, fetches blocks in batches, and scans each block
//! for outputs belonging to the wallet's ViewPair using monero-wallet's Scanner.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::ops::RangeInclusive;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::sleep;

use arti_client::TorClient;
use tor_rtcompat::PreferredRuntime;

use monero_address::SubaddressIndex;
use monero_daemon_rpc::prelude::*;
use monero_daemon_rpc::{HttpTransport, MoneroDaemon};
use monero_simple_request_rpc::SimpleRequestTransport;
use monero_wallet::{Scanner, ViewPair};

use super::state::{bump_next, lookahead_indices, window_growth, WalletState};
use super::{storage, types::SyncStatus};
use crate::emit_log;
use crate::tor::{ArtiTransport, SocksTransport, TorState};

const GITHUB_NODES_URL: &str =
    "https://raw.githubusercontent.com/KYC-rip/ripley-terminal/main/resources/nodes.json";

/// Read the configured routing mode ("tor" | "clearnet" | "custom") from config.json.
/// Defaults to "clearnet" when the file is absent or unparseable — the unparseable
/// case is logged, since it silently drops a Tor/custom user to clearnet.
pub(crate) fn read_routing_mode(app: &AppHandle) -> String {
    if let Some(mode) = read_config_str(app, "routingMode") {
        return mode;
    }
    let path = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("config.json");
    if let Ok(data) = std::fs::read_to_string(&path) {
        if let Err(e) = serde_json::from_str::<serde_json::Value>(&data) {
            log::warn!("config.json does not parse ({e}) — routing falls back to clearnet until it is fixed");
        }
    }
    "clearnet".to_string()
}

pub(crate) fn known_routing_mode(mode: &str) -> bool {
    matches!(mode, "tor" | "clearnet" | "custom")
}

/// Read the external SOCKS proxy address (custom routing mode) from config.json,
/// Fold fullwidth ASCII variants (U+FF01..U+FF5E, e.g. `：` `．` fullwidth digits)
/// and the ideographic space back to their ASCII equivalents. A CJK IME commonly
/// emits a fullwidth colon `：` for `host：port`, which every downstream parser
/// (tokio-socks, reqwest, the webview proxy) rejects — and the webview one PANICS.
/// Normalizing at the single read point makes the whole app tolerate the typo.
pub(crate) fn fold_fullwidth(s: &str) -> String {
    s.chars()
        .map(|c| {
            let u = c as u32;
            if (0xFF01..=0xFF5E).contains(&u) {
                char::from_u32(u - 0xFEE0).unwrap_or(c)
            } else if u == 0x3000 {
                ' '
            } else {
                c
            }
        })
        .collect()
}

/// normalized to a bare `host:port` (tokio-socks wants no scheme prefix).
pub(crate) fn read_proxy_address(app: &AppHandle) -> String {
    let raw = read_config_str(app, "systemProxyAddress").unwrap_or_default();
    let folded = fold_fullwidth(&raw);
    let trimmed = folded.trim();
    for prefix in ["socks5h://", "socks5://", "socks://", "http://"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return rest.trim_end_matches('/').to_string();
        }
    }
    trimmed.to_string()
}

/// Read a boolean field from config.json (default false).
pub(crate) fn read_config_bool(app: &AppHandle, key: &str) -> bool {
    let path = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("config.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok())
        .and_then(|v| v.get(key).and_then(|m| m.as_bool()))
        .unwrap_or(false)
}

/// Read a string field from config.json, if present.
fn read_config_str(app: &AppHandle, key: &str) -> Option<String> {
    let path = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("config.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok())
        .and_then(|v| v.get(key).and_then(|m| m.as_str()).map(String::from))
}

/// Parse nodes for a given network + section ("clearnet" | "tor") from nodes.json.
///
/// Clearnet addresses keep their scheme (bare `host:port` defaults to `http://`);
/// https nodes race alongside http ones — reqwest handles TLS. Tor `.onion`
/// addresses are stored verbatim as `host:port` — `ArtiTransport` parses them
/// and arti dials them natively (no exit node).
fn parse_nodes(parsed: &serde_json::Value, network: &str, section: &str) -> Vec<(String, String)> {
    let mut nodes = vec![];
    if let Some(sec) = parsed
        .get(network)
        .and_then(|m| m.get(section))
        .and_then(|c| c.as_object())
    {
        for (label, addresses) in sec {
            if let Some(addrs) = addresses.as_array() {
                for addr in addrs {
                    if let Some(addr_str) = addr.as_str() {
                        if section == "clearnet" {
                            // https nodes are kept: the clearnet transport is reqwest
                            // (native TLS) — the old "skip HTTPS" rule was for the
                            // retired simple-request transport and it silently dropped
                            // the only nodes that survive DPI-filtered networks (plain
                            // HTTP on 18081/18089 gets reset; TLS on 443 passes).
                            let url = super::fetch_health::clearnet_url(addr_str);
                            nodes.push((label.clone(), url));
                        } else {
                            // Tor / .onion: verbatim host:port (ArtiTransport parses it)
                            nodes.push((label.clone(), addr_str.to_string()));
                        }
                    }
                }
            }
        }
    }
    nodes
}

/// A pluggable way to build a `MoneroDaemon` for a node URL. The clearnet variant
/// uses `SimpleRequestTransport`; the Tor variant uses `ArtiTransport` over arti.
/// This keeps the scan logic generic over one concrete transport per run, while
/// leaving the clearnet path (and its battle-tested behavior) entirely unchanged.
pub trait DaemonConnector: Clone + Send + Sync + 'static {
    type Transport: HttpTransport + Clone + Send + Sync + 'static;

    /// nodes.json section this connector reads ("clearnet" | "tor").
    fn section(&self) -> &'static str;

    /// Err carries a short, URL-free reason ("node refused: HTTP 403 · subscription expired
    /// (-32001)") so a pinned node's refusal reaches the log instead of "unreachable".
    fn connect(
        &self,
        url: String,
    ) -> impl Future<Output = Result<MoneroDaemon<Self::Transport>, String>> + Send;
}

/// What a race produced: the first daemon to connect, plus why the others (or the only
/// one) did not. Public-pool races only read `winner`; the pinned-node path reads `failures`.
pub(crate) struct RaceOutcome<T: HttpTransport> {
    pub winner: Option<(String, String, MoneroDaemon<T>)>,
    pub failures: Vec<(String, String)>,
}

/// A one-line next step for the refusals a user can act on. Host-specific on purpose:
/// mnr.network's codes mean "your token", a self-hosted node's mean whatever its operator set.
pub(crate) fn pinned_hint(host: &str, reason: &str) -> Option<&'static str> {
    if host != "rpc.mnr.network" {
        return None;
    }
    let r = reason.to_ascii_lowercase();
    if r.contains("-32001") || r.contains("subscription expired") {
        Some("renew the token at mnr.network (the same token keeps working afterwards)")
    } else if r.contains("-32600") || r.contains("unknown token") {
        Some("get a new token at mnr.network and paste it in Settings ▸ Node")
    } else {
        None
    }
}

#[derive(Clone)]
struct ClearnetConnector;

impl DaemonConnector for ClearnetConnector {
    // reqwest, not simple-request: the latter hangs reading large response bodies
    // (multi-block get_blocks.bin catch-ups, and get_output_distribution.bin during
    // sends). See wallet::reqwest_transport. 60s bounds even a large bulk batch.
    type Transport = crate::wallet::reqwest_transport::ReqwestTransport;
    fn section(&self) -> &'static str {
        "clearnet"
    }
    async fn connect(&self, url: String) -> Result<MoneroDaemon<Self::Transport>, String> {
        crate::wallet::reqwest_transport::ReqwestTransport::connect(
            url,
            std::time::Duration::from_secs(60),
        )
        .await
    }
}

#[derive(Clone)]
struct TorConnector {
    tor: TorClient<PreferredRuntime>,
}

impl DaemonConnector for TorConnector {
    type Transport = ArtiTransport;
    fn section(&self) -> &'static str {
        "tor"
    }
    async fn connect(&self, url: String) -> Result<MoneroDaemon<ArtiTransport>, String> {
        match ArtiTransport::connect(self.tor.clone(), url.clone()).await {
            Ok(daemon) => Ok(daemon),
            Err(e) => {
                let reason = crate::wallet::reqwest_transport::redact_text(&format!("{e:?}"));
                log::warn!(
                    "Tor connect to {} failed: {reason}",
                    crate::wallet::reqwest_transport::redact_url(&url)
                );
                Err(reason)
            }
        }
    }
}

/// Custom/Whonix mode: dial nodes through an EXTERNAL SOCKS5 proxy. Uses the
/// same .onion node section — the proxy's Tor resolves them remotely (SOCKS5h).
#[derive(Clone)]
struct CustomProxyConnector {
    proxy: String,
}

impl DaemonConnector for CustomProxyConnector {
    type Transport = SocksTransport;
    fn section(&self) -> &'static str {
        "tor"
    }
    async fn connect(&self, url: String) -> Result<MoneroDaemon<SocksTransport>, String> {
        match SocksTransport::connect(self.proxy.clone(), url.clone()).await {
            Ok(daemon) => Ok(daemon),
            Err(e) => {
                let reason = crate::wallet::reqwest_transport::redact_text(&format!("{e:?}"));
                log::warn!(
                    "SOCKS connect to {} via {} failed: {reason}",
                    crate::wallet::reqwest_transport::redact_url(&url),
                    self.proxy
                );
                Err(reason)
            }
        }
    }
}

// Force a specific node for testing (set to None for normal racing)
// Set to Some(("label", "url")) to force a specific node for testing
const FORCE_NODE: Option<(&str, &str)> = None;

/// Load nodes for the given section ("clearnet" | "tor"): try fresh GitHub fetch
/// → cached disk copy → bundled fallback.
pub(crate) async fn load_nodes(app: &AppHandle, section: &str) -> Vec<(String, String)> {
    if let Some((label, url)) = FORCE_NODE {
        return vec![(label.to_string(), url.to_string())];
    }
    // Manual override: if the user set a custom node address in Settings, use
    // ONLY that node (no racing). Works in any routing mode — the active
    // connector (clearnet/Tor/SOCKS) dials it. Clearnet needs an http:// scheme;
    // Tor/SOCKS connectors parse host:port and ignore the scheme.
    let custom = read_config_str(app, "customNodeAddress").unwrap_or_default();
    let custom = custom.trim();
    if !custom.is_empty() {
        // A bare `host:443` is TLS — `http://host:443` was refused with HTTP 400.
        let url = super::fetch_health::clearnet_url(custom);
        // Path redacted: authenticating proxies (mnr.network) carry the token there.
        log::info!(
            "Using manual node override: {}",
            crate::wallet::reqwest_transport::redact_url(&url)
        );
        return vec![("custom".to_string(), url)];
    }
    load_pool_nodes(app, section).await
}

/// Load the public node pool (GitHub → cached → bundled), IGNORING any custom-node
/// override. Used by the connect-time fallback path: when a pinned node is
/// unreachable AND the user enabled `nodeFallback`, we race this pool instead.
pub(crate) async fn load_pool_nodes(app: &AppHandle, section: &str) -> Vec<(String, String)> {
    let cache_path = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("latest_nodes.json");

    // 1. Try fetching fresh nodes from GitHub. In Tor mode this goes over Tor
    //    (tor_get); on any failure (e.g. exit-node blocked by GitHub) we fall
    //    through to the cached/bundled copy — never a hard failure.
    let mode = read_routing_mode(app);
    let fetched: Option<String> = if mode == "tor" {
        match app.state::<TorState>().get_client().await {
            Some(tor) => match crate::tor::tor_get(&tor, GITHUB_NODES_URL).await {
                Ok(bytes) => String::from_utf8(bytes).ok(),
                Err(e) => {
                    log::warn!("Tor nodes.json fetch failed ({e}); using cache/bundled");
                    None
                }
            },
            None => None,
        }
    } else if mode == "custom" {
        let proxy = read_proxy_address(app);
        if proxy.trim().is_empty() {
            None
        } else {
            match crate::tor::socks_get(&proxy, GITHUB_NODES_URL).await {
                Ok(bytes) => String::from_utf8(bytes).ok(),
                Err(e) => {
                    log::warn!("SOCKS nodes.json fetch failed ({e}); using cache/bundled");
                    None
                }
            }
        }
    } else {
        match reqwest::Client::new()
            .get(GITHUB_NODES_URL)
            .timeout(Duration::from_secs(8))
            .send()
            .await
        {
            Ok(response) => response.text().await.ok(),
            Err(_) => None,
        }
    };
    if let Some(text) = fetched {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
            let nodes = parse_nodes(&parsed, "mainnet", section);
            if !nodes.is_empty() {
                // Cache to disk
                let _ = std::fs::write(&cache_path, &text);
                log::info!("Fetched {} {} nodes, cached locally", nodes.len(), section);
                return nodes;
            }
        }
    }

    // 2. Try cached nodes from disk
    if let Ok(text) = std::fs::read_to_string(&cache_path) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
            let nodes = parse_nodes(&parsed, "mainnet", section);
            if !nodes.is_empty() {
                log::info!("Using {} cached {} nodes from disk", nodes.len(), section);
                return nodes;
            }
        }
    }

    // 3. Fall back to bundled nodes.json
    let bundled = include_str!("../../../resources/nodes.json");
    let parsed: serde_json::Value = serde_json::from_str(bundled).unwrap_or_default();
    let nodes = parse_nodes(&parsed, "mainnet", section);
    log::info!("Using {} bundled fallback {} nodes", nodes.len(), section);
    nodes
}

/// Race ALL nodes — first to connect wins. Generic over the connector so the
/// same racing logic serves both clearnet (SimpleRequestTransport) and Tor
/// (ArtiTransport).
async fn race_nodes<C: DaemonConnector>(
    app: &AppHandle,
    connector: &C,
) -> RaceOutcome<C::Transport> {
    let nodes = load_nodes(app, connector.section()).await;
    // "Racing 1 nodes" reads oddly — a single node means a pinned custom node.
    if nodes.len() == 1 {
        emit_log(app, "Network", "info", "🔗 Connecting to pinned node…");
    } else {
        emit_log(
            app,
            "Network",
            "info",
            &format!("🏁 Racing {} nodes...", nodes.len()),
        );
    }
    race_list(connector, nodes).await
}

/// Race an explicit node list — first to connect wins (15s cap). Split out so the
/// custom-node fallback path can race the public pool without the custom override.
async fn race_list<C: DaemonConnector>(
    connector: &C,
    nodes: Vec<(String, String)>,
) -> RaceOutcome<C::Transport> {
    use tokio::sync::mpsc;
    let (tx, mut rx) = mpsc::channel(1);
    // Failures go on an unbounded channel and are sent BEFORE the task's winner sender
    // drops, so when `rx.recv()` yields None (every task done, nobody won) every reason is
    // already queued; the drain below cannot miss one.
    let (ftx, mut frx) = mpsc::unbounded_channel::<(String, String)>();

    for (label, url) in nodes {
        let tx = tx.clone();
        let ftx = ftx.clone();
        let connector = connector.clone();
        tokio::spawn(async move {
            match connector.connect(url.clone()).await {
                Ok(daemon) => {
                    let _ = tx.send((label, url, daemon)).await;
                }
                Err(reason) => {
                    log::debug!("node {label} failed: {reason}");
                    let _ = ftx.send((label, reason));
                }
            }
        });
    }
    drop(tx);
    drop(ftx);

    let winner = tokio::select! {
        result = rx.recv() => result,
        _ = sleep(Duration::from_secs(15)) => None,
    };
    let mut failures = Vec::new();
    while let Ok(f) = frx.try_recv() {
        failures.push(f);
    }
    RaceOutcome { winner, failures }
}

/// Background blockchain scanner.
pub struct BlockScanner;

impl BlockScanner {
    /// Race all nodes for fastest connection, then start scanning.
    /// On scan failure, re-race and retry.
    pub async fn start(
        app: AppHandle,
        _daemon_url: &str,
        _node_label: &str,
        from_height: u64,
    ) -> Result<(), String> {
        // Bump generation — any previous scanner will see the mismatch and stop
        let wallet_state = app.state::<WalletState>();
        let generation = wallet_state.next_scanner_generation();

        let app_clone = app.clone();
        tokio::spawn(async move {
            // Routing mode decides the transport. In Tor mode we bootstrap arti
            // FIRST (so the very first node race already goes over Tor — no
            // clearnet leak), then drive the same scan logic with ArtiTransport.
            let mode = read_routing_mode(&app_clone);
            match mode.as_str() {
                "tor" => {
                    emit_log(&app_clone, "Network", "info", "🧅 Routing mode: Tor (arti, pure Rust)");
                    // Never fall back to clearnet (would leak the IP the user asked us
                    // to hide). ensure_tor now bounds + retries each bootstrap; if it
                    // still fails, wait and retry the WHOLE thing so a transient network
                    // issue self-recovers instead of sync sitting dead forever. Abort if
                    // a newer scan supersedes us (re-select / relock / relaunch).
                    let ws = app_clone.state::<WalletState>();
                    loop {
                        if ws.current_scanner_generation() != generation {
                            break;
                        }
                        match ensure_tor(&app_clone).await {
                            Some(tor) => {
                                run_outer(app_clone.clone(), generation, TorConnector { tor }).await;
                                break;
                            }
                            None => {
                                emit_log(&app_clone, "Network", "warn", "🧅 Tor unavailable — retrying bootstrap in 15s (check your network if this persists)…");
                                sleep(Duration::from_secs(15)).await;
                            }
                        }
                    }
                }
                "custom" => {
                    let proxy = read_proxy_address(&app_clone);
                    if proxy.trim().is_empty() {
                        // Refuse — starting clearnet would leak the IP. Surface
                        // the misconfiguration instead of silently downgrading.
                        emit_log(
                            &app_clone,
                            "Network",
                            "error",
                            "❌ Custom routing selected but no proxy address is set. Sync paused — set a SOCKS proxy in Settings.",
                        );
                    } else {
                        emit_log(&app_clone, "Network", "info", &format!("🧦 Routing mode: custom SOCKS proxy ({proxy})"));
                        run_outer(app_clone, generation, CustomProxyConnector { proxy }).await;
                    }
                }
                "clearnet" => {
                    run_outer(app_clone, generation, ClearnetConnector).await;
                }
                other => emit_log(
                    &app_clone,
                    "Network",
                    "error",
                    &format!("❌ Unknown routing mode {other:?}. Sync paused rather than falling back to clearnet."),
                ),
            }
        });

        Ok(())
    }
}

/// Ensure arti is bootstrapped and return the shared `TorClient`. Emits UI log
/// events so the first-run consensus download (~30-120s) is visible.
pub(crate) async fn ensure_tor(app: &AppHandle) -> Option<TorClient<PreferredRuntime>> {
    let tor_state = app.state::<TorState>();
    if let Some(client) = tor_state.get_client().await {
        return Some(client);
    }
    emit_log(
        app,
        "Tor",
        "info",
        "🧅 Bootstrapping Tor (downloading consensus — up to ~30-120s on first run)...",
    );
    match tor_state.connect(app).await {
        Ok(()) => {
            emit_log(
                app,
                "Tor",
                "success",
                "🧅 Tor connected — daemon RPC routes through Tor",
            );
            tor_state.get_client().await
        }
        Err(e) => {
            emit_log(
                app,
                "Tor",
                "error",
                &format!("❌ Tor bootstrap failed: {}. Sync paused — check your connection or switch to clearnet.", e),
            );
            None
        }
    }
}

/// The race → scan → re-race loop, generic over the transport connector.
async fn run_outer<C: DaemonConnector>(app_clone: AppHandle, generation: u64, connector: C) {
    loop {
        // Check if we've been superseded by a newer scanner
        let ws = app_clone.state::<WalletState>();
        if ws.current_scanner_generation() != generation {
            emit_log(
                &app_clone,
                "Sync",
                "info",
                "🛑 Scanner stopped (superseded by newer scan)",
            );
            return;
        }

        // Race all nodes
        let (label, url, daemon) = match race_nodes(&app_clone, &connector).await {
            RaceOutcome { winner: Some(result), .. } => result,
            RaceOutcome { winner: None, failures } => {
                // A pinned custom node just failed to connect. If the user opted into
                // fallback, race the PUBLIC POOL (bypassing the pin) so a dead node
                // doesn't brick sync. Otherwise keep the pin (privacy: never silently
                // talk to a node the user didn't choose) and surface a clear reason.
                let custom = read_config_str(&app_clone, "customNodeAddress").unwrap_or_default();
                let custom = custom.trim().to_string();
                // Why the pin failed: the daemon's own refusal when it answered ("HTTP 403 ·
                // subscription expired (-32001)"), else it never answered within the race cap.
                let why = if custom.is_empty() {
                    String::new()
                } else {
                    let shown = crate::wallet::reqwest_transport::redact_url(&custom);
                    let host = shown.split("://").last().unwrap_or("").split(':').next().unwrap_or("").to_string();
                    match failures.first() {
                        Some((_, reason)) => {
                            let hint = pinned_hint(&host, reason).map(|h| format!(" · {h}")).unwrap_or_default();
                            format!("refused: {reason}{hint}")
                        }
                        None => "unreachable (no answer in 15 s)".to_string(),
                    }
                };
                if !custom.is_empty() && read_config_bool(&app_clone, "nodeFallback") {
                    emit_log(
                        &app_clone,
                        "Network",
                        "warn",
                        &format!("🔌 Pinned node {why} — falling back to the public pool…"),
                    );
                    let pool = load_pool_nodes(&app_clone, connector.section()).await;
                    match race_list(&connector, pool).await.winner {
                        Some(result) => result,
                        None => {
                            emit_log(&app_clone, "Network", "error", "❌ Pinned node and public pool both unreachable. Retrying in 10s...");
                            sleep(Duration::from_secs(10)).await;
                            continue;
                        }
                    }
                } else if !custom.is_empty() {
                    emit_log(&app_clone, "Network", "error", &format!("❌ Pinned node {} {why} — check the address or clear the pin in Settings ▸ Node. Retrying in 10s...", crate::wallet::reqwest_transport::redact_url(&custom)));
                    sleep(Duration::from_secs(10)).await;
                    continue;
                } else {
                    emit_log(
                        &app_clone,
                        "Network",
                        "error",
                        "❌ All nodes failed. Retrying in 10s...",
                    );
                    sleep(Duration::from_secs(10)).await;
                    continue;
                }
            }
        };

        emit_log(
            &app_clone,
            "Network",
            "success",
            &format!(
                "✅ Fastest node: {} ({})",
                label,
                crate::wallet::reqwest_transport::redact_url(&url)
            ),
        );

        // Store daemon URL so tx commands can connect
        let wallet_state = app_clone.state::<WalletState>();
        wallet_state.set_daemon_url(&url).await;

        // Read current scan height from state (may have been updated by rescan)
        let current_height = {
            let ws = app_clone.state::<WalletState>();
            ws.get_scan_height().await
        };

        // Run scan loop — if it fails, re-race
        match scan_loop(
            app_clone.clone(),
            daemon,
            current_height,
            url.clone(),
            label.clone(),
            generation,
            &connector,
        )
        .await
        {
            Ok(()) => break,
            Err(e) => {
                emit_log(
                    &app_clone,
                    "Sync",
                    "error",
                    &format!("⚠️ {} disconnected: {}. Re-racing...", label, e),
                );
                sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

// RingCT fork height — blocks before this have no RingCT outputs.
// monero-wallet only scans RingCT outputs, so scanning earlier blocks is pointless.
const RINGCT_FORK_HEIGHT: u64 = 1_220_516;

/// Validated per-block fetch of a contiguous range, pipelined round-robin across
/// the connection pool (buffered = pool size). This is the trustless default path
/// and the fast-sync fallback.
async fn parallel_per_block<T>(
    pool: &[MoneroDaemon<T>],
    range: RangeInclusive<usize>,
) -> Result<Vec<ScannableBlock>, InterfaceError>
where
    T: HttpTransport + Clone + Send + Sync + 'static,
{
    use futures::stream::StreamExt;
    let pool_n = pool.len().max(1);
    futures::stream::iter(range.enumerate())
        .map(|(i, n)| {
            let d = &pool[i % pool_n];
            async move { ProvidesScannableBlocks::scannable_block_by_number(d, n).await }
        })
        .buffered(pool_n)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect()
}

/// Fast-sync bulk fetch, parallelized. Splits `range` into consecutive sub-ranges
/// of up to `sub_size` blocks and fetches them CONCURRENTLY (`streams` in flight)
/// against the SAME trusted node, reassembled in order. Over Tor the bottleneck is
/// circuit latency, not bandwidth, so overlapping fetches multiplies throughput
/// while the scanner stays idle far less. `buffered` yields results in input
/// (height) order, so the concatenated stream is contiguous from `range.start()` —
/// the downstream scan loop (`block_height = scan_height + i`) is unchanged.
///
/// One trusted node × K circuits (rather than K different nodes): in fast-sync we
/// already trust this node, so a single node keeps the trust model identical and
/// avoids any cross-node tip/reorg mismatch in the reassembled stream. arti reuses
/// circuits internally, so concurrent calls on clones spread across Tor streams.
/// Returns the contiguous run of sub-ranges that arrived, from the start, plus the
/// first failure (fetch_health::ok_prefix) — so a node that turns down one stream
/// (HTTP 429) doesn't cost the ones it served. Only an empty prefix is an error →
/// the caller's shrink/narrow-and-retry / per-block fallback handles it.
async fn bulk_parallel<T>(
    daemon: &MoneroDaemon<T>,
    range: RangeInclusive<usize>,
    sub_size: usize,
    streams: usize,
) -> Result<(Vec<ScannableBlock>, Option<InterfaceError>), InterfaceError>
where
    T: HttpTransport + Clone + Send + Sync + 'static,
{
    use futures::stream::StreamExt;
    let (start, end) = (*range.start(), *range.end());
    let sub_size = sub_size.max(1);
    let mut subs: Vec<RangeInclusive<usize>> = Vec::new();
    let mut s = start;
    while s <= end {
        let e = (s + sub_size - 1).min(end);
        subs.push(s..=e);
        s = e + 1;
    }
    let results: Vec<Result<Vec<ScannableBlock>, InterfaceError>> = futures::stream::iter(subs)
        .map(|sub| {
            let d = daemon.clone();
            async move { d.bulk_scannable_blocks_trusting_node(sub).await }
        })
        .buffered(streams.max(1))
        .collect::<Vec<_>>()
        .await;
    match super::fetch_health::ok_prefix(results) {
        (blocks, Some(e)) if blocks.is_empty() => Err(e),
        (blocks, err) => Ok((blocks, err)),
    }
}

/// Seconds of transfer one proxied batch may plan for at the measured rate — well
/// inside both FETCH_DEADLINE (75 s) and the transport's 60 s per-request timeout,
/// so a normal batch never trips either and a stall still does.
const PROXIED_BATCH_SECS: f64 = 30.0;
/// Per-block (validated) batches on a proxied route before throughput is known,
/// and their floor.
const PROXIED_PER_BLOCK_START: u64 = 20;
const PROXIED_PER_BLOCK_MIN: u64 = 5;
/// Clearnet per-block fallback slice (it used to take the whole bulk-sized batch).
const PER_BLOCK_FALLBACK_MAX: u64 = 100;

/// Blocks a proxied route can move in PROXIED_BATCH_SECS at `measured_bps`
/// (at least 1). Callers clamp it to their own floors and ceilings.
fn proxied_batch_budget(measured_bps: f64) -> u64 {
    if !measured_bps.is_finite() || measured_bps <= 0.0 {
        return 1;
    }
    ((measured_bps * PROXIED_BATCH_SECS).floor() as u64).max(1)
}

/// Which blocks of an in-memory batch still need scanning when the watched subaddress
/// window can widen mid-batch. Each widening bumps a version; a block is (re)visited
/// while the window version it was last scanned with is older than the current one.
/// The caller refreshes its scanner right after a widening, so blocks after it in the
/// same pass are already current — only the blocks before it (and the widening block
/// itself) are revisited. Terminates: each widening needs a newly found output.
pub(crate) struct DiscoveryCursor {
    /// Window version each block was last scanned with (0 = never).
    scanned_with: Vec<u32>,
    version: u32,
    pos: usize,
    visits: usize,
}

impl DiscoveryCursor {
    pub(crate) fn new(len: usize) -> Self {
        Self { scanned_with: vec![0; len], version: 1, pos: 0, visits: 0 }
    }

    /// The next block to scan, in height order, or None when every block is current.
    pub(crate) fn next_block(&mut self) -> Option<usize> {
        for _ in 0..2 {
            while self.pos < self.scanned_with.len() {
                let b = self.pos;
                self.pos += 1;
                if self.scanned_with[b] < self.version {
                    return Some(b);
                }
            }
            if !self.scanned_with.iter().any(|&v| v < self.version) {
                return None;
            }
            self.pos = 0; // stale blocks remain behind us: another pass
        }
        None
    }

    /// Block `b` was just scanned with the current window; `grew` = it widened it.
    pub(crate) fn scanned(&mut self, b: usize, grew: bool) {
        self.scanned_with[b] = self.version;
        self.visits += 1;
        if grew {
            self.version += 1;
        }
    }

    /// Visits beyond the first pass (0 when nothing was discovered).
    pub(crate) fn revisits(&self) -> usize {
        self.visits.saturating_sub(self.scanned_with.len())
    }
}

/// After a proxied fetch TIMES OUT, wait this long before retrying. Ticket
/// #8175618389 (built-in Tor and Whonix alike): after one oversized batch, even
/// 400-block retries and per-block fetches timed out on a node that serves the same
/// range fine to curl — while our side does close abandoned connections (see the
/// transport tests). The likely cause is the node still building the abandoned
/// responses one after another (monerod has no request cancellation), so an
/// immediate retry queues behind them and each failed round adds more. The pause
/// lets that backlog drain; it costs nothing on the happy path.
const PROXIED_TIMEOUT_PAUSE: Duration = Duration::from_secs(20);

fn is_timeout(err: &str) -> bool {
    err.contains("watchdog") || err.contains("timed out")
}

async fn proxied_timeout_pause(app: &AppHandle, proxied: bool, err: &str) {
    if proxied && is_timeout(err) {
        emit_log(
            app,
            "Sync",
            "info",
            &format!("⏸ Pausing {}s so the node can finish the abandoned request before retrying", PROXIED_TIMEOUT_PAUSE.as_secs()),
        );
        sleep(PROXIED_TIMEOUT_PAUSE).await;
    }
}

/// Wait out a node's failure backoff (fetch_health), waking each second so a re-race
/// or rescan isn't held up. Returns false when this scan loop was superseded.
async fn backoff_wait(app: &AppHandle, node_label: &str, secs: u64, generation: u64, streams: usize) -> bool {
    if secs == 0 {
        return true;
    }
    emit_log(
        app,
        "Sync",
        "warn",
        &format!("⏸ {node_label} keeps failing — next try in {secs}s ({streams} stream(s) at once)"),
    );
    for _ in 0..secs {
        if app.state::<WalletState>().current_scanner_generation() != generation {
            return false;
        }
        sleep(Duration::from_secs(1)).await;
    }
    true
}

/// How far above the node's tip a start height must be before it is treated as
/// impossible (not this chain's height) rather than a node that is merely behind.
/// No usable node lags ~140 days; a mainnet height on stagenet is ~1.8M above.
const BEYOND_TIP_BLOCKS: u64 = 100_000;

fn start_beyond_tip(scan_height: u64, daemon_height: u64) -> bool {
    scan_height != u64::MAX && daemon_height > 0 && scan_height > daemon_height.saturating_add(BEYOND_TIP_BLOCKS)
}

/// How long any single block-fetch attempt may run before the watchdog aborts it.
/// Healthy bulk/per-block batches finish in ~10–50s even over Tor; this only trips
/// on a genuinely stalled node/circuit.
const FETCH_DEADLINE: Duration = Duration::from_secs(75);

/// Watchdog wrapper: bound a fetch by FETCH_DEADLINE. Over Tor a dead circuit can
/// make a request hang with NO transport-level timeout — `buffered()` then waits on
/// the stuck future forever, the scan loop never returns, and the outer re-race
/// never fires (a true deadlock, not a slow sync). Converting the hang into an Err
/// lets the existing retry/shrink/re-race recover, so the app self-heals across
/// flaky networks instead of freezing. Returns `String` errors so the caller's
/// recovery is identical whether the cause was an RPC error or a stall.
async fn with_deadline<F, V>(fut: F) -> Result<V, String>
where
    F: Future<Output = Result<V, InterfaceError>>,
{
    match tokio::time::timeout(FETCH_DEADLINE, fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(format!("{:?}", e)),
        Err(_) => Err(format!(
            "watchdog: fetch exceeded {}s — node/circuit stalled, recovering",
            FETCH_DEADLINE.as_secs()
        )),
    }
}

/// Ask the daemon which key images are spent via the `is_key_image_spent` RPC.
/// Returns the spent_status array (0 = unspent, 1 = spent on-chain, 2 = spent in
/// pool), aligned with `kis_hex`. None on RPC/parse error. This is the
/// authoritative way to detect spends — it consults the daemon's global key-image
/// set, independent of which blocks we've scanned.
async fn query_spent_status<T>(daemon: &MoneroDaemon<T>, kis_hex: &[String]) -> Option<Vec<u64>>
where
    T: HttpTransport + Clone + Send + Sync + 'static,
{
    let body = serde_json::json!({ "key_images": kis_hex }).to_string();
    let resp = daemon
        .rpc_call("is_key_image_spent", Some(body), 4 * 1024 * 1024)
        .await
        .ok()?;
    let v: serde_json::Value = serde_json::from_str(&resp).ok()?;
    let arr = v.get("spent_status")?.as_array()?;
    Some(arr.iter().map(|x| x.as_u64().unwrap_or(0)).collect())
}

/// Build the multi-node fallback pool: spread ONE connection across many distinct
/// nodes (each sees a single connection → no per-IP throttling). The primary daemon
/// is always first. Historical blocks are identical across nodes and every per-block
/// fetch is validated, so multi-node fetch is safe. In Tor mode all entries share
/// one TorClient (arti reuses circuits internally).
async fn build_fallback_pool<C: DaemonConnector>(
    app: &AppHandle,
    connector: &C,
    primary: &MoneroDaemon<C::Transport>,
    primary_url: &str,
    cap: usize,
) -> Vec<MoneroDaemon<C::Transport>> {
    use futures::stream::StreamExt;
    let mut pool = vec![primary.clone()];
    let others: Vec<(String, String)> = load_nodes(app, connector.section())
        .await
        .into_iter()
        .filter(|(_, u)| u != primary_url)
        .collect();
    let connected: Vec<Option<_>> = futures::stream::iter(others)
        .map(|(_, url)| {
            let connector = connector.clone();
            async move { connector.connect(url).await.ok() }
        })
        .buffer_unordered(cap)
        .collect()
        .await;
    for d in connected.into_iter().flatten() {
        pool.push(d);
        if pool.len() >= cap {
            break;
        }
    }
    pool
}

async fn scan_loop<C: DaemonConnector>(
    app: AppHandle,
    daemon: MoneroDaemon<C::Transport>,
    mut scan_height: u64,
    node_url: String,
    node_label: String,
    generation: u64,
    connector: &C,
) -> Result<(), String> {
    // Dynamic batch size based on gap — bigger gap = bigger batches for speed.
    // Monero daemon limits response to ~100MB, so we cap at 1000 blocks.
    let base_batch: u64 = 50;
    // Concurrent block fetches per batch (pipelined RPC round-trips). Tor
    // circuits add latency and arti builds them lazily, so fewer parallel
    // streams perform better over Tor; clearnet keeps wide parallelism.
    let fetch_concurrency: usize = if connector.section() == "tor" { 4 } else { 12 };
    // Built-in Tor and an external SOCKS proxy (Whonix) both report section "tor".
    // Those routes can be ~30 blk/s, so a batch is sized to what the route has
    // actually delivered (see proxied_batch_budget) instead of a fixed size that
    // can never finish under the watchdog.
    let proxied = connector.section() == "tor";

    // Opt-in "Fast sync" (Settings, default OFF): bulk-fetch each batch via
    // get_blocks.bin, trusting the node for tx content. Skips the prunable_hash
    // gate (monero #10120) that otherwise forces a slow per-block JSON fallback.
    // Output ownership is still proven cryptographically; the residual trust is
    // that the node doesn't hide/alter txs (recoverable by rescanning). On any
    // bulk error we fall back to the validated multi-node per-block path below.
    let fast_sync = read_config_bool(&app, "fast_sync");

    // One-time marker so it's obvious from the log whether THIS build includes
    // key-image spend detection (and whether it can run). If you don't see this
    // line, the running binary predates the feature — restart `tauri dev` so the
    // Rust side rebuilds (frontend HMR alone does NOT rebuild Rust).
    if app.state::<WalletState>().can_detect_spends().await {
        emit_log(&app, "Sync", "info", "🔑 Key-image spend detection: ON");
    } else {
        emit_log(
            &app,
            "Sync",
            "info",
            "🔑 Key-image spend detection: OFF (no spend key)",
        );
    }

    if scan_height == u64::MAX {
        emit_log(
            &app,
            "Sync",
            "info",
            "🔍 New wallet — will sync from daemon tip",
        );
    } else {
        emit_log(
            &app,
            "Sync",
            "info",
            &format!("🔍 Scan loop started from height {}", scan_height),
        );
    }
    // Restore baseline — the height this session's scan begins from (captured once,
    // after the sentinel/RingCT clamps below). Lets the UI show restore-range progress.
    // (Named restore_base, not scan_start, to avoid colliding with the per-batch timer.)
    let mut restore_base: Option<u64> = None;

    // The multi-node fallback pool. In NORMAL mode it's the primary fetch path, so
    // build it upfront (one connection spread across many nodes for parallelism).
    // In FAST mode a single node carries the whole sync via get_blocks.bin, so we
    // skip the upfront connections entirely and only build the pool lazily if a
    // bulk batch ever fails (see the fallback branch below).
    let mut pool = vec![daemon.clone()];
    if !fast_sync {
        pool = build_fallback_pool(&app, connector, &daemon, &node_url, fetch_concurrency).await;
    }
    let pool_n = pool.len();
    if fast_sync {
        emit_log(&app, "Sync", "info", &format!("⚡ Fast sync ON — bulk get_blocks.bin, trusting {} (fallback nodes spun up only if a batch fails)", node_label));
    } else {
        emit_log(
            &app,
            "Sync",
            "info",
            &format!("🔗 Fetching across {} nodes in parallel", pool_n),
        );
    }

    // Rolling measured throughput (blocks/sec), seeded then EMA-smoothed from real
    // batch timings so the ETA reflects actual speed. Fast sync is seeded high
    // (bulk path) so the first ETA isn't wildly pessimistic; both self-correct.
    let mut measured_bps: f64 = if fast_sync {
        80.0
    } else {
        (pool_n as f64) * 1.5
    };

    // Public nodes routinely drop the keep-alive connection after a big
    // get_blocks.bin response, so the next request fails with ConnectionReset.
    // That's almost always cured by an immediate reconnect — NOT a reason to
    // sleep 5s or abandon the node. We retry quickly a few times; only if the
    // node stays unresponsive do we return Err so run_outer re-races to a fresh
    // node (instead of looping forever on a dead one).
    const MAX_NODE_FAILURES: u32 = 3;
    let mut consecutive_failures = 0u32;

    // Adaptive bulk batch (fast sync). A bulk get_blocks.bin response for a dense
    // near-tip range can be too big to transfer within the request timeout, so on a
    // bulk failure we HALVE the batch and retry bulk (staying on the fast path) down
    // to a floor. Only if even a floor-sized bulk fails do we serve one validated
    // per-block batch and then re-race — never grinding the slow path forever on a
    // node that can't bulk. Successful batches grow it back toward the max.
    const MAX_BULK_BATCH: u64 = 1000;
    const MIN_BULK_BATCH: u64 = 100;
    // Proxied routes start small (4 × 50 = 200 blocks) and grow only as far as the
    // measured throughput allows; their floor is low enough to stay on bulk at a
    // few blocks per second. Ticket #8175618389: a fixed 4 × 1000 first batch at
    // ~28 blk/s needed ~140 s against a 75 s watchdog and never completed.
    const PROXIED_START_BULK_BATCH: u64 = 50;
    const PROXIED_MIN_BULK_BATCH: u64 = 10;
    let start_bulk = if proxied { PROXIED_START_BULK_BATCH } else { MAX_BULK_BATCH };
    let min_bulk = if proxied { PROXIED_MIN_BULK_BATCH } else { MIN_BULK_BATCH };
    let mut bulk_batch: u64 = start_bulk;
    // Set once a batch has been timed on this route (the seed is a guess).
    let mut throughput_measured = false;

    // Bulk fetches in flight per batch (fast sync). Over Tor the bottleneck is
    // circuit latency, not bandwidth, so we fetch BULK_STREAMS sub-ranges of
    // `bulk_batch` blocks concurrently against the trusted node and reassemble in
    // order — overlapping the round-trips the sequential path wasted. 4 matches the
    // Tor `fetch_concurrency` (wider hurts over Tor per arti's lazy circuit build).
    // How many a node takes is learned per node (fetch_health): mnr.network starts
    // at its Pro cap of 3, and every HTTP 429 drops one.

    // AIMD sizing to stop the batch from oscillating. A bulk timeout means K
    // concurrent responses of this size overwhelmed the circuit, so we remember the
    // largest size that WORKS (`bulk_ceiling`) and refuse to grow straight back into
    // the size that just failed — otherwise every success doubles into the failing
    // size, wasting ~half the fetches on doomed timeouts. We only probe ABOVE the
    // ceiling after a streak of clean fetches (region got sparser / circuit improved),
    // so the steady state settles at the sustainable size instead of bouncing.
    let mut bulk_ceiling: u64 = MAX_BULK_BATCH;
    let mut bulk_streak: u32 = 0;
    const GROW_PROBE_STREAK: u32 = 6;

    // One-shot spend-detection diagnostics (filter the console for "KIDIAG"):
    // `diag_inputs` fires on the first batch (confirms input key images are being
    // collected at all); `diag_sanity` fires once we have an owned output (checks
    // x·G == P, i.e. the spend key is correct).
    let mut diag_inputs_logged = false;
    let mut diag_sanity_logged = false;

    // Reconcile spends with the daemon once we reach the tip. The per-block
    // scan-based detection can miss spends; this asks the daemon directly (via
    // is_key_image_spent) which of our outputs are spent — authoritative, and it
    // works on an already-synced wallet without rescanning.
    let mut spend_reconciled = false;

    loop {
        // Check if superseded
        let ws = app.state::<WalletState>();
        if ws.current_scanner_generation() != generation {
            emit_log(&app, "Sync", "info", "🛑 Scan loop stopped (superseded)");
            return Ok(());
        }

        // Get daemon height
        let daemon_height = match daemon.latest_block_number().await {
            Ok(h) => h as u64,
            Err(e) => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_NODE_FAILURES {
                    return Err(format!(
                        "{} unresponsive ({} consecutive failures): {:?}",
                        node_label, consecutive_failures, e
                    ));
                }
                emit_log(
                    &app,
                    "Sync",
                    "warn",
                    &format!(
                        "⚠️ Height check failed ({}/{}) — reconnecting…",
                        consecutive_failures, MAX_NODE_FAILURES
                    ),
                );
                sleep(Duration::from_millis(400)).await;
                continue;
            }
        };

        if scan_height == u64::MAX {
            // New wallet sentinel — start near the tip.
            emit_log(
                &app,
                "Sync",
                "info",
                &format!(
                    "📦 New wallet: starting near daemon tip ({})",
                    daemon_height
                ),
            );
            scan_height = daemon_height.saturating_sub(10);
        }
        // A start height FAR above the tip is not a real height on this chain — e.g. a
        // mainnet date estimate handed to a stagenet wallet. Left alone, the wallet would
        // idle as "synced" until the tip caught up (years). Scan from the start instead.
        if start_beyond_tip(scan_height, daemon_height) {
            emit_log(
                &app,
                "Sync",
                "warn",
                &format!(
                    "⚠️ Start height {} is far above the node's tip {} — not a height on this chain; scanning from the start instead",
                    scan_height, daemon_height
                ),
            );
            scan_height = 0;
        }
        // NOTE: being slightly AHEAD of the daemon (scan_height == daemon_height + 1,
        // the normal fully-synced state) must NOT reset to near-tip — that caused an
        // infinite re-scan loop of the last ~10 blocks. The SYNCED check below handles
        // scan_height >= daemon_height by idling.

        // Skip pre-RingCT blocks — monero-wallet can only scan RingCT outputs
        if scan_height < RINGCT_FORK_HEIGHT {
            emit_log(&app, "Sync", "info", &format!("⏩ Skipping to RingCT fork (block {}), pre-RingCT blocks have no scannable outputs", RINGCT_FORK_HEIGHT));
            scan_height = RINGCT_FORK_HEIGHT;
        }
        // Lock in the restore baseline on the first iteration (after the clamps).
        if restore_base.is_none() {
            restore_base = Some(scan_height);
        }
        let restore_base = restore_base.unwrap_or(scan_height);

        if scan_height >= daemon_height {
            // Active wallet caught up — let the background pool run again.
            app.state::<crate::wallet::SyncPool>()
                .set_active_busy(false);
            // Persist the tip here too. update_sync_status is otherwise only called in
            // the batch-scan path below, which runs solely when there are NEW blocks to
            // scan. A wallet that resumes already at/near the tip goes straight to this
            // branch every iteration and never sets sync_status.daemon_height — leaving
            // tip_height() at 0, so balances()/get_spendable_outputs() treat EVERY output
            // as immature: unlocked balance reads 0, no spendable inputs, sends fail.
            if !ws.update_sync_status_for(generation, scan_height, daemon_height).await {
                emit_log(&app, "Sync", "info", "🛑 Scan loop stopped (superseded at tip)");
                return Ok(());
            }
            // Reconcile spends with the daemon once we're at the tip (authoritative,
            // catches spends made in any wallet — including before this feature).
            if !spend_reconciled {
                spend_reconciled = true;
                let unspent = ws.unspent_key_images().await;
                if !unspent.is_empty() {
                    emit_log(
                        &app,
                        "Scan",
                        "info",
                        &format!(
                            "🔁 Reconciling spend status of {} outputs with the daemon…",
                            unspent.len()
                        ),
                    );
                    let kis: Vec<String> = unspent.iter().map(|(_, k)| k.clone()).collect();
                    match query_spent_status(&daemon, &kis).await {
                        Some(status) => {
                            let spent_ids: Vec<String> = unspent
                                .iter()
                                .zip(status.iter())
                                .filter(|(_, s)| **s != 0)
                                .map(|((id, _), _)| id.clone())
                                .collect();
                            let n = ws.mark_ids_spent(&spent_ids).await;
                            if n > 0 {
                                ws.save_output_cache().await;
                                let bal = WalletState::format_xmr(ws.compute_balance().await);
                                emit_log(&app, "Scan", "success", &format!("📤 Reconciled spends: {} output(s) marked spent. Balance: {} XMR", n, bal));
                            } else {
                                emit_log(&app, "Scan", "info", "✓ No spent outputs found — balance already accurate");
                            }
                        }
                        None => emit_log(&app, "Scan", "warn", "⚠️ Spend reconciliation RPC failed (is_key_image_spent) — balance may over-count"),
                    }
                }
                // Push the (now reconciled) balance to the UI — frontend polling
                // stops once synced, so without this the displayed balance stays at
                // the pre-reconcile over-count.
                let (total, unlocked) = ws.balances(daemon_height).await;
                crate::emit_balance(&app, total, unlocked);
            }
            crate::emit_sync_status(
                &app,
                "SYNCED",
                scan_height,
                daemon_height,
                100.0,
                &node_label,
                restore_base,
            );
            sleep(Duration::from_secs(10)).await;
            continue;
        }

        // We have new blocks to scan — re-arm the daemon reconcile so it runs again
        // when we next catch up (to detect spends made since the last reconcile).
        spend_reconciled = false;

        // In fast-sync the whole batch comes back in ONE get_blocks.bin call, so
        // use a large batch. The validated per-block fallback gains nothing from
        // big batches, so keep those modest for smooth progress reporting.
        let gap = daemon_height - scan_height;

        // Pause the background "Sync all wallets" pool during a heavy catch-up so
        // it doesn't compete with the active wallet for the node + CPU. Resumes
        // automatically once the gap is small (and in the SYNCED branch above).
        app.state::<crate::wallet::SyncPool>()
            .set_active_busy(gap > 2_000);
        // On a proxied route, once throughput is known, no batch may need more than
        // PROXIED_BATCH_SECS at that rate.
        let budget = (proxied && throughput_measured).then(|| proxied_batch_budget(measured_bps));
        let bulk_streams = super::fetch_health::with(&node_url, |h| h.streams);
        // Sub-range size for this bulk batch (fast sync): the adaptive size, clamped
        // to the time budget split across the concurrent streams.
        let sub_size: u64 = match budget {
            Some(b) => bulk_batch.min((b / bulk_streams as u64).max(min_bulk)),
            None => bulk_batch,
        };
        let batch_size: u64 = if fast_sync {
            // K sub-ranges of `sub_size`, fetched concurrently (see bulk_parallel).
            (sub_size * bulk_streams as u64).min(gap)
        } else if proxied {
            budget.unwrap_or(PROXIED_PER_BLOCK_START).clamp(PROXIED_PER_BLOCK_MIN, 100).min(gap.max(1))
        } else if gap > 1_000 {
            100
        } else {
            base_batch
        };

        // Show ETA for large syncs, based on MEASURED throughput (updated
        // after each batch) rather than a hardcoded guess.
        // On a proxied route, only once a batch has been timed: before that the
        // figure is the fast-sync seed (80 blk/s), not this route's speed.
        if gap > 10_000 && (throughput_measured || !proxied) {
            let eta_secs = (gap as f64 / measured_bps.max(0.1)) as u64;
            let eta_mins = eta_secs / 60;
            let eta_hours = eta_mins / 60;
            if eta_hours > 0 {
                emit_log(
                    &app,
                    "Sync",
                    "info",
                    &format!(
                        "⏱️ ETA: ~{}h {}m ({} blocks remaining at {:.1} blk/s)",
                        eta_hours,
                        eta_mins % 60,
                        gap,
                        measured_bps
                    ),
                );
            } else {
                emit_log(
                    &app,
                    "Sync",
                    "info",
                    &format!(
                        "⏱️ ETA: ~{}m ({} blocks remaining at {:.1} blk/s)",
                        eta_mins, gap, measured_bps
                    ),
                );
            }
        }

        let mut batch_end = (scan_height + batch_size).min(daemon_height);
        let range = (scan_height as usize)..=(batch_end as usize);

        emit_log(
            &app,
            "Sync",
            "info",
            &format!(
                "📥 Fetching blocks {}-{} / {}",
                scan_height, batch_end, daemon_height
            ),
        );

        let mut fetch_start = std::time::Instant::now();
        // Set when a timeout pause already ran for this batch (the fallback branch),
        // so its own failure doesn't pause a second time.
        let mut paused_this_batch = false;
        // When set, this batch was served by the slow per-block fallback because the
        // node couldn't bulk even at the minimum size — re-race afterward to find a
        // bulk-capable node instead of staying slow.
        let mut reraise_for_bulk = false;
        // Set when only a prefix of a fast-sync batch arrived (fetch_health::partial
        // already recorded it — it isn't a clean batch).
        let mut partial_batch = false;
        // Fast sync: one bulk get_blocks.bin call for the whole batch (trusting the
        // node). Normal mode uses the validated per-block path across the pool.
        let parallel_result = if fast_sync {
            match with_deadline(bulk_parallel(
                &daemon,
                range.clone(),
                sub_size as usize,
                bulk_streams,
            ))
            .await
            {
                Ok((blocks, Some(e))) => {
                    // Some streams arrived, a later one didn't: scan what's contiguous,
                    // fetch the rest next round. Progress, but not a clean batch: a 429
                    // drops a stream, anything else halves the size; neither grows.
                    let e = format!("{:?}", e);
                    let rl = super::fetch_health::is_rate_limited(&e);
                    super::fetch_health::with(&node_url, |h| h.partial(rl));
                    partial_batch = true;
                    if !rl {
                        bulk_batch = (sub_size / 2).max(min_bulk);
                        bulk_ceiling = bulk_batch;
                    }
                    bulk_streak = 0;
                    batch_end = scan_height + blocks.len() as u64 - 1;
                    emit_log(&app, "Sync", "warn", &format!("⚡ Kept blocks {}-{}; the rest of the batch failed ({}) — refetching it next", scan_height, batch_end, e));
                    Ok(blocks)
                }
                Ok((blocks, None)) => {
                    // Grow the sub-range size after a clean fetch, but never straight
                    // back into a size that just timed out (see bulk_ceiling). Stay
                    // at/under the known-good ceiling; only probe above it after a
                    // streak of clean fetches earns it (then a timeout knocks it back).
                    bulk_streak = bulk_streak.saturating_add(1);
                    let want = (bulk_batch * 2).min(MAX_BULK_BATCH);
                    if want <= bulk_ceiling {
                        bulk_batch = want;
                    } else if bulk_streak >= GROW_PROBE_STREAK {
                        bulk_batch = want;
                        bulk_ceiling = want;
                        bulk_streak = 0;
                    }
                    Ok(blocks)
                }
                Err(e) if super::fetch_health::is_rate_limited(&e) => {
                    // The node turned down a stream (429): smaller batches won't help —
                    // fewer streams at once and a growing pause will.
                    let (wait, streams) = super::fetch_health::with(&node_url, |h| (h.failed(true), h.streams));
                    emit_log(&app, "Sync", "warn", &format!("⚡ {} is limiting us ({}) — {} stream(s) at once from now on", node_label, e, streams));
                    if !backoff_wait(&app, &node_label, wait, generation, streams).await {
                        return Ok(());
                    }
                    continue;
                }
                Err(e) if sub_size > min_bulk => {
                    // K concurrent responses of this size overwhelmed the circuit/timeout.
                    // HALVE and retry bulk (stay on the fast path), and remember the
                    // halved size as the ceiling so we don't immediately grow back into
                    // the size that just failed.
                    bulk_batch = (sub_size / 2).max(min_bulk);
                    bulk_ceiling = bulk_batch;
                    bulk_streak = 0;
                    emit_log(&app, "Sync", "warn", &format!("⚡ Bulk fetch failed ({:?}) — shrinking to {} blocks per stream ({} per batch) and retrying bulk", e, bulk_batch, bulk_batch * bulk_streams as u64));
                    proxied_timeout_pause(&app, proxied, &e).await;
                    let wait = super::fetch_health::with(&node_url, |h| h.failed(false));
                    if !backoff_wait(&app, &node_label, wait, generation, bulk_streams).await {
                        return Ok(());
                    }
                    continue;
                }
                Err(e) => {
                    // Even a floor-sized bulk failed: this node can't serve bulk. Serve
                    // THIS batch via the validated per-block path so we still progress,
                    // then re-race to hunt for a node that CAN bulk (resetting the batch
                    // size) — never grinding the slow path forever.
                    emit_log(&app, "Sync", "warn", &format!("⚡ Bulk unavailable on {} even at {} blocks ({:?}) — one validated per-block batch, then re-racing", node_label, min_bulk, e));
                    if pool.len() == 1 {
                        pool = build_fallback_pool(
                            &app,
                            connector,
                            &daemon,
                            &node_url,
                            fetch_concurrency,
                        )
                        .await;
                        emit_log(
                            &app,
                            "Sync",
                            "info",
                            &format!("🔗 Fallback pool ready: {} nodes", pool.len()),
                        );
                    }
                    reraise_for_bulk = true;
                    bulk_batch = start_bulk;
                    bulk_ceiling = MAX_BULK_BATCH;
                    bulk_streak = 0;
                    proxied_timeout_pause(&app, proxied, &e).await;
                    paused_this_batch = proxied && is_timeout(&e);
                    // Per-block costs several round-trips per block; over Tor a whole
                    // bulk-sized range can't finish under the watchdog, so take a
                    // per-block-sized slice of it (the rest is the next batch's).
                    // On clearnet too: 400 one-by-one blocks through a proxy can't
                    // finish under the 75 s watchdog either (2026-10-23 loop).
                    let per_block_max = if proxied { PROXIED_PER_BLOCK_START } else { PER_BLOCK_FALLBACK_MAX };
                    batch_end = batch_end.min(scan_height + per_block_max - 1);
                    emit_log(&app, "Sync", "info", &format!("📥 Per-block blocks {}-{} / {}", scan_height, batch_end, daemon_height));
                    // Time only the per-block fetch, not the failed bulk + pause.
                    fetch_start = std::time::Instant::now();
                    with_deadline(parallel_per_block(&pool, (scan_height as usize)..=(batch_end as usize))).await
                }
            }
        } else {
            with_deadline(parallel_per_block(&pool, range.clone())).await
        };
        match parallel_result {
            Ok(blocks) => {
                let fetch_ms = fetch_start.elapsed().as_millis();
                // Update rolling throughput (EMA) from this batch's real timing
                if fetch_ms > 0 && !blocks.is_empty() {
                    let batch_bps = blocks.len() as f64 / (fetch_ms as f64 / 1000.0);
                    // The first real timing replaces the seed outright — blending it
                    // with an optimistic guess would size the next proxied batch too big.
                    measured_bps = if throughput_measured { measured_bps * 0.6 + batch_bps * 0.4 } else { batch_bps };
                    throughput_measured = true;
                }
                let blk_s = if fetch_ms > 0 {
                    blocks.len() as f64 / (fetch_ms as f64 / 1000.0)
                } else {
                    0.0
                };
                emit_log(
                    &app,
                    "Sync",
                    "info",
                    &format!(
                        "✅ Got {} blocks in {}ms ({:.0} blk/s)",
                        blocks.len(),
                        fetch_ms,
                        blk_s
                    ),
                );
                // A successful fetch means the node is healthy — reset the failure counter.
                consecutive_failures = 0;
                if !partial_batch {
                    super::fetch_health::with(&node_url, |h| h.progress());
                }
                // Scan each block with the wallet's Scanner. This is CPU-bound and,
                // for recent (dense) blocks, can dominate wall-clock — far exceeding
                // the fetch time — so we time it separately to make the cost visible.
                let scan_start = std::time::Instant::now();
                let wallet_state = app.state::<WalletState>();
                if let Some(mut scanner) = wallet_state.get_scanner().await {
                    let mut new_output_count = 0u64;
                    let mut new_amount = 0u64;
                    // Map each spent input key image in this batch to (spending txid,
                    // height) — used to detect which owned outputs were spent (incl.
                    // spends made in other wallets) AND to record the outgoing tx.
                    // block.transactions[k] is the hash of the k-th parsed tx, which we
                    // use as the txid (we can't recompute pruned-tx hashes ourselves).
                    let mut ki_to_tx: HashMap<[u8; 32], ([u8; 32], u64)> = HashMap::new();

                    // Discovery can widen the watched subaddress window mid-batch (an
                    // output at a new index → add_outputs registers the next 200). The
                    // scanner is refreshed at once, and DiscoveryCursor re-visits exactly
                    // the blocks scanned with an older window (they are never fetched
                    // again). add_outputs dedupes by output id; the key-image map is
                    // idempotent. With no discovery every block is visited once.
                    let mut cursor = DiscoveryCursor::new(blocks.len());
                    while let Some(i) = cursor.next_block() {
                        let block = &blocks[i];
                        let mut window_grew = false;
                        // Blocks are fetched in range order starting at scan_height,
                        // so the i-th block is at height scan_height + i.
                        let block_height = scan_height + i as u64;
                        match scanner.scan(block.clone()) {
                            Ok(timelocked) => {
                                let outputs = timelocked.ignore_additional_timelock();
                                if !outputs.is_empty() {
                                    // Real block header time (Unix s) — stable, unlike the
                                    // now−(tip−height)·120 estimate that drifts during sync.
                                    let block_ts = block.block.header.timestamp;
                                    let added = wallet_state
                                        .add_outputs(outputs, block_height, block_ts, generation)
                                        .await;
                                    // Count what was NEW, so a re-scan can't double the log.
                                    new_output_count += added.count;
                                    new_amount += added.amount;
                                    window_grew = added.grew;
                                }
                            }
                            Err(e) => {
                                emit_log(
                                    &app,
                                    "Scan",
                                    "error",
                                    &format!("⚠️ Scan error at ~{}: {:?}", scan_height, e),
                                );
                            }
                        }
                        // Collect key image -> spending tx for this block's (non-miner) txs.
                        for (tx_idx, tx) in block.transactions.iter().enumerate() {
                            let txid = block
                                .block
                                .transactions
                                .get(tx_idx)
                                .copied()
                                .unwrap_or([0u8; 32]);
                            for input in &tx.prefix().inputs {
                                if let monero_oxide::transaction::Input::ToKey {
                                    key_image, ..
                                } = input
                                {
                                    ki_to_tx.insert(key_image.to_bytes(), (txid, block_height));
                                }
                            }
                        }
                        cursor.scanned(i, window_grew);
                        if window_grew {
                            if let Some(s) = wallet_state.get_scanner().await {
                                scanner = s;
                            }
                        }
                    }
                    if cursor.revisits() > 0 {
                        emit_log(
                            &app,
                            "Scan",
                            "info",
                            &format!(
                                "🔁 New subaddresses in use — re-scanned {} block(s) of {}-{} with the wider window",
                                cursor.revisits(), scan_height, batch_end
                            ),
                        );
                    }

                    let scan_ms = scan_start.elapsed().as_millis();
                    let scan_bps = if scan_ms > 0 {
                        blocks.len() as f64 / (scan_ms as f64 / 1000.0)
                    } else {
                        0.0
                    };
                    emit_log(
                        &app,
                        "Scan",
                        "info",
                        &format!(
                            "🔬 Scanned {} blocks in {}ms ({:.0} blk/s)",
                            blocks.len(),
                            scan_ms,
                            scan_bps
                        ),
                    );

                    // Diagnostics (filter console for KIDIAG).
                    if !diag_inputs_logged {
                        emit_log(&app, "Scan", "warn", &format!("🔧 KIDIAG-inputs first batch [{}-{}]: collected {} input key images, txs={}", scan_height, batch_end, ki_to_tx.len(), blocks.iter().map(|b| b.transactions.len()).sum::<usize>()));
                        diag_inputs_logged = true;
                    }
                    if !diag_sanity_logged {
                        if let Some(diag) = wallet_state.first_output_kidiag().await {
                            emit_log(&app, "Scan", "warn", &format!("🔧 KIDIAG-sanity {}", diag));
                            diag_sanity_logged = true;
                        }
                    }

                    // Detect spends + record outgoing ledger entries for the spending
                    // txs. Requires the spend key (active wallet only).
                    let newly_spent = wallet_state
                        .detect_and_record_spends(&ki_to_tx, daemon_height, scan_height, batch_end, generation)
                        .await;
                    if newly_spent > 0 {
                        emit_log(
                            &app,
                            "Scan",
                            "info",
                            &format!(
                                "📤 Detected {} spent output(s) in blocks {}-{}",
                                newly_spent, scan_height, batch_end
                            ),
                        );
                        let (total, unlocked) = wallet_state.balances(daemon_height).await;
                        crate::emit_balance(&app, total, unlocked);
                    }

                    if new_output_count > 0 {
                        emit_log(
                            &app,
                            "Scan",
                            "success",
                            &format!(
                                "💰 Found {} outputs ({} piconero) in blocks {}-{}",
                                new_output_count, new_amount, scan_height, batch_end
                            ),
                        );
                        let total = wallet_state.compute_balance().await;
                        crate::emit_sync_status(
                            &app,
                            "SYNCING",
                            scan_height,
                            daemon_height,
                            (scan_height as f64 / daemon_height as f64) * 100.0,
                            &node_label,
                            restore_base,
                        );
                    }
                }

                scan_height = batch_end + 1;

                // Update scan height in state — only while this scanner is still
                // current, checked under the same lock a rescan resets in, so a
                // superseded scanner can't write its height over a rescan's.
                let ws = app.state::<WalletState>();
                if !ws.update_sync_status_for(generation, scan_height, daemon_height).await {
                    emit_log(
                        &app,
                        "Sync",
                        "info",
                        "🛑 Scan loop stopped (superseded after batch)",
                    );
                    return Ok(());
                }

                // Persist progress after EVERY batch. The old `scan_height % 500`
                // heuristic drifted with the batch step and rarely fired, so the
                // cache froze tens of thousands of blocks behind the live scan —
                // and since unlock/restart resumes from the persisted height, all
                // that progress was lost on every relaunch. The cache is small
                // (serialized owned outputs only), so saving each batch is cheap.
                ws.save_output_cache().await;
            }
            Err(e) => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_NODE_FAILURES {
                    return Err(format!(
                        "{} block fetch failing ({} consecutive): {:?}",
                        node_label, consecutive_failures, e
                    ));
                }
                emit_log(
                    &app,
                    "Sync",
                    "warn",
                    &format!(
                        "⚠️ Block fetch failed {}-{} ({}/{}) — reconnecting…",
                        scan_height, batch_end, consecutive_failures, MAX_NODE_FAILURES
                    ),
                );
                if !paused_this_batch {
                    proxied_timeout_pause(&app, proxied, &e).await;
                }
                let rl = super::fetch_health::is_rate_limited(&e);
                let (wait, streams) = super::fetch_health::with(&node_url, |h| (h.failed(rl), h.streams));
                if !backoff_wait(&app, &node_label, wait, generation, streams).await {
                    return Ok(());
                }
                sleep(Duration::from_millis(400)).await;
                continue;
            }
        }

        // This batch was served by per-block because the node couldn't bulk. We've
        // persisted its progress above; now re-race for a bulk-capable node so fast
        // sync resumes rather than crawling the slow path on a bulk-hostile node.
        if reraise_for_bulk {
            return Err(format!(
                "{} can't serve bulk — re-racing for a faster node",
                node_label
            ));
        }

        // Emit sync progress
        let percent = if daemon_height > 0 {
            (scan_height as f64 / daemon_height as f64) * 100.0
        } else {
            0.0
        };
        crate::emit_sync_status(
            &app,
            "SYNCING",
            scan_height,
            daemon_height,
            percent,
            &node_label,
            restore_base,
        );
    }
}

// ── Background multi-wallet sync ("Sync all wallets") ──
//
// Scans a NON-active wallet from `view_pair` alone (no spend key), keeping its
// <id>.cache warm so switching to it is instant. Independent of WalletState; it
// owns its own scanner + cache and never touches the active wallet's state.

/// Dispatch the background scan for one pooled wallet over the configured route.
pub(crate) async fn run_pool_scan(
    app: AppHandle,
    identity_id: String,
    view_pair: ViewPair,
    from_height: u64,
    cancel: Arc<AtomicBool>,
) {
    match read_routing_mode(&app).as_str() {
        "tor" => {
            if let Some(tor) = ensure_tor(&app).await {
                pool_loop(app, identity_id, view_pair, from_height, cancel, TorConnector { tor }).await;
            }
        }
        "custom" => {
            let proxy = read_proxy_address(&app);
            if !proxy.trim().is_empty() {
                pool_loop(app, identity_id, view_pair, from_height, cancel, CustomProxyConnector { proxy }).await;
            }
        }
        "clearnet" => pool_loop(app, identity_id, view_pair, from_height, cancel, ClearnetConnector).await,
        other => emit_log(
            &app,
            "Network",
            "error",
            &format!("❌ Unknown routing mode {other:?}. Background sync paused rather than falling back to clearnet."),
        ),
    }
}

async fn pool_loop<C: DaemonConnector>(
    app: AppHandle,
    identity_id: String,
    view_pair: ViewPair,
    mut scan_height: u64,
    cancel: Arc<AtomicBool>,
    connector: C,
) {
    use futures::stream::StreamExt;

    let data_dir = app.state::<WalletState>().data_dir().await;

    // Resume from (and accumulate into) the wallet's own cache.
    let mut cache = storage::load_output_cache(&data_dir, &identity_id);

    // View-only scanner watching the same wallet2-sized window as the active wallet
    // (state::lookahead_indices), seeded with the indices its cached outputs show are
    // in use. ~10k key derivations, so build it off the async workers.
    let mut next: HashMap<u32, u32> = HashMap::from([(0u32, 1u32)]);
    let mut seen: HashSet<String> = HashSet::new();
    for c in &cache.outputs {
        seen.insert(format!("{}:{}", c.tx_hash, c.tx_index));
        if let Ok(o) = monero_wallet::WalletOutput::read(&mut c.data.as_slice()) {
            if let Some(s) = o.subaddress() {
                bump_next(&mut next, s.account(), s.address());
            }
        }
    }
    let window = lookahead_indices(&next);
    let vp = view_pair.clone();
    let mut scanner = match tokio::task::spawn_blocking(move || {
        let mut s = Scanner::new(vp);
        for (account, index) in window {
            if let Some(idx) = SubaddressIndex::new(account, index) {
                s.register_subaddress(idx);
            }
        }
        s
    })
    .await
    {
        Ok(s) => s,
        Err(_) => return,
    };
    if cache.scan_height > scan_height {
        scan_height = cache.scan_height;
    }
    if scan_height < RINGCT_FORK_HEIGHT {
        scan_height = RINGCT_FORK_HEIGHT;
    }

    let short = identity_id
        .chars()
        .rev()
        .take(7)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();

    // Opt-in fast sync (same trade-off as the active scanner; see scan_loop).
    let fast_sync = read_config_bool(&app, "fast_sync");
    // Proxied routes (built-in Tor / external SOCKS): size each background batch to
    // PROXIED_BATCH_SECS at the throughput this loop has measured, like scan_loop.
    let proxied = connector.section() == "tor";
    let mut bg_bps: Option<f64> = None;

    'outer: loop {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        // The active wallet scans itself via WalletState — never double-scan it.
        if app
            .state::<WalletState>()
            .is_active_identity(&identity_id)
            .await
        {
            return;
        }

        let (_, _, daemon) = match race_nodes(&app, &connector).await.winner {
            Some(r) => r,
            None => {
                sleep(Duration::from_secs(15)).await;
                continue;
            }
        };

        loop {
            if cancel.load(Ordering::SeqCst)
                || app
                    .state::<WalletState>()
                    .is_active_identity(&identity_id)
                    .await
            {
                return;
            }
            // Back off while the active wallet is doing a heavy catch-up, so we
            // don't compete for the node + CPU (resumes when it's caught up).
            if app.state::<crate::wallet::SyncPool>().is_active_busy() {
                sleep(Duration::from_secs(5)).await;
                continue;
            }
            let daemon_height = match daemon.latest_block_number().await {
                Ok(h) => h as u64,
                Err(_) => continue 'outer, // re-race
            };
            // Same start-height rules as the active scan loop: the new-wallet sentinel
            // starts near the tip, and an impossible height (far above this chain's tip)
            // scans from the start. Without these a background wallet "synced" at
            // u64::MAX — and saved that — forever.
            if scan_height == u64::MAX {
                scan_height = daemon_height.saturating_sub(10);
            } else if start_beyond_tip(scan_height, daemon_height) {
                log::warn!("[bg {short}] start height {scan_height} is far above the tip {daemon_height}; scanning from the start");
                scan_height = RINGCT_FORK_HEIGHT;
            }
            if scan_height >= daemon_height {
                cache.scan_height = scan_height;
                let _ = storage::save_output_cache(&data_dir, &identity_id, &cache);
                log::info!("[bg {short}] synced to {scan_height}");
                sleep(Duration::from_secs(30)).await;
                continue;
            }

            let batch_step: u64 = match (proxied, fast_sync) {
                (false, true) => 1000,
                (false, false) => 100,
                (true, true) => bg_bps.map(proxied_batch_budget).unwrap_or(200).clamp(20, 1000),
                (true, false) => bg_bps.map(proxied_batch_budget).unwrap_or(PROXIED_PER_BLOCK_START).clamp(PROXIED_PER_BLOCK_MIN, 100),
            };
            let batch_end = (scan_height + batch_step).min(daemon_height);
            let fetch_start = std::time::Instant::now();
            let range = (scan_height as usize)..=(batch_end as usize);
            let per_block = || async {
                let r: Result<Vec<_>, _> = futures::stream::iter(range.clone())
                    .map(|n| ProvidesScannableBlocks::scannable_block_by_number(&daemon, n))
                    .buffered(4)
                    .collect::<Vec<_>>()
                    .await
                    .into_iter()
                    .collect();
                r
            };
            // Fast sync: one bulk get_blocks.bin call (trusting node); fall back to
            // the validated per-block path on any error.
            let fetched = if fast_sync {
                match daemon
                    .bulk_scannable_blocks_trusting_node(range.clone())
                    .await
                {
                    Ok(b) => Ok(b),
                    Err(_) => per_block().await,
                }
            } else {
                per_block().await
            };
            let blocks = match fetched {
                Ok(b) => b,
                Err(_) => continue 'outer, // re-race
            };
            let secs = fetch_start.elapsed().as_secs_f64();
            if secs > 0.0 && !blocks.is_empty() {
                let bps = blocks.len() as f64 / secs;
                bg_bps = Some(bg_bps.map_or(bps, |prev| prev * 0.6 + bps * 0.4));
            }

            // Same discovery as the active scan loop: an output at a new index widens
            // the window, and the batch is re-scanned in memory until nothing widens.
            // `seen` keeps re-scans (and re-raced overlaps) from duplicating outputs.
            let mut cursor = DiscoveryCursor::new(blocks.len());
            while let Some(i) = cursor.next_block() {
                let block = &blocks[i];
                let h = scan_height + i as u64;
                let before = next.clone();
                if let Ok(timelocked) = scanner.scan(block.clone()) {
                    for o in timelocked.ignore_additional_timelock() {
                        if !seen.insert(format!("{}:{}", hex::encode(o.transaction()), o.index_in_transaction())) {
                            continue;
                        }
                        if let Some(s) = o.subaddress() {
                            bump_next(&mut next, s.account(), s.address());
                        }
                        cache.outputs.push(storage::CachedOutput {
                            data: o.serialize(),
                            amount: o.commitment().amount,
                            tx_hash: hex::encode(o.transaction()),
                            tx_index: o.index_in_transaction(),
                            subaddress: o.subaddress().map(|s| s.address()),
                            height: h,
                            timestamp: block.block.header.timestamp,
                        });
                    }
                }
                let growth = window_growth(&before, &next);
                for &(account, index) in &growth {
                    if let Some(idx) = SubaddressIndex::new(account, index) {
                        scanner.register_subaddress(idx);
                    }
                }
                cursor.scanned(i, !growth.is_empty());
            }
            scan_height = batch_end + 1;
            cache.scan_height = scan_height;
            let _ = storage::save_output_cache(&data_dir, &identity_id, &cache);
            log::info!(
                "[bg {short}] {scan_height} / {daemon_height} ({} outputs)",
                cache.outputs.len()
            );
        }
    }
}

#[cfg(test)]
mod discovery_cursor_tests {
    use super::DiscoveryCursor;
    use std::collections::BTreeSet;

    /// Drive the cursor like the scan loops do, over a fake chain: `blocks[i]` holds the
    /// subaddress indices paid in block i; the "scanner" sees an index only if it is
    /// within the window — the highest used index (starting at `known`) rounded up to
    /// WINDOW_STEP, plus the 200 lookahead, exactly as state::lookahead_indices.
    /// Returns (indices found, block visits).
    fn edge(highest: u32) -> u32 {
        use crate::wallet::state::{SUBADDRESS_LOOKAHEAD, WINDOW_STEP};
        highest.div_ceil(WINDOW_STEP) * WINDOW_STEP + SUBADDRESS_LOOKAHEAD
    }
    fn run_from(known: u32, blocks: &[Vec<u32>]) -> (BTreeSet<u32>, usize) {
        let mut window = edge(known);
        let mut found = BTreeSet::new();
        let mut cursor = DiscoveryCursor::new(blocks.len());
        let mut visits = 0;
        while let Some(i) = cursor.next_block() {
            visits += 1;
            let visible_window = window; // the scanner as refreshed before this block
            let mut grew = false;
            for &idx in &blocks[i] {
                if idx <= visible_window && found.insert(idx) && edge(idx) > window {
                    window = edge(idx);
                    grew = true;
                }
            }
            cursor.scanned(i, grew);
        }
        (found, visits)
    }
    fn run(blocks: &[Vec<u32>]) -> (BTreeSet<u32>, usize) {
        run_from(0, blocks)
    }

    #[test]
    fn outputs_inside_the_current_window_step_cost_no_revisits() {
        // The wallet already used index 40, so indices up to 50 don't widen the window.
        let (found, visits) = run_from(40, &[vec![], vec![5], vec![], vec![47]]);
        assert_eq!(found, BTreeSet::from([5, 47]));
        assert_eq!(visits, 4);
    }

    #[test]
    fn an_output_beyond_the_window_earlier_in_the_batch_is_found() {
        // #230 in block 0 is invisible until #150 (block 3) widens the window to 350.
        let (found, visits) = run(&[vec![230], vec![], vec![], vec![150], vec![], vec![]]);
        assert_eq!(found, BTreeSet::from([150, 230]));
        // Pass 1: 6 visits. Block 3 widened → blocks 0..=3 revisited; block 0 widens
        // again (#230 → 430) → everything scanned with the older window is revisited.
        assert!(visits > 6 && visits <= 6 * 3, "visits = {visits}");
    }

    #[test]
    fn chained_discoveries_inside_one_batch_are_all_found() {
        // Each index is only visible once the previous one is found; they appear in
        // REVERSE block order, the worst case for a single forward pass.
        let (found, _) = run(&[vec![790], vec![590], vec![390], vec![190]]);
        assert_eq!(found, BTreeSet::from([190, 390, 590, 790]));
    }

    #[test]
    fn an_index_past_any_lookahead_stays_unseen_like_wallet2() {
        // #10 widens the window to 250 (block 1 → revisit 0..=1); #900 stays out of reach.
        let (found, visits) = run(&[vec![900], vec![10]]);
        assert_eq!(found, BTreeSet::from([10]));
        assert!(visits <= 4, "visits = {visits}");
    }

    #[test]
    fn many_new_indices_widen_rarely() {
        // 40 blocks each paying the next subaddress (1..=40): one step, so at most one
        // widening and one revisit pass — not 40.
        let blocks: Vec<Vec<u32>> = (1..=40).map(|i| vec![i]).collect();
        let (found, visits) = run(&blocks);
        assert_eq!(found.len(), 40);
        assert!(visits <= 40 + 2, "visits = {visits}");
    }
}

#[cfg(test)]
mod proxied_budget_tests {
    use super::{is_timeout, proxied_batch_budget, start_beyond_tip, PROXIED_BATCH_SECS};

    #[test]
    fn only_an_impossible_start_height_is_reset() {
        // A mainnet estimate on stagenet (tip ~1.9M) is reset…
        assert!(start_beyond_tip(3_783_000, 1_900_000));
        // …a node merely a few days behind the wallet's cache is not.
        assert!(!start_beyond_tip(3_790_000, 3_785_000));
        assert!(!start_beyond_tip(3_790_000 + 99_000, 3_790_000));
        // The new-wallet sentinel and an unknown tip are never touched.
        assert!(!start_beyond_tip(u64::MAX, 1_900_000));
        assert!(!start_beyond_tip(3_783_000, 0));
    }

    #[test]
    fn only_timeouts_trigger_the_pause() {
        assert!(is_timeout("watchdog: fetch exceeded 75s — node/circuit stalled, recovering"));
        assert!(is_timeout("SOCKS request to abc.onion:18089 timed out"));
        assert!(!is_timeout("HTTP 403 Forbidden"));
        assert!(!is_timeout("InvalidNode(\"wrong block hash\")"));
    }

    #[test]
    fn budget_tracks_measured_throughput() {
        // Ticket #8175618389: ~28 blk/s over Whonix → 840 blocks, ~30 s, not 4000 (~140 s).
        assert_eq!(proxied_batch_budget(28.0), 840);
        assert!(proxied_batch_budget(28.0) as f64 / 28.0 <= PROXIED_BATCH_SECS);
        assert_eq!(proxied_batch_budget(0.5), 15);
        assert_eq!(proxied_batch_budget(0.0), 1);
        assert_eq!(proxied_batch_budget(f64::NAN), 1);
        assert_eq!(proxied_batch_budget(-3.0), 1);
    }
}

#[cfg(test)]
mod fold_tests {
    use super::{fold_fullwidth, known_routing_mode};

    #[test]
    fn folds_fullwidth_colon_and_digits() {
        // CJK-IME fullwidth colon + fullwidth digits → ASCII host:port.
        assert_eq!(fold_fullwidth("127.0.0.1：17890"), "127.0.0.1:17890");
        assert_eq!(
            fold_fullwidth("１２７．０．０．１：９０５０"),
            "127.0.0.1:9050"
        );
    }
    #[test]
    fn leaves_ascii_untouched() {
        assert_eq!(fold_fullwidth("127.0.0.1:9050"), "127.0.0.1:9050");
        assert_eq!(
            fold_fullwidth("socks5://localhost:1080"),
            "socks5://localhost:1080"
        );
    }
    #[test]
    fn folds_ideographic_space() {
        assert_eq!(fold_fullwidth("a\u{3000}b"), "a b");
    }
    #[test]
    fn only_legacy_routing_values_are_network_capable() {
        for mode in ["tor", "clearnet", "custom"] {
            assert!(known_routing_mode(mode));
        }
        for mode in ["torOverVpn", "vpn", "", "TOR"] {
            assert!(!known_routing_mode(mode));
        }
    }
}

#[cfg(test)]
mod connect_smoke {
    use monero_daemon_rpc::prelude::*;
    use monero_simple_request_rpc::SimpleRequestTransport;

    // Reproduce the app's exact clearnet connect path against a known-reachable
    // node. Run: cargo test -p ripley-terminal clearnet_connect -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn clearnet_connect() {
        let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
        let url = "http://xmr-node.cakewallet.com:18081".to_string();
        match SimpleRequestTransport::new(url.clone()).await {
            Ok(daemon) => {
                let h = daemon.latest_block_number().await;
                println!("✅ connected {url} -> height {h:?}");
                assert!(h.is_ok());
            }
            Err(e) => panic!("❌ SimpleRequestTransport::new({url}) failed: {e:?}"),
        }
    }

    // Probe which nodes serve get_blocks.bin (bulk). 30-block contiguous fetch:
    // fast (<2s) ⇒ bulk path; slow (>8s) ⇒ per-block JSON fallback.
    // Run: cargo test -p ripley-terminal bulk_probe -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn bulk_probe() {
        let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
        let nodes = [
            "http://xmr-node.cakewallet.com:18081",
            "http://node3-us.monero.love:18081",
            "http://node2-eu.monero.love:18089",
            "http://node.monerodevs.org:18089",
            "http://nodes.hashvault.pro:18081",
        ];
        let start = 3_400_000usize;
        for url in nodes {
            let daemon = match SimpleRequestTransport::new(url.to_string()).await {
                Ok(d) => d,
                Err(e) => {
                    println!("⚠️  {url}: connect failed {e:?}");
                    continue;
                }
            };
            let t = std::time::Instant::now();
            let r =
                ProvidesScannableBlocks::contiguous_scannable_blocks(&daemon, start..=(start + 29))
                    .await;
            let ms = t.elapsed().as_millis();
            match r {
                Ok(b) => println!(
                    "{} {url}: {} blocks in {}ms ({:.0} blk/s)",
                    if ms < 2500 {
                        "🚀 BULK"
                    } else {
                        "🐌 FALLBACK"
                    },
                    b.len(),
                    ms,
                    b.len() as f64 / (ms.max(1) as f64 / 1000.0)
                ),
                Err(e) => println!("❌ {url}: {e:?}"),
            }
        }
    }

    // Exercise the app's real clearnet transport (ReqwestTransport, the same path
    // the custom-node setting takes) against an arbitrary daemon URL — every
    // route a sync + spend needs, in the order the scanner uses them. Meant for
    // proxies that allow-list methods (e.g. mnr.network's /v1/<token> URLs).
    // Run: RIPLEY_PROBE_NODE=https://host/base cargo test -p ripley-terminal node_probe -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn node_probe() {
        let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
        let url = std::env::var("RIPLEY_PROBE_NODE").expect("set RIPLEY_PROBE_NODE=<daemon url>");
        // Never echo the URL: a proxy token may live in its path.
        let daemon = crate::wallet::reqwest_transport::ReqwestTransport::connect(
            url,
            std::time::Duration::from_secs(60),
        )
        .await
        .expect("connect (get_height)");
        let tip = daemon
            .latest_block_number()
            .await
            .expect("latest_block_number");
        println!("✅ /get_height -> {tip}");

        let fee = daemon
            .fee_rate(FeePriority::Normal, 500_000)
            .await
            .expect("get_fee_estimate");
        println!("✅ get_fee_estimate -> {fee:?}");

        let start = tip.saturating_sub(120);
        let t = std::time::Instant::now();
        let blocks = daemon
            .bulk_scannable_blocks_trusting_node(start..=(start + 99))
            .await
            .expect("get_blocks.bin (trusting bulk)");
        println!(
            "✅ /get_blocks.bin -> {} blocks in {}ms",
            blocks.len(),
            t.elapsed().as_millis()
        );
        assert_eq!(blocks.len(), 100);

        let dist = daemon
            .ringct_output_distribution(start..=(start + 99))
            .await
            .expect("get_output_distribution.bin");
        println!("✅ /get_output_distribution.bin -> {} entries", dist.len());
        let last = *dist.last().expect("distribution non-empty");
        assert!(last > 0);

        let idx = [
            last.saturating_sub(3),
            last.saturating_sub(2),
            last.saturating_sub(1),
        ];
        let outs = daemon.ringct_outputs(&idx).await.expect("get_outs.bin");
        println!("✅ /get_outs.bin -> {} outputs", outs.len());
        assert_eq!(outs.len(), idx.len());

        let tx_hash = blocks
            .iter()
            .flat_map(|b| b.block.transactions.iter().copied())
            .next()
            .expect("a non-miner tx in the window");
        let txs = daemon
            .transactions(&[tx_hash])
            .await
            .expect("/get_transactions");
        println!("✅ /get_transactions -> {} tx", txs.len());
        let oi = daemon
            .output_indexes(tx_hash)
            .await
            .expect("get_o_indexes.bin");
        println!("✅ /get_o_indexes.bin -> {} indexes", oi.len());

        let body = serde_json::json!({ "key_images": [format!("{:064x}", 1u8)] }).to_string();
        let res = daemon
            .rpc_call("is_key_image_spent", Some(body), 1024 * 1024)
            .await
            .expect("/is_key_image_spent");
        println!("✅ /is_key_image_spent -> {} bytes", res.len());
        println!("🎉 every sync/spend route answered (send_raw_transaction not exercised)");
    }

    // Measures the FORK's trusting bulk path (get_blocks.bin without prunable_hash).
    // Run: cargo test -p ripley-terminal fast_bulk_speed -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn fast_bulk_speed() {
        let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
        let daemon =
            SimpleRequestTransport::new("http://xmr-node.cakewallet.com:18081".to_string())
                .await
                .expect("connect");
        let start = 3_400_000usize;
        let t = std::time::Instant::now();
        let blocks = daemon
            .bulk_scannable_blocks_trusting_node(start..=(start + 999))
            .await
            .expect("bulk trusting fetch");
        let ms = t.elapsed().as_millis().max(1);
        println!(
            "⚡ fast bulk: {} blocks in {}ms ({:.0} blk/s)",
            blocks.len(),
            ms,
            blocks.len() as f64 / (ms as f64 / 1000.0)
        );
        assert_eq!(blocks.len(), 1000);
        let with_idx = blocks
            .iter()
            .filter(|b| b.output_index_for_first_ringct_output.is_some())
            .count();
        println!("   {with_idx}/1000 blocks carry a first-ringct output index");
        assert!(
            with_idx > 0,
            "no output indices populated — spending would break"
        );
    }
}

#[cfg(test)]
mod pinned_hint_tests {
    use super::pinned_hint;

    #[test]
    fn hints_only_for_mnr_and_only_for_token_problems() {
        let expired = "node refused: HTTP 403 · subscription expired (-32001)";
        assert!(pinned_hint("rpc.mnr.network", expired).unwrap().contains("renew"));
        assert!(pinned_hint("rpc.mnr.network", "node refused: HTTP 401 · unknown token (-32600)").unwrap().contains("new token"));
        assert_eq!(pinned_hint("rpc.mnr.network", "daemon init failed: timeout"), None);
        assert_eq!(pinned_hint("node.example.org", expired), None);
    }
}
