//! HTTP-over-Tor transport for the Monero daemon RPC.
//!
//! monero-oxide talks to a daemon through the `HttpTransport` trait. The stock
//! `SimpleRequestTransport` opens clearnet TCP connections with no proxy hook,
//! so it leaks the user's IP to every node. `ArtiTransport` implements the same
//! trait but tunnels each request through an arti `DataStream` (pure-Rust Tor),
//! driving HTTP/1.1 with `hyper` over that stream.
//!
//! Why hyper rather than a hand-rolled parser: monero-oxide reads responses via
//! hyper today (through `simple-request`), so `monerod` is free to reply with
//! chunked transfer-encoding (notably the large `.bin` endpoints). hyper decodes
//! both Content-Length and chunked transparently, so reusing it here is correct
//! by construction. `http_body_util::Limited` enforces the response size limit
//! the trait passes in.
//!
//! Connections are NOT reused: we open a fresh stream per request and drop it
//! once the body is fully read. This sidesteps the trait's "read the full
//! response before reusing the connection" hazard entirely. arti manages circuit
//! reuse internally, so the per-request cost is a stream open, not a circuit build.

use std::future::Future;

use arti_client::TorClient;
use tor_rtcompat::PreferredRuntime;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;

use monero_daemon_rpc::prelude::InterfaceError;
use monero_daemon_rpc::{HttpTransport, MoneroDaemon};

/// An `HttpTransport` that tunnels every request through Tor via arti.
#[derive(Clone)]
pub struct ArtiTransport {
    /// Shared, Arc-backed Tor client. Cloning is cheap; all transports in the
    /// scanner's multi-node pool share one `TorClient` and arti reuses circuits.
    tor: TorClient<PreferredRuntime>,
    host: String,
    port: u16,
}

impl ArtiTransport {
    /// Build a daemon backed by Tor for the given node URL.
    ///
    /// `url` may be `http://host:port`, `host:port`, or a bare `host` (port
    /// defaults to 18081, monerod's standard RPC port). `.onion` hosts are
    /// dialed natively by arti — no exit node is used.
    pub async fn connect(
        tor: TorClient<PreferredRuntime>,
        url: String,
    ) -> Result<MoneroDaemon<ArtiTransport>, InterfaceError> {
        let (host, port) = parse_host_port(&url)?;
        let transport = ArtiTransport { tor, host, port };
        // MoneroDaemon::new validates the connection (calls get_info).
        MoneroDaemon::new(transport).await
    }
}

impl HttpTransport for ArtiTransport {
    fn post(
        &self,
        route: &str,
        body: Vec<u8>,
        response_size_limit: Option<usize>,
    ) -> impl Send + Future<Output = Result<Vec<u8>, InterfaceError>> {
        let tor = self.tor.clone();
        let host = self.host.clone();
        let port = self.port;
        // monero-oxide passes the route without a leading slash (e.g. "json_rpc",
        // "get_info", "get_blocks.bin"); normalize to an origin-form request target.
        let path = if route.starts_with('/') {
            route.to_string()
        } else {
            format!("/{route}")
        };
        async move {
            tor_http(&tor, Method::POST, &host, port, &path, body, response_size_limit)
                .await
                .map_err(InterfaceError::InterfaceError)
        }
    }
}

/// Issue a single HTTP/1.1 request over a fresh Tor stream and return the body.
///
/// Used by both `ArtiTransport::post` (daemon RPC) and the reqwest-replacement
/// GETs (Phase 2). Opens `tor.connect((host, port))`, wraps the `DataStream` in
/// `hyper_util::TokioIo`, performs an HTTP/1.1 handshake, sends the request, and
/// collects the full body (respecting `size_limit` via `Limited`).
pub async fn tor_http(
    tor: &TorClient<PreferredRuntime>,
    method: Method,
    host: &str,
    port: u16,
    path: &str,
    body: Vec<u8>,
    size_limit: Option<usize>,
) -> Result<Vec<u8>, String> {
    // Open a stream through Tor. arti dials .onion natively; for clearnet hosts
    // it exits through the Tor network (still no IP leak to the node).
    let stream = tor
        .connect((host, port))
        .await
        .map_err(|e| format!("Tor connect to {host}:{port} failed: {e}"))?;

    let io = TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| format!("HTTP handshake failed: {e}"))?;

    // The connection future must be driven concurrently while we await the
    // response. Spawn it; abort once the body is fully read.
    let conn_task = tokio::spawn(async move {
        let _ = conn.await;
    });

    let content_length = body.len();
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header(hyper::header::HOST, host)
        .header(hyper::header::CONTENT_LENGTH, content_length)
        .body(Full::new(Bytes::from(body)))
        .map_err(|e| format!("Failed to build request: {e}"))?;

    let response = sender
        .send_request(request)
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let incoming = response.into_body();
    let result = match size_limit {
        Some(limit) => Limited::new(incoming, limit)
            .collect()
            .await
            .map_err(|e| format!("Response body error (limit {limit}): {e}")),
        None => incoming
            .collect()
            .await
            .map_err(|e| format!("Response body error: {e}")),
    };

    // Always tear down the connection driver, including on the body-error path
    // (an early `?` would otherwise leak the spawned task until the stream dies).
    conn_task.abort();
    Ok(result?.to_bytes().to_vec())
}

/// Parse a node URL into (host, port). Accepts `scheme://host:port`, `host:port`,
/// or bare `host`. Defaults to monerod's standard RPC port 18081.
fn parse_host_port(url: &str) -> Result<(String, u16), InterfaceError> {
    let without_scheme = url.split("://").last().unwrap_or(url);
    // Strip any trailing path.
    let authority = without_scheme.split('/').next().unwrap_or(without_scheme);
    if authority.is_empty() {
        return Err(InterfaceError::InterfaceError(format!("invalid node URL: {url}")));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) => {
            let port: u16 = port
                .parse()
                .map_err(|_| InterfaceError::InterfaceError(format!("invalid port in URL: {url}")))?;
            Ok((host.to_string(), port))
        }
        None => Ok((authority.to_string(), 18081)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_and_port() {
        assert_eq!(parse_host_port("http://node.example:18089").unwrap(), ("node.example".into(), 18089));
        assert_eq!(parse_host_port("node.example:18081").unwrap(), ("node.example".into(), 18081));
        assert_eq!(parse_host_port("xmrtoaddr.onion").unwrap(), ("xmrtoaddr.onion".into(), 18081));
        assert_eq!(parse_host_port("https://abc.onion:443/foo").unwrap(), ("abc.onion".into(), 443));
        assert!(parse_host_port("http://").is_err());
    }

    /// Live smoke test against a known monero .onion node. Ignored by default
    /// (needs network + a bootstrapped Tor); run explicitly:
    ///   cargo test -p ripley-terminal arti_onion_get_info -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn arti_onion_get_info() {
        use arti_client::{TorClient, TorClientConfig};
        use monero_daemon_rpc::prelude::ProvidesBlockchainMeta;
        let tor = TorClient::create_bootstrapped(TorClientConfig::default())
            .await
            .expect("tor bootstrap");
        // monero.fail-listed onion (replace if it rotates).
        let url = "monerujod4lhmwkdt3xqdq2akm4spvksp22hpgxsabe6lcsfh67abqd.onion:18081".to_string();
        let daemon = ArtiTransport::connect(tor, url).await.expect("connect");
        let height = daemon.latest_block_number().await.expect("height");
        println!("onion node height = {height}");
        assert!(height > 3_000_000);
    }
}
