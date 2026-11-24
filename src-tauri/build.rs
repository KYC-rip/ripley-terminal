/// Every command registered in `tauri::generate_handler!` (lib.rs). Declaring them
/// here generates `allow-<command>` / `deny-<command>` ACL permissions AND — the
/// actual point — flips Tauri's IPC authority into enforcing mode for app commands
/// (`has_app_acl_manifest` in tauri's webview/mod.rs): without an app manifest,
/// app commands are NOT ACL-checked at all, so any webview with the IPC injected
/// (including the `ros-embed` child webview showing arbitrary remote pages) could
/// invoke wallet commands. With it, a webview can only call what a capability
/// matching its window + URL context explicitly allows:
///   - capabilities/default.json    → the local classic renderer (everything)
///   - capabilities/ros_remote.json → remote RipleyOS (wallet surface only)
///   - anything else (ros-embed, ros-browser-* windows) → nothing.
const APP_COMMANDS: &[&str] = &[
    // Wallet lifecycle
    "create_wallet",
    "open_wallet",
    "close_wallet",
    "get_mnemonic",
    "get_wallet_keys",
    // Account operations
    "get_accounts",
    "create_account",
    "rename_account",
    "get_balance",
    "get_height",
    // Address operations
    "get_subaddresses",
    "find_address_owner",
    "create_subaddress",
    "set_subaddress_label",
    "estimate_fees",
    // Transaction operations
    "prepare_transfer",
    "relay_transfer",
    "sweep_all",
    "sweep_single",
    "reselect_node",
    "get_transactions",
    "get_outputs",
    // Proof operations
    "get_tx_key",
    "get_tx_proof",
    "sign_message",
    "check_tx_key",
    "check_tx_proof",
    // Sync
    "get_sync_status",
    "refresh",
    "set_vigil_hot",
    "verify_password",
    "change_wallet_password",
    "rescan",
    // Config
    "get_config",
    "save_config",
    "save_config_only",
    "save_config_and_reload",
    "watch_sync_set",
    "get_app_info",
    "reveal_path",
    "get_ui_mode",
    "set_ui_mode",
    // Signed-OTA update channel for the RipleyOS bundle
    "check_ros_update",
    "ros_channel_status",
    // Client-side metadata stores + system
    "save_ghost_trade",
    "get_ghost_trades",
    "save_xmr402_payment",
    "get_xmr402_payment",
    "get_all_xmr402_payments",
    "ros_kv_load",
    "ros_kv_set",
    "ros_kv_remove",
    "ros_kv_clear",
    "select_background_image",
    "check_for_updates",
    "proxied_get",
    "agent_web_read",
    // Window screenshot (RipleyOS ⌘-leader + I): snapshot the webview region, and put the PNG on
    // the clipboard — the webview itself has no image clipboard.
    "capture_window_png",
    "clipboard_write_image",
    "resolve_openalias",
    "ros_native_fetch",
    // RipleyOS windows only (granted in ros_local / ros_remote): the binary-safe fetch, the
    // shell version for the Feedback app, and the rev-addressed wallpaper file store.
    "ros_native_fetch_bytes",
    "app_version",
    "wallpaper_save",
    "wallpaper_url",
    "wallpaper_clear",
    "open_native_browser",
    "open_external_url",
    "browser_embed_open",
    "browser_embed_bounds",
    "browser_embed_navigate",
    "browser_embed_zoom",
    "browser_embed_visible",
    "browser_embed_close",
    "browser_embed_deliver_xmr402",
    "xapp_open",
    "xapp_bounds",
    "xapp_navigate",
    "xapp_visible",
    "xapp_zoom",
    "xapp_history",
    "xapp_close",
    "xapp_bridge",
    "xapp_bridge_reply",
    "xapp_push",
    // Identity
    "get_identities",
    "save_identities",
    "detect_legacy_wallets",
    "create_identity",
    "delete_identity",
    "switch_identity",
    "get_active_identity",
    "rename_identity",
    // Tor
    "get_tor_status",
    "tor_circuit",
    "restart_tor",
    // VPN (unprivileged client of the root-owned broker)
    "vpn_status",
    "vpn_probe_endpoints",
    "vpn_probe_exit_ip",
    "vpn_connect",
    "vpn_disconnect",
    "vpn_set_killswitch",
    "vpn_recover",
    "vpn_set_dns_filter",
    "vpn_cache_endpoints",
    "vpn_emergency_restore",
    "vpn_open_window",
    "vpn_set_locale",
    "vpn_profiles_load",
    "vpn_profiles_save",
    "vpn_profiles_clear",
    // Vigil (limit-order persistence)
    "vigil_save_strike_key",
    "vigil_get_strike_key",
    "vigil_delete_strike_key",
    "vigil_archive_strike_key",
    "vigil_save_session",
    "vigil_get_session",
    "vigil_clear_session",
    "fetch_price_history",
    // Transfer grants (EJECT autonomous sells) + agent gateway
    "arm_transfer_grant",
    "relay_transfer_grant",
    "revoke_transfer_grant",
    "revoke_all_transfer_grants",
    "transfer_grant_status",
    "agent_gateway_status",
    "agent_gateway_set_config",
    "agent_gateway_rotate_key",
    // Watch-only + offline signing (registered in lib.rs since 2026-08-17 but never listed
    // here, so the IPC authority rejected them in every window) and onboarding P1.
    "import_watch_only",
    "export_watch_only",
    "export_unsigned_transfer",
    "sign_offline_transfer",
    "import_signed_transfer",
    "inspect_seed",
    "import_view_only",
    // Local AI: granted in every capability and working only because stale permission
    // files from an earlier build were tracked; listed so it no longer depends on them.
    "local_ai_status",
    "local_ai_download",
    "local_ai_load",
    "local_ai_complete",
    "local_ai_remove",
    "local_ai_clear_all",
];

