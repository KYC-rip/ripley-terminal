//! Android's ordinary Terminal-compatible backend. Wallet APIs are DEBUG/stagenet
//! only, use the SAME WalletState/keys/storage/scanner as desktop, and never export
//! secrets or sign. No test results or network successes are fabricated.
use super::*;
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::{
    ipc::{Invoke, InvokeBody, InvokeError},
    plugin::{Builder, PluginHandle, TauriPlugin},
    Emitter,
};

pub const TEST_PASSWORD: &str = "ANDROID-STAGENET-TEST-ONLY";
pub const MAINNET_READONLY: bool = cfg!(android_mainnet_readonly);
pub const TEST_NETWORK: &str = if MAINNET_READONLY {
    "mainnet"
} else {
    "stagenet"
};
pub const TEST_DATA_DIR: &str = if MAINNET_READONLY {
    "android-terminal-debug-mainnet-readonly"
} else if cfg!(android_offline_regtest) {
    "android-terminal-debug-regtest"
} else {
    "android-terminal-debug-stagenet"
};
#[path = "android_scan_plan.rs"]
mod scan_plan;
pub const PUBLIC_RESTORE:&str="avidly chlorine gave yeti ramped certain hybrid comb governing amply hinder pamphlet offend geometry narrate unopened robot epoxy annoyed glide ingested ascend were austere unopened";
#[cfg(not(any(
    android_offline_stagenet,
    android_offline_regtest,
    android_mainnet_readonly
)))]
const NODE: &str = "http://stagenet.community.rino.io:38081";
#[cfg(android_mainnet_readonly)]
const NODE: &str = "https://node.kyc.rip";
#[cfg(any(android_offline_stagenet, android_offline_regtest))]
const NODE: &str = "http://127.0.0.1:48081";
pub fn notify_lock(app: &tauri::AppHandle) {
    emit(app, "WALLET_STATE", "info", "{\"locked\":true}");
}

