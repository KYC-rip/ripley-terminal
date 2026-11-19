//! Pure Android POC IPC policy. Inputs come from the native WebView URL, never JS.
pub const ORIGIN: &str = "http://ros.localhost";
pub const DIAGNOSTICS: &str = "/__android_poc.html";
pub fn diagnostic_allowed(debug: bool, label: &str, origin: &str, path: &str) -> bool {
    debug && label == "ros-android" && origin == ORIGIN && path == DIAGNOSTICS
}
// Wry maps ros://localhost to http://ros.localhost on Android. In particular,
// ros://local would map to http://ros.local, a different origin.
pub fn trusted_location(scheme: &str, host: &str, port: Option<u16>, userinfo: bool) -> bool {
    !userinfo
        && port.is_none()
        && ((scheme == "ros" && host == "localhost")
            || (scheme == "http" && host == "ros.localhost"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wry_android_origin_mapping_is_exact() {
        assert!(trusted_location("ros", "localhost", None, false));
        assert!(trusted_location("http", "ros.localhost", None, false));
        assert!(!trusted_location("ros", "local", None, false));
        assert!(!trusted_location("http", "ros.local", None, false));
    }
    #[test]
    fn scheme_host_prefixes_are_not_authority() {
        assert!(!trusted_location("https", "ros.localhost", None, false));
        assert!(!trusted_location("http", "ros.localhost.evil", None, false));
        assert!(!trusted_location("ros", "localhost.evil", None, false));
    }
    #[test]
    fn credentials_and_nonstandard_ports_refused() {
        assert!(!trusted_location("http", "ros.localhost", Some(81), false));
        assert!(!trusted_location("ros", "localhost", None, true));
    }
    #[test]
    fn explicit_debug_local_page_allowed() {
        assert!(diagnostic_allowed(true, "ros-android", ORIGIN, DIAGNOSTICS));
    }
    #[test]
    fn release_never_allows_wallet_diagnostics() {
        assert!(!diagnostic_allowed(
            false,
            "ros-android",
            ORIGIN,
            DIAGNOSTICS
        ));
    }
    #[test]
    fn remote_and_lookalike_origins_denied() {
        for origin in [
            "https://app.ros.rip",
            "https://example.com",
            "http://ros.localhost.evil",
            "http://ros.localhost:81",
            "null",
        ] {
            assert!(!diagnostic_allowed(
                true,
                "ros-android",
                origin,
                DIAGNOSTICS
            ));
        }
    }
    #[test]
    fn ros_ui_not_a_wallet_diagnostic_page() {
        assert!(!diagnostic_allowed(
            true,
            "ros-android",
            ORIGIN,
            "/index.html"
        ));
    }
    #[test]
    fn arbitrary_labels_denied() {
        assert!(!diagnostic_allowed(true, "main", ORIGIN, DIAGNOSTICS));
    }
    #[test]
    fn path_prefix_and_encoding_not_accepted() {
        for path in [
            "/__android_poc.html/evil",
            "/%5f_android_poc.html",
            "/__android_poc.html.evil",
        ] {
            assert!(!diagnostic_allowed(true, "ros-android", ORIGIN, path));
        }
    }
}