const ANDROID_COMMANDS: &[&str] = &[
    // Android host & SOLO native commands
    "android_runtime_status",
    "android_renderer_ready",
    "android_clipboard_read",
    "android_clipboard_write",
    "android_save_export",
    "android_pin_shortcut",
    "android_set_secure_screen",
    "app_version",
    // Monero wallet lifecycle, accounts, addresses, proofs, transfers, cold signing
    "create_wallet",
    "open_wallet",
    "close_wallet",
    "get_mnemonic",
    "get_wallet_keys",
    "get_accounts",
    "create_account",
    "rename_account",
    "get_balance",
    "get_height",
    "get_subaddresses",
    "find_address_owner",
    "create_subaddress",
    "set_subaddress_label",
    "estimate_fees",
    "prepare_transfer",
    "relay_transfer",
    "sweep_all",
    "sweep_single",
    "reselect_node",
    "get_transactions",
    "get_outputs",
    "get_tx_key",
    "get_tx_proof",
    "sign_message",
    "check_tx_key",
    "check_tx_proof",
    "get_sync_status",
    "refresh",
    "set_vigil_hot",
    "verify_password",
    "change_wallet_password",
    "rescan",
    "import_watch_only",
    "export_watch_only",
    "export_unsigned_transfer",
    "sign_offline_transfer",
    "import_signed_transfer",
    "inspect_seed",
    "import_view_only",
    // Identities
    "get_identities",
    "save_identities",
    "switch_identity",
    "delete_identity",
    // Transfer grants
    "arm_transfer_grant",
    "relay_transfer_grant",
    "revoke_transfer_grant",
    "revoke_all_transfer_grants",
    "transfer_grant_status",
    // Tor
    "get_tor_status",
    "tor_circuit",
    "restart_tor",
    // Config & Signed OTA
    "get_config",
    "save_config",
    "save_config_and_reload",
    "watch_sync_set",
    "check_ros_update",
    "ros_channel_status",
    // Persistence: Disk KV, Wallpapers, XMR402
    "ros_kv_load",
    "ros_kv_set",
    "ros_kv_remove",
    "ros_kv_clear",
    "wallpaper_save",
    "wallpaper_url",
    "wallpaper_clear",
    "save_xmr402_payment",
    "get_xmr402_payment",
    "get_all_xmr402_payments",
    // Network
    "ros_native_fetch",
    "ros_native_fetch_bytes",
    "agent_web_read",
    "resolve_openalias",
    // Embedded Overlay Browser & External URL
    "open_external_url",
    "open_native_browser",
    "browser_embed_open",
    "browser_embed_bounds",
    "browser_embed_navigate",
    "browser_embed_visible",
    "browser_embed_zoom",
    "browser_embed_close",
    "browser_embed_deliver_xmr402",
    // Desktop-only feature stubs
    "vpn_status",
    "vpn_open_window",
    "vpn_set_locale",
    "agent_gateway_status",
    "agent_gateway_set_config",
    "agent_gateway_rotate_key",
    "local_ai_status",
    "local_ai_download",
    "local_ai_load",
    "local_ai_complete",
    "local_ai_remove",
    "local_ai_clear_all",
];

