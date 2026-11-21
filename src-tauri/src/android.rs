// Experimental Android host. Desktop remains in desktop.rs. No production wallet
// or raw-secret IPC is registered here; diagnostics are DEBUG-only and stagenet-only.
mod wallet {
    pub mod base58_monero;
    pub mod msg_sign;
    pub mod offline;
    pub mod owner;
    pub mod state;
    pub mod time;
    pub mod transfer_ledger;
    pub mod types;
    pub use state::WalletState;
    pub mod data_budget;
    pub mod fetch_health;
    pub mod keys;
    pub mod reqwest_transport;
    pub mod storage;
    // Android Keystore has NOT been implemented. Never claim a watch/cache key.
    pub mod device_key {
        pub fn cache_key() -> Option<zeroize::Zeroizing<[u8; 32]>> {
            None
        }
        pub fn watch_key() -> Option<zeroize::Zeroizing<[u8; 32]>> {
            None
        }
    }
}
mod updater {
    pub mod ota;
    pub mod protocol;
}
mod tor {
    pub mod transport;
}

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{Manager, WebviewWindow};

mod android_policy;
mod android_session;
mod android_chain;
mod android_terminal;
mod commands {
    pub mod ros_kv;
    pub mod wallet {
        pub(crate) use crate::wallet::time::sent_time;
    }
}
static ANDROID_FOREGROUND: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
static ANDROID_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
use android_policy::{DIAGNOSTICS, ORIGIN as ROS_ORIGIN};
const MOBILE_CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: ipc: http://ipc.localhost; media-src 'self' data: blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
include!(concat!(env!("OUT_DIR"), "/android_bundle.rs"));
struct PocSession {
    wallet_unlocked: Mutex<bool>,
    epoch: AtomicU64,
}
static POC_SESSION: PocSession = PocSession {
    wallet_unlocked: Mutex::new(false),
    epoch: AtomicU64::new(0),
};
// Called from this app's Kotlin Activity only. No JS wallet/key access.
#[no_mangle]
pub extern "system" fn Java_run_ripley_androidpoc_MainActivity_nativeResume(
    _: *mut std::ffi::c_void,
    _: *mut std::ffi::c_void,
) {
    ANDROID_FOREGROUND.store(true, Ordering::SeqCst);
    if POC_SESSION.epoch.load(Ordering::SeqCst) > 0 {
        if let Some(app) = ANDROID_APP.get() {
            android_terminal::notify_lock(app);
        }
    }
}
#[no_mangle]
pub extern "system" fn Java_run_ripley_androidpoc_MainActivity_nativeLock(
    _: *mut std::ffi::c_void,
    _: *mut std::ffi::c_void,
) {
    ANDROID_FOREGROUND.store(false, Ordering::SeqCst);
    POC_SESSION.epoch.fetch_add(1, Ordering::SeqCst);
    if let Some(app) = ANDROID_APP.get().cloned() {
        let ticket=app.state::<android_terminal::TerminalState>().session.invalidate();
        android_terminal::notify_lock(&app);
        tauri::async_runtime::spawn(async move {
            let terminal=app.state::<android_terminal::TerminalState>();
            let _operation=terminal.wallet_ops.lock().await;
            if !terminal.session.accepts(ticket){return;}
            if let Some(state) = app.try_state::<wallet::WalletState>() {
                state.lock().await;
            }
        });
    }
    if let Ok(mut unlocked) = POC_SESSION.wallet_unlocked.lock() {
        *unlocked = false;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    bridge_version: u32,
    platform: &'static str,
    abi: &'static str,
    app_version: &'static str,
    debug_poc: bool,
    custody: &'static str,
    capabilities: Value,
}
fn local_url(url: &tauri::Url) -> bool {
    android_policy::trusted_location(
        url.scheme(),
        url.host_str().unwrap_or(""),
        url.port(),
        !url.username().is_empty() || url.password().is_some(),
    )
}
fn diagnostic_allowed(debug: bool, label: &str, url: &tauri::Url) -> bool {
    local_url(url) && android_policy::diagnostic_allowed(debug, label, ROS_ORIGIN, url.path())
}
fn require_poc(webview: &WebviewWindow) -> Result<(), String> {
    if diagnostic_allowed(
        cfg!(debug_assertions),
        webview.label(),
        &webview.url().map_err(|_| "no origin")?,
    ) {
        Ok(())
    } else {
        Err("Android POC diagnostic access denied".into())
    }
}
#[tauri::command]
fn android_runtime_status(webview: WebviewWindow) -> Result<RuntimeStatus, String> {
    if webview.label() != "ros-android" || !local_url(&webview.url().map_err(|_| "no origin")?) {
        return Err("Untrusted origin".into());
    }
    Ok(RuntimeStatus {
        bridge_version: 1,
        platform: "android",
        abi: std::env::consts::ARCH,
        app_version: env!("CARGO_PKG_VERSION"),
        debug_poc: cfg!(debug_assertions),
        custody: if cfg!(debug_assertions) {
            if cfg!(android_mainnet_readonly) {
                "debug-mainnet-readonly-throwaway"
            } else {
                "debug-stagenet-test-only"
            }
        } else {
            "keyless"
        },
        capabilities: json!({"bundledRos":true,"productionSigning":false,"remoteBridge":false,
          "arbitraryNetwork":false,"keystore":false,"backgroundSync":false,
          "uiRevision":UI_REVISION,"debugLocalUi":DEBUG_LOCAL_UI,"stagenetDiagnostics": cfg!(debug_assertions),"terminalWalletTestCore":cfg!(debug_assertions),
          "secretExport":false,"spending":false,"fullWalletSync":false,"outputCacheSealing":true,"softwarePasswordEncryption":true,"resumableBatchedScan":true,"mainnetReadOnlyTest":cfg!(android_mainnet_readonly),"offlineRegtest":cfg!(android_offline_regtest),"offlineStagenetProtocolTest":cfg!(android_offline_stagenet),
          "publicHttpsGet":true,"networkPost":false,"torRouting":false,
          "nativePreferences":true,"nativeClipboardText":true,"nativeNotifications":true,"walletKeystore":false,"nativeDocumentSave":true,"browserMode":"isolated-clearnet-activity","foregroundWalletLock":true}),
    })
}
fn save_report(app: &tauri::AppHandle, name: &str, value: &Value) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("android-poc");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    std::fs::write(
        root.join(format!("{name}.json")),
        serde_json::to_vec_pretty(value).unwrap(),
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
async fn android_poc_wallet(
    app: tauri::AppHandle,
    webview: WebviewWindow,
    consent: String,
) -> Result<Value, String> {
    require_poc(&webview)?;
    if consent != "STAGENET TEST ONLY" {
        return Err("Explicit stagenet test consent required".into());
    }
    let session = &POC_SESSION;
    let epoch = session.epoch.load(Ordering::SeqCst);
    let a = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || wallet_check(&a))
        .await
        .map_err(|_| "wallet worker failed")??;
    // A lock during encryption must never resurrect an unlocked session.
    if epoch != session.epoch.load(Ordering::SeqCst) {
        return Err("Locked during wallet check".into());
    }
    *session.wallet_unlocked.lock().map_err(|_| "session lock")? = true;
    save_report(&app, "wallet", &result)?;
    Ok(result)
}
#[cfg(debug_assertions)]
fn wallet_check(app: &tauri::AppHandle) -> Result<Value, String> {
    use wallet::{keys, storage};
    use zeroize::Zeroizing;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("android-poc/stagenet");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    // PUBLIC TEST PASSWORD. This file can NEVER be used for funds; no caller-supplied
    // phrase, password, destination, network or identity is accepted by this API.
    let password = "PUBLIC-ANDROID-POC-STAGENET-ONLY";
    let existed = storage::wallet_exists(&root, "throwaway-stagenet");
    let restore_ok = if !existed {
        let (phrase, spend, view) = keys::generate_mnemonic();
        let phrase = Zeroizing::new(phrase);
        let (restored_spend, restored_view) = keys::keys_from_mnemonic(&phrase)?;
        let matched = spend == restored_spend && view == restored_view;
        let secret_scalar: curve25519_dalek::Scalar = (*spend).into();
        let data = storage::WalletFileData {
            seed_entropy: hex::encode(secret_scalar.to_bytes()),
            scan_height: 0,
            accounts: vec![],
            subaddress_labels: vec![],
            view_only: None,
        };
        storage::save_wallet(&root, "throwaway-stagenet", &data, password)?;
        matched
    } else {
        true
    };
    let data = storage::load_wallet(&root, "throwaway-stagenet", password)?;
    let raw = std::fs::read(storage::wallet_path(&root, "throwaway-stagenet")?)
        .map_err(|e| e.to_string())?;
    let seed = Zeroizing::new(hex::decode(&data.seed_entropy).map_err(|_| "bad test entropy")?);
    let entropy: Zeroizing<[u8; 32]> =
        Zeroizing::new(seed.as_slice().try_into().map_err(|_| "bad entropy size")?);
    let (spend, view) = keys::keys_from_entropy(&entropy)?;
    let scalar: curve25519_dalek::Scalar = (*spend).into();
    let point = monero_oxide::ed25519::Point::from(
        &scalar * curve25519_dalek::constants::ED25519_BASEPOINT_POINT,
    );
    let pair = monero_wallet::ViewPair::new(point, view).map_err(|_| "view pair")?;
    let address = pair
        .legacy_address(monero_address::Network::Stagenet)
        .to_string();
    let sealed = !raw
        .windows(data.seed_entropy.len())
        .any(|w| w == data.seed_entropy.as_bytes());
    let wrong_password = storage::load_wallet(&root, "throwaway-stagenet", "WRONG").is_err();
    let mut corrupt = raw.clone();
    let n = corrupt.len() - 1;
    corrupt[n] ^= 1;
    let tamper_rejected = storage::decrypt_wallet(&corrupt, password).is_err();
    let expected_path = root.join("public-address.txt");
    let stable = if existed {
        std::fs::read_to_string(&expected_path).map_err(|_| "missing public metadata")? == address
    } else {
        std::fs::write(&expected_path, &address).map_err(|e| e.to_string())?;
        true
    };
    // Only booleans/public metadata leave Rust. No mnemonic/private/view key returned.
    Ok(
        json!({"network":"stagenet","created":!existed,"reopened":existed,
      "mnemonicRestore":if existed {Value::String("NOT_RERUN".into())} else {json!(restore_ok)},
      "encryptedReopen":true,"ciphertextNotPlaintext":sealed,"wrongPasswordRejected":wrong_password,
      "tamperRejected":tamper_rejected,"stablePublicAddress":stable,
      "signing":"NOT_VERIFIED_NO_TEST_FUNDS","keystore":false}),
    )
}
#[cfg(not(debug_assertions))]
fn wallet_check(_: &tauri::AppHandle) -> Result<Value, String> {
    Err("Debug only".into())
}

#[tauri::command]
fn android_poc_lock(app: tauri::AppHandle, webview: WebviewWindow) -> Result<Value, String> {
    require_poc(&webview)?;
    let state = &POC_SESSION;
    state.epoch.fetch_add(1, Ordering::SeqCst);
    *state.wallet_unlocked.lock().map_err(|_| "session lock")? = false;
    let out = json!({"locked":true});
    save_report(&app, "lock", &out)?;
    Ok(out)
}
#[tauri::command]
async fn android_poc_scan(app: tauri::AppHandle, webview: WebviewWindow) -> Result<Value, String> {
    require_poc(&webview)?;
    if !*POC_SESSION
        .wallet_unlocked
        .lock()
        .map_err(|_| "session lock")?
    {
        return Err("Test session locked".into());
    }
    #[cfg(debug_assertions)]
    {
        use monero_daemon_rpc::prelude::*;
        let epoch = POC_SESSION.epoch.load(Ordering::SeqCst);
        let result = tokio::time::timeout(std::time::Duration::from_secs(45), async {
            let url="http://stagenet.tools.rino.io:38081";
            let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "HTTP init")?;
            let response=client.get(format!("{url}/get_info")).send().await.map_err(|_| "stagenet node unreachable")?;
            if !response.status().is_success() {return Err(format!("stagenet node HTTP {}",response.status().as_u16()));}
            let info:Value=response.json().await.map_err(|_| "stagenet info invalid")?;
            if info["nettype"]!="stagenet" { return Err("Node did not attest stagenet".to_string()); }
            let daemon=wallet::reqwest_transport::ReqwestTransport::connect(url.to_string(), std::time::Duration::from_secs(15)).await.map_err(|_| "native daemon connect")?;
            let tip=daemon.latest_block_number().await.map_err(|_| "native height")?;
            if epoch != POC_SESSION.epoch.load(Ordering::SeqCst) { return Err("Locked during scan".into()); }
            let root=app.path().app_data_dir().map_err(|_| "app directory")?.join("android-poc/stagenet");
            let data=wallet::storage::load_wallet(&root,"throwaway-stagenet","PUBLIC-ANDROID-POC-STAGENET-ONLY")?;
            let bytes:zeroize::Zeroizing<Vec<u8>>=zeroize::Zeroizing::new(hex::decode(data.seed_entropy).map_err(|_| "test entropy")?);
            let entropy:zeroize::Zeroizing<[u8;32]>=zeroize::Zeroizing::new(bytes.as_slice().try_into().map_err(|_| "test entropy size")?);
            let(spend,view)=wallet::keys::keys_from_entropy(&entropy)?;
            let scalar:curve25519_dalek::Scalar=(*spend).into();
            let point=monero_oxide::ed25519::Point::from(&scalar*curve25519_dalek::constants::ED25519_BASEPOINT_POINT);
            let pair=monero_wallet::ViewPair::new(point,view).map_err(|_| "view pair")?;
            let mut scanner=monero_wallet::Scanner::new(pair);
            let block=ProvidesScannableBlocks::scannable_block_by_number(&daemon,tip-1).await.map_err(|_| "native block fetch")?;
            if epoch != POC_SESSION.epoch.load(Ordering::SeqCst) {return Err("Locked during block fetch".into());}
            let count=scanner.scan(block).map_err(|_| "native block scan")?.not_additionally_locked().len();
            Ok(json!({"network":"stagenet","height":tip,"nativeBlocksScanned":1,"outputs":count,"transport":"explicit-clearnet-test","signing":"NOT_VERIFIED_NO_TEST_FUNDS"}))
        }).await;
        let report = match result {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => json!({"status":"NOT_VERIFIED","reason":e}),
            Err(_) => {
                json!({"status":"NOT_VERIFIED","reason":"Stagenet scan timed out after 45 seconds"})
            }
        };
        save_report(&app, "scan", &report)?;
        return Ok(report);
    }
    #[cfg(not(debug_assertions))]
    Err("Debug only".into())
}
#[tauri::command]
async fn android_poc_tor(app: tauri::AppHandle, webview: WebviewWindow) -> Result<Value, String> {
    require_poc(&webview)?;
    #[cfg(debug_assertions)]
    {
        let mut bootstrapped = false;
        let result=tokio::time::timeout(std::time::Duration::from_secs(100),async {
            let dir=app.path().app_data_dir().map_err(|_| "app directory")?.join("android-poc/tor");
            std::fs::create_dir_all(&dir).map_err(|_| "Tor directory")?;
            let mut builder=arti_client::TorClientConfig::builder();
            builder.storage().cache_dir(tor_config_path::CfgPath::new_literal(dir.join("cache")));
            builder.storage().state_dir(tor_config_path::CfgPath::new_literal(dir.join("state")));
            let config=builder.build().map_err(|_| "Tor config")?;
            let client=arti_client::TorClient::create_bootstrapped(config).await.map_err(|_| "Tor bootstrap failed")?;
            bootstrapped=true;
            let body=tor::transport::tor_get(&client,"http://rino4sek7bzoqgkgsn5qxlsic3gk2mj23t3shcaj5axfyipjnyoql4ad.onion:38081/get_info").await.map_err(|_| "stagenet onion unreachable")?;
            let info:Value=serde_json::from_slice(&body).map_err(|_| "onion RPC response invalid")?;
            if info["nettype"]!="stagenet" {return Err("Onion did not attest stagenet");}
            Ok(json!({"bootstrap":true,"stagenetOnionReachable":true,"allAppTor":false}))
        }).await;
        let out = match result {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                json!({"status":"NOT_VERIFIED","bootstrap":bootstrapped,"stagenetOnionReachable":false,"allAppTor":false,"reason":e})
            }
            Err(_) => {
                json!({"status":"NOT_VERIFIED","bootstrap":bootstrapped,"stagenetOnionReachable":false,"allAppTor":false,"reason":"Tor test timed out after 100 seconds"})
            }
        };
        save_report(&app, "tor", &out)?;
        return Ok(out);
    }
    #[cfg(not(debug_assertions))]
    Err("Debug only".into())
}
#[tauri::command]
async fn android_poc_confirmation(
    app: tauri::AppHandle,
    webview: WebviewWindow,
) -> Result<Value, String> {
    require_poc(&webview)?;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let approved=app.dialog().message("STAGENET diagnostic only — no transaction exists and nothing can be broadcast. Choose Cancel to test native denial.").title("Native spending confirmation test").buttons(MessageDialogButtons::OkCancelCustom("Approve test".into(),"Cancel".into())).blocking_show();
    let out = json!({"nativeDialogApproved":approved,"broadcast":false});
    save_report(&app, "confirmation", &out)?;
    Ok(out)
}
#[tauri::command]
fn android_poc_attacks(webview: WebviewWindow) -> Result<Value, String> {
    require_poc(&webview)?;
    let checks = [
        "https://example.com/__android_poc.html",
        "http://ros.localhost.evil/__android_poc.html",
        "http://ros.localhost/index.html",
        "http://ros.localhost:81/__android_poc.html",
    ];
    Ok(
        json!({"hostileOriginsRejected":checks.iter().all(|u|!diagnostic_allowed(true,"ros-android",&u.parse().unwrap())),"releaseDiagnosticsDenied":!diagnostic_allowed(false,"ros-android",&format!("{ROS_ORIGIN}{DIAGNOSTICS}").parse().unwrap()),"wrongLabelDenied":!diagnostic_allowed(true,"other",&format!("{ROS_ORIGIN}{DIAGNOSTICS}").parse().unwrap())}),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
    let diagnostics: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        android_runtime_status,
        android_poc_wallet,
        android_poc_scan,
        android_poc_tor,
        android_poc_confirmation,
        android_poc_lock,
        android_poc_attacks
    ];
    tauri::Builder::default()
        .plugin(android_terminal::io_plugin())
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
                "/__android_boot.js" => (
                    "text/javascript",
                    include_bytes!("android/boot.js").to_vec(),
                    200,
                ),
                "/__android_poc.html" if cfg!(debug_assertions) => (
                    "text/html",
                    include_bytes!("android/diagnostics.html").to_vec(),
                    200,
                ),
                "/__android_poc.js" if cfg!(debug_assertions) => (
                    "text/javascript",
                    include_bytes!("android/diagnostics.js").to_vec(),
                    200,
                ),
                _ => {
                    let r = ctx
                        .app_handle()
                        .state::<updater::protocol::RosBundle>()
                        .resolve(&uri);
                    let mut body = r.body;
                    if r.content_type == "text/html" {
                        let text = String::from_utf8_lossy(&body);
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
            if !updater::ota::verify_archive_hash(ARCHIVE, ARCHIVE_EXPECTED_HASH) {
                return Err("Bundled ROS hash mismatch".into());
            }
            app.manage(updater::protocol::RosBundle::from_archive(ARCHIVE)?);
            let _=ANDROID_APP.set(app.handle().clone());
            app.manage(wallet::WalletState::new_android_debug_test(app.handle().clone(), app.path().app_data_dir()?.join(android_terminal::TEST_DATA_DIR)));
            app.manage(android_terminal::TerminalState::default());
            let window=tauri::WebviewWindowBuilder::new(
                app,
                "ros-android",
                tauri::WebviewUrl::CustomProtocol("ros://localhost/index.html".parse()?),
            )
            .on_navigation(|url| local_url(url));
            // Explicit DEBUG desktop-layout trial. Runtime status still says Android.
            #[cfg(debug_assertions)]
            let window=window.user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 RipleyRuntimeDebugDesktop/1").initialization_script("Object.defineProperty(window,'__ANDROID_STAGENET_DEBUG__',{value:true}); const actualMatchMedia=window.matchMedia.bind(window); Object.defineProperty(window,'__ANDROID_ACTUAL_COARSE_POINTER__',{value:actualMatchMedia('(pointer: coarse)').matches}); window.matchMedia=q=>actualMatchMedia(String(q).replace(/\\(pointer:\\s*coarse\\)/g,'(max-width: 0px)'));");
            window.build()?;
            Ok(())
        })
        .invoke_handler(move |invoke| {
            if invoke.message.command().starts_with("android_poc_") || invoke.message.command()=="android_runtime_status" {diagnostics(invoke)}
            else {android_terminal::handle(invoke)}
        })
        .run(tauri::generate_context!())
        .expect("Android POC startup failed");
}
