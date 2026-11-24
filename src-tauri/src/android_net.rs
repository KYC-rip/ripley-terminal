//! Android networking, CORS-free fetch (over Tor / custom SOCKS5 / clearnet),
//! public web reader, and DNSSEC-gated OpenAlias DoH resolution.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

use base64::Engine as _;
use hickory_proto::op::{Edns, Message, MessageType, OpCode, Query, ResponseCode};
use hickory_proto::rr::{Name, RData, RecordType};
use hickory_proto::serialize::binary::BinEncodable;
use monero_address::MoneroAddress;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::android_policy::public_ip;
use crate::wallet::WalletState;

const KYC_API_ONION: &str = "kycripxmrmlmkfaqf4hwchilhtrp36nu6vyjoh3e7rmsgmyylxfm25ad.onion";
const FETCH_MAX_RESPONSE: usize = 32 * 1024 * 1024;
const FETCH_MAX_REQUEST: usize = 8 * 1024 * 1024;
const AGENT_WEB_READ_MAX_BYTES: usize = 1024 * 1024;

const OPENALIAS_DOH_ENDPOINTS: &[&str] = &[
    "https://dns.mullvad.net/dns-query",
    "https://doh.dns.sb/dns-query",
];

fn is_onion(url: &str) -> bool {
    match tauri::Url::parse(url) {
        Ok(u) => u
            .host_str()
            .map(|h| h.to_ascii_lowercase().ends_with(".onion"))
            .unwrap_or(false),
        Err(_) => url.to_ascii_lowercase().contains(".onion"),
    }
}

fn validate_non_onion_host(url: &tauri::Url) -> Result<(), String> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL credentials are not allowed".into());
    }
    let host = url
        .host_str()
        .ok_or("URL has no host")?
        .to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".lan")
    {
        return Err("Local and private-network hosts are blocked".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !public_ip(ip) {
            return Err("Private/loopback IP destinations are blocked".into());
        }
    }
    Ok(())
}

fn is_tun_fake_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => {
            let b = a.octets();
            b[0] == 198 && (18..=19).contains(&b[1])
        }
        IpAddr::V6(_) => false,
    }
}

fn allowed_resolved_ip(host: &str, ip: IpAddr) -> bool {
    if public_ip(ip) {
        return true;
    }
    // Android/macOS TUN proxies (Clash/Surge/Mihomo) map public hostnames into RFC 2544
    // Fake-IP space (198.18.0.0/15). Literal IP URLs are still rejected by validate_non_onion_host.
    host.parse::<IpAddr>().is_err() && is_tun_fake_ip(ip)
}

fn safe_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("Too many redirects");
        }
        let u = attempt.url();
        if u.scheme() != "https" && u.scheme() != "http" {
            return attempt.error("Blocked redirect scheme");
        }
        if !is_onion(u.as_str()) {
            if let Ok(parsed) = tauri::Url::parse(u.as_str()) {
                if let Err(e) = validate_non_onion_host(&parsed) {
                    return attempt.error(e);
                }
            } else {
                return attempt.error("Invalid redirect URL");
            }
        }
        attempt.follow()
    })
}

