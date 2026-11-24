use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::wallet::{BlockScanner, WalletState};

fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("config.json")
}

/// Side file for the skin background data URL — kept out of config.json so the
/// (frequently-rewritten) config stays small even with a multi-MB image.
fn skin_bg_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("skin_bg.b64")
}

#[tauri::command]
pub async fn get_config(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = config_path(&app);
    let mut config = match std::fs::read_to_string(&path) {
        // Merge the stored config OVER the defaults so configs written before a
        // new key existed (e.g. `shortcuts`) get backfilled — otherwise the
        // Settings UI shows empty sections for keys the old file never had.
        Ok(data) => {
            let stored: serde_json::Value =
                serde_json::from_str(&data).map_err(|e| format!("Config parse error: {}", e))?;
            let mut merged = default_config();
            if let (Some(m), Some(s)) = (merged.as_object_mut(), stored.as_object()) {
                for (k, v) in s {
                    m.insert(k.clone(), v.clone());
                }
            }
            // A config saved before `shortcuts` existed may have persisted it as
            // an empty object — treat that as missing and restore the defaults so
            // the Settings keybinding rows aren't blank.
            let shortcuts_empty = merged
                .get("shortcuts")
                .and_then(|s| s.as_object())
                .map_or(true, |o| o.is_empty());
            if shortcuts_empty {
                if let Some(m) = merged.as_object_mut() {
                    m.insert(
                        "shortcuts".to_string(),
                        default_config()["shortcuts"].clone(),
                    );
                }
            }
            merged
        }
        // Keep these in sync with the renderer's SettingsView controls so it
        // never reads `undefined`.
        Err(_) => default_config(),
    };

    // Reattach the skin background from its side file (it's stored out of
    // config.json to keep that small). Falls back to whatever's already in the
    // config if there's no side file (e.g. a pre-offload config still embedding
    // it — that migrates to the side file on the next save).
    if let Ok(bg) = std::fs::read_to_string(skin_bg_path(&app)) {
        if !bg.is_empty() {
            if let Some(m) = config.as_object_mut() {
                m.insert("skin_background".to_string(), serde_json::json!(bg));
            }
        }
    }
    Ok(config)
}

/// Default config shape. Mirrors the controls SettingsView renders.
pub fn default_config() -> serde_json::Value {
    serde_json::json!({
        "ui_mode": "classic",
        "routingMode": "clearnet",
        "transportPolicy": {
            "v": 2,
            "vpn": "ignore"
        },
        "useSystemProxy": true,
        "systemProxyAddress": "",
        "network": "mainnet",
        "customNodeAddress": "",
        "autoLockMinutes": 10,
        "show_scanlines": true,
        "hide_zero_balances": false,
        "include_prereleases": false,
        "watchSync": false,
        "watchSyncAsked": false,
        "watchSyncKeychainExplained": false,
        "sync_all_wallets": false,
        "fast_sync": false,
        "shortcuts": {
            "LOCK": "Mod+L",
            "SEND": "Mod+S",
            "RECEIVE": "Mod+R",
            "CHURN": "Mod+Alt+C",
            "SPLIT": "Mod+Alt+S",
            "SYNC": "Mod+U",
            "SETTINGS": "Mod+,",
            "TERMINAL": "Mod+Shift+T"
        }
    })
}

