//! Pure Android IPC policy. Inputs come from the native WebView URL, never JS.
pub const ORIGIN: &str = "https://ros.localhost";
pub const DIAGNOSTICS: &str = "/__android_poc.html";
pub fn diagnostic_allowed(debug: bool, label: &str, origin: &str, path: &str) -> bool {
    debug && label == "ros-android" && origin == ORIGIN && path == DIAGNOSTICS
}
// With use_https_scheme(true), wry maps ros://localhost to https://ros.localhost on
// Android (a Secure Context for WebCrypto + QR camera, classified as local by Tauri).
// In particular, ros://local would map to https://ros.local (Origin::Remote, zero IPC).
pub fn trusted_location(scheme: &str, host: &str, port: Option<u16>, userinfo: bool) -> bool {
    !userinfo
        && port.is_none()
        && ((scheme == "ros" && host == "localhost")
            || (scheme == "https" && host == "ros.localhost"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wry_android_origin_mapping_is_exact() {
        assert!(trusted_location("ros", "localhost", None, false));
        assert!(trusted_location("https", "ros.localhost", None, false));
        assert!(!trusted_location("ros", "local", None, false));
        assert!(!trusted_location("https", "ros.local", None, false));
        assert!(!trusted_location("http", "ros.localhost", None, false));
    }
    #[test]
    fn scheme_host_prefixes_are_not_authority() {
        assert!(!trusted_location("http", "ros.localhost", None, false));
        assert!(!trusted_location("https", "ros.localhost.evil", None, false));
        assert!(!trusted_location("ros", "localhost.evil", None, false));
    }
    #[test]
    fn credentials_and_nonstandard_ports_refused() {
        assert!(!trusted_location("https", "ros.localhost", Some(81), false));
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
            "http://ros.localhost",
            "https://ros.localhost.evil",
            "https://ros.localhost:81",
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

// Public HTTPS GET destination filtering.
use std::net::IpAddr;
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => {
            let b = a.octets();
            !(a.is_private()
                || a.is_loopback()
                || a.is_link_local()
                || a.is_unspecified()
                || a.is_multicast()
                || a.is_broadcast()
                || a.is_documentation()
                || b[0] == 0
                || b[0] >= 224
                || (b[0] == 100 && (64..=127).contains(&b[1]))
                || (b[0] == 198 && (18..=19).contains(&b[1]))
                || (b[0] == 192 && b[1] == 0 && b[2] == 0)
                || (b[0] == 192 && b[1] == 88 && b[2] == 99))
        }
        IpAddr::V6(a) => {
            if let Some(v4) = a.to_ipv4() {
                return public_ip(IpAddr::V4(v4));
            }
            let b = a.segments();
            // Global unicast only; exclude documentation and transition ranges.
            (b[0] & 0xe000) == 0x2000
                && !(b[0] == 0x2001 && (b[1] <= 0x1ff || b[1] == 0xdb8))
                && b[0] != 0x2002
                && !(b[0] == 0x3fff && (b[1] & 0xf000) == 0)
        }
    }
}
#[cfg(test)]
mod network_policy_tests {
    use super::*;
    #[test]
    fn denies_nonpublic_and_transition_addresses() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.1.2.3",
            "198.19.1.1",
            "224.0.0.1",
            "255.255.255.255",
            "192.0.2.1",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:10.1.2.3",
            "fd00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "2002:7f00:1::1",
            "3fff::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
    }
    #[test]
    fn accepts_public_addresses() {
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ] {
            assert!(public_ip(ip.parse().unwrap()), "{ip}");
        }
    }
}