/// Shared raw-bytes GET used by the signed OTA updater (`updater::check_and_stage_update`).
pub async fn proxied_get_bytes(
    app: &AppHandle,
    url: &str,
    timeout: Duration,
    max_bytes: Option<u64>,
) -> Result<Vec<u8>, String> {
    let mode = crate::wallet::scanner::read_routing_mode(app);
    let target = if mode != "clearnet" {
        url.replace(
            "https://api.kyc.rip",
            &format!("http://{KYC_API_ONION}/api"),
        )
        .replace(
            "https://ros.rip/",
            &format!("http://{}/", crate::updater::ota::OTA_ONION_HOST),
        )
    } else {
        url.to_string()
    };

    if !is_onion(&target) {
        let parsed = tauri::Url::parse(&target).map_err(|_| "Invalid URL".to_string())?;
        if parsed.scheme() != "https" && parsed.scheme() != "http" {
            return Err("Only http(s) URLs are supported".into());
        }
        validate_non_onion_host(&parsed)?;
    }

    let route = if is_onion(&target) {
        "tor"
    } else {
        mode.as_str()
    };
    let cap_usize = max_bytes.map(|c| c.min(usize::MAX as u64) as usize);

    match route {
        "tor" => match app.state::<crate::tor::TorState>().get_client().await {
            Some(tor) => match cap_usize {
                Some(l) => crate::tor::tor_get_capped(&tor, &target, l).await,
                None => crate::tor::tor_get(&tor, &target).await,
            },
            None => Err("Tor is not connected yet (required for this request)".into()),
        },
        "custom" => {
            let proxy = crate::wallet::scanner::read_proxy_address(app);
            if proxy.trim().is_empty() {
                Err("Custom routing selected but no proxy address is set".into())
            } else {
                match cap_usize {
                    Some(l) => crate::tor::socks_get_capped(&proxy, &target, l).await,
                    None => crate::tor::socks_get(&proxy, &target).await,
                }
            }
        }
        _ => {
            let client = reqwest::Client::builder()
                .redirect(safe_redirect_policy())
                .build()
                .map_err(|e| e.to_string())?;
            let mut resp = client
                .get(&target)
                .header(
                    "User-Agent",
                    concat!("ripley-terminal/", env!("CARGO_PKG_VERSION")),
                )
                .timeout(timeout)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if let (Some(cap), Some(len)) = (max_bytes, resp.content_length()) {
                if len > cap {
                    return Err(format!("response too large: {len} > {cap} bytes"));
                }
            }
            let mut buf = Vec::new();
            while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
                if let Some(cap) = max_bytes {
                    if buf.len() as u64 + chunk.len() as u64 > cap {
                        return Err(format!("response too large (> {cap} bytes)"));
                    }
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(buf)
        }
    }
}

#[derive(serde::Deserialize)]
pub struct RosFetchReq {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
}

async fn route_fetch(app: &AppHandle, req: &RosFetchReq) -> Result<(u16, Vec<u8>), String> {
    let mode = crate::wallet::scanner::read_routing_mode(app);
    let method = req.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let body = req.body.clone().unwrap_or_default().into_bytes();
    if body.len() > FETCH_MAX_REQUEST {
        return Err("Request body exceeds size limit".into());
    }
    let has_body = !body.is_empty();

    let target = if mode != "clearnet" {
        req.url.replace(
            "https://api.kyc.rip",
            &format!("http://{KYC_API_ONION}/api"),
        )
    } else {
        req.url.clone()
    };

    let parsed = tauri::Url::parse(&target).map_err(|_| "Invalid URL".to_string())?;
    let onion = is_onion(&target);
    if !onion {
        if parsed.scheme() != "https" && parsed.scheme() != "http" {
            return Err("Only http(s) URLs are supported".into());
        }
        validate_non_onion_host(&parsed)?;
    }

    let route = if onion { "tor" } else { mode.as_str() };
    let header_pairs: Vec<(String, String)> = req
        .headers
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    match route {
        "tor" => match app.state::<crate::tor::TorState>().get_client().await {
            Some(tor) => {
                let m = hyper::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
                crate::tor::tor_request_with_headers(
                    &tor,
                    m,
                    &target,
                    body,
                    &header_pairs,
                    Some(FETCH_MAX_RESPONSE),
                )
                .await
            }
            None => Err("Tor is enabled but not connected yet".into()),
        },
        "custom" => {
            let proxy = crate::wallet::scanner::read_proxy_address(app);
            if proxy.trim().is_empty() {
                return Err("Custom routing selected but no proxy address is set".into());
            }
            let px = reqwest::Proxy::all(&proxy).map_err(|e| e.to_string())?;
            ros_reqwest(
                reqwest::Client::builder().proxy(px),
                &method,
                &target,
                &req.headers,
                &body,
                has_body,
            )
            .await
        }
        _ => {
            let host = parsed.host_str().unwrap_or("");
            let port = parsed.port_or_known_default().unwrap_or(443);
            let addrs: Vec<_> = tokio::time::timeout(
                Duration::from_secs(5),
                tokio::net::lookup_host((host, port)),
            )
            .await
            .map_err(|_| "DNS lookup timed out".to_string())?
            .map_err(|e| format!("DNS lookup failed: {e}"))?
            .collect();
            if addrs.is_empty() || addrs.iter().any(|a| !allowed_resolved_ip(host, a.ip())) {
                return Err("Private/loopback destinations are blocked".into());
            }
            ros_reqwest(
                reqwest::Client::builder().resolve_to_addrs(host, &addrs),
                &method,
                &target,
                &req.headers,
                &body,
                has_body,
            )
            .await
        }
    }
}

async fn ros_reqwest(
    builder: reqwest::ClientBuilder,
    method: &str,
    url: &str,
    headers: &Option<HashMap<String, String>>,
    body: &[u8],
    has_body: bool,
) -> Result<(u16, Vec<u8>), String> {
    let client = builder
        .timeout(Duration::from_secs(30))
        .redirect(safe_redirect_policy())
        .build()
        .map_err(|e| e.to_string())?;
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut rb = client.request(m, url).header(
        "User-Agent",
        concat!("ripley-terminal/", env!("CARGO_PKG_VERSION")),
    );
    if let Some(hs) = headers {
        for (k, v) in hs {
            if [
                "host",
                "content-length",
                "connection",
                "transfer-encoding",
                "upgrade",
            ]
            .iter()
            .any(|b| k.eq_ignore_ascii_case(b))
            {
                continue;
            }
            rb = rb.header(k, v);
        }
    }
    if has_body {
        rb = rb.body(body.to_vec());
    }
    let mut resp = rb.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if out.len() + chunk.len() > FETCH_MAX_RESPONSE {
            return Err("Response exceeds fetch size limit".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok((status, out))
}

#[tauri::command]
pub async fn ros_native_fetch(app: AppHandle, req: RosFetchReq) -> Result<Value, String> {
    match route_fetch(&app, &req).await {
        Ok((status, bytes)) => Ok(json!({
            "ok": status < 400,
            "status": status,
            "body": String::from_utf8_lossy(&bytes),
        })),
        Err(e) => Ok(json!({ "ok": false, "status": 502, "body": e })),
    }
}

#[tauri::command]
pub async fn ros_native_fetch_bytes(
    app: AppHandle,
    req: RosFetchReq,
) -> Result<tauri::ipc::Response, String> {
    let (status, bytes) = route_fetch(&app, &req).await?;
    if status >= 400 {
        return Err(format!("upstream {status}"));
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWebReadResponse {
    status: u16,
    final_url: String,
    content_type: Option<String>,
    body: String,
}

#[tauri::command]
pub async fn agent_web_read(app: AppHandle, url: String) -> Result<AgentWebReadResponse, String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "web_read requires a valid absolute URL")?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("web_read allows only http:// or https:// URLs".into());
    }
    if !is_onion(&url) {
        validate_non_onion_host(&parsed)?;
    }
    let req = RosFetchReq {
        url: url.clone(),
        method: Some("GET".into()),
        headers: None,
        body: None,
    };
    let (status, mut bytes) = route_fetch(&app, &req).await?;
    if bytes.len() > AGENT_WEB_READ_MAX_BYTES {
        bytes.truncate(AGENT_WEB_READ_MAX_BYTES);
    }
    Ok(AgentWebReadResponse {
        status,
        final_url: url,
        content_type: Some("text/plain".into()),
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAliasResult {
    pub address: String,
    pub recipient_name: Option<String>,
    pub tx_description: Option<String>,
    pub dnssec: bool,
    pub ticker: String,
}

fn normalize_openalias_name(raw: &str) -> Result<String, String> {
    let s = raw.trim().trim_end_matches('.').to_ascii_lowercase();
    let fqdn = if let Some((local, domain)) = s.split_once('@') {
        if local.is_empty() || domain.is_empty() || domain.contains('@') {
            return Err("Invalid OpenAlias name".into());
        }
        format!("{local}.{domain}")
    } else {
        s
    };
    if fqdn.is_empty() || !fqdn.contains('.') || fqdn.len() > 253 {
        return Err("Invalid OpenAlias domain".into());
    }
    Ok(fqdn)
}

fn build_doh_query(fqdn: &str) -> Result<String, String> {
    let name = Name::from_ascii(fqdn).map_err(|e| format!("invalid DNS name: {e}"))?;
    let query = Query::query(name, RecordType::TXT);
    let mut msg = Message::new();
    msg.set_id(0)
        .set_message_type(MessageType::Query)
        .set_op_code(OpCode::Query)
        .set_recursion_desired(true)
        .add_query(query);
    let mut edns = Edns::new();
    edns.set_dnssec_ok(true);
    edns.set_max_payload(1232);
    msg.set_edns(edns);
    let wire = msg
        .to_bytes()
        .map_err(|e| format!("DNS encode failed: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(wire))
}

fn extract_txt_records(msg: &Message) -> Vec<String> {
    msg.answers()
        .iter()
        .filter_map(|rec| match rec.data() {
            Some(RData::TXT(txt)) => {
                let mut s = String::new();
                for chunk in txt.txt_data() {
                    s.push_str(&String::from_utf8_lossy(chunk));
                }
                Some(s)
            }
            _ => None,
        })
        .collect()
}

fn oa1_field(record: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=");
    let pos = record.find(&needle)?;
    let rest = &record[pos + needle.len()..];
    let val = rest.split(';').next()?.trim();
    Some(val.trim_matches('"').to_string())
}

#[tauri::command]
pub async fn resolve_openalias(
    app: AppHandle,
    name: String,
    ticker: String,
) -> Result<OpenAliasResult, String> {
    let ticker = ticker.trim().to_ascii_lowercase();
    if ticker.is_empty() {
        return Err("ticker is required".into());
    }
    let fqdn = normalize_openalias_name(&name)?;
    let query = build_doh_query(&fqdn)?;
    let mode = crate::wallet::scanner::read_routing_mode(&app);
    let headers: &[(&str, &str)] = &[("Accept", "application/dns-message")];

    let mut last_err = String::new();
    let mut answer: Option<Message> = None;
    for endpoint in OPENALIAS_DOH_ENDPOINTS {
        let url = format!("{endpoint}?dns={query}");
        let res: Result<Vec<u8>, String> = match mode.as_str() {
            "tor" => match app.state::<crate::tor::TorState>().get_client().await {
                Some(tor) => crate::tor::tor_get_with_headers(&tor, &url, headers).await,
                None => {
                    return Err(
                        "Tor is not connected yet (required for OpenAlias resolution)".into(),
                    )
                }
            },
            "custom" => {
                let proxy = crate::wallet::scanner::read_proxy_address(&app);
                if proxy.trim().is_empty() {
                    return Err("Custom routing selected but no proxy address is set".into());
                }
                crate::tor::socks_get_with_headers(&proxy, &url, headers).await
            }
            _ => {
                let resp = reqwest::Client::new()
                    .get(&url)
                    .header("Accept", "application/dns-message")
                    .header(
                        "User-Agent",
                        concat!("ripley-terminal/", env!("CARGO_PKG_VERSION")),
                    )
                    .timeout(Duration::from_secs(15))
                    .send()
                    .await
                    .map_err(|e| e.to_string());
                match resp {
                    Ok(r) if r.status().is_success() => {
                        r.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
                    }
                    Ok(r) => Err(format!("HTTP {}", r.status())),
                    Err(e) => Err(e),
                }
            }
        };
        match res {
            Ok(bytes) => match Message::from_vec(&bytes) {
                Ok(msg) => {
                    answer = Some(msg);
                    break;
                }
                Err(e) => last_err = format!("{endpoint}: unreadable DNS ({e})"),
            },
            Err(e) => last_err = format!("{endpoint}: {e}"),
        }
    }

    let msg = answer.ok_or_else(|| format!("no DoH resolver answered ({last_err})"))?;
    if msg.truncated() {
        return Err("DNS response was truncated (TC=1)".into());
    }
    if msg.response_code() != ResponseCode::NoError {
        return Err("DNS lookup failed".into());
    }
    if !msg.authentic_data() {
        return Err("DNSSEC not validated (AD=0)".into());
    }

    let prefix = format!("oa1:{ticker}");
    let txts = extract_txt_records(&msg);
    let matches: Vec<&String> = txts
        .iter()
        .filter(|t| {
            let l = t.trim().to_ascii_lowercase();
            l.starts_with(&format!("{prefix} ")) || l.starts_with(&format!("{prefix};"))
        })
        .collect();
    if matches.is_empty() {
        return Err(format!("No OpenAlias record found for {ticker}"));
    }
    if matches.len() > 1 {
        return Err(format!("Multiple OpenAlias records found for {ticker}"));
    }
    let record = matches[0];
    let address = oa1_field(record, "recipient_address")
        .filter(|s| !s.is_empty())
        .ok_or("OpenAlias record missing recipient_address")?;
    let recipient_name = oa1_field(record, "recipient_name").filter(|s| !s.is_empty());
    let tx_description = oa1_field(record, "tx_description").filter(|s| !s.is_empty());

    if ticker == "xmr" {
        let network = app.state::<WalletState>().get_network().await;
        MoneroAddress::from_str(network, &address)
            .map_err(|e| format!("resolved XMR address failed validation: {e}"))?;
    }

    Ok(OpenAliasResult {
        address,
        recipient_name,
        tx_description,
        dnssec: true,
        ticker,
    })
}