/// The UI the shell boots into. Read at startup (before any window exists) to pick
/// the main webview's URL: "classic" → the bundled legacy renderer, "ros" → RipleyOS.
/// Reads config.json directly (not get_config) so it stays sync and never touches
/// the skin side file. Unknown/missing/corrupt → "classic", the safe default.
pub fn read_ui_mode(app: &AppHandle) -> String {
    let stored = std::fs::read_to_string(config_path(app))
        .ok()
        .and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok())
        .and_then(|c| {
            c.get("ui_mode")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
    match stored.as_deref() {
        Some("ros") => "ros".to_string(),
        _ => "classic".to_string(),
    }
}

/// A first launch (no config.json yet) boots RipleyOS: write `{"ui_mode":"ros"}` (temp file, then rename) before the
/// window is built. Returns the mode to boot when it decided one; an existing file is never touched. A failed write is
/// logged and this launch still boots ROS (the next launch decides again).
pub fn seed_first_launch_ui_mode(app: &AppHandle) -> Option<String> {
    let path = config_path(app);
    let mode = crate::boot::first_launch_ui_mode(path.exists())?;
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(path.parent().unwrap_or(std::path::Path::new(".")))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::json!({ "ui_mode": mode }).to_string())?;
        std::fs::rename(&tmp, &path)
    };
    match write() {
        Ok(()) => println!("[UI] first launch — booting RipleyOS (ui_mode=ros saved)"),
        Err(e) => println!("[UI/warn] first launch — booting RipleyOS, but config.json could not be written ({e})"),
    }
    Some(mode.to_string())
}

/// Where a `ui_mode=ros` window sources its UI from:
/// - `"beta"` → remote `https://app.ros.rip` (fast iteration; the current default),
/// - `"ota"`  → the on-device verified `ros://local` bundle (signed OTA — the stable path).
///
/// Kept a SEPARATE key from `ui_mode` so the beta remote path and the OTA local path can
/// coexist during bring-up (a bad OTA bundle can't strand the user — flip back to beta).
/// Unknown/absent → `"beta"`.
pub fn read_ros_source(app: &AppHandle) -> String {
    let stored = std::fs::read_to_string(config_path(app))
        .ok()
        .and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok())
        .and_then(|c| {
            c.get("ros_source")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
    match stored.as_deref() {
        Some("ota") => "ota".to_string(),
        _ => "beta".to_string(),
    }
}

/// Validate + set `ui_mode` on a config object. Pure (no I/O) so it's unit-testable;
/// `set_ui_mode` owns the persistence + relaunch around it.
fn apply_ui_mode(config: &mut serde_json::Value, mode: &str) -> Result<(), String> {
    if mode != "classic" && mode != "ros" {
        return Err(format!(
            "invalid ui_mode \"{mode}\" — expected \"classic\" or \"ros\""
        ));
    }
    config
        .as_object_mut()
        .ok_or_else(|| "config is not an object".to_string())?
        .insert("ui_mode".to_string(), serde_json::json!(mode));
    Ok(())
}

#[tauri::command]
pub async fn get_ui_mode(app: AppHandle) -> Result<String, String> {
    Ok(read_ui_mode(&app))
}

/// Switch the shell UI (classic ↔ RipleyOS) and RELAUNCH into it. A full process
/// restart — not an in-place navigate — is deliberate: it drops every renderer
/// global and lets startup re-derive the window + capability binding from the
/// persisted mode (the conservative choice for a wallet).
///
/// Persistence is a raw read-modify-write of config.json touching ONLY `ui_mode`,
/// so it can't clobber settings the caller never saw (and skips the skin-offload
/// round-trip in save_config).
#[tauri::command]
pub async fn set_ui_mode(app: AppHandle, mode: String) -> Result<(), String> {
    let path = config_path(&app);
    let mut config = std::fs::read_to_string(&path)
        .ok()
        .and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    apply_ui_mode(&mut config, &mode)?;

    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|e| format!("Failed to create config dir: {}", e))?;
    let data = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    // Write-then-rename so a crash between here and restart() can't leave a
    // truncated config.json (rename is atomic on the same filesystem).
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("Failed to write config: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Failed to replace config: {}", e))?;

    crate::emit_log(
        &app,
        "UI",
        "info",
        &format!("Switching interface to {mode} — relaunching..."),
    );
    #[cfg(not(target_os = "android"))]
    {
        // Diverges (never returns): the process relaunches into the new mode.
        app.restart()
    }
    #[cfg(target_os = "android")]
    {
        Err("Classic desktop mode is not supported on Android".into())
    }
}

/// Strictly validate a startup SOLO app id (`[a-z0-9_-]{1,32}`), preventing path
/// traversal or external origin injection when building `ros://localhost/<appId>`.
pub fn sanitize_boot_app_id(raw: &str) -> Option<String> {
    let s = raw.trim().to_ascii_lowercase();
    if s.is_empty() || s.len() > 32 {
        return None;
    }
    if s.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    {
        Some(s)
    } else {
        None
    }
}