fn main() {
    println!("cargo:rustc-check-cfg=cfg(android_offline_stagenet)");
    println!("cargo:rustc-check-cfg=cfg(android_offline_regtest)");
    println!("cargo:rustc-check-cfg=cfg(android_mainnet_readonly)");
    for key in [
        "ROS_ANDROID_DEBUG_BUNDLE",
        "ROS_ANDROID_DEBUG_BUNDLE_SHA256",
        "ROS_ANDROID_UI_REVISION",
        "ROS_ANDROID_OFFLINE_STAGENET",
        "ROS_ANDROID_OFFLINE_REGTEST",
        "ROS_ANDROID_MAINNET_READONLY",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        let debug = std::env::var("PROFILE").as_deref() == Ok("debug");
        let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
        let fallback = manifest_dir.join("resources/ros-fallback.tar.zst");
        let debug_manifest = manifest_dir.join("target/ros-android-debug.manifest");
        println!("cargo:rerun-if-changed={}", debug_manifest.display());
        let env_or_manifest = if debug {
            if let Ok(p) = std::env::var("ROS_ANDROID_DEBUG_BUNDLE") {
                Some((
                    p,
                    std::env::var("ROS_ANDROID_DEBUG_BUNDLE_SHA256").expect("debug bundle pin required"),
                    std::env::var("ROS_ANDROID_UI_REVISION").expect("debug UI revision required"),
                ))
            } else if let Ok(raw) = std::fs::read_to_string(&debug_manifest) {
                let mut lines = raw.lines().map(str::trim).filter(|l| !l.is_empty());
                match (lines.next(), lines.next(), lines.next()) {
                    (Some(p), Some(h), Some(r)) if std::path::Path::new(p).exists() => {
                        Some((p.to_string(), h.to_string(), r.to_string()))
                    }
                    _ => None,
                }
            } else {
                None
            }
        } else {
            None
        };
        let generated = if let Some((raw_path, hash, rev)) = env_or_manifest {
            let path = std::fs::canonicalize(raw_path).expect("debug UI archive");
            assert!(hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()));
            assert!(rev.len() == 40 && rev.bytes().all(|b| b.is_ascii_hexdigit()));
            println!("cargo:rerun-if-changed={}", path.display());
            format!("const ARCHIVE:&[u8]=include_bytes!({:?}); const ARCHIVE_EXPECTED_HASH:&str={:?}; const UI_REVISION:&str={:?}; const DEBUG_LOCAL_UI:bool=true;",path,hash,rev)
        } else {
            format!("const ARCHIVE:&[u8]=include_bytes!({:?}); const ARCHIVE_EXPECTED_HASH:&str=updater::ota::FALLBACK_SHA256; const UI_REVISION:&str=\"pinned-release-fallback\"; const DEBUG_LOCAL_UI:bool=false;",fallback)
        };
        std::fs::write(
            std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("android_bundle.rs"),
            generated,
        )
        .unwrap();
        if debug {
            let modes = [
                "ROS_ANDROID_OFFLINE_STAGENET",
                "ROS_ANDROID_OFFLINE_REGTEST",
                "ROS_ANDROID_MAINNET_READONLY",
            ]
            .iter()
            .filter(|k| std::env::var(k).as_deref() == Ok("1"))
            .count();
            assert!(modes <= 1, "Android test networks are mutually exclusive");
        }
        if debug && std::env::var("ROS_ANDROID_MAINNET_READONLY").as_deref() == Ok("1") {
            println!("cargo:rustc-cfg=android_mainnet_readonly");
        }
        if debug && std::env::var("ROS_ANDROID_OFFLINE_REGTEST").as_deref() == Ok("1") {
            println!("cargo:rustc-cfg=android_offline_regtest");
        }
        if debug && std::env::var("ROS_ANDROID_OFFLINE_STAGENET").as_deref() == Ok("1") {
            println!("cargo:rustc-cfg=android_offline_stagenet");
        }
    }

    let commands = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        ANDROID_COMMANDS
    } else {
        APP_COMMANDS
    };
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands));
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // Validate only the selected mobile capability files. Desktop plugins are
        // intentionally not linked on Android, so their permission sets do not exist.
        attributes = attributes.capabilities_path_pattern("capabilities/android-*.json");
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