#[derive(Default)]
pub struct TerminalState {
    last_error: Mutex<Option<String>>,
    unlocked_epoch: AtomicU64,
    scanning: std::sync::atomic::AtomicBool,
}
pub struct NativeIo(PluginHandle<tauri::Wry>);
pub fn io_plugin() -> TauriPlugin<tauri::Wry> {
    Builder::new("android-io")
        .setup(|app, api| {
            app.manage(NativeIo(api.register_android_plugin(
                "run.ripley.androidpoc",
                "NativeIoPlugin",
            )?));
            Ok(())
        })
        .build()
}
#[derive(Debug, Serialize)]
pub struct Error {
    code: &'static str,
    message: String,
    command: String,
    platform: &'static str,
}
type ResultValue = Result<Value, Error>;
fn err(c: &str, code: &'static str, m: impl Into<String>) -> Error {
    Error {
        code,
        message: m.into(),
        command: c.into(),
        platform: "android",
    }
}
fn unsupported(c: &str) -> Error {
    err(
        c,
        "UNSUPPORTED_ANDROID",
        format!("{c} is not implemented on Android; no operation was performed"),
    )
}
fn strarg<'a>(v: &'a Value, k: &str) -> Result<&'a str, Error> {
    v[k].as_str()
        .ok_or_else(|| err(k, "INVALID_ARGUMENT", format!("Missing {k}")))
}
fn num(v: &Value, k: &str) -> u32 {
    v[k].as_u64().unwrap_or(0) as u32
}
fn wallet_error(c: &str, e: String) -> Error {
    err(c, "WALLET_ERROR", e)
}
fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() < 120
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn root(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .expect("private directory")
        .join(TEST_DATA_DIR)
}
fn read_json(p: std::path::PathBuf) -> Value {
    std::fs::read(p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(json!([]))
}
fn write_json(p: std::path::PathBuf, v: &Value) -> Result<(), Error> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| err("storage", "STORAGE_ERROR", e.to_string()))?;
    }
    std::fs::write(p, serde_json::to_vec(v).unwrap())
        .map_err(|e| err("storage", "STORAGE_ERROR", e.to_string()))
}
fn identities(app: &tauri::AppHandle) -> Value {
    read_json(root(app).join("identities.json"))
}
fn config() -> Value {
    json!({"network":TEST_NETWORK,"routingMode":"clearnet","transportPolicy":"strict","customNodeAddress":NODE,"nodeFallback":false,"watchSync":false,"watchSyncAsked":true,"sync_all_wallets":false,"fast_sync":false,"autoLockMinutes":0,"allowWsOverTor":false,"androidTestMode":cfg!(debug_assertions),"nativeSigning":false,"mainnetReadOnlyTest":MAINNET_READONLY,"nativeBrowserMode":"isolated-activity","offlineRegtest":cfg!(android_offline_regtest),"offlineStagenetProtocolTest":cfg!(android_offline_stagenet)})
}
fn emit(app: &tauri::AppHandle, source: &str, level: &str, message: &str) {
    let _ = app.emit(
        "core-log",
        json!({"source":source,"level":level,"message":message}),
    );
}
fn check_wallet(c: &str) -> Result<(), Error> {
    if !ANDROID_FOREGROUND.load(Ordering::SeqCst) {
        return Err(err(
            c,
            "APP_BACKGROUND",
            "Native wallet operations require the foreground Activity",
        ));
    }
    if cfg!(debug_assertions) {
        Ok(())
    } else {
        Err(err(
            c,
            "TEST_MODE_REQUIRED",
            "Android native wallets are DEBUG stagenet only; production custody remains disabled",
        ))
    }
}
fn check_password(c: &str, p: &str) -> Result<(), Error> {
    check_wallet(c)?;
    if p != TEST_PASSWORD {
        return Err(err(c,"PUBLIC_TEST_PASSWORD_REQUIRED",format!("Disposable test wallet only. Use public test password: {TEST_PASSWORD}. Never use real funds or keys.")));
    }
    Ok(())
}
fn check_network(c: &str, v: &Value) -> Result<(), Error> {
    if v["network"].as_str().is_some_and(|n| n != "stagenet") {
        return Err(err(c, "STAGENET_ONLY", "Mainnet is disabled"));
    }
    if v["routingMode"].as_str().is_some_and(|n| n != "clearnet") {
        return Err(err(c,"UNSUPPORTED_TRANSPORT","Android bridge currently supports explicit clearnet only; Tor is not silently bypassed"));
    }
    Ok(())
}
pub fn handle(invoke: Invoke) -> bool {
    let command = invoke.message.command().to_string();
    let webview = invoke.message.webview();
    let app = webview.app_handle().clone();
    let trusted = webview.label() == "ros-android"
        && webview
            .url()
            .ok()
            .is_some_and(|u| super::local_url(&u) && u.path() != "/__android_poc.html");
    if !trusted {
        invoke.resolver.reject(err(
            &command,
            "UNTRUSTED_ORIGIN",
            "Native Terminal bridge denied for this origin/page",
        ));
        return true;
    }
    let payload = match invoke.message.payload() {
        InvokeBody::Json(v) => v.clone(),
        _ => json!({}),
    };
    // Command names only. Never log arguments, passwords, seeds or response bodies.
    eprintln!("ANDROID_TERMINAL_INVOKE {}", command);
    invoke.resolver.respond_async(async move {
        dispatch(&app, &command, payload).await.map_err(|e| {
            // The shipped frontend's direct AI/Gateway adapters use String(error),
            // matching desktop's Result<_, String>; keep their failure readable.
            if command.starts_with("local_ai_") || command.starts_with("agent_gateway_") {
                InvokeError::from(format!("[{}] {}", e.code, e.message))
            } else {
                InvokeError::from(e)
            }
        })
    });
    true
}
async fn unlocked(app: &tauri::AppHandle, c: &str) -> Result<(), Error> {
    check_wallet(c)?;
    if app
        .state::<TerminalState>()
        .unlocked_epoch
        .load(Ordering::SeqCst)
        != POC_SESSION.epoch.load(Ordering::SeqCst)
        || app.state::<wallet::WalletState>().is_locked().await
    {
        return Err(err(
            c,
            "WALLET_LOCKED",
            "Native wallet is locked; unlock again after backgrounding",
        ));
    }
    Ok(())
}
async fn canonical_hash(client:&reqwest::Client,height:u64)->Result<String,Error>{
 let v:Value=client.post(format!("{NODE}/json_rpc")).json(&json!({"jsonrpc":"2.0","id":"android-canonical","method":"get_block_header_by_height","params":{"height":height}})).send().await.map_err(|e|err("reselect_node","HEADER_UNAVAILABLE",e.to_string()))?.error_for_status().map_err(|e|err("reselect_node","HEADER_UNAVAILABLE",e.to_string()))?.json().await.map_err(|e|err("reselect_node","HEADER_UNAVAILABLE",e.to_string()))?;
 if v.get("error").is_some()||v["result"]["block_header"]["height"].as_u64()!=Some(height){return Err(err("reselect_node","HEADER_UNAVAILABLE","Invalid canonical header response"))}
 let h=v["result"]["block_header"]["hash"].as_str().ok_or_else(||err("reselect_node","HEADER_UNAVAILABLE","Missing block hash"))?;
 if h.len()!=64||!h.bytes().all(|b|b.is_ascii_hexdigit()){return Err(err("reselect_node","HEADER_UNAVAILABLE","Malformed hash"))}
 Ok(h.to_ascii_lowercase())
}
async fn scan(app: tauri::AppHandle) -> Result<(), Error> {
    use monero_daemon_rpc::prelude::*;
    let c = "reselect_node";
    unlocked(&app, c).await?;
    let terminal = app.state::<TerminalState>();
    if terminal.scanning.swap(true, Ordering::SeqCst) {
        return Err(err(c, "BUSY", "A bounded node request is already running"));
    }
    app.state::<wallet::WalletState>().android_invalidate_verification().await;
    *terminal.last_error.lock().unwrap() = None;
    emit(
        &app,
        "SYNC_DATA",
        "info",
        &format!("CONNECTING|0|0|0|{NODE}|0"),
    );
    let epoch = POC_SESSION.epoch.load(Ordering::SeqCst);
    let outcome = (async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| err(c, "NETWORK_ERROR", e.to_string()))?;
        let r = client
            .get(format!("{NODE}/get_info"))
            .send()
            .await
            .map_err(|e| err(c, "NETWORK_UNAVAILABLE", e.to_string()))?;
        if !r.status().is_success() {
            return Err(err(
                c,
                "NODE_HTTP_ERROR",
                format!("{} node HTTP {}", TEST_NETWORK, r.status().as_u16()),
            ));
        }
        let info: Value = r
            .json()
            .await
            .map_err(|e| err(c, "INVALID_NODE_RESPONSE", e.to_string()))?;
        let expected_network = if cfg!(android_offline_regtest) {
            "fakechain"
        } else {
            TEST_NETWORK
        };
        if info["nettype"] != expected_network {
            return Err(err(
                c,
                "STAGENET_ONLY",
                "Node does not match the compiled test-network identity",
            ));
        }
        let state = app.state::<wallet::WalletState>();
        let mut generation = state.current_scanner_generation();
        let daemon = wallet::reqwest_transport::ReqwestTransport::connect(
            NODE.into(),
            std::time::Duration::from_secs(10),
        )
        .await
        .map_err(|e| err(c, "NETWORK_ERROR", format!("{e:?}")))?;
        // latest_block_number is an INDEX, not a block count: genesis is valid.
        let target = daemon
            .latest_block_number()
            .await
            .map_err(|e| err(c, "NODE_RPC_ERROR", format!("{e:?}")))? as u64
            + 1;
        let mut scanner = state
            .get_scanner()
            .await
            .ok_or_else(|| err(c, "WALLET_LOCKED", "No scanner"))?;
        let cursor = state.get_scan_height().await;
        let initial=if cursor==u64::MAX {target.saturating_sub(8)}else{cursor};
        let chain=state.android_chain_prepare(initial).await.map_err(|e|err(c,"CHECKPOINT_INVALID",e))?;
        let mut remote=Vec::new();
        for (h,old_hash) in chain.anchors.iter().rev(){
          if *h>=target{continue}
          let hash=canonical_hash(&client,*h).await?;
          let matched=&hash==old_hash;remote.push((*h,hash));if matched{break}
        }
        let start=crate::android_chain::rollback(initial,chain.floor,&chain.anchors,&remote,target).map_err(|e|err(c,"REORG_RESCAN_REQUIRED",e))?;
        generation=state.android_reconcile(start,generation).await.map_err(|e|err(c,"ROLLBACK_CHECKPOINT_ERROR",e))?;
        if !state.update_sync_status_for(generation,start,target).await{return Err(err(c,"WALLET_LOCKED","Stale reconciliation"))}
        if start<initial{eprintln!("ANDROID_REORG_ROLLBACK old={initial} next={start} target={target}");
         #[cfg(all(debug_assertions,android_offline_regtest))]
         if app.path().app_data_dir().map(|p|p.join("android-rollback-pause").exists()).unwrap_or(false){eprintln!("ANDROID_REORG_CHECKPOINT_PAUSED");tokio::time::sleep(std::time::Duration::from_secs(5)).await;}
        }
        let mut next = start;
        while next < target {
            let end = scan_plan::batch_end(next, target);
            let batch_start = next;
            while next < end {
                if epoch != POC_SESSION.epoch.load(Ordering::SeqCst)
                    || !ANDROID_FOREGROUND.load(Ordering::SeqCst)
                {
                    return Err(err(c, "WALLET_LOCKED", "Scan cancelled by lifecycle lock"));
                }
                let block =
                    ProvidesScannableBlocks::scannable_block_by_number(&daemon, next as usize)
                        .await
                        .map_err(|e| err(c, "NODE_RPC_ERROR", format!("{e:?}")))?;
                if epoch != POC_SESSION.epoch.load(Ordering::SeqCst) {
                    return Err(err(c, "WALLET_LOCKED", "Locked during block fetch"));
                }
                let block_timestamp = block.block.header.timestamp;
                let hash=hex::encode(block.block.hash());let previous=hex::encode(block.block.header.previous);
                let mut inputs=std::collections::HashMap::new();
                for (idx,tx) in block.transactions.iter().enumerate(){
                 let txid=*block.block.transactions.get(idx).ok_or_else(||err(c,"INVALID_BLOCK","Missing transaction id"))?;
                 for input in &tx.prefix().inputs{if let monero_oxide::transaction::Input::ToKey{key_image,..}=input{inputs.insert(key_image.to_bytes(),(txid,next,block_timestamp));}}
                }
                let outputs=scanner.scan(block).map_err(|e|err(c,"SCAN_ERROR",format!("{e:?}")))?.ignore_additional_timelock();
                if canonical_hash(&client,next).await?!=hash{return Err(err(c,"CHAIN_CHANGED","Canonical block changed during fetch; retry reconciliation"))}
                state.android_commit_block(outputs,next,block_timestamp,hash,previous,inputs,generation).await.map_err(|e|err(c,"CHECKPOINT_ERROR",e))?;
                next+=1;
                if !state.update_sync_status_for(generation,next,target).await{return Err(err(c,"WALLET_LOCKED","Stale scanner generation"))}
                if let Some(updated)=state.get_scanner().await{scanner=updated;}
                let status = if next >= target { "SYNCED" } else { "SYNCING" };
                let pct = 100.0 * (next - start) as f64 / (target - start).max(1) as f64;
                emit(
                    &app,
                    "SYNC_DATA",
                    "info",
                    &format!("{status}|{next}|{target}|{pct}|{NODE}|{start}"),
                );
                eprintln!(
                    "ANDROID_SCAN_CHECKPOINT next={next} target={target} offline={}",
                    cfg!(android_offline_stagenet)
                );
            }
            eprintln!(
                "ANDROID_SCAN_BATCH from={batch_start} next={next} target={target} regtest={}",
                cfg!(android_offline_regtest)
            );
            tokio::task::yield_now().await;
        }
        if next >= target {
            emit(
                &app,
                "SYNC_DATA",
                "info",
                &format!("SYNCED|{next}|{target}|100|{NODE}|{start}"),
            );
        }
        state.set_daemon_url(NODE).await;
        Ok(())
    })
    .await;
    terminal.scanning.store(false, Ordering::SeqCst);
    *terminal.last_error.lock().unwrap() = outcome.as_ref().err().map(|e| e.message.clone());
    if let Err(e) = &outcome {
        app.state::<wallet::WalletState>().android_invalidate_verification().await;
        emit(
            &app,
            "SYNC_DATA",
            "error",
            &format!("ERROR|0|0|0|{}|0", e.message.replace('|', "/")),
        );
        emit(
            &app,
            "NETWORK",
            "error",
            &format!("{}: {}", e.code, e.message),
        );
    }
    outcome
}
async fn native_io(app: &tauri::AppHandle, c: &str, method: &str, args: Value) -> ResultValue {
    let handle = app.state::<NativeIo>().0.clone();
    let cmd = c.to_string();
    let m = method.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        handle
            .run_mobile_plugin::<Value>(&m, args)
            .map_err(|e| err(&cmd, "ANDROID_IO_ERROR", e.to_string()))
    })
    .await
    .map_err(|_| err(c, "ANDROID_IO_ERROR", "Native IO worker failed"))?
}
async fn fetch(app: &tauri::AppHandle, c: &str, args: &Value) -> ResultValue {
    let req = &args["req"];
    let u = strarg(req, "url")?;
    let url: tauri::Url = u
        .parse()
        .map_err(|_| err(c, "INVALID_URL", "Invalid URL"))?;
    if req["method"].as_str().is_some_and(|m| m != "GET") {
        return Err(err(
            c,
            "UNSUPPORTED_METHOD",
            "Only public HTTPS GET is enabled; no transaction or arbitrary POST relay",
        ));
    }
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https"
        || host.is_empty()
        || url.port().is_some_and(|p| p != 443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(err(
            c,
            "NETWORK_POLICY",
            "Only public HTTPS URLs without credentials are accepted",
        ));
    }
    let addresses = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::net::lookup_host((host, 443)),
    )
    .await
    .map_err(|_| err(c, "NETWORK_TIMEOUT", "DNS lookup exceeded five seconds"))?
    .map_err(|_| err(c, "NETWORK_UNAVAILABLE", "DNS lookup failed"))?
    .collect::<Vec<_>>();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|a| !super::android_policy::public_ip(a.ip()))
    {
        return Err(err(
            c,
            "NETWORK_POLICY",
            "Private/loopback destinations are not allowed",
        ));
    }
    let client = reqwest::Client::builder()
        .resolve_to_addrs(host, &addresses)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| err(c, "NETWORK_ERROR", "HTTP initialization failed"))?;
    let mut r = client
        .get(url)
        .header("User-Agent", "RipleyAndroidTest/1")
        .send()
        .await
        .map_err(|e| err(c, "NETWORK_UNAVAILABLE", e.to_string()))?;
    let status = r.status().as_u16();
    let headers: BTreeMap<_, _> = r
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|s| (k.to_string(), s.to_string())))
        .collect();
    let mut body = vec![];
    while let Some(chunk) = r
        .chunk()
        .await
        .map_err(|_| err(c, "NETWORK_ERROR", "Response read failed"))?
    {
        if body.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(err(c, "RESPONSE_TOO_LARGE", "Response exceeds 2 MiB"));
        }
        body.extend_from_slice(&chunk);
    }
    let _ = app;
    if c.ends_with("_bytes") {
        if !(200..300).contains(&status) {
            return Err(err(c, "HTTP_ERROR", format!("HTTP {status}")));
        }
        return Ok(json!(body));
    }
    Ok(
        json!({"status":status,"ok":(200..300).contains(&status),"headers":headers,"body":String::from_utf8_lossy(&body)}),
    )
}
async fn dispatch(app: &tauri::AppHandle, c: &str, a: Value) -> ResultValue {
    let state = app.state::<wallet::WalletState>();
    match c {
        "get_config" => Ok(config()),
        "save_config" | "save_config_and_reload" => {
            if MAINNET_READONLY {
                return Err(err(c,"NETWORK_CONFIG_IMMUTABLE","Read-only mainnet test endpoint and custody policy cannot be changed by JavaScript"));
            }
            check_network(c, &a["config"])?;
            let current = config();
            if let Some(o) = a["config"].as_object() {
                if let Some((k, _)) = o.iter().find(|(k, v)| current.get(*k) != Some(*v)) {
                    return Err(err(
                        c,
                        "UNSUPPORTED_CONFIG",
                        format!("Changing {k} is not yet supported on Android"),
                    ));
                }
            }
            Ok(current)
        }
        "get_tor_status" => Ok(
            json!({"Disconnected":null,"supported":false,"reason":"Tor routing not implemented in Android bridge; clearnet is explicit"}),
        ),
        "get_identities" => Ok(identities(app)),
        "save_identities" => {
            check_wallet(c)?;
            let ids = a["ids"]
                .as_array()
                .ok_or_else(|| err(c, "INVALID_ARGUMENT", "ids must be an array"))?;
            if ids.iter().any(|i| {
                !i["id"].as_str().is_some_and(valid_id)
                    || i["name"].as_str().unwrap_or("").len() > 120
            }) {
                return Err(err(c, "INVALID_ARGUMENT", "Invalid identity metadata"));
            }
            let metadata: Vec<Value> = ids
                .iter()
                .map(|i| json!({"id":i["id"],"name":i["name"],"created":i["created"]}))
                .collect();
            write_json(root(app).join("identities.json"), &json!(metadata))?;
            Ok(Value::Null)
        }
        "switch_identity" => {
            check_wallet(c)?;
            let id = strarg(&a, "id")?;
            if !valid_id(id) {
                return Err(err(c, "INVALID_ARGUMENT", "Invalid wallet id"));
            }
            write_json(root(app).join("active.json"), &json!(id))?;
            Ok(Value::Null)
        }
        "create_wallet" => {
            let name = strarg(&a, "name")?;
            let password = strarg(&a, "password")?;
            check_password(c, password)?;
            if !valid_id(name) {
                return Err(err(c, "INVALID_ARGUMENT", "Invalid wallet id"));
            }
            let seed = a["seed"].as_str().filter(|s| !s.trim().is_empty());
            if MAINNET_READONLY && seed.is_some() {
                return Err(err(c,"THROWAWAY_ONLY","Mainnet read-only test accepts only fresh native throwaway keys; imports are disabled"));
            }
            let restore_height = if MAINNET_READONLY {
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(10))
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|e| err(c, "NETWORK_ERROR", e.to_string()))?;
                let info: Value = client
                    .get(format!("{NODE}/get_info"))
                    .send()
                    .await
                    .map_err(|e| err(c, "NETWORK_ERROR", e.to_string()))?
                    .error_for_status()
                    .map_err(|e| err(c, "NETWORK_ERROR", e.to_string()))?
                    .json()
                    .await
                    .map_err(|e| err(c, "NODE_RESPONSE", e.to_string()))?;
                if info["nettype"] != "mainnet" {
                    return Err(err(
                        c,
                        "NETWORK_MISMATCH",
                        "Pinned node did not attest mainnet",
                    ));
                }
                let tip = info["height"]
                    .as_u64()
                    .filter(|h| *h > 24)
                    .ok_or_else(|| err(c, "NODE_RESPONSE", "Invalid mainnet height"))?;
                let start = tip - 24;
                eprintln!("ANDROID_READONLY_WINDOW start={start} sampled_tip={tip} blocks=24");
                Some(start)
            } else {
                a["restoreHeight"].as_u64()
            };
            if seed.is_some_and(|s| s.trim() != PUBLIC_RESTORE) {
                return Err(err(c,"PUBLIC_TEST_SEED_REQUIRED","Restore accepts ONLY the published Cake test vector in this debug host. Never import real keys."));
            }
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
            if !app.dialog().message(if MAINNET_READONLY {"DEBUG MAINNET READ-ONLY THROWAWAY WALLET. Fresh test keys only, recent 24-block scan. Never send funds. No import, seed export, transaction preparation, signing or spending. Approve test wallet?"} else {"DEBUG STAGENET TEST WALLET ONLY. Public test password; no real funds, mainnet, seed export or signing. Approve this native create/restore?"}).title(if MAINNET_READONLY {"Android MAINNET READ-ONLY test"} else {"Android stagenet test custody"}).buttons(MessageDialogButtons::OkCancelCustom("Approve test wallet".into(),"Cancel".into())).blocking_show(){return Err(err(c,"USER_DENIED","Native wallet creation denied"));}
            let epoch = POC_SESSION.epoch.load(Ordering::SeqCst);
            let mnemonic = zeroize::Zeroizing::new(
                state
                    .create_wallet(name, password, seed, restore_height)
                    .await
                    .map_err(|e| wallet_error(c, e))?,
            );
            drop(mnemonic);
            if epoch != POC_SESSION.epoch.load(Ordering::SeqCst) {
                return Err(err(c, "WALLET_LOCKED", "Backgrounded during creation"));
            }
            Ok(json!({"success":true,"network":TEST_NETWORK,"secretExport":false}))
        }
        "open_wallet" => {
            let name = strarg(&a, "name")?;
            let password = strarg(&a, "password")?;
            check_password(c, password)?;
            if !valid_id(name) {
                return Err(err(c, "INVALID_ARGUMENT", "Invalid id"));
            }
            let epoch = POC_SESSION.epoch.load(Ordering::SeqCst);
            state
                .unlock(name, password)
                .await
                .map_err(|e| wallet_error(c, e))?;
            if epoch != POC_SESSION.epoch.load(Ordering::SeqCst) {
                state.lock().await;
                return Err(err(c, "WALLET_LOCKED", "Backgrounded during unlock"));
            }
            app.state::<TerminalState>()
                .unlocked_epoch
                .store(epoch, Ordering::SeqCst);
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = scan(handle).await;
            });
            Ok(json!({"success":true,"network":TEST_NETWORK,"signing":false}))
        }
        "close_wallet" => {
            state.lock().await;
            Ok(Value::Null)
        }
        "verify_password" => {
            check_wallet(c)?;
            let id = strarg(&a, "identityId")?;
            if !valid_id(id) {
                return Err(err(c, "INVALID_ARGUMENT", "Invalid id"));
            }
            Ok(json!(state
                .verify_password(id, strarg(&a, "password")?)
                .await
                .is_ok()))
        }
        "get_accounts" => {
            unlocked(app, c).await?;
            let mut accounts=json!(state.get_accounts().await);
            let verified=state.android_verification().await["chainVerified"]==true;
            if let Some(xs)=accounts.as_array_mut(){for x in xs{x["unlocked_balance"]=json!("0");if !verified{x["balance"]=json!("0");}}}
            Ok(accounts)
        }
        "get_balance" => {
            unlocked(app, c).await?;
            let (total, _unlocked) = state
                .balances_for_account(num(&a, "accountIndex"), state.tip_height().await)
                .await;
            Ok(
                json!({"total":if state.android_verification().await["chainVerified"]==true{total.to_string()}else{"0".into()},"observedTotal":total.to_string(),"unlocked":"0","spendingEnabled":false,"verification":state.android_verification().await,"viewOnly":false,"network":TEST_NETWORK,"verifiedSync":false}),
            )
        }
        "get_height" => Ok(json!(state.get_sync_status().await.height)),
        "get_sync_status" => {
            let mut s = json!(state.get_sync_status().await);
            if app
                .state::<TerminalState>()
                .last_error
                .lock()
                .unwrap()
                .is_some()
            {
                s["status"] = json!("OFFLINE");
            }
            s["network"] = json!(TEST_NETWORK);
            s["locked"] = json!(
                !ANDROID_FOREGROUND.load(Ordering::SeqCst)
                    || app
                        .state::<TerminalState>()
                        .unlocked_epoch
                        .load(Ordering::SeqCst)
                        != POC_SESSION.epoch.load(Ordering::SeqCst)
                    || state.is_locked().await
            );
            s["scanning"] = json!(app.state::<TerminalState>().scanning.load(Ordering::SeqCst));
            s["fullSyncVerified"] = json!(false);
            s["verification"]=state.android_verification().await;
            s["scanHeight"] = json!(state.get_scan_height().await);
            s["ownedOutputCount"] = json!(state.output_count().await);
            s["fixtureNetwork"] = json!(if cfg!(android_offline_regtest) {
                "FAKECHAIN REGTEST - NOT STAGENET"
            } else if MAINNET_READONLY {
                "MAINNET READ-ONLY THROWAWAY"
            } else {
                "stagenet"
            });
            s["lastError"] = json!(app
                .state::<TerminalState>()
                .last_error
                .lock()
                .unwrap()
                .clone());
            Ok(s)
        }
        "get_subaddresses" => {
            unlocked(app, c).await?;
            Ok(json!(
                state
                    .get_subaddresses(num(&a, "accountIndex"), state.tip_height().await)
                    .await
            ))
        }
        "create_subaddress" => {
            unlocked(app, c).await?;
            Ok(json!(
                state
                    .create_subaddress(num(&a, "accountIndex"), strarg(&a, "label")?)
                    .await
                    .map_err(|e| wallet_error(c, e))?
                    .address
            ))
        }
        "set_subaddress_label" => {
            unlocked(app, c).await?;
            state
                .set_subaddress_label(
                    num(&a, "accountIndex"),
                    num(&a, "index"),
                    strarg(&a, "label")?,
                )
                .await;
            Ok(Value::Null)
        }
        "create_account" => {
            unlocked(app, c).await?;
            let ac = state
                .create_account(strarg(&a, "label")?)
                .await
                .map_err(|e| wallet_error(c, e))?;
            Ok(json!({"index":ac.index,"address":ac.base_address}))
        }
        "rename_account" => {
            unlocked(app, c).await?;
            state
                .rename_account(
                    num(&a, "accountIndex"),
                    strarg(&a, "newLabel").or_else(|_| strarg(&a, "new_label"))?,
                )
                .await
                .map_err(|e| wallet_error(c, e))?;
            Ok(Value::Null)
        }
        "get_transactions"|"get_outputs" => {
          unlocked(app,c).await?;
          let verification=state.android_verification().await;
          if verification["chainVerified"]!=true{return Err(err(c,"CHAIN_UNVERIFIED","Canonical history is not verified; sync/retry required"))}
          let account=num(&a,"accountIndex");let sent=state.get_sent().await;let tip=state.tip_height().await;
          let mut transfers=Vec::new();let mut incoming:BTreeMap<String,(u64,u64,u64)>=BTreeMap::new();
          for (o,spent,frozen) in state.list_owned().await{
            let v=&o.output;let major=v.subaddress().map(|s|s.account()).unwrap_or(0);if major!=account{continue}
            let txid=hex::encode(v.transaction());
            if !spent{transfers.push(json!({"amount":v.commitment().amount,"key_image":wallet::state::output_id(v),"unlocked":false,"frozen":frozen,"subaddr_index":{"major":major,"minor":v.subaddress().map(|s|s.address()).unwrap_or(0)},"timestamp":o.timestamp,"txid":txid}));}
            if !sent.iter().any(|s|s.tx_hash==txid){let x=incoming.entry(txid).or_insert((0,o.height,o.timestamp));x.0=x.0.saturating_add(v.commitment().amount);}
          }
          if c=="get_outputs"{return Ok(json!({"transfers":transfers,"verification":verification,"spendingEnabled":false}))}
          let ins:Vec<_>=incoming.into_iter().map(|(txid,(amount,height,timestamp))|json!({"txid":txid,"amount":amount,"height":height,"timestamp":timestamp,"confirmations":tip.saturating_sub(height),"subaddr_index":{"major":account,"minor":0},"payment_id":"0000000000000000"})).collect();
          let outs:Vec<_>=sent.into_iter().filter(|s|s.account==account).map(|s|json!({"txid":s.tx_hash,"amount":s.amount,"height":s.height,"timestamp":s.timestamp,"fee":s.fee,"confirmations":tip.saturating_sub(s.height),"subaddr_index":{"major":account,"minor":0},"destinations":[],"address":""})).collect();
          Ok(json!({"in":ins,"out":outs,"pending":[],"verification":verification}))
        }
        "rescan" => {
          unlocked(app,c).await?;
          if app.state::<TerminalState>().scanning.load(Ordering::SeqCst){return Err(err(c,"BUSY","Wait for bounded scanner to finish"))}
          let verification=state.android_verification().await;
          let floor=verification["restoreFloor"].as_u64().ok_or_else(||err(c,"CHECKPOINT_INVALID","Restore disposable wallet to initialize a canonical checkpoint"))?;
          if a["height"].as_u64().unwrap_or(0)!=floor{return Err(err(c,"RESCAN_RANGE","Test rescan must use its original restore floor; no arbitrary mainnet history scan"))}
          use tauri_plugin_dialog::{DialogExt,MessageDialogButtons};
          if !app.dialog().message("Discard disposable cached observations and rescan from the original restore height? Keys remain native, application spending remains disabled.").title("Read-only native rescan").buttons(MessageDialogButtons::OkCancelCustom("Rescan test wallet".into(),"Cancel".into())).blocking_show(){return Err(err(c,"USER_DENIED","Rescan cancelled"))}
          state.android_reconcile(floor,state.current_scanner_generation()).await.map_err(|e|err(c,"RESET_CHECKPOINT_ERROR",e))?;
          scan(app.clone()).await?;
          Ok(json!({"success":true,"resetHeight":floor,"spendingEnabled":false}))
        }
        "reselect_node" => {
            scan(app.clone()).await?;
            Ok(
                json!({"boundedBatches":true,"offlineProtocolTest":cfg!(android_offline_stagenet),"network":TEST_NETWORK}),
            )
        }
        "ros_native_fetch" | "ros_native_fetch_bytes" => fetch(app, c, &a).await,
        "open_native_browser"
        | "open_external_url"
        | "browser_embed_open"
        | "browser_embed_navigate" => {
            native_io(app, c, "openBrowser", json!({"url":strarg(&a,"url")?})).await
        }
        "browser_embed_bounds" | "browser_embed_visible" | "browser_embed_zoom" => {
            Ok(json!({"mode":"isolated-activity","embedded":false,"layoutApplied":false}))
        }
        "browser_embed_close" => native_io(app, c, "closeBrowser", json!({})).await,
        "android_save_export" => native_io(app, c, "saveExport", a).await,
        "agent_gateway_status" => Ok(
            json!({"enabled":false,"running":false,"supported":false,"available":false,"reason":"UNSUPPORTED_ANDROID: gateway listener and spend grants are disabled","port":0,"apiKeyMasked":"UNAVAILABLE","boundGrantId":null,"accountIndex":0,"address":null,"walletId":null,"walletName":null}),
        ),
        "local_ai_status" => Ok(
            json!({"modelId":a["modelId"],"installed":false,"loaded":false,"bytes":0,"downloadedBytes":0,"downloading":false,"runtime":"UNSUPPORTED_ANDROID — no native inference engine","accelerated":false,"supported":false}),
        ),
        "vpn_status" => Ok(
            json!({"supported":false,"connected":false,"phase":"unsupported","reason":"Android VPN not implemented"}),
        ),
        "get_mnemonic"
        | "get_wallet_keys"
        | "prepare_transfer"
        | "relay_transfer"
        | "sign_message"
        | "sign_offline_transfer" => Err(err(
            c,
            "CUSTODY_POLICY",
            "Secret exports and spending are disabled in Android stagenet POC",
        )),
        _ => Err(unsupported(c)),
    }
}