/// Validate a cold-start SOLO path: either `<appId>` or `<appId>/<safe-subpath>`
/// (rejecting traversal, queries/fragments, or control chars).
pub fn sanitize_solo_boot_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches('/');
    let (app_part, rest) = match trimmed.split_once('/') {
        Some((a, r)) => (a, Some(r)),
        None => (trimmed, None),
    };
    let clean_app = sanitize_boot_app_id(app_part)?;
    let Some(sub) = rest else {
        return Some(clean_app);
    };
    let sub = sub.trim_end_matches('/');
    if sub.is_empty() {
        return Some(clean_app);
    }
    if sub.len() > 256 || sub.contains("..") || sub.contains('\\') {
        return None;
    }
    if !sub.bytes().all(|b| {
        b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.' | b':' | b'@' | b'~')
    }) {
        return None;
    }
    Some(format!("{clean_app}/{sub}"))
}

/// Read the configured startup SOLO app id from `config.json`.
/// - `bootApp: null / ""` → `None` (boot into RipleyOS Desktop `/`)
/// - `bootApp: "last"` → resolves `lastApp` (if valid)
/// - `bootApp: "<appId>"` → `Some("<appId>")`
pub fn read_boot_app(app: &AppHandle) -> Option<String> {
    let cfg = std::fs::read_to_string(config_path(app))
        .ok()
        .and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok())?;
    let boot = cfg.get("bootApp").and_then(|v| v.as_str())?.trim();
    if boot.is_empty() {
        return None;
    }
    if boot.eq_ignore_ascii_case("last") {
        let last = cfg.get("lastApp").and_then(|v| v.as_str())?;
        return sanitize_boot_app_id(last);
    }
    sanitize_boot_app_id(boot)
}

/// Resolve which Android launcher icon alias should be active:
/// - `appIcon == Some("default")` → `"default"` (explicit ROS icon)
/// - `appIcon == Some("<id>")` (not `"auto"`) → that explicit embedded app icon
/// - `appIcon == None | Some("") | Some("auto")` → follow `bootApp` when it names a specific
///   app (not Desktop or `"last"`), otherwise `"default"` (ROS icon).
pub fn effective_launcher_icon(boot_app: Option<&str>, app_icon: Option<&str>) -> String {
    if let Some(raw_icon) = app_icon.map(str::trim).filter(|s| !s.is_empty()) {
        if raw_icon.eq_ignore_ascii_case("default") {
            return "default".to_string();
        }
        if !raw_icon.eq_ignore_ascii_case("auto") {
            if let Some(clean) = sanitize_boot_app_id(raw_icon) {
                return clean;
            }
        }
    }
    if let Some(raw_boot) = boot_app.map(str::trim).filter(|s| !s.is_empty()) {
        if !raw_boot.eq_ignore_ascii_case("last") {
            if let Some(clean) = sanitize_boot_app_id(raw_boot) {
                return clean;
            }
        }
    }
    "default".to_string()
}

pub fn read_effective_launcher_icon(app: &AppHandle) -> String {
    let cfg = std::fs::read_to_string(config_path(app))
        .ok()
        .and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok());
    let boot = cfg
        .as_ref()
        .and_then(|c| c.get("bootApp"))
        .and_then(|v| v.as_str());
    let icon = cfg
        .as_ref()
        .and_then(|c| c.get("appIcon"))
        .and_then(|v| v.as_str());
    effective_launcher_icon(boot, icon)
}

/// App metadata + on-disk storage locations for the Settings → Data Storage
/// panel (the renderer showed "Loading..." because the bridge returned empty
/// paths). appDataPath holds config/nodes/Tor state; walletsPath holds the
/// encrypted .vault files.
#[tauri::command]
pub async fn get_app_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let wallets = app_data.join("wallets");
    Ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "appDataPath": app_data.to_string_lossy(),
        "walletsPath": wallets.to_string_lossy(),
        "platform": std::env::consts::OS,
        "isPackaged": !cfg!(debug_assertions),
    }))
}

