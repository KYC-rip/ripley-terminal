// Production Native Android host for Ripley Terminal + RipleyOS (ROS).
// Reuses the same pure-Rust Monero wallet engine, Arti Tor stack, signed OTA
// bundle pipeline, disk KV store, and wallpaper store as desktop (`desktop.rs`),
// paired with Android-native SOLO boot, pinned Home Screen shortcuts, hardware
// Keystore watchSync, overlay Tor-routed WebView browser, and system Back/insets.

mod android_chain;
mod android_net;
mod android_policy;
mod boot;
pub mod migration;
mod tor;
mod updater;
mod wallet;
mod commands {
    pub mod config;
    pub mod identity;
    pub mod kvstore;
    pub mod ros_kv;
    pub mod tor;
    pub mod transfer_grant;
    pub mod wallet;
    pub mod wallpaper;
    pub mod system {
        pub use crate::android_net::*;
    }
}

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, OnceLock,
};

use base64::Engine as _;
use jni::objects::{JObject, JString};
use jni::JNIEnv;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{
    plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin},
    AppHandle, Emitter, Manager, WebviewWindow,
};
use zeroize::Zeroizing;

include!(concat!(env!("OUT_DIR"), "/android_bundle.rs"));

/// Mobile ROS CSP over https://ros.localhost (`use_https_scheme(true)`).
/// HTTP goes through `ros_native_fetch`, WSS relays ride `ProxyController` in Tor mode,
/// and ROS's own `<meta>` CSP further narrows allowed hosts.
const MOBILE_CSP: &str = "default-src 'self'; \
script-src 'self' 'wasm-unsafe-eval'; \
worker-src 'self'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob: https: asset: http://asset.localhost https://asset.localhost; \
font-src 'self' data:; \
connect-src 'self' blob: ipc: http://ipc.localhost https://ipc.localhost https: wss:; \
media-src 'self' data: blob: https:; \
frame-src 'self' https:; \
object-src 'none'; \
base-uri 'none'; \
form-action 'self'; \
frame-ancestors 'none'";

static ANDROID_APP: OnceLock<AppHandle> = OnceLock::new();
static ANDROID_FOREGROUND: AtomicBool = AtomicBool::new(true);
static RENDERER_READY: AtomicBool = AtomicBool::new(false);
static PENDING_SOLO_BOOT: Mutex<Option<String>> = Mutex::new(None);
static PENDING_DEEP_LINKS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static WS_TUNNELED: AtomicBool = AtomicBool::new(false);

pub struct NativeIo(pub PluginHandle<tauri::Wry>);

fn io_plugin() -> TauriPlugin<tauri::Wry> {
    PluginBuilder::new("android-io")
        .setup(|app, api| {
            app.manage(NativeIo(api.register_android_plugin(
                "run.ripley.terminal",
                "NativeIoPlugin",
            )?));
            Ok(())
        })
        .build()
}

async fn run_native_io(app: &AppHandle, method: &str, args: Value) -> Result<Value, String> {
    let handle = app
        .try_state::<NativeIo>()
        .ok_or_else(|| "Android NativeIoPlugin not initialized".to_string())?
        .0
        .clone();
    let m = method.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        handle
            .run_mobile_plugin::<Value>(&m, args)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Android IO worker failed".to_string())?
}

/// Shared log/event emitter — identical signature to `desktop.rs` so all shared
/// wallet, scanner, Tor, and updater modules compile unchanged.
pub fn emit_log(app: &AppHandle, source: &str, level: &str, message: &str) {
    if source != "SYNC_DATA" && source != "TOR_STATUS" && source != "BALANCE_DATA" {
        println!("[{source}/{level}] {message}");
    }
    let _ = app.emit(
        "core-log",
        json!({
            "source": source,
            "level": level,
            "message": message,
        }),
    );
}

pub fn emit_balance(app: &AppHandle, total: u64, unlocked: u64) {
    let _ = app.emit(
        "core-log",
        json!({
            "source": "BALANCE_DATA",
            "level": "info",
            "message": format!("{total}|{unlocked}"),
        }),
    );
}

pub fn emit_sync_status(
    app: &AppHandle,
    status: &str,
    height: u64,
    daemon_height: u64,
    percent: f64,
    node_label: &str,
    scan_start: u64,
) {
    let _ = app.emit(
        "core-log",
        json!({
            "source": "SYNC_DATA",
            "level": "info",
            "message": format!("{status}|{height}|{daemon_height}|{percent:.1}|{node_label}|{scan_start}"),
        }),
    );
}

/// Normalize a custom proxy string for Android's `ProxyConfig.Builder.addProxyRule`.
/// Bare `host:port` (valid on desktop) is normalized to `socks5://host:port`, and
/// `socks5h://` is mapped to `socks5://` (Chromium SOCKS5 resolves DNS remotely).
fn normalize_webview_proxy(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix("socks5h://") {
        return Some(format!("socks5://{rest}"));
    }
    if trimmed.contains("://") {
        return Some(trimmed.to_string());
    }
    Some(format!("socks5://{trimmed}"))
}

