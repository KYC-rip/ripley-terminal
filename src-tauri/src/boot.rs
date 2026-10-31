//! Which UI the main window boots into (plans/onboarding-first-wallet.md in ripley-os).
//!
//! - A true first launch (no config.json yet) starts in RipleyOS: `ui_mode = "ros"` is written before the window is
//!   built. An existing config is never touched — one without `ui_mode` (older than the key) stays classic.
//! - RipleyOS "beta" loads https://app.ros.rip. When that host can't be reached at launch (offline first run), the
//!   on-device verified bundle (ros://local) boots instead, so ROS mode never opens a dead window. A bundle that
//!   fails its pinned hash falls back to classic, as the OTA path always has.

use std::time::Duration;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum BootTarget {
    Classic,
    Remote,
    Bundle,
}

/// `Some("ros")` when there is no config file yet (a first launch); `None` = leave the stored choice alone.
pub fn first_launch_ui_mode(config_exists: bool) -> Option<&'static str> {
    if config_exists { None } else { Some("ros") }
}

/// Does this launch need the verified bundle? Only in ROS mode: the OTA source always, the beta source when the
/// remote host did not answer.
pub fn wants_bundle(ui_mode: &str, source: &str, remote_ok: bool) -> bool {
    ui_mode == "ros" && (source == "ota" || !remote_ok)
}

/// The window's target, given what was found.
pub fn ros_boot_target(ui_mode: &str, source: &str, remote_ok: bool, bundle_ok: bool) -> BootTarget {
    if ui_mode != "ros" {
        return BootTarget::Classic;
    }
    if wants_bundle(ui_mode, source, remote_ok) {
        if bundle_ok { BootTarget::Bundle } else { BootTarget::Classic }
    } else {
        BootTarget::Remote
    }
}

/// One HEAD to the remote ROS origin, 3 s budget. Only a success (2xx; redirects are followed) counts: a network
/// failure, a timeout, or an error page (5xx, a captive portal's 4xx) boots the verified bundle instead. No new
/// exposure: the webview contacts the same host a moment later.
pub fn remote_reachable(url: &str) -> bool {
    let url = url.to_string();
    tauri::async_runtime::block_on(async move {
        let client = match reqwest::Client::builder().timeout(Duration::from_secs(3)).build() {
            Ok(c) => c,
            Err(_) => return false,
        };
        matches!(client.head(&url).send().await, Ok(r) if r.status().is_success())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_launch_only_without_a_config_file() {
        assert_eq!(first_launch_ui_mode(false), Some("ros"));
        assert_eq!(first_launch_ui_mode(true), None);
    }

    #[test]
    fn boot_target_table() {
        use BootTarget::*;
        assert_eq!(ros_boot_target("classic", "beta", false, true), Classic);
        assert_eq!(ros_boot_target("ros", "beta", true, false), Remote);
        assert_eq!(ros_boot_target("ros", "beta", false, true), Bundle);
        assert_eq!(ros_boot_target("ros", "beta", false, false), Classic);
        assert_eq!(ros_boot_target("ros", "ota", true, true), Bundle);
        assert_eq!(ros_boot_target("ros", "ota", true, false), Classic);
    }
}