/// Launch-capable file extensions `reveal_path` refuses to hand the OS opener even
/// inside the app dirs: `open`/`xdg-open`/`explorer` would RUN these, not reveal them.
/// Covers direct executables/scripts plus indirect launchers — `.desktop` executes its
/// `Exec=` line under `xdg-open`, and `.lnk` follows a shortcut to an arbitrary target.
const REVEAL_BLOCKED_EXT: &[&str] = &[
    "app",
    "exe",
    "com",
    "cmd",
    "bat",
    "sh",
    "bash",
    "zsh",
    "command",
    "scpt",
    "applescript",
    "desktop",
    "lnk",
];

/// Confinement check for `reveal_path`, split out PURE (no filesystem / process I/O)
/// so it's unit-testable. `requested` and `allowed` are ALREADY canonicalized by the
/// caller, so `..`/symlinks are resolved before we get here. Allows the path iff it
/// sits inside an allowed base — `Path::starts_with` is component-wise, so `/data`
/// never matches a sibling like `/data-evil` — and carries no launch-capable extension.
fn reveal_guard(requested: &Path, allowed: &[PathBuf]) -> Result<(), String> {
    if !allowed.iter().any(|base| requested.starts_with(base)) {
        return Err("Refusing to reveal a path outside the app's data directories".into());
    }
    if let Some(ext) = requested.extension().and_then(|e| e.to_str()) {
        if REVEAL_BLOCKED_EXT
            .iter()
            .any(|b| b.eq_ignore_ascii_case(ext))
        {
            return Err("Refusing to open an executable path".into());
        }
    }
    Ok(())
}

/// Reveal a path in the OS file manager (Settings → Data Storage "Reveal").
///
/// The renderer supplies `path`, so treat it as hostile: `open <arg>` will happily
/// launch an arbitrary app bundle or a URL (which in Tor mode would deanonymize by
/// opening in the default browser). Only reveal locations UNDER the app's own
/// data/log dirs — the Settings panel only ever passes those. We canonicalize the
/// request (resolving `..`/symlinks and requiring it to exist, so a URL or a
/// non-file can't slip through) and confirm it sits inside an allowed base.
///
/// Callers pass DIRECTORIES (the data/log dirs): `open <dir>` opens the folder in the
/// file manager. Note `open <file>` would instead LAUNCH the file's default handler
/// (macOS reveal-in-Finder needs `open -R`); `reveal_guard` refuses launch-capable
/// files, but a benign handler-triggering file (e.g. `.html`/`.pdf`) inside app_data
/// would still open in the default app — acceptable since only validated writers ever
/// touch app_data today.
#[tauri::command]
pub async fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    // Canonicalize each allowed base up front (resolves symlinks; on macOS also maps
    // /var → /private/var) so it compares against the equally-canonicalized request.
    let mut allowed: Vec<PathBuf> = Vec::new();
    for base in [app.path().app_data_dir(), app.path().app_log_dir()] {
        if let Ok(d) = base {
            if let Ok(c) = std::fs::canonicalize(&d) {
                allowed.push(c);
            }
        }
    }

    let requested = std::fs::canonicalize(&path).map_err(|_| "Path does not exist".to_string())?;
    reveal_guard(&requested, &allowed)?;

    #[cfg(target_os = "android")]
    {
        let _ = requested;
        return Err("Revealing files in a desktop file manager is not supported on Android".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        #[cfg(target_os = "macos")]
        let program = "open";
        #[cfg(target_os = "windows")]
        let program = "explorer";
        #[cfg(all(unix, not(target_os = "macos")))]
        let program = "xdg-open";

        std::process::Command::new(program)
            .arg(&requested)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {e}", requested.display()))?;
        Ok(())
    }
}