/// Synchronize Android's app-wide `androidx.webkit.ProxyController` with the current
/// routing mode (`tor` → Arti loopback SOCKS5, `custom` → user proxy, `clearnet` → clear).
/// In `tor` mode before Arti binds its SOCKS5 port, we fail closed via a dead local
/// loopback sink (`socks5://127.0.0.1:1`) so `*.localhost` (ROS + IPC) stays reachable
/// while external clearnet traffic cannot leak during Tor bootstrap.
pub async fn android_sync_proxy_now(app: &AppHandle) {
    let mode = wallet::scanner::read_routing_mode(app);
    let (proxy_url, is_sink): (Option<String>, bool) = match mode.as_str() {
        "tor" => {
            let port = tor::socks_port();
            if port > 0 {
                (Some(format!("socks5://127.0.0.1:{port}")), false)
            } else {
                (Some("socks5://127.0.0.1:1".to_string()), true)
            }
        }
        "custom" => {
            let addr = wallet::scanner::read_proxy_address(app);
            match normalize_webview_proxy(&addr) {
                Some(p) => (Some(p), false),
                None => (Some("socks5://127.0.0.1:1".to_string()), true),
            }
        }
        _ => (None, false),
    };
    let res = run_native_io(app, "applyProxy", json!({ "proxyUrl": proxy_url })).await;
    let applied = res
        .ok()
        .and_then(|v| v["applied"].as_bool())
        .unwrap_or(false);
    let tunneled = applied && proxy_url.is_some() && !is_sink;
    WS_TUNNELED.store(tunneled, Ordering::SeqCst);
    let status = if tunneled {
        mode.as_str()
    } else if mode == "clearnet" {
        "clearnet"
    } else if is_sink {
        "connecting"
    } else {
        "error"
    };
    emit_log(app, "PROXY_STATUS", "info", status);
}

pub fn android_sync_proxy(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        android_sync_proxy_now(&handle).await;
    });
}

/// Synchronize the Android launcher icon & label (`<activity-alias>`) with the persisted
/// `bootApp` + `appIcon` settings (default ROS icon, auto-following startup app, or explicit override).
pub async fn android_sync_launcher_icon(app: &AppHandle) {
    let target = commands::config::read_effective_launcher_icon(app);
    let _ = run_native_io(app, "setAppIcon", json!({ "iconId": target })).await;
}

/// Hardware-backed Android Keystore watch root for `watchSync` view-only files
/// (called by `wallet::device_key::ensure_watch_key`).
pub async fn android_ensure_watch_key(app: &AppHandle) -> Option<Zeroizing<[u8; 32]>> {
    let res = run_native_io(app, "ensureWatchKey", json!({})).await.ok()?;
    let b64 = res["keyBase64"].as_str()?;
    let raw = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if raw.len() != 32 {
        return None;
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&raw);
    Some(key)
}

fn local_url(url: &tauri::Url) -> bool {
    android_policy::trusted_location(
        url.scheme(),
        url.host_str().unwrap_or(""),
        url.port(),
        !url.username().is_empty() || url.password().is_some(),
    )
}

fn require_local(webview: &WebviewWindow) -> Result<(), String> {
    if webview.label() != "ros-android" || !local_url(&webview.url().map_err(|_| "no origin")?) {
        return Err("Untrusted origin".into());
    }
    Ok(())
}

fn queue_or_emit_deep_link(uri: String) {
    if RENDERER_READY.load(Ordering::SeqCst) {
        if let Some(app) = ANDROID_APP.get() {
            emit_log(app, "DEEP_LINK", "info", &uri);
            return;
        }
    }
    if let Ok(mut q) = PENDING_DEEP_LINKS.lock() {
        if q.len() < 16 {
            q.push(uri);
        }
    }
}

fn jstring_to_rust(env: &mut JNIEnv, s: JString) -> Option<String> {
    env.get_string(&s).ok().map(|js| js.into())
}

// ── JNI Callbacks from `run.ripley.terminal.MainActivity` ──

#[no_mangle]
pub extern "system" fn Java_run_ripley_terminal_MainActivity_nativeResume(
    _env: JNIEnv,
    _this: JObject,
) {
    ANDROID_FOREGROUND.store(true, Ordering::SeqCst);
}

#[no_mangle]
pub extern "system" fn Java_run_ripley_terminal_MainActivity_nativeLock(
    _env: JNIEnv,
    _this: JObject,
) {
    ANDROID_FOREGROUND.store(false, Ordering::SeqCst);
}

/// Called from `MainActivity.onStop()` when the app genuinely leaves the foreground
/// (not transient permission/SAF/pin-shortcut dialogs). Locks any open Monero wallet
/// in memory and notifies ROS via `WALLET_STATE` so the UI re-prompts for passphrase.
#[no_mangle]
pub extern "system" fn Java_run_ripley_terminal_MainActivity_nativeBackgroundLock(
    _env: JNIEnv,
    _this: JObject,
) {
    ANDROID_FOREGROUND.store(false, Ordering::SeqCst);
    if let Some(app) = ANDROID_APP.get().cloned() {
        tauri::async_runtime::spawn(async move {
            if let Some(ws) = app.try_state::<wallet::WalletState>() {
                if !ws.is_locked().await {
                    ws.lock().await;
                    emit_log(
                        &app,
                        "WALLET_STATE",
                        "info",
                        r#"{"locked":true,"reason":"background"}"#,
                    );
                }
            }
        });
    }
}

#[no_mangle]
pub extern "system" fn Java_run_ripley_terminal_MainActivity_nativeNetworkChanged(
    _env: JNIEnv,
    _this: JObject,
) {
    if let Some(app) = ANDROID_APP.get().cloned() {
        tauri::async_runtime::spawn(async move {
            if let Some(tor_state) = app.try_state::<tor::TorState>() {
                tor_state.refresh_after_network_change(&app).await;
            }
        });
    }
}

