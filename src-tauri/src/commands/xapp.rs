// ---- X app (plans: ripley-os/plans/x-app-xmradar.md) ----
// A second embedded child webview, label "xapp", for x.com only — separate from the Browser
// app's view (ros-embed): its own cookie / storage store (macOS 14+ data store id, a data directory on
// Windows / Linux), its own routing-mode record, and every command here touches only XAPP_LABEL,
// so opening, navigating or closing the Browser never replaces the X view (and the reverse).
//
// Navigation: on macOS wry asks the navigation hook about EVERY navigation, frames included, with
// no main-frame flag — and X's login / media need third-party iframes. So the hook allows ordinary
// web schemes and refuses local / privileged ones; links leaving X are routed to the Browser app
// from the two places that are top-level only: new windows (target=_blank, window.open) and a small
// main-frame script that turns a click on an external link into a `ripley-open:` navigation the
// hook catches. Residual (stated): X's own script moving the whole page elsewhere stays in this
// view — same store and same proxy, so it's a convenience gap, not a leak.
#[cfg(not(target_os = "macos"))]
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::system::{embed_pin_zoom, parse_rgb, resolve_browser_proxy};

pub const XAPP_LABEL: &str = "xapp";
/// The X app's own WKWebsiteDataStore (macOS 14+). Fixed, so the login survives restarts.
const XAPP_STORE_ID: [u8; 16] = *b"ripley-xapp-v1\0\0";

/// The route the view was created on: mode + the Tor port / the custom proxy (its proxy is fixed at
/// creation, so a different port or proxy is as stale as a different mode).
static XAPP_MODE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// Per-view secret known only to the main-frame link script (frames never run it and can't read the
/// top frame cross-origin): a payment URI reaches the wallet only as `ripley-uri:<secret>:<uri>`.
static XAPP_NONCE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// The last X page loaded at the top level — where a top-level move off X is sent back to.
static XAPP_LAST_X: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

// XMRadar in X's page asks RipleyOS through `xapp_bridge` (plans/x-app-xmradar.md R4/R13/R16): requests
// waiting for RipleyOS's answer, by id. Bounded: request size, answer size, how many at once, how long.
const BRIDGE_MAX_REQUEST: usize = 16 * 1024;
const BRIDGE_MAX_ANSWER: usize = 64 * 1024;
const BRIDGE_MAX_IN_FLIGHT: usize = 8;
const BRIDGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// Ripley's settings pushed into X's page (`xapp_push`).
const PUSH_MAX: usize = 64 * 1024;
static BRIDGE_NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static BRIDGE_PENDING: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<u64, tokio::sync::oneshot::Sender<String>>>> =
    std::sync::LazyLock::new(Default::default);

fn normalize_proxy(raw: &str) -> String {
    let folded = crate::wallet::scanner::fold_fullwidth(raw);
    let t = folded.trim();
    for prefix in ["socks5h://", "socks5://", "socks://", "http://"] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return rest.trim_end_matches('/').to_string();
        }
    }
    t.to_string()
}

/// "mode", "tor|<port>" or "custom|<host:port>".
fn route_fingerprint(mode: &str, proxy: &str) -> String {
    match mode {
        "tor" => format!("tor|{}", crate::tor::socks_port()),
        "custom" => format!("custom|{}", normalize_proxy(proxy)),
        m => m.to_string(),
    }
}

fn current_route(app: &AppHandle) -> String {
    let mode = crate::wallet::scanner::read_routing_mode(app);
    route_fingerprint(&mode, &crate::wallet::scanner::read_proxy_address(app))
}

/// Top-level pages the X view may show: X itself, its media CDN, and the two sign-in providers X's
/// login offers. Anything else at the top level goes to the Browser.
pub fn top_level_ok(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    is_x_host(&h)
        || h == "twimg.com" || h.ends_with(".twimg.com")
        || h == "accounts.google.com" || h == "appleid.apple.com"
}

/// Where a navigation (or new-window request) in the X view goes.
#[derive(Debug, PartialEq, Eq)]
pub enum XRoute {
    /// Load it here.
    Stay,
    /// A payment / wallet URI: hand to ROS (the X app's own channel), cancel here.
    Uri,
    /// Leave X: open in the Browser app (ROS), cancel here.
    Browser(String),
    /// http X address: load its https form instead.
    Upgrade(String),
    /// Refuse.
    Deny,
}