#[tauri::command]
pub async fn save_config(app: AppHandle, mut config: serde_json::Value) -> Result<(), String> {
    // routingMode is consumed independently by scanner/browser/fetch paths.
    // Unknown values historically fell through to direct clearnet, so reject
    // them at the shared write boundary.
    if let Some(mode) = config.get("routingMode").and_then(|v| v.as_str()) {
        if !crate::wallet::scanner::known_routing_mode(mode) {
            return Err(format!(
                "Unknown routingMode {mode:?}; refusing to persist a fail-open network mode"
            ));
        }
    } else if config.get("routingMode").is_some() {
        return Err("routingMode must be a string".into());
    }

    let path = config_path(&app);
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|e| format!("Failed to create config dir: {}", e))?;

    // Offload a large skin background (a base64 data URL) to a side file so
    // config.json stays small — it's rewritten on every save, and embedding a
    // multi-MB image bloated it. get_config reattaches it on read.
    let skin_path = skin_bg_path(&app);
    if let Some(obj) = config.as_object_mut() {
        match obj.get("skin_background").and_then(|v| v.as_str()) {
            Some(bg) if !bg.is_empty() => {
                std::fs::write(&skin_path, bg)
                    .map_err(|e| format!("Failed to write skin background: {}", e))?;
                obj.insert("skin_background".to_string(), serde_json::json!(""));
            }
            // Explicitly cleared → remove the side file so it doesn't reappear.
            Some(_) => {
                let _ = std::fs::remove_file(&skin_path);
            }
            None => {}
        }
    }

    let data = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&path, data).map_err(|e| format!("Failed to write config: {}", e))?;
    #[cfg(target_os = "android")]
    {
        crate::android_sync_proxy_now(&app).await;
        crate::android_sync_launcher_icon(&app).await;
    }
    Ok(())
}

/// Save config for UI-only preferences (scanlines, auto-lock, theme). Does NOT
/// touch the network uplink — use this when nothing about routing changed.
#[tauri::command]
pub async fn save_config_only(app: AppHandle, config: serde_json::Value) -> Result<(), String> {
    save_config(app, config).await
}

/// Read-modify-write a single boolean key in config.json (full get/save round-trip
/// so the skin-background offload and defaults keep working).
pub async fn set_config_bool(app: &AppHandle, key: &str, value: bool) -> Result<(), String> {
    let mut cfg = get_config(app.clone())
        .await
        .unwrap_or_else(|_| default_config());
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert(key.to_string(), serde_json::Value::Bool(value));
    }
    save_config(app.clone(), cfg).await
}

/// Enable/disable the watch tier's boot-time view-only sync. This is the ONLY
/// writer of the `watchSync` flag so the off-path ordering is enforced in one
/// place: persist the flag → stop all pool scanners (awaits quiescence) → delete
/// the persisted view pairs. Enabling takes effect at the next unlock (that's
/// when a `.watch` file is written) and syncs from the next launch.
#[tauri::command]
pub async fn watch_sync_set(
    app: AppHandle,
    state: tauri::State<'_, WalletState>,
    pool: tauri::State<'_, crate::wallet::SyncPool>,
    enabled: bool,
) -> Result<(), String> {
    log::info!("[watch-sync] watch_sync_set entered enabled={enabled}");
    crate::emit_log(
        &app,
        "Wallet",
        "info",
        &format!("👁 Sync at launch toggle requested: {enabled}"),
    );
    // Enabling needs the keychain-backed watch key FIRST (this is the moment the
    // OS may prompt — the user just clicked Enable, so it has clear context). A
    // denied/unavailable keychain fails the whole toggle: the flag is not set,
    // the renderer reverts the checkbox, and nothing is stored anywhere.
    if enabled && !crate::wallet::device_key::ensure_watch_key(&app).await {
        // Record that the question was answered so the one-time consent modal
        // doesn't loop; the feature stays off until a successful re-enable.
        set_config_bool(&app, "watchSyncAsked", true).await?;
        log::warn!("[watch-sync] enable rejected: keychain unavailable or denied");
        crate::emit_log(&app, "Wallet", "error",
            "👁 Sync at launch needs the system keychain to protect the view key — the keychain was denied or unavailable, so it stays off.");
        return Err("keychain unavailable or denied".into());
    }
    set_config_bool(&app, "watchSync", enabled).await?;
    // A manual toggle IS the consent decision — don't re-ask.
    set_config_bool(&app, "watchSyncAsked", true).await?;
    if enabled {
        // If a wallet is unlocked right now (the in-app consent shows post-unlock),
        // persist its watch pair immediately from in-memory keys — the choice takes
        // effect from the very next launch, no extra unlock needed.
        if let Some((id, spend_pub, view_sec)) = state.watch_parts_from_memory().await {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            if let Err(e) =
                crate::wallet::storage::save_watch(&data_dir, &id, &spend_pub, &view_sec)
            {
                log::warn!("watch store write for {id} failed: {e}");
            }
        }
        crate::emit_log(
            &app,
            "Wallet",
            "info",
            "👁 Sync at launch enabled — watch-only sync starts from the next launch.",
        );
        log::info!("[watch-sync] enabled successfully");
    } else {
        pool.stop_all().await;
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        for id in crate::wallet::storage::list_watch_ids(&data_dir) {
            crate::wallet::storage::delete_watch(&data_dir, &id);
        }
        crate::emit_log(
            &app,
            "Wallet",
            "info",
            "👁 Sync at launch disabled — persisted view keys removed.",
        );
        log::info!("[watch-sync] disabled successfully");
    }
    Ok(())
}