#[no_mangle]
pub extern "system" fn Java_run_ripley_terminal_MainActivity_nativeSetLaunchSoloApp(
    mut env: JNIEnv,
    _this: JObject,
    app_path: JString,
) {
    if let Some(raw) = jstring_to_rust(&mut env, app_path) {
        if let Some(clean) = commands::config::sanitize_solo_boot_path(&raw) {
            if let Ok(mut slot) = PENDING_SOLO_BOOT.lock() {
                *slot = Some(clean);
            }
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_run_ripley_terminal_MainActivity_nativeDeepLink(
    mut env: JNIEnv,
    _this: JObject,
    uri: JString,
) {
    if let Some(raw) = jstring_to_rust(&mut env, uri) {
        if !raw.is_empty() && raw.len() <= 2048 {
            queue_or_emit_deep_link(raw);
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_run_ripley_terminal_MainActivity_nativeBrowserEvent(
    mut env: JNIEnv,
    _this: JObject,
    source: JString,
    message: JString,
) {
    if let (Some(src), Some(msg)) = (
        jstring_to_rust(&mut env, source),
        jstring_to_rust(&mut env, message),
    ) {
        if matches!(
            src.as_str(),
            "BROWSER_LOAD"
                | "BROWSER_URI"
                | "BROWSER_THEME"
                | "XAPP_LOAD"
                | "XAPP_URI"
                | "XAPP_EXTERNAL"
                | "XAPP_NOTE"
                | "XAPP_THEME"
        ) {
            if let Some(app) = ANDROID_APP.get() {
                emit_log(app, &src, "info", &msg);
            }
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_run_ripley_terminal_MainActivity_nativeXappBridge(
    mut env: JNIEnv,
    _this: JObject,
    id: jni::sys::jlong,
    request: JString,
) {
    if id <= 0 {
        return;
    }
    if let Some(req) = jstring_to_rust(&mut env, request) {
        if req.len() <= 16 * 1024 {
            if let Some(app) = ANDROID_APP.get() {
                let _ = app.emit_to(
                    tauri::EventTarget::webview("ros-android"),
                    "xapp-bridge",
                    json!({ "id": id, "request": req }),
                );
            }
        }
    }
}

// ── Android Host Commands ──

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    bridge_version: u32,
    platform: &'static str,
    abi: &'static str,
    app_version: &'static str,
    custody: &'static str,
    capabilities: Value,
}

#[tauri::command]
fn android_runtime_status(webview: WebviewWindow) -> Result<RuntimeStatus, String> {
    require_local(&webview)?;
    Ok(RuntimeStatus {
        bridge_version: 2,
        platform: "android",
        abi: std::env::consts::ARCH,
        app_version: env!("CARGO_PKG_VERSION"),
        custody: "sovereign",
        capabilities: json!({
            "bundledRos": true,
            "monero": true,
            "torRouting": true,
            "wsTunneled": WS_TUNNELED.load(Ordering::SeqCst),
            "browser": true,
            "browserMode": "overlay",
            "xApp": true,
            "vpnWindow": false,
            "classicUi": false,
            "keystore": true,
            "pinShortcut": true,
            "secureScreen": true,
            "appIcon": true,
            "nativeBiometric": true,
            "nativePreferences": true,
            "nativeClipboardText": true,
            "nativeNotifications": true,
            "nativeDocumentSave": true,
            "nativeWalletTestMode": false,
        }),
    })
}

#[tauri::command]
fn android_renderer_ready(app: AppHandle) -> Result<(), String> {
    RENDERER_READY.store(true, Ordering::SeqCst);
    let drained: Vec<String> = PENDING_DEEP_LINKS
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default();
    for uri in drained {
        emit_log(&app, "DEEP_LINK", "info", &uri);
    }
    android_sync_proxy(&app);
    Ok(())
}

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
async fn android_clipboard_read(app: AppHandle, webview: WebviewWindow) -> Result<Value, String> {
    require_local(&webview)?;
    if !ANDROID_FOREGROUND.load(Ordering::SeqCst) {
        return Err("Clipboard read requires foreground Activity".into());
    }
    run_native_io(&app, "readClipboard", json!({})).await
}

#[tauri::command]
async fn android_clipboard_write(
    app: AppHandle,
    webview: WebviewWindow,
    text: String,
) -> Result<Value, String> {
    require_local(&webview)?;
    if !ANDROID_FOREGROUND.load(Ordering::SeqCst) {
        return Err("Clipboard write requires foreground Activity".into());
    }
    run_native_io(&app, "writeClipboard", json!({ "text": text })).await
}

#[tauri::command]
async fn android_save_export(
    app: AppHandle,
    webview: WebviewWindow,
    name: String,
    mime: Option<String>,
    base64: String,
) -> Result<Value, String> {
    require_local(&webview)?;
    run_native_io(
        &app,
        "saveExport",
        json!({
            "name": name,
            "mime": mime.unwrap_or_else(|| "application/octet-stream".into()),
            "base64": base64,
        }),
    )
    .await
}

#[tauri::command]
async fn android_set_secure_screen(
    app: AppHandle,
    webview: WebviewWindow,
    enabled: bool,
) -> Result<Value, String> {
    require_local(&webview)?;
    run_native_io(&app, "setSecureScreen", json!({ "enabled": enabled })).await
}

#[tauri::command]
async fn android_set_system_bars(
    app: AppHandle,
    webview: WebviewWindow,
    light: bool,
) -> Result<Value, String> {
    require_local(&webview)?;
    run_native_io(&app, "setSystemBars", json!({ "light": light })).await
}

#[tauri::command]
async fn android_list_app_icons(app: AppHandle, webview: WebviewWindow) -> Result<Value, String> {
    require_local(&webview)?;
    run_native_io(&app, "listAppIcons", json!({})).await
}

#[tauri::command]
async fn android_set_app_icon(
    app: AppHandle,
    webview: WebviewWindow,
    icon_id: String,
) -> Result<Value, String> {
    require_local(&webview)?;
    let clean = if icon_id.trim().eq_ignore_ascii_case("default") {
        "default".to_string()
    } else {
        commands::config::sanitize_boot_app_id(&icon_id)
            .ok_or_else(|| "Invalid icon id".to_string())?
    };
    run_native_io(&app, "setAppIcon", json!({ "iconId": clean })).await
}

#[tauri::command]
async fn android_bio_status(app: AppHandle, webview: WebviewWindow) -> Result<Value, String> {
    require_local(&webview)?;
    run_native_io(&app, "bioStatus", json!({})).await
}

#[tauri::command]
async fn android_bio_seal(
    app: AppHandle,
    webview: WebviewWindow,
    secret_base64: String,
    title: Option<String>,
    subtitle: Option<String>,
) -> Result<Value, String> {
    require_local(&webview)?;
    run_native_io(
        &app,
        "bioSeal",
        json!({
            "secretBase64": secret_base64,
            "title": title.unwrap_or_else(|| "Biometric unlock".into()),
            "subtitle": subtitle,
        }),
    )
    .await
}

#[tauri::command]
async fn android_bio_unseal(
    app: AppHandle,
    webview: WebviewWindow,
    iv_base64: String,
    ct_base64: String,
    title: Option<String>,
    subtitle: Option<String>,
) -> Result<Value, String> {
    require_local(&webview)?;
    run_native_io(
        &app,
        "bioUnseal",
        json!({
            "ivBase64": iv_base64,
            "ctBase64": ct_base64,
            "title": title.unwrap_or_else(|| "Unlock".into()),
            "subtitle": subtitle,
        }),
    )
    .await
}

#[tauri::command]
async fn android_bio_clear(app: AppHandle, webview: WebviewWindow) -> Result<Value, String> {
    require_local(&webview)?;
    run_native_io(&app, "bioClear", json!({})).await
}

// ── Sovereign Full-Device Migration (Mac ↔ Pixel, Offline .ripley-migrate + Direct LAN QR) ──

#[tauri::command]
async fn migration_export_bundle(
    app: AppHandle,
    webview: WebviewWindow,
    passphrase: String,
) -> Result<Value, String> {
    require_local(&webview)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = migration::pack_bundle(&data_dir)?;
        let encrypted = migration::encrypt_with_passphrase(&bundle, &passphrase)?;
        let preview = migration::preview_bundle(&bundle, encrypted.len());
        let b64 = base64::engine::general_purpose::STANDARD.encode(&encrypted);
        let ts = chrono::Utc::now().format("%Y%m%d-%H%M");
        Ok::<Value, String>(json!({
            "filename": format!("ripley-device-{ts}.ripley-migrate"),
            "base64": b64,
            "preview": preview,
        }))
    })
    .await
    .map_err(|_| "migration worker failed".to_string())?
}

#[tauri::command]
async fn migration_inspect_bundle(
    webview: WebviewWindow,
    base64_data: String,
    passphrase: String,
) -> Result<migration::MigrationPreview, String> {
    require_local(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(base64_data.trim())
            .map_err(|e| format!("invalid archive encoding: {e}"))?;
        let bundle = migration::decrypt_with_passphrase(&raw, &passphrase)?;
        Ok(migration::preview_bundle(&bundle, raw.len()))
    })
    .await
    .map_err(|_| "migration worker failed".to_string())?
}

#[tauri::command]
async fn migration_import_bundle(
    app: AppHandle,
    webview: WebviewWindow,
    base64_data: String,
    passphrase: String,
) -> Result<migration::MigrationPreview, String> {
    require_local(&webview)?;
    // Close any open Monero wallet before overwriting vaults on disk.
    if let Some(ws) = app.try_state::<wallet::WalletState>() {
        ws.lock().await;
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(base64_data.trim())
            .map_err(|e| format!("invalid archive encoding: {e}"))?;
        let bundle = migration::decrypt_with_passphrase(&raw, &passphrase)?;
        let mut preview = migration::apply_bundle(&data_dir, &bundle)?;
        preview.bundle_bytes = raw.len();
        Ok(preview)
    })
    .await
    .map_err(|_| "migration worker failed".to_string())?
}

#[tauri::command]
async fn migration_lan_start(
    app: AppHandle,
    webview: WebviewWindow,
) -> Result<migration::LanSessionInfo, String> {
    require_local(&webview)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    migration::start_managed_lan_sender(&data_dir).await
}

#[tauri::command]
async fn migration_lan_stop(webview: WebviewWindow) -> Result<Value, String> {
    require_local(&webview)?;
    migration::stop_managed_lan_sender();
    Ok(json!({ "stopped": true }))
}

#[tauri::command]
async fn migration_lan_fetch(
    webview: WebviewWindow,
    uri: String,
) -> Result<migration::LanFetchedTransfer, String> {
    require_local(&webview)?;
    migration::fetch_and_stage_lan(&uri).await
}

#[tauri::command]
async fn migration_lan_apply(
    app: AppHandle,
    webview: WebviewWindow,
    transfer_id: String,
) -> Result<migration::MigrationPreview, String> {
    require_local(&webview)?;
    if let Some(ws) = app.try_state::<wallet::WalletState>() {
        ws.lock().await;
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || migration::apply_staged_lan(&data_dir, &transfer_id))
        .await
        .map_err(|_| "migration worker failed".to_string())?
}

#[tauri::command]
async fn android_pin_shortcut(
    app: AppHandle,
    webview: WebviewWindow,
    app_id: String,
    label: String,
    icon_base64: Option<String>,
) -> Result<Value, String> {
    require_local(&webview)?;
    let clean = commands::config::sanitize_boot_app_id(&app_id)
        .ok_or_else(|| "Invalid app id".to_string())?;
    // Prefer the verified build-time per-app icon from the in-memory RosBundle.
    let bundle_icon = app.try_state::<updater::protocol::RosBundle>().and_then(|b| {
        for suffix in ["maskable.png", "512.png", "192.png"] {
            let r = b.resolve(&format!("ros://localhost/m/{clean}-{suffix}"));
            if r.status == 200 && !r.body.is_empty() {
                return Some(base64::engine::general_purpose::STANDARD.encode(&r.body));
            }
        }
        None
    });
    run_native_io(
        &app,
        "pinShortcut",
        json!({
            "appId": clean,
            "label": label,
            "iconBase64": bundle_icon.or(icon_base64),
        }),
    )
    .await
}

// ── Embedded Overlay Browser & External URL Commands ──

fn allow_onion_for_browser(app: &AppHandle, mode: Option<&str>) -> Result<bool, String> {
    let effective = mode
        .map(str::to_string)
        .unwrap_or_else(|| wallet::scanner::read_routing_mode(app));
    if effective == "tor" {
        if tor::socks_port() == 0 {
            return Err("Tor is enabled but still connecting — wait for Tor before opening Browser".into());
        }
        if !WS_TUNNELED.load(Ordering::SeqCst) {
            return Err("WebView proxy override is not active for Tor mode".into());
        }
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
async fn open_external_url(
    app: AppHandle,
    webview: WebviewWindow,
    url: String,
) -> Result<(), String> {
    require_local(&webview)?;
    run_native_io(&app, "openExternalUrl", json!({ "url": url })).await?;
    Ok(())
}

#[tauri::command]
async fn open_native_browser(
    app: AppHandle,
    webview: WebviewWindow,
    url: String,
    _mode: Option<String>,
    _proxy: Option<String>,
) -> Result<(), String> {
    require_local(&webview)?;
    run_native_io(&app, "openBrowser", json!({ "url": url })).await?;
    Ok(())
}

#[tauri::command]
async fn browser_embed_open(
    app: AppHandle,
    webview: WebviewWindow,
    url: String,
    mode: Option<String>,
    _proxy: Option<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    bg: Option<String>,
    zoom: Option<f64>,
) -> Result<(), String> {
    require_local(&webview)?;
    let allow_onion = allow_onion_for_browser(&app, mode.as_deref())?;
    run_native_io(
        &app,
        "embedOpen",
        json!({
            "url": url,
            "x": x,
            "y": y,
            "w": w,
            "h": h,
            "bg": bg,
            "zoom": zoom,
            "allowOnion": allow_onion,
        }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
async fn browser_embed_bounds(
    app: AppHandle,
    webview: WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    require_local(&webview)?;
    run_native_io(&app, "embedBounds", json!({ "x": x, "y": y, "w": w, "h": h })).await?;
    Ok(())
}

#[tauri::command]
async fn browser_embed_navigate(
    app: AppHandle,
    webview: WebviewWindow,
    url: String,
) -> Result<(), String> {
    require_local(&webview)?;
    let allow_onion = allow_onion_for_browser(&app, None)?;
    run_native_io(
        &app,
        "embedNavigate",
        json!({ "url": url, "allowOnion": allow_onion }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
async fn browser_embed_visible(
    app: AppHandle,
    webview: WebviewWindow,
    visible: bool,
) -> Result<(), String> {
    require_local(&webview)?;
    run_native_io(&app, "embedVisible", json!({ "visible": visible })).await?;
    Ok(())
}

#[tauri::command]
async fn browser_embed_zoom(
    app: AppHandle,
    webview: WebviewWindow,
    zoom: f64,
) -> Result<(), String> {
    require_local(&webview)?;
    run_native_io(&app, "embedZoom", json!({ "zoom": zoom })).await?;
    Ok(())
}

#[tauri::command]
async fn browser_embed_close(app: AppHandle, webview: WebviewWindow) -> Result<(), String> {
    require_local(&webview)?;
    run_native_io(&app, "embedClose", json!({})).await?;
    Ok(())
}

#[tauri::command]
async fn browser_embed_deliver_xmr402(_txid: String, _proof: String) -> Result<(), String> {
    Err("Embedded XMR402 auto-delivery is not yet supported on Android — copy the proof manually".into())
}

// ── Built-in X App Overlay Commands (with XMRadar document-start script + bridge) ──

fn is_x_host(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "x.com" || h == "twitter.com" || h.ends_with(".x.com") || h.ends_with(".twitter.com")
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn xapp_open(
    app: AppHandle,
    webview: WebviewWindow,
    url: String,
    script: Option<String>,
    mode: Option<String>,
    _proxy: Option<String>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    bg: Option<String>,
    zoom: Option<f64>,
) -> Result<(), String> {
    require_local(&webview)?;
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    match parsed.host_str() {
        Some(host) if parsed.scheme() == "https" && is_x_host(host) => {}
        _ => return Err("The X app only opens x.com.".into()),
    }
    let _ = allow_onion_for_browser(&app, mode.as_deref())?;
    run_native_io(
        &app,
        "xappOpen",
        json!({
            "url": parsed.to_string(),
            "script": script,
            "x": x,
            "y": y,
            "w": w,
            "h": h,
            "bg": bg,
            "zoom": zoom,
        }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
async fn xapp_bounds(
    app: AppHandle,
    webview: WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    require_local(&webview)?;
    run_native_io(&app, "xappBounds", json!({ "x": x, "y": y, "w": w, "h": h })).await?;
    Ok(())
}

#[tauri::command]
async fn xapp_navigate(
    app: AppHandle,
    webview: WebviewWindow,
    url: String,
) -> Result<(), String> {
    require_local(&webview)?;
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    match parsed.host_str() {
        Some(host) if parsed.scheme() == "https" && is_x_host(host) => {}
        _ => return Err("The X app only opens x.com.".into()),
    }
    let _ = allow_onion_for_browser(&app, None)?;
    run_native_io(&app, "xappNavigate", json!({ "url": parsed.to_string() })).await?;
    Ok(())
}

#[tauri::command]
async fn xapp_visible(
    app: AppHandle,
    webview: WebviewWindow,
    visible: bool,
) -> Result<(), String> {
    require_local(&webview)?;
    run_native_io(&app, "xappVisible", json!({ "visible": visible })).await?;
    Ok(())
}

#[tauri::command]
async fn xapp_zoom(
    app: AppHandle,
    webview: WebviewWindow,
    zoom: f64,
) -> Result<(), String> {
    require_local(&webview)?;
    run_native_io(&app, "xappZoom", json!({ "zoom": zoom })).await?;
    Ok(())
}

#[tauri::command]
async fn xapp_history(
    app: AppHandle,
    webview: WebviewWindow,
    action: String,
) -> Result<(), String> {
    require_local(&webview)?;
    if !matches!(action.as_str(), "reload" | "back" | "forward") {
        return Err("unknown history action".into());
    }
    let _ = allow_onion_for_browser(&app, None)?;
    run_native_io(&app, "xappHistory", json!({ "action": action })).await?;
    Ok(())
}

#[tauri::command]
async fn xapp_close(app: AppHandle, webview: WebviewWindow) -> Result<(), String> {
    require_local(&webview)?;
    run_native_io(&app, "xappClose", json!({})).await?;
    Ok(())
}

#[tauri::command]
async fn xapp_push(
    app: AppHandle,
    webview: WebviewWindow,
    state: String,
) -> Result<(), String> {
    require_local(&webview)?;
    if state.len() > 64 * 1024 {
        return Err("state too large".into());
    }
    let v: Value = serde_json::from_str(&state).map_err(|_| "state isn't JSON")?;
    if !v.is_object() {
        return Err("state must be an object".into());
    }
    let lit = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    let js = format!("window.dispatchEvent(new CustomEvent('xmradar:state',{{detail:JSON.parse({lit})}}))");
    run_native_io(&app, "xappEval", json!({ "js": js })).await?;
    Ok(())
}

#[tauri::command]
async fn xapp_bridge_reply(
    app: AppHandle,
    webview: WebviewWindow,
    id: u64,
    answer: String,
) -> Result<(), String> {
    require_local(&webview)?;
    let safe_answer = if answer.len() > 64 * 1024 {
        r#"{"ok":false,"error":"answer too large"}"#.to_string()
    } else {
        answer
    };
    let lit = serde_json::to_string(&safe_answer).map_err(|e| e.to_string())?;
    let js = format!("window.__ripleyXBridgeDeliver && window.__ripleyXBridgeDeliver({id}, {lit})");
    run_native_io(&app, "xappEval", json!({ "js": js })).await?;
    Ok(())
}

// ── Desktop-Only Feature Stubs (honest structured degradation) ──

#[tauri::command]
fn vpn_status() -> Value {
    json!({
        "supported": false,
        "connected": false,
        "phase": "unsupported",
        "reason": "Host-wide Android VpnService is planned for Phase 2"
    })
}

#[tauri::command]
fn vpn_open_window() -> Result<(), String> {
    Err("Host VPN panel is not available on Android yet".into())
}

#[tauri::command]
fn vpn_set_locale(_locale: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn agent_gateway_status() -> Value {
    json!({
        "enabled": false,
        "running": false,
        "supported": false,
        "available": false,
        "reason": "Agent HTTP gateway is desktop-only",
        "port": 0,
        "apiKeyMasked": "UNAVAILABLE",
        "boundGrantId": null,
        "accountIndex": 0,
        "address": null,
        "walletId": null,
        "walletName": null
    })
}

#[tauri::command]
fn agent_gateway_set_config(_patch: Value) -> Result<Value, String> {
    Err("Agent HTTP gateway is desktop-only".into())
}

#[tauri::command]
fn agent_gateway_rotate_key() -> Result<Value, String> {
    Err("Agent HTTP gateway is desktop-only".into())
}

#[tauri::command]
fn local_ai_status(model_id: Option<String>) -> Value {
    json!({
        "modelId": model_id,
        "installed": false,
        "loaded": false,
        "bytes": 0,
        "downloadedBytes": 0,
        "downloading": false,
        "runtime": "Native llama.cpp is desktop-only — use BYOK or WebLLM",
        "accelerated": false,
        "supported": false
    })
}

#[tauri::command]
fn local_ai_download(_model_id: String, _allow_clearnet: Option<bool>) -> Result<Value, String> {
    Err("Native Local AI is not enabled on Android".into())
}

#[tauri::command]
fn local_ai_load(_model_id: String) -> Result<(), String> {
    Err("Native Local AI is not enabled on Android".into())
}

#[tauri::command]
fn local_ai_complete(_model_id: String, _messages: Value, _max_tokens: Option<u32>) -> Result<Value, String> {
    Err("Native Local AI is not enabled on Android".into())
}

#[tauri::command]
fn local_ai_remove(_model_id: String) -> Result<(), String> {
    Err("Native Local AI is not enabled on Android".into())
}

#[tauri::command]
fn local_ai_clear_all() -> Result<(), String> {
    Ok(())
}

fn load_android_bundle(app: &AppHandle) -> Result<updater::protocol::RosBundle, String> {
    // In debug builds embedding local `ripley-os/dist` (`DEBUG_LOCAL_UI`), always boot
    // that verified build-time archive; in release builds, prefer staged signed OTA first.
    if !DEBUG_LOCAL_UI {
        if let Some(bundle) = updater::load_bundle_at_launch(app) {
            return Ok(bundle);
        }
    }
    if !updater::ota::verify_archive_hash(ARCHIVE, ARCHIVE_EXPECTED_HASH) {
        return Err("Bundled ROS archive hash mismatch".into());
    }
    updater::protocol::RosBundle::from_archive(ARCHIVE)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(io_plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .register_uri_scheme_protocol("ros", |ctx, request| {
            let uri = request.uri().to_string();
            let path = uri
                .parse::<tauri::Url>()
                .ok()
                .map(|u| u.path().to_string())
                .unwrap_or_default();
            let (mime, body, status) = match path.as_str() {
                "/__android_boot.js" => {
                    let active_icon = commands::config::read_effective_launcher_icon(ctx.app_handle());
                    let prefix = format!(
                        "window.__ROS_ANDROID_ICON__={};\n",
                        serde_json::to_string(&active_icon).unwrap_or_else(|_| "\"default\"".into())
                    );
                    let mut script = prefix.into_bytes();
                    script.extend_from_slice(include_bytes!("android/boot.js"));
                    ("text/javascript", script, 200)
                }
                _ => {
                    let r = ctx
                        .app_handle()
                        .state::<updater::protocol::RosBundle>()
                        .resolve(&uri);
                    let mut body = r.body;
                    if r.content_type == "text/html" {
                        let mut text = String::from_utf8_lossy(&body).into_owned();
                        // Ensure meta-CSP also permits https://asset.localhost & https://ipc.localhost
                        // (use_https_scheme(true) on Android) even if an older OTA HTML only listed http://.
                        if !text.contains("https://asset.localhost") {
                            text = text.replace(
                                "http://asset.localhost",
                                "http://asset.localhost https://asset.localhost",
                            );
                        }
                        if !text.contains("https://ipc.localhost") {
                            text = text.replace(
                                "http://ipc.localhost",
                                "http://ipc.localhost https://ipc.localhost",
                            );
                        }
                        body = text
                            .replacen(
                                "</head>",
                                "<script src=\"/__android_boot.js\"></script></head>",
                                1,
                            )
                            .into_bytes();
                    }
                    (r.content_type, body, r.status)
                }
            };
            tauri::http::Response::builder()
                .status(status)
                .header("Content-Type", mime)
                .header("Content-Security-Policy", MOBILE_CSP)
                .header("Cache-Control", "no-store")
                .body(body)
                .unwrap()
        })
        .setup(|app| {
            let _ = ANDROID_APP.set(app.handle().clone());

            // 1. Load verified ROS bundle (staged signed OTA or build-time fallback).
            let bundle = load_android_bundle(app.handle())?;
            app.manage(bundle);

            // 2. Initialize full pure-Rust Monero Wallet, Arti Tor, and Multi-Wallet SyncPool.
            let wallet_state = wallet::WalletState::new(app.handle().clone());
            app.manage(wallet_state);
            app.manage(tor::TorState::new());
            app.manage(wallet::SyncPool::new());

            // 3. Apply initial WebView ProxyController policy (fail-closed sink when mode=tor
            // before Arti finishes bootstrapping) and sync launcher icon before loading ROS.
            android_sync_proxy(app.handle());
            let icon_boot = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                android_sync_launcher_icon(&icon_boot).await;
            });

            // 4. Bootstrap Arti Tor in background (so .onion APIs & Tor mode are ready).
            let tor_boot = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = wallet::scanner::ensure_tor(&tor_boot).await;
            });

            // 5. Initialize cache device key & optional Watch Sync boot.
            let watch_boot = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                wallet::device_key::init_file_key(&watch_boot);
                if wallet::scanner::read_config_bool(&watch_boot, "watchSync")
                    && wallet::device_key::ensure_watch_key(&watch_boot).await
                {
                    let data_dir = watch_boot
                        .path()
                        .app_data_dir()
                        .unwrap_or_else(|_| std::path::PathBuf::from("."));
                    let ids = wallet::storage::list_watch_ids(&data_dir);
                    if !ids.is_empty() {
                        let pool = watch_boot.state::<wallet::SyncPool>();
                        for id in ids {
                            if let Some(vp) = wallet::storage::load_watch(&data_dir, &id) {
                                pool.start(&watch_boot, id, vp, 0).await;
                            }
                        }
                    }
                }
            });

            // 6. Stage signed OTA ROS updates in background (release builds; takes effect on next launch).
            if !DEBUG_LOCAL_UI {
                let ota_boot = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                    updater::check_and_stage_update(&ota_boot).await;
                });
            }

            // 7. Determine boot path: pinned SOLO shortcut > configured `bootApp` > Desktop (`/`).
            let solo_target = PENDING_SOLO_BOOT
                .lock()
                .ok()
                .and_then(|mut s| s.take())
                .or_else(|| commands::config::read_boot_app(app.handle()));
            let boot_url = match solo_target {
                Some(app_id) => format!("ros://localhost/{app_id}"),
                None => "ros://localhost/index.html".to_string(),
            };

            let logical = app
                .primary_monitor()
                .ok()
                .flatten()
                .map(|m| {
                    let s = m.size();
                    let f = m.scale_factor();
                    (s.width as f64 / f, s.height as f64 / f)
                })
                .unwrap_or((412.0, 915.0));

            tauri::WebviewWindowBuilder::new(
                app,
                "ros-android",
                tauri::WebviewUrl::CustomProtocol(boot_url.parse()?),
            )
            .use_https_scheme(true)
            .inner_size(logical.0, logical.1)
            .on_navigation(|url| local_url(url))
            .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Android host & SOLO native commands
            android_runtime_status,
            android_renderer_ready,
            android_clipboard_read,
            android_clipboard_write,
            android_save_export,
            android_pin_shortcut,
            android_set_secure_screen,
            android_set_system_bars,
            android_list_app_icons,
            android_set_app_icon,
            android_bio_status,
            android_bio_seal,
            android_bio_unseal,
            android_bio_clear,
            migration_export_bundle,
            migration_inspect_bundle,
            migration_import_bundle,
            migration_lan_start,
            migration_lan_stop,
            migration_lan_fetch,
            migration_lan_apply,
            app_version,
            // Monero wallet lifecycle, accounts, addresses, proofs, transfers, cold signing
            commands::wallet::create_wallet,
            commands::wallet::open_wallet,
            commands::wallet::close_wallet,
            commands::wallet::get_mnemonic,
            commands::wallet::get_wallet_keys,
            commands::wallet::get_accounts,
            commands::wallet::create_account,
            commands::wallet::rename_account,
            commands::wallet::get_balance,
            commands::wallet::get_height,
            commands::wallet::get_subaddresses,
            commands::wallet::find_address_owner,
            commands::wallet::create_subaddress,
            commands::wallet::set_subaddress_label,
            commands::wallet::estimate_fees,
            commands::wallet::prepare_transfer,
            commands::wallet::relay_transfer,
            commands::wallet::sweep_all,
            commands::wallet::sweep_single,
            commands::wallet::reselect_node,
            commands::wallet::get_transactions,
            commands::wallet::get_outputs,
            commands::wallet::get_tx_key,
            commands::wallet::get_tx_proof,
            commands::wallet::sign_message,
            commands::wallet::check_tx_key,
            commands::wallet::check_tx_proof,
            commands::wallet::get_sync_status,
            commands::wallet::refresh,
            commands::wallet::set_vigil_hot,
            commands::wallet::verify_password,
            commands::wallet::change_wallet_password,
            commands::wallet::rescan,
            commands::wallet::import_watch_only,
            commands::wallet::export_watch_only,
            commands::wallet::export_unsigned_transfer,
            commands::wallet::sign_offline_transfer,
            commands::wallet::import_signed_transfer,
            commands::wallet::inspect_seed,
            commands::wallet::import_view_only,
            // Identities
            commands::identity::get_identities,
            commands::identity::save_identities,
            commands::identity::switch_identity,
            commands::identity::delete_identity,
            // Autonomous Transfer Grants
            commands::transfer_grant::arm_transfer_grant,
            commands::transfer_grant::relay_transfer_grant,
            commands::transfer_grant::revoke_transfer_grant,
            commands::transfer_grant::revoke_all_transfer_grants,
            commands::transfer_grant::transfer_grant_status,
            // Tor
            commands::tor::get_tor_status,
            commands::tor::tor_circuit,
            commands::tor::restart_tor,
            // Config & Signed OTA
            commands::config::get_config,
            commands::config::save_config,
            commands::config::save_config_and_reload,
            commands::config::watch_sync_set,
            updater::check_ros_update,
            updater::ros_channel_status,
            // Persistence: Disk KV, Wallpapers, XMR402
            commands::ros_kv::ros_kv_load,
            commands::ros_kv::ros_kv_set,
            commands::ros_kv::ros_kv_remove,
            commands::ros_kv::ros_kv_clear,
            commands::wallpaper::wallpaper_save,
            commands::wallpaper::wallpaper_url,
            commands::wallpaper::wallpaper_clear,
            commands::kvstore::save_xmr402_payment,
            commands::kvstore::get_xmr402_payment,
            commands::kvstore::get_all_xmr402_payments,
            // Network: CORS-free fetch, web reader, OpenAlias DoH
            android_net::ros_native_fetch,
            android_net::ros_native_fetch_bytes,
            android_net::agent_web_read,
            android_net::resolve_openalias,
            // Embedded Overlay Browser & External URL
            open_external_url,
            open_native_browser,
            browser_embed_open,
            browser_embed_bounds,
            browser_embed_navigate,
            browser_embed_visible,
            browser_embed_zoom,
            browser_embed_close,
            browser_embed_deliver_xmr402,
            // Built-in X App Overlay & XMRadar Bridge
            xapp_open,
            xapp_bounds,
            xapp_navigate,
            xapp_visible,
            xapp_zoom,
            xapp_history,
            xapp_close,
            xapp_push,
            xapp_bridge_reply,
            // Honest stubs for desktop-only features
            vpn_status,
            vpn_open_window,
            vpn_set_locale,
            agent_gateway_status,
            agent_gateway_set_config,
            agent_gateway_rotate_key,
            local_ai_status,
            local_ai_download,
            local_ai_load,
            local_ai_complete,
            local_ai_remove,
            local_ai_clear_all,
        ])
        .run(tauri::generate_context!())
        .expect("Ripley Terminal Android startup failed");
}