/// x.com and twitter.com, with their subdomains (mobile., www., api. …).
pub fn is_x_host(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    ["x.com", "twitter.com"].iter().any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

// No lightning: nothing in Ripley handles it yet, so it is refused rather than swallowed.
const URI_SCHEMES: &[&str] = &["monero", "bitcoin", "solana", "ethereum", "xmr402", "ripley", "monero-signin"];

/// The navigation hook's rule (any frame — wry can't tell frames apart): web schemes load (an http X
/// address is upgraded to https), `ripley-open:<url>` / `ripley-uri:<uri>` from the MAIN-FRAME link
/// script go to the Browser / the wallet, and a raw payment URI is refused here: it could come from
/// any third-party iframe on X, so only a click in X's own page (via the script) or a new tab
/// (`xapp_new_window_route`, top-level only) reaches the wallet. Everything else (ros:, tauri:, ipc:,
/// asset:, file:, javascript: …) is refused.
pub fn xapp_navigation_route(url: &tauri::Url, nonce: &str) -> XRoute {
    let scheme = url.scheme().to_ascii_lowercase();
    match scheme.as_str() {
        "ripley-open" => match external_target(url) {
            Some(t) => XRoute::Browser(t),
            None => XRoute::Deny,
        },
        "ripley-uri" => match wrapped_uri(url, nonce) {
            Some(_) => XRoute::Uri,
            None => XRoute::Deny,
        },
        "http" if url.host_str().is_some_and(is_x_host) => {
            let mut u = url.clone();
            match u.set_scheme("https") {
                Ok(()) => XRoute::Upgrade(u.to_string()),
                Err(()) => XRoute::Deny,
            }
        }
        "https" | "http" | "about" | "blob" | "data" => XRoute::Stay,
        _ => XRoute::Deny,
    }
}

/// `ripley-uri:<secret>:<percent-encoded payment URI>` → that URI, if the secret is this view's and
/// its scheme is one Ripley handles.
pub fn wrapped_uri(url: &tauri::Url, nonce: &str) -> Option<String> {
    let rest = url.as_str().splitn(2, ':').nth(1)?;
    let (given, enc) = rest.split_once(':')?;
    if nonce.is_empty() || given != nonce {
        return None;
    }
    let inner = percent_decode(enc)?;
    let scheme = inner.split(':').next()?.to_ascii_lowercase();
    URI_SCHEMES.contains(&scheme.as_str()).then_some(inner)
}

/// A new window (target=_blank, window.open) is always top-level: X stays here, the rest of the
/// web opens in the Browser, payment URIs go to ROS, anything else is refused. Never a new
/// native window — it would escape this view's store and proxy.
pub fn xapp_new_window_route(url: &tauri::Url) -> XRoute {
    // Payment URIs: refused here — any frame can window.open one; a real click on a payment link in
    // X's page is caught by the main-frame script before it opens anything.
    match url.scheme().to_ascii_lowercase().as_str() {
        "https" | "http" => match url.host_str() {
            Some(h) if is_x_host(h) && url.scheme() == "https" => XRoute::Stay,
            Some(h) if is_x_host(h) => {
                let mut u = url.clone();
                if u.set_scheme("https").is_ok() { XRoute::Upgrade(u.to_string()) } else { XRoute::Deny }
            }
            Some(_) => XRoute::Browser(url.to_string()),
            None => XRoute::Deny,
        },
        _ => XRoute::Deny,
    }
}

/// `ripley-open:<percent-encoded http(s) URL>` → that URL, if it is plain http(s).
fn external_target(url: &tauri::Url) -> Option<String> {
    let raw = url.as_str().splitn(2, ':').nth(1)?;
    let decoded = percent_decode(raw)?;
    let t: tauri::Url = decoded.parse().ok()?;
    matches!(t.scheme(), "http" | "https").then(|| t.to_string())
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Main-frame only: an external link clicked in X (not a new tab) is sent to the Browser
/// instead of replacing X. X links, payment URIs and anything modified (ctrl / meta → new
/// window, handled by on_new_window) are left alone.
const LINK_SCRIPT: &str = r#"(function(){ var NONCE = '__RIPLEY_NONCE__';
  if (window.top !== window || window.__ripleyXLinks) return; window.__ripleyXLinks = true;
  var isX = function(h){ h = (h||'').toLowerCase(); return h==='x.com'||h==='twitter.com'||/\.(x|twitter)\.com$/.test(h); };
  // the link may sit in a shadow root (XMRadar's tip popup): composedPath sees into open ones.
  // Only real clicks count: a click made by the page's own script (a.click()) is not the user's.
  document.addEventListener('click', function(e){
    if (!e.isTrusted || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var path = e.composedPath ? e.composedPath() : [e.target], a = null;
    for (var i = 0; i < path.length && !a; i++) { var n = path[i]; if (n && n.tagName === 'A' && n.hasAttribute('href')) a = n; }
    if (!a) return;
    var u; try { u = new URL(a.href, location.href); } catch (_) { return; }
    // a payment link in X's own page → the wallet (raw payment URIs from frames are refused)
    if (/^(monero|bitcoin|solana|ethereum|xmr402|ripley|monero-signin):$/.test(u.protocol)) {
      e.preventDefault(); e.stopPropagation();
      location.href = 'ripley-uri:' + NONCE + ':' + encodeURIComponent(a.href); return;
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || isX(u.hostname)) return;
    e.preventDefault(); e.stopPropagation();
    location.href = 'ripley-open:' + encodeURIComponent(u.href);
  }, true);
})();"#;

const NO_CONTEXT_MENU: &str = "document.addEventListener('contextmenu',function(e){e.preventDefault();},true);";

/// macOS major version (14 = Sonoma); None when unknown.
#[cfg(target_os = "macos")]
fn macos_major() -> Option<u32> {
    static V: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        let out = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok()?;
        String::from_utf8(out.stdout).ok()?.trim().split('.').next()?.parse().ok()
    })
}