/// Save config AND apply network-affecting changes live. If a wallet is
/// unlocked, restart the block scanner so a new routingMode / proxy / node /
/// network takes effect without re-login. BlockScanner::start bumps the scanner
/// generation, so the running scanner is cleanly superseded after its current
/// batch and the new one re-races nodes (re-reading config + re-running Tor
/// bootstrap as needed). The scanner resumes from the current scan height, so
/// no progress is lost.
#[tauri::command]
pub async fn save_config_and_reload(
    app: AppHandle,
    config: serde_json::Value,
) -> Result<(), String> {
    save_config(app.clone(), config).await?;

    let state = app.state::<WalletState>();
    if !state.is_locked().await {
        let height = state.get_scan_height().await;
        crate::emit_log(
            &app,
            "Network",
            "info",
            "♻️ Routing changed — restarting uplink with the new configuration...",
        );
        BlockScanner::start(app.clone(), "", "", height).await?;
    }

    // Apply the "Sync all wallets" setting immediately: reconcile the background
    // pool with the (possibly just-changed) toggle.
    let pool = app.state::<crate::wallet::SyncPool>();
    match state.active_session().await {
        Some((id, pw)) => {
            crate::commands::wallet::refresh_pool(&app, &state, &pool, &id, &pw).await
        }
        // Locked: can't start background sync without a password; if the toggle
        // is off, make sure nothing is left running.
        None => {
            if !crate::wallet::scanner::read_config_bool(&app, "sync_all_wallets") {
                pool.stop_all().await;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod ui_mode_tests {
    use super::{apply_ui_mode, default_config};

    #[test]
    fn default_config_boots_classic() {
        assert_eq!(default_config()["ui_mode"], "classic");
        assert_eq!(default_config()["transportPolicy"]["v"], 2);
        assert_eq!(default_config()["transportPolicy"]["vpn"], "ignore");
    }

    #[test]
    fn round_trips_both_modes() {
        let mut c = default_config();
        apply_ui_mode(&mut c, "ros").unwrap();
        assert_eq!(c["ui_mode"], "ros");
        apply_ui_mode(&mut c, "classic").unwrap();
        assert_eq!(c["ui_mode"], "classic");
    }

    #[test]
    fn preserves_sibling_keys() {
        let mut c = serde_json::json!({ "routingMode": "tor", "autoLockMinutes": 5 });
        apply_ui_mode(&mut c, "ros").unwrap();
        assert_eq!(c["routingMode"], "tor");
        assert_eq!(c["autoLockMinutes"], 5);
        assert_eq!(c["ui_mode"], "ros");
    }

    #[test]
    fn rejects_unknown_modes_untouched() {
        // The renderer is untrusted — an arbitrary mode string must not persist.
        let mut c = default_config();
        for bad in ["", "ROS", "classic ", "file:///x", "both"] {
            assert!(
                apply_ui_mode(&mut c, bad).is_err(),
                "{bad:?} should be rejected"
            );
            assert_eq!(c["ui_mode"], "classic", "{bad:?} must not change the mode");
        }
    }

    #[test]
    fn sanitize_boot_app_id_enforces_strict_slugs() {
        use super::sanitize_boot_app_id;
        assert_eq!(sanitize_boot_app_id("wallet").as_deref(), Some("wallet"));
        assert_eq!(sanitize_boot_app_id("  Markets ").as_deref(), Some("markets"));
        assert_eq!(sanitize_boot_app_id("auto-dca_1").as_deref(), Some("auto-dca_1"));
        for bad in ["", "   ", "../etc", "wallet/btc", "https://evil.com", "a?b=1", "a#b", "a b"] {
            assert_eq!(sanitize_boot_app_id(bad), None, "{bad:?} must be rejected");
        }
    }
}

#[cfg(test)]
mod reveal_guard_tests {
    use super::{reveal_guard, Path, PathBuf};

    // Two allowed bases, as reveal_path builds (already canonicalized in production).
    fn bases() -> Vec<PathBuf> {
        vec![
            PathBuf::from("/home/u/.app/data"),
            PathBuf::from("/home/u/.app/logs"),
        ]
    }

    #[test]
    fn accepts_a_dir_inside_an_allowed_base() {
        assert!(reveal_guard(Path::new("/home/u/.app/data/wallets"), &bases()).is_ok());
        assert!(reveal_guard(Path::new("/home/u/.app/logs"), &bases()).is_ok());
    }

    #[test]
    fn accepts_a_non_launchable_file_inside() {
        assert!(reveal_guard(Path::new("/home/u/.app/data/config.json"), &bases()).is_ok());
    }

    #[test]
    fn rejects_a_path_outside_every_base() {
        assert!(reveal_guard(Path::new("/etc/passwd"), &bases()).is_err());
        assert!(reveal_guard(Path::new("/home/u/.ssh/id_ed25519"), &bases()).is_err());
    }

    #[test]
    fn rejects_a_prefix_sibling_directory() {
        // Component-wise starts_with: "/home/u/.app/data-evil" must NOT match ".../data".
        assert!(reveal_guard(Path::new("/home/u/.app/data-evil/loot"), &bases()).is_err());
    }

    #[test]
    fn rejects_launch_capable_extensions_case_insensitively() {
        for name in [
            "payload.app",
            "run.sh",
            "x.EXE",
            "hook.desktop",
            "s.LNK",
            "a.scpt",
        ] {
            let p = PathBuf::from("/home/u/.app/data").join(name);
            assert!(
                reveal_guard(&p, &bases()).is_err(),
                "{name} should be refused"
            );
        }
    }

    #[test]
    fn effective_launcher_icon_follows_boot_app_and_explicit_override() {
        use super::effective_launcher_icon;
        // Default: desktop boot + no icon override -> default ROS icon
        assert_eq!(effective_launcher_icon(None, None), "default");
        assert_eq!(effective_launcher_icon(Some(""), Some("auto")), "default");
        assert_eq!(effective_launcher_icon(Some("last"), None), "default");
        // Changing startup app uses that app's icon by default (auto)
        assert_eq!(effective_launcher_icon(Some("markets"), None), "markets");
        assert_eq!(effective_launcher_icon(Some("calc"), Some("auto")), "calc");
        // Explicit override wins over bootApp
        assert_eq!(effective_launcher_icon(Some("wallet"), Some("calc")), "calc");
        assert_eq!(effective_launcher_icon(None, Some("notepad")), "notepad");
        // Explicit "default" forces ROS icon even when bootApp is a SOLO app
        assert_eq!(effective_launcher_icon(Some("markets"), Some("default")), "default");
        // Traversal/invalid values fail closed to default
        assert_eq!(effective_launcher_icon(Some("../evil"), None), "default");
        assert_eq!(effective_launcher_icon(None, Some("a/b")), "default");
    }
}