/// The view's proxy is frozen at creation: any load after a routing change (or while Tor is down)
/// must wait for a reopen, never reuse the old transport. Used by every path that loads a page.
fn routing_unchanged(app: &AppHandle) -> Result<(), String> {
    let mode = crate::wallet::scanner::read_routing_mode(app);
    if mode == "tor" && crate::tor::socks_port() == 0 {
        return Err("Tor is still connecting — try again in a moment.".into());
    }
    if let Some(created) = XAPP_MODE.lock().ok().and_then(|g| g.clone()) {
        if created != current_route(app) {
            // "routing" tells the X app to reopen the view on the current route.
            crate::emit_log(app, "XAPP_NOTE", "warn", "routing");
            return Err("Routing changed since X was opened — reopening X.".into());
        }
    }
    Ok(())
}

fn xapp_guard(app: &AppHandle, url: &tauri::Url) -> Result<(), String> {
    routing_unchanged(app)?;
    match url.host_str() {
        Some(h) if url.scheme() == "https" && is_x_host(h) => Ok(()),
        _ => Err("The X app only opens x.com.".into()),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn xapp_open(
    app: AppHandle,
    url: String,
    script: Option<String>,
    mode: Option<String>,
    proxy: Option<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    bg: Option<String>,
    zoom: Option<f64>,
) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    match parsed.host_str() {
        Some(host) if parsed.scheme() == "https" && is_x_host(host) => {}
        _ => return Err("The X app only opens x.com.".into()),
    }
    #[cfg(target_os = "macos")]
    if !macos_major().is_some_and(|v| v >= 14) {
        // Without a separate data store the X login would share the Browser's cookies — so an
        // unknown version is refused too (fail closed).
        return Err("The X app needs macOS 14 or later (for its own separate login).".into());
    }
    let proxy_url = resolve_browser_proxy(&parsed, &mode, &proxy)?;
    // Only OUR label: the Browser's view (ros-embed) is never touched here.
    if let Some(wv) = app.get_webview(XAPP_LABEL) {
        let _ = wv.close();
    }
    let win = app
        .get_window("main")
        .or_else(|| app.get_window("ros"))
        .ok_or_else(|| "no main window".to_string())?;
    let app_nav = app.clone();
    let app_new = app.clone();
    let app_load = app.clone();
    let app_dl = app.clone();
    let nonce = {
        use rand::Rng;
        let b: [u8; 16] = rand::thread_rng().gen();
        hex::encode(b)
    };
    let nav_nonce = nonce.clone();
    let z = zoom.unwrap_or(1.0);
    let mut b = tauri::WebviewBuilder::new(XAPP_LABEL, tauri::WebviewUrl::External(parsed.clone()))
        .initialization_script(NO_CONTEXT_MENU)
        .initialization_script(LINK_SCRIPT.replace("__RIPLEY_NONCE__", &nonce))
        .on_navigation(move |url| match xapp_navigation_route(url, &nav_nonce) {
            // Network loads only while the routing mode is the one this view was created with
            // (its proxy is fixed at creation) — frames included.
            XRoute::Stay => routing_unchanged(&app_nav).is_ok(),
            XRoute::Upgrade(https) => {
                if routing_unchanged(&app_nav).is_ok() {
                    if let (Some(wv), Ok(u)) = (app_nav.get_webview(XAPP_LABEL), https.parse::<tauri::Url>()) {
                        let _ = wv.navigate(u);
                    }
                }
                false
            }
            XRoute::Uri => {
                // Its own channel (not the Browser's): handled by the X app even when the Browser is closed.
                let nonce = XAPP_NONCE.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
                if let Some(inner) = wrapped_uri(url, &nonce) {
                    crate::emit_log(&app_nav, "XAPP_URI", "info", &inner);
                }
                false
            }
            XRoute::Browser(target) => {
                crate::emit_log(&app_nav, "XAPP_EXTERNAL", "info", &target);
                false
            }
            XRoute::Deny => {
                crate::emit_log(&app_nav, "XAPP", "warn", &format!("navigation refused ({})", url.scheme()));
                false
            }
        })
        .on_new_window(move |url, _features| {
            match xapp_new_window_route(&url) {
                XRoute::Stay | XRoute::Upgrade(_) if routing_unchanged(&app_new).is_err() => {}
                XRoute::Stay => {
                    // An X link in a new tab: load it here instead of a second native window.
                    if let Some(wv) = app_new.get_webview(XAPP_LABEL) {
                        let _ = wv.navigate(url.clone());
                    }
                }
                XRoute::Upgrade(https) => {
                    if let (Some(wv), Ok(u)) = (app_new.get_webview(XAPP_LABEL), https.parse::<tauri::Url>()) {
                        let _ = wv.navigate(u);
                    }
                }
                XRoute::Uri => {}
                XRoute::Browser(target) => crate::emit_log(&app_new, "XAPP_EXTERNAL", "info", &target),
                XRoute::Deny => crate::emit_log(&app_new, "XAPP", "warn", "new window refused"),
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(move |_wv, _ev| {
            crate::emit_log(&app_dl, "XAPP_NOTE", "info", "download");
            false
        })
        .on_page_load(move |wv, payload| {
            let phase = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "start",
                _ => "end",
            };
            // Page-load events are the MAIN frame's: a top-level page off X (moved there by X's own
            // script or a redirect) goes to the Browser, and X goes back to its last X page.
            let url = payload.url();
            // data: / blob: / about: at the TOP level (X's script can move the main frame there) is not
            // X either: back to the last X page. In frames they stay allowed (on_navigation).
            if !matches!(url.scheme(), "http" | "https") && phase == "start" && url.as_str() != "about:blank" {
                crate::emit_log(&app_load, "XAPP", "warn", &format!("top-level {} page refused", url.scheme()));
                let back = XAPP_LAST_X.lock().ok().and_then(|g| g.clone()).unwrap_or_else(|| "https://x.com/home".into());
                if let Ok(u) = back.parse::<tauri::Url>() {
                    let _ = wv.navigate(u);
                }
                return;
            }
            if matches!(url.scheme(), "http" | "https") {
                match url.host_str() {
                    Some(h) if top_level_ok(h) => {
                        if is_x_host(h) {
                            if let Ok(mut g) = XAPP_LAST_X.lock() {
                                *g = Some(url.to_string());
                            }
                        }
                    }
                    _ if phase == "start" => {
                        crate::emit_log(&app_load, "XAPP_EXTERNAL", "info", url.as_str());
                        let back = XAPP_LAST_X.lock().ok().and_then(|g| g.clone()).unwrap_or_else(|| "https://x.com/home".into());
                        if let Ok(u) = back.parse::<tauri::Url>() {
                            let _ = wv.navigate(u);
                        }
                        return;
                    }
                    _ => return,
                }
            }
            if phase == "end" {
                embed_pin_zoom(&app_load, &wv, z);
            }
            crate::emit_log(&app_load, "XAPP_LOAD", "info", &format!("{}|{}", phase, payload.url()));
        });
    if let Some(s) = script.filter(|s| !s.is_empty()) {
        // R11: what went into X's page, by fingerprint (RipleyOS supplies it; its own bundle is signed + verified)
        crate::emit_log(&app, "XAPP", "info", &format!("injected script {}", script_fingerprint(&s)));
        b = b.initialization_script(&s);
    }
    #[cfg(target_os = "macos")]
    {
        b = b.data_store_identifier(XAPP_STORE_ID);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let dir: PathBuf = app.path().app_data_dir().map_err(|e| e.to_string())?.join("xapp-webview");
        b = b.data_directory(dir);
    }
    if let Some(pu) = proxy_url {
        b = b.proxy_url(pu);
    }
    if let Some(c) = bg.as_deref().and_then(parse_rgb) {
        b = b.background_color(c);
    }
    win.add_child(b, tauri::LogicalPosition::new(x, y), tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    let created_mode = mode.unwrap_or_else(|| crate::wallet::scanner::read_routing_mode(&app));
    crate::emit_log(&app, "XAPP", "info", &format!("open · mode={created_mode}"));
    if let Ok(mut g) = XAPP_MODE.lock() {
        *g = Some(route_fingerprint(&created_mode, proxy.as_deref().unwrap_or("")));
    }
    if let Ok(mut g) = XAPP_NONCE.lock() {
        *g = Some(nonce);
    }
    if let Ok(mut g) = XAPP_LAST_X.lock() {
        *g = Some(parsed.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn xapp_bounds(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    if let Some(wv) = app.get_webview(XAPP_LABEL) {
        wv.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(tauri::LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn xapp_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    xapp_guard(&app, &parsed)?;
    if let Some(wv) = app.get_webview(XAPP_LABEL) {
        wv.navigate(parsed).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn xapp_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    if let Some(wv) = app.get_webview(XAPP_LABEL) {
        if visible { wv.show() } else { wv.hide() }.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn xapp_zoom(app: AppHandle, zoom: f64) -> Result<(), String> {
    if let Some(wv) = app.get_webview(XAPP_LABEL) {
        embed_pin_zoom(&app, &wv, zoom);
    }
    Ok(())
}

/// "reload" | "back" | "forward" — in-page history only, no new navigation target.
#[tauri::command]
pub fn xapp_history(app: AppHandle, action: String) -> Result<(), String> {
    let js = match action.as_str() {
        "reload" => "location.reload()",
        "back" => "history.back()",
        "forward" => "history.forward()",
        _ => return Err("unknown history action".into()),
    };
    routing_unchanged(&app)?;
    if let Some(wv) = app.get_webview(XAPP_LABEL) {
        wv.eval(js).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn xapp_close(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(XAPP_LABEL) {
        let _ = wv.close();
    }
    if let Ok(mut g) = XAPP_MODE.lock() {
        *g = None;
    }
    if let Ok(mut g) = XAPP_NONCE.lock() {
        *g = None;
    }
    // the page that asked is gone: its waiting requests end now, not after the timeout
    if let Ok(mut p) = BRIDGE_PENDING.lock() {
        p.clear();
    }
    Ok(())
}

/// `sha256:<first 12 hex> (<bytes> bytes)` — the log line's fingerprint of an injected script.
pub fn script_fingerprint(script: &str) -> String {
    use sha2::{Digest, Sha256};
    let h = hex::encode(Sha256::digest(script.as_bytes()));
    format!("sha256:{} ({} bytes)", &h[..12], script.len())
}

/// The RipleyOS view: the window's own webview (the X view and the Browser's are children of it).
fn ros_label(app: &AppHandle) -> Option<&'static str> {
    if app.get_webview("main").is_some() {
        Some("main")
    } else if app.get_webview("ros").is_some() {
        Some("ros")
    } else {
        None
    }
}

/// Only the X view, on an X page, may use the bridge (the capability says the same; this is the second lock).
pub fn bridge_caller_ok(label: &str, url: &tauri::Url) -> bool {
    label == XAPP_LABEL && url.scheme() == "https" && url.host_str().is_some_and(is_x_host)
}

/// A request from XMRadar in X's page, answered by RipleyOS (`xapp_bridge_reply`). Every answer is
/// public data (badges, totals, a price); RipleyOS decides what it answers — this only carries it.
#[tauri::command]
pub async fn xapp_bridge(app: AppHandle, webview: tauri::Webview, request: String) -> Result<String, String> {
    let url = webview.url().map_err(|e| e.to_string())?;
    if !bridge_caller_ok(webview.label(), &url) {
        return Err("not allowed".into());
    }
    if request.len() > BRIDGE_MAX_REQUEST {
        return Err("request too large".into());
    }
    let ros = ros_label(&app).ok_or("RipleyOS isn't open")?;
    let id = BRIDGE_NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut pending = BRIDGE_PENDING.lock().map_err(|_| "bridge unavailable")?;
        if pending.len() >= BRIDGE_MAX_IN_FLIGHT {
            return Err("busy".into());
        }
        pending.insert(id, tx);
    }
    use tauri::Emitter;
    if let Err(e) = app.emit_to(tauri::EventTarget::webview(ros), "xapp-bridge", serde_json::json!({ "id": id, "request": request })) {
        BRIDGE_PENDING.lock().map(|mut p| p.remove(&id)).ok();
        return Err(e.to_string());
    }
    match tokio::time::timeout(BRIDGE_TIMEOUT, rx).await {
        Ok(Ok(answer)) => Ok(answer),
        _ => {
            BRIDGE_PENDING.lock().map(|mut p| p.remove(&id)).ok();
            Err("RipleyOS didn't answer".into())
        }
    }
}

/// RipleyOS's answer to a bridge request (JSON text, as the extension's background answers).
#[tauri::command]
pub fn xapp_bridge_reply(id: u64, answer: String) -> Result<(), String> {
    let tx = BRIDGE_PENDING.lock().map_err(|_| "bridge unavailable")?.remove(&id);
    let Some(tx) = tx else { return Ok(()) }; // timed out or the view closed meanwhile
    let answer = if answer.len() > BRIDGE_MAX_ANSWER { r#"{"ok":false,"error":"answer too large"}"#.to_string() } else { answer };
    let _ = tx.send(answer);
    Ok(())
}

/// The script that hands RipleyOS's state to XMRadar in X's page: the JSON travels as a JS string
/// literal and is parsed there — it is never spliced in as code.
pub fn push_script(state: &str) -> Result<String, String> {
    if state.len() > PUSH_MAX {
        return Err("state too large".into());
    }
    let v: serde_json::Value = serde_json::from_str(state).map_err(|_| "state isn't JSON")?;
    if !v.is_object() {
        return Err("state must be an object".into());
    }
    let lit = serde_json::to_string(state).map_err(|e| e.to_string())?;
    Ok(format!("window.dispatchEvent(new CustomEvent('xmradar:state',{{detail:JSON.parse({lit})}}))"))
}

/// RipleyOS's settings for XMRadar changed: tell the open X page (dropped when X isn't open or is off X).
#[tauri::command]
pub fn xapp_push(app: AppHandle, state: String) -> Result<(), String> {
    let js = push_script(&state)?;
    if let Some(wv) = app.get_webview(XAPP_LABEL) {
        if wv.url().is_ok_and(|u| bridge_caller_ok(XAPP_LABEL, &u)) {
            wv.eval(&js).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn u(s: &str) -> tauri::Url { s.parse().unwrap() }
    const N: &str = "0123456789abcdef0123456789abcdef";
    fn xapp_navigation_route_t(url: &tauri::Url) -> XRoute { xapp_navigation_route(url, N) }

    #[test]
    fn x_hosts() {
        for h in ["x.com", "X.COM", "mobile.twitter.com", "twitter.com", "api.x.com", "x.com."] { assert!(is_x_host(h), "{h}"); }
        for h in ["notx.com", "x.co", "t.co", "evilx.com", "x.com.evil.io", "twitter.com.evil.io"] { assert!(!is_x_host(h), "{h}"); }
    }

    #[test]
    fn navigation_rule_any_frame() {
        assert_eq!(xapp_navigation_route_t(&u("https://x.com/home")), XRoute::Stay);
        // third-party frames (captcha, media) must load
        assert_eq!(xapp_navigation_route_t(&u("https://client-api.arkoselabs.com/v2/x")), XRoute::Stay);
        assert_eq!(xapp_navigation_route_t(&u("about:blank")), XRoute::Stay);
        // raw payment URIs (could be any third-party frame) are refused; the main-frame script wraps real clicks
        assert_eq!(xapp_navigation_route_t(&u("monero:4abc?tx_amount=1")), XRoute::Deny);
        assert_eq!(xapp_navigation_route_t(&u("monero-signin:?address=4abc")), XRoute::Deny);
        assert_eq!(xapp_navigation_route_t(&u(&format!("ripley-uri:{N}:monero%3A4abc%3Ftx_amount%3D1"))), XRoute::Uri);
        // a frame doesn't know the secret: no secret, a wrong one, or an empty view secret → refused
        assert_eq!(xapp_navigation_route_t(&u("ripley-uri:monero%3A4abc")), XRoute::Deny);
        assert_eq!(xapp_navigation_route_t(&u("ripley-uri:ffffffffffffffffffffffffffffffff:monero%3A4abc")), XRoute::Deny);
        assert_eq!(xapp_navigation_route(&u(&format!("ripley-uri:{N}:monero%3A4abc")), ""), XRoute::Deny);
        assert_eq!(wrapped_uri(&u(&format!("ripley-uri:{N}:monero%3A4abc%3Ftx_amount%3D1")), N).as_deref(), Some("monero:4abc?tx_amount=1"));
        assert_eq!(xapp_navigation_route_t(&u(&format!("ripley-uri:{N}:javascript%3Aalert(1)"))), XRoute::Deny);
        assert_eq!(xapp_navigation_route_t(&u(&format!("ripley-uri:{N}:lightning%3Alnbc1"))), XRoute::Deny);
        assert_eq!(xapp_navigation_route_t(&u("http://x.com/home")), XRoute::Upgrade("https://x.com/home".into()));
        assert_eq!(xapp_navigation_route_t(&u("http://example.org/frame")), XRoute::Stay);
        assert_eq!(
            xapp_navigation_route_t(&u("ripley-open:https%3A%2F%2Fexample.org%2Fa%3Fb%3D1")),
            XRoute::Browser("https://example.org/a?b=1".into())
        );
        for bad in ["ros://localhost/index.html", "tauri://localhost", "ipc://localhost/x", "asset://localhost/x", "file:///etc/passwd", "javascript:alert(1)", "ripley-open:javascript%3Aalert(1)", "ripley-open:file%3A%2F%2F%2Fetc"] {
            assert_eq!(xapp_navigation_route_t(&u(bad)), XRoute::Deny, "{bad}");
        }
    }

    #[test]
    fn new_window_rule_top_level() {
        assert_eq!(xapp_new_window_route(&u("https://x.com/someone/status/1")), XRoute::Stay);
        assert_eq!(xapp_new_window_route(&u("https://t.co/abc")), XRoute::Browser("https://t.co/abc".into()));
        assert_eq!(xapp_new_window_route(&u("https://example.org/")), XRoute::Browser("https://example.org/".into()));
        assert_eq!(xapp_new_window_route(&u("monero:4abc")), XRoute::Deny);   // frames can window.open one
        assert_eq!(xapp_new_window_route(&u("lightning:lnbc1")), XRoute::Deny);
        assert_eq!(xapp_new_window_route(&u("http://twitter.com/a")), XRoute::Upgrade("https://twitter.com/a".into()));
        for bad in ["about:blank", "data:text/html,hi", "blob:https://x.com/1", "ros://localhost/", "file:///tmp/x"] {
            assert_eq!(xapp_new_window_route(&u(bad)), XRoute::Deny, "{bad}");
        }
    }

    #[test]
    fn top_level_pages_allowed() {
        for h in ["x.com", "mobile.twitter.com", "pbs.twimg.com", "accounts.google.com", "appleid.apple.com"] { assert!(top_level_ok(h), "{h}"); }
        for h in ["t.co", "example.org", "google.com", "evil-twimg.com", "apple.com"] { assert!(!top_level_ok(h), "{h}"); }
    }

    #[test]
    fn route_fingerprint_covers_proxy() {
        assert_eq!(route_fingerprint("clearnet", "x"), "clearnet");
        assert_eq!(route_fingerprint("custom", "socks5://127.0.0.1：9050/"), "custom|127.0.0.1:9050");
        assert_ne!(route_fingerprint("custom", "127.0.0.1:9050"), route_fingerprint("custom", "127.0.0.1:9150"));
    }

    #[test]
    fn injected_script_fingerprint() {
        // sha256("abc") = ba7816bf8f01…
        assert_eq!(script_fingerprint("abc"), "sha256:ba7816bf8f01 (3 bytes)");
    }

    #[test]
    fn bridge_only_from_the_x_view_on_x() {
        assert!(bridge_caller_ok("xapp", &u("https://x.com/home")));
        assert!(bridge_caller_ok("xapp", &u("https://mobile.twitter.com/a")));
        for (label, url) in [("xapp", "https://example.org/"), ("xapp", "http://x.com/"), ("xapp", "https://accounts.google.com/"), ("ros-embed", "https://x.com/"), ("main", "https://x.com/"), ("xapp", "about:blank")] {
            assert!(!bridge_caller_ok(label, &u(url)), "{label} {url}");
        }
    }

    #[test]
    fn push_is_data_never_code() {
        let js = push_script(r#"{"sync:xmrSettings":{"badgesX":true},"x":"</script><script>alert(1)</script>','\u2028"}"#).unwrap();
        assert!(js.starts_with("window.dispatchEvent(new CustomEvent('xmradar:state',{detail:JSON.parse(\""));
        assert!(js.ends_with("\")}))"));
        // the payload sits inside one JS string literal: every quote in it is escaped
        let inner = &js["window.dispatchEvent(new CustomEvent('xmradar:state',{detail:JSON.parse(".len()..js.len() - ")}))".len()];
        let back: String = serde_json::from_str(inner).unwrap();
        assert!(back.contains("</script>"));
        assert!(push_script("[1,2]").is_err());
        assert!(push_script("alert(1)").is_err());
        assert!(push_script(&format!("{{\"a\":\"{}\"}}", "x".repeat(PUSH_MAX))).is_err());
    }

    #[test]
    fn bridge_reply_for_an_unknown_id_is_harmless_and_large_answers_are_refused() {
        assert!(xapp_bridge_reply(u64::MAX, "{}".into()).is_ok());
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        BRIDGE_PENDING.lock().unwrap().insert(u64::MAX - 1, tx);
        xapp_bridge_reply(u64::MAX - 1, "x".repeat(BRIDGE_MAX_ANSWER + 1)).unwrap();
        assert_eq!(rx.try_recv().unwrap(), r#"{"ok":false,"error":"answer too large"}"#);
    }

    #[test]
    fn link_script_sees_into_shadow_roots_and_takes_only_real_clicks() {
        assert!(LINK_SCRIPT.contains("e.composedPath") && LINK_SCRIPT.contains("!e.isTrusted"));
        assert!(!LINK_SCRIPT.contains("closest('a[href]')"));
    }

    #[test]
    fn link_script_carries_the_secret_placeholder() {
        assert!(LINK_SCRIPT.contains("'__RIPLEY_NONCE__'") && LINK_SCRIPT.contains("'ripley-uri:' + NONCE + ':'"));
    }

    /// R12: each embed's commands only ever look up their own label, so the Browser and X
    /// never close, hide or navigate each other.
    #[test]
    fn browser_and_x_touch_only_their_own_view() {
        let me = include_str!("xapp.rs");
        let code = &me[..me.find("#[cfg(test)]").unwrap()];
        assert!(!code.contains("EMBED_LABEL") && !code.contains("\"ros-embed\""), "xapp code touches the Browser's view");
        let sys = include_str!("system.rs");
        assert!(!sys.contains("XAPP_LABEL") && !sys.contains("\"xapp\""), "browser code touches the X view");
    }
}
