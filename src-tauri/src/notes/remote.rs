// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

//! Fetching a public HTTPS document for a note.
//!
//! The renderer never fetches anything. This module runs in Rust and enforces:
//!
//! * `https` only, port 443, no credentials in the URL, TLS verification on;
//! * only the web: `localhost`, single-label names, `.local`/`.internal`/…,
//!   and every loopback, private, link-local, CGNAT, multicast, documentation or
//!   otherwise non-public address are refused, for the URL **and for every
//!   redirect**;
//! * DNS-rebinding defence: the host is resolved here, **all** answers must be
//!   public, and the connection is pinned to exactly those validated addresses
//!   (the HTTP client does not resolve the name again);
//! * at most 5 redirects, each one re-validated; no cookies, no `Authorization`,
//!   no proxies picked up from the environment, no other request than the document;
//! * timeouts and a hard size limit while streaming; only text, Markdown and
//!   HTML are accepted.
//!
//! Nothing here is persisted or logged (not the URL, not the content).

use super::model::{DocFormat, MAX_DOC_BYTES, MAX_SOURCE_CHARS};
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use url::{Host, Url};

pub const MAX_REDIRECTS: usize = 5;
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FetchError {
    InvalidUrl,
    /// Not `https`, or not the default HTTPS port.
    NotHttps,
    /// A local, private or otherwise non-public destination.
    Blocked,
    Dns,
    Timeout,
    /// Could not connect, TLS failed, connection dropped.
    Network,
    TooManyRedirects,
    /// Any non-success HTTP status (carried separately in `Response`).
    Http(u16),
    TooLarge,
    UnsupportedType,
}

impl FetchError {
    /// A short fixed token for the renderer.
    pub fn token(self) -> &'static str {
        match self {
            Self::InvalidUrl => "invalid_url",
            Self::NotHttps => "not_https",
            Self::Blocked => "blocked",
            Self::Dns => "dns",
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::TooManyRedirects => "redirects",
            Self::Http(_) => "http",
            Self::TooLarge => "too_large",
            Self::UnsupportedType => "unsupported_type",
        }
    }

    pub fn sentence(self) -> String {
        match self {
            Self::InvalidUrl => "That is not a valid web address.".into(),
            Self::NotHttps => "Only https:// addresses can be used.".into(),
            Self::Blocked => {
                "That address points to a local or private network and is not allowed.".into()
            }
            Self::Dns => "The server name could not be found.".into(),
            Self::Timeout => "The server did not answer in time.".into(),
            Self::Network => "The document could not be downloaded (no connection?).".into(),
            Self::TooManyRedirects => "The address redirects too many times.".into(),
            Self::Http(code) => format!("The server answered with an error ({code})."),
            Self::TooLarge => "The document is too large.".into(),
            Self::UnsupportedType => {
                "That address is not a Markdown, text or HTML document.".into()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

fn v4_public(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || (a == 100 && (64..=127).contains(&b)) // CGNAT 100.64/10
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 192 && b == 88 && c == 99) // 6to4 relay
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || a >= 240) // reserved / future use
}

fn v6_public(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return v4_public(v4);
    }
    let seg = ip.segments();
    // NAT64 64:ff9b::/96 carries an IPv4 address in the last 32 bits
    if seg[0] == 0x64 && seg[1] == 0xff9b && seg[2..6] == [0, 0, 0, 0] {
        let [a, b] = seg[6].to_be_bytes();
        let [c, d] = seg[7].to_be_bytes();
        return v4_public(Ipv4Addr::new(a, b, c, d));
    }
    // 6to4 2002::/16 embeds an IPv4 address too
    if seg[0] == 0x2002 {
        let [a, b] = seg[1].to_be_bytes();
        let [c, d] = seg[2].to_be_bytes();
        return v4_public(Ipv4Addr::new(a, b, c, d));
    }
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (seg[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
        || (seg[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (seg[0] & 0xffc0) == 0xfec0 // deprecated site-local
        || (seg[0] == 0x2001 && seg[1] == 0x0db8) // documentation
        || (seg[0] == 0x0100 && seg[1..4] == [0, 0, 0])) // discard prefix
}

/// Only addresses of the public internet pass.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v4_public(v),
        IpAddr::V6(v) => v6_public(v),
    }
}

fn domain_allowed(name: &str) -> bool {
    let n = name.trim_end_matches('.').to_ascii_lowercase();
    if n.is_empty() || !n.contains('.') {
        return false; // localhost and single-label intranet names
    }
    const INTERNAL: [&str; 8] = [
        ".localhost",
        ".local",
        ".localdomain",
        ".internal",
        ".intranet",
        ".lan",
        ".home",
        ".corp",
    ];
    if INTERNAL.iter().any(|s| n.ends_with(s)) || n == "localhost" {
        return false;
    }
    // names made only of digits and dots are number-style IP spellings
    !n.chars().all(|c| c.is_ascii_digit() || c == '.')
}

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

/// Parse, validate and, for GitHub file pages, resolve to the raw content URL.
pub fn normalize(input: &str) -> Result<Url, FetchError> {
    let text = input.trim();
    if text.is_empty()
        || text.chars().count() > MAX_SOURCE_CHARS
        || text.chars().any(char::is_control)
    {
        return Err(FetchError::InvalidUrl);
    }
    let url = Url::parse(text).map_err(|_| FetchError::InvalidUrl)?;
    check_url(&url)?;
    Ok(github_raw(url))
}

/// Scheme, port, credentials and host policy (no DNS here).
pub fn check_url(url: &Url) -> Result<(), FetchError> {
    if url.scheme() != "https" {
        return Err(FetchError::NotHttps);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(FetchError::InvalidUrl);
    }
    if url.port_or_known_default() != Some(443) {
        return Err(FetchError::NotHttps);
    }
    match url.host() {
        Some(Host::Domain(d)) if domain_allowed(d) => Ok(()),
        Some(Host::Domain(_)) => Err(FetchError::Blocked),
        Some(Host::Ipv4(v)) if is_public_ip(IpAddr::V4(v)) => Ok(()),
        Some(Host::Ipv6(v)) if is_public_ip(IpAddr::V6(v)) => Ok(()),
        Some(_) => Err(FetchError::Blocked),
        None => Err(FetchError::InvalidUrl),
    }
}

/// `https://github.com/{owner}/{repo}/blob/{ref}/{path}` shows the file inside a
/// web page; its content lives on `raw.githubusercontent.com`. Only this exact
/// form is rewritten; nothing else about GitHub is understood or scraped.
fn github_raw(url: Url) -> Url {
    if url.host_str() != Some("github.com") {
        return url;
    }
    let segs: Vec<&str> = url.path_segments().map(|s| s.collect()).unwrap_or_default();
    if segs.len() >= 5 && segs[2] == "blob" && segs.iter().all(|s| !s.is_empty()) {
        let rest = segs[3..].join("/");
        if let Ok(raw) = Url::parse(&format!(
            "https://raw.githubusercontent.com/{}/{}/{}",
            segs[0], segs[1], rest
        )) {
            return raw;
        }
    }
    url
}

/// The format a URL most likely has, from its path.
pub fn format_from_path(url: &Url) -> Option<DocFormat> {
    let last = url.path_segments()?.next_back()?;
    let ext = last.rsplit_once('.')?.1;
    DocFormat::from_extension(ext)
}

// ---------------------------------------------------------------------------
// Fetching (transport and resolver are injected so the policy is testable)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub location: Option<String>,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

#[allow(async_fn_in_trait)]
pub trait Resolver {
    async fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, FetchError>;
}

#[allow(async_fn_in_trait)]
pub trait Transport {
    /// GET `url`, connecting ONLY to `addrs` (already validated), with no redirects.
    async fn get(&self, url: &Url, addrs: &[SocketAddr]) -> Result<Response, FetchError>;
}

#[derive(Debug)]
pub struct Fetched {
    #[cfg_attr(not(test), allow(dead_code))]
    pub final_url: Url,
    pub format: DocFormat,
    pub text: String,
}

async fn validated_addrs<R: Resolver>(
    resolver: &R,
    url: &Url,
) -> Result<Vec<SocketAddr>, FetchError> {
    check_url(url)?;
    let ips: Vec<IpAddr> = match url.host() {
        Some(Host::Ipv4(v)) => vec![IpAddr::V4(v)],
        Some(Host::Ipv6(v)) => vec![IpAddr::V6(v)],
        Some(Host::Domain(d)) => resolver.resolve(d).await?,
        None => return Err(FetchError::InvalidUrl),
    };
    if ips.is_empty() {
        return Err(FetchError::Dns);
    }
    // One private answer poisons the whole name: that is exactly what DNS rebinding looks like.
    if ips.iter().any(|ip| !is_public_ip(*ip)) {
        return Err(FetchError::Blocked);
    }
    Ok(ips.into_iter().map(|ip| SocketAddr::new(ip, 443)).collect())
}

fn classify_body(url: &Url, response: &Response) -> Result<(DocFormat, String), FetchError> {
    if response.body.len() > MAX_DOC_BYTES {
        return Err(FetchError::TooLarge);
    }
    let media = response
        .content_type
        .as_deref()
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let by_path = format_from_path(url);
    let format = match media.as_str() {
        "text/markdown" | "text/x-markdown" => DocFormat::Markdown,
        "text/html" | "application/xhtml+xml" => DocFormat::Html,
        "text/plain" => by_path
            .filter(|f| *f != DocFormat::Html)
            .unwrap_or(DocFormat::Text),
        _ => return Err(FetchError::UnsupportedType),
    };
    let body = response
        .body
        .strip_prefix(b"\xEF\xBB\xBF")
        .unwrap_or(&response.body);
    Ok((format, String::from_utf8_lossy(body).into_owned()))
}

/// Fetch `start`, following at most [`MAX_REDIRECTS`] redirects, re-validating
/// every hop (scheme, host, DNS answers).
pub async fn fetch<R: Resolver, T: Transport>(
    resolver: &R,
    transport: &T,
    start: &Url,
) -> Result<Fetched, FetchError> {
    let mut url = start.clone();
    for _ in 0..=MAX_REDIRECTS {
        let addrs = validated_addrs(resolver, &url).await?;
        let response = transport.get(&url, &addrs).await?;
        match response.status {
            200..=299 => {
                let (format, text) = classify_body(&url, &response)?;
                return Ok(Fetched {
                    final_url: url,
                    format,
                    text,
                });
            }
            301 | 302 | 303 | 307 | 308 => {
                let next = response
                    .location
                    .as_deref()
                    .and_then(|l| url.join(l).ok())
                    .ok_or(FetchError::Network)?;
                // The next hop is judged like a brand-new request (http:, private hosts, …).
                url = next;
            }
            code => return Err(FetchError::Http(code)),
        }
    }
    Err(FetchError::TooManyRedirects)
}

// ---------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------

pub struct SystemResolver;

impl Resolver for SystemResolver {
    async fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, FetchError> {
        let found = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((host, 443)))
            .await
            .map_err(|_| FetchError::Timeout)?
            .map_err(|_| FetchError::Dns)?;
        Ok(found.map(|a| a.ip()).collect())
    }
}

pub struct ReqwestTransport;

fn install_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

impl Transport for ReqwestTransport {
    async fn get(&self, url: &Url, addrs: &[SocketAddr]) -> Result<Response, FetchError> {
        install_crypto_provider();
        let host = url.host_str().ok_or(FetchError::InvalidUrl)?;
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .no_proxy()
            .timeout(TOTAL_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent("PeachTerm")
            .default_headers({
                let mut h = reqwest::header::HeaderMap::new();
                h.insert(
                    reqwest::header::ACCEPT,
                    reqwest::header::HeaderValue::from_static(
                        "text/markdown, text/plain, text/html;q=0.8",
                    ),
                );
                h
            });
        // Pin the connection to the addresses that were validated: no second DNS lookup.
        if matches!(url.host(), Some(Host::Domain(_))) {
            builder = builder.resolve_to_addrs(host, addrs);
        }
        let client = builder.build().map_err(|_| FetchError::Network)?;
        let mut response = client.get(url.clone()).send().await.map_err(map_error)?;
        let status = response.status().as_u16();
        let header = |name| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let location = header(reqwest::header::LOCATION);
        let content_type = header(reqwest::header::CONTENT_TYPE);
        if response
            .content_length()
            .is_some_and(|n| n > MAX_DOC_BYTES as u64)
        {
            return Err(FetchError::TooLarge);
        }
        let mut body = Vec::new();
        if (200..300).contains(&status) {
            while let Some(chunk) = response.chunk().await.map_err(map_error)? {
                if body.len() + chunk.len() > MAX_DOC_BYTES {
                    return Err(FetchError::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
        }
        Ok(Response {
            status,
            location,
            content_type,
            body,
        })
    }
}

fn map_error(error: reqwest::Error) -> FetchError {
    if error.is_timeout() {
        FetchError::Timeout
    } else {
        FetchError::Network
    }
}

/// Fetch with the real resolver and HTTP client.
pub async fn fetch_system(url: &Url) -> Result<Fetched, FetchError> {
    fetch(&SystemResolver, &ReqwestTransport, url).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn only_public_addresses_pass() {
        for ok in [
            "8.8.8.8",
            "1.1.1.1",
            "140.82.112.3",
            "2606:4700:4700::1111",
            "2a00:1450:4001::1",
        ] {
            assert!(is_public_ip(ip(ok)), "{ok}");
        }
        for bad in [
            "127.0.0.1",
            "127.1.2.3",
            "0.0.0.0",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "224.0.0.1",
            "255.255.255.255",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "198.18.0.1",
            "240.0.0.1",
            "192.0.0.1",
            "0.1.2.3",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:192.168.1.1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::1",
        ] {
            assert!(!is_public_ip(ip(bad)), "{bad}");
        }
    }

    #[test]
    fn urls_must_be_plain_https_on_the_public_web() {
        for ok in [
            "https://example.com/doc.md",
            "https://raw.githubusercontent.com/o/r/main/README.md",
            "https://docs.example.org:443/guide",
            "https://8.8.8.8/x.txt",
        ] {
            assert!(normalize(ok).is_ok(), "{ok}");
        }
        let cases: [(&str, FetchError); 16] = [
            ("http://example.com/a.md", FetchError::NotHttps),
            ("file:///etc/passwd", FetchError::NotHttps),
            ("ftp://example.com/a", FetchError::NotHttps),
            ("javascript:alert(1)", FetchError::NotHttps),
            ("https://example.com:8443/a", FetchError::NotHttps),
            ("https://user:pw@example.com/a", FetchError::InvalidUrl),
            ("https://localhost/a", FetchError::Blocked),
            ("https://127.0.0.1/a", FetchError::Blocked),
            ("https://[::1]/a", FetchError::Blocked),
            ("https://0x7f.1/a", FetchError::Blocked),
            ("https://2130706433/a", FetchError::Blocked),
            ("https://10.1.2.3/a", FetchError::Blocked),
            (
                "https://169.254.169.254/latest/meta-data",
                FetchError::Blocked,
            ),
            ("https://printer.local/a", FetchError::Blocked),
            ("https://intranet/a", FetchError::Blocked),
            ("not a url", FetchError::InvalidUrl),
        ];
        for (input, want) in cases {
            assert_eq!(normalize(input).unwrap_err(), want, "{input}");
        }
        assert!(normalize("").is_err());
        assert!(
            normalize(&format!(
                "https://example.com/{}",
                "a".repeat(MAX_SOURCE_CHARS)
            ))
            .is_err()
        );
        assert!(normalize("https://example.com/a\nb").is_err());
    }

    #[test]
    fn github_file_pages_resolve_to_raw_content_and_nothing_else_is_rewritten() {
        let raw = normalize("https://github.com/example/project/blob/main/README.md").unwrap();
        assert_eq!(
            raw.as_str(),
            "https://raw.githubusercontent.com/example/project/main/README.md"
        );
        let nested = normalize("https://github.com/o/r/blob/v1.2/docs/install/linux.md").unwrap();
        assert_eq!(
            nested.as_str(),
            "https://raw.githubusercontent.com/o/r/v1.2/docs/install/linux.md"
        );
        // already raw, a repository page, an issue: used as given (no scraping, no guessing)
        for same in [
            "https://raw.githubusercontent.com/o/r/main/README.md",
            "https://github.com/o/r",
            "https://github.com/o/r/issues/1",
            "https://github.com/o/r/tree/main/docs",
        ] {
            assert_eq!(normalize(same).unwrap().as_str(), same);
        }
        assert_eq!(format_from_path(&raw), Some(DocFormat::Markdown));
        assert_eq!(
            format_from_path(&Url::parse("https://e.com/a.txt").unwrap()),
            Some(DocFormat::Text)
        );
        assert_eq!(
            format_from_path(&Url::parse("https://e.com/a").unwrap()),
            None
        );
    }

    // ---- fakes ---------------------------------------------------------------

    #[derive(Default)]
    struct Dns {
        /// host -> answers per call (the last one repeats)
        answers: Mutex<HashMap<String, Vec<Vec<IpAddr>>>>,
        calls: Mutex<Vec<String>>,
    }
    impl Dns {
        fn with(mut self, host: &str, rounds: &[&[&str]]) -> Self {
            self.answers.get_mut().unwrap().insert(
                host.into(),
                rounds
                    .iter()
                    .map(|r| r.iter().map(|s| ip(s)).collect())
                    .collect(),
            );
            self
        }
    }
    impl Resolver for Dns {
        async fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, FetchError> {
            self.calls.lock().unwrap().push(host.into());
            let mut map = self.answers.lock().unwrap();
            let rounds = map.get_mut(host).ok_or(FetchError::Dns)?;
            Ok(if rounds.len() > 1 {
                rounds.remove(0)
            } else {
                rounds[0].clone()
            })
        }
    }

    #[derive(Default)]
    struct Web {
        /// url -> response (or error)
        pages: HashMap<String, Result<Response, FetchError>>,
        seen: Mutex<Vec<(String, Vec<SocketAddr>)>>,
    }
    fn page(status: u16, ct: &str, body: &str) -> Result<Response, FetchError> {
        Ok(Response {
            status,
            location: None,
            content_type: Some(ct.into()),
            body: body.as_bytes().to_vec(),
        })
    }
    fn redirect(to: &str) -> Result<Response, FetchError> {
        Ok(Response {
            status: 302,
            location: Some(to.into()),
            content_type: None,
            body: vec![],
        })
    }
    impl Transport for Web {
        async fn get(&self, url: &Url, addrs: &[SocketAddr]) -> Result<Response, FetchError> {
            self.seen
                .lock()
                .unwrap()
                .push((url.to_string(), addrs.to_vec()));
            self.pages
                .get(url.as_str())
                .cloned()
                .unwrap_or(Err(FetchError::Network))
        }
    }
    fn web(pages: &[(&str, Result<Response, FetchError>)]) -> Web {
        Web {
            pages: pages
                .iter()
                .map(|(u, r)| ((*u).into(), r.clone()))
                .collect(),
            seen: Mutex::default(),
        }
    }
    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }
    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn a_normal_document_is_fetched_with_the_connection_pinned_to_the_validated_address() {
        let dns = Dns::default().with("example.com", &[&["93.184.216.34"]]);
        let w = web(&[(
            "https://example.com/README.md",
            page(200, "text/plain; charset=utf-8", "# Hello"),
        )]);
        let got = run(fetch(&dns, &w, &u("https://example.com/README.md"))).unwrap();
        assert_eq!(got.text, "# Hello");
        assert_eq!(got.format, DocFormat::Markdown, "text/plain + .md path");
        let seen = w.seen.lock().unwrap();
        assert_eq!(
            seen[0].1,
            vec!["93.184.216.34:443".parse::<SocketAddr>().unwrap()]
        );
        assert_eq!(
            dns.calls.lock().unwrap().len(),
            1,
            "resolved once, then pinned"
        );
    }

    #[test]
    fn content_types_are_checked() {
        let dns = Dns::default().with("example.com", &[&["93.184.216.34"]]);
        for (ct, path, want) in [
            ("text/markdown", "a", Ok(DocFormat::Markdown)),
            ("text/plain", "a.txt", Ok(DocFormat::Text)),
            ("text/plain", "a", Ok(DocFormat::Text)),
            ("text/html; charset=utf-8", "a.html", Ok(DocFormat::Html)),
            (
                "application/octet-stream",
                "a.md",
                Err(FetchError::UnsupportedType),
            ),
            (
                "application/javascript",
                "a.js",
                Err(FetchError::UnsupportedType),
            ),
            ("image/svg+xml", "a.svg", Err(FetchError::UnsupportedType)),
            ("application/pdf", "a.pdf", Err(FetchError::UnsupportedType)),
        ] {
            let url = format!("https://example.com/{path}");
            let w = web(&[(url.as_str(), page(200, ct, "x"))]);
            let got = run(fetch(&dns, &w, &u(&url))).map(|f| f.format);
            assert_eq!(got, want, "{ct} {path}");
        }
    }

    #[test]
    fn http_errors_timeouts_and_oversized_bodies_are_reported() {
        let dns = Dns::default().with("example.com", &[&["93.184.216.34"]]);
        let w = web(&[
            ("https://example.com/404", page(404, "text/html", "nope")),
            ("https://example.com/500", page(500, "text/plain", "x")),
            ("https://example.com/slow", Err(FetchError::Timeout)),
            ("https://example.com/big", {
                let mut r = page(200, "text/plain", "").unwrap();
                r.body = vec![b'a'; MAX_DOC_BYTES + 1];
                Ok(r)
            }),
        ]);
        let err =
            |p: &str| run(fetch(&dns, &w, &u(&format!("https://example.com/{p}")))).unwrap_err();
        assert_eq!(err("404"), FetchError::Http(404));
        assert_eq!(err("500"), FetchError::Http(500));
        assert_eq!(err("slow"), FetchError::Timeout);
        assert_eq!(err("big"), FetchError::TooLarge);
        assert_eq!(err("missing"), FetchError::Network, "offline / unreachable");
    }

    #[test]
    fn redirects_are_followed_and_every_hop_is_revalidated() {
        let dns = Dns::default()
            .with("example.com", &[&["93.184.216.34"]])
            .with("cdn.example.net", &[&["151.101.1.1"]]);
        let w = web(&[
            (
                "https://example.com/a",
                redirect("https://cdn.example.net/b.md"),
            ),
            (
                "https://cdn.example.net/b.md",
                page(200, "text/markdown", "ok"),
            ),
        ]);
        let got = run(fetch(&dns, &w, &u("https://example.com/a"))).unwrap();
        assert_eq!(got.final_url.as_str(), "https://cdn.example.net/b.md");
        // relative redirects resolve against the current URL
        let w = web(&[
            ("https://example.com/a", redirect("/b.md")),
            ("https://example.com/b.md", page(200, "text/markdown", "ok")),
        ]);
        assert!(run(fetch(&dns, &w, &u("https://example.com/a"))).is_ok());
    }

    #[test]
    fn a_redirect_to_a_local_or_insecure_destination_is_refused() {
        let dns = Dns::default()
            .with("example.com", &[&["93.184.216.34"]])
            .with("evil.example.net", &[&["10.0.0.5"]]);
        for target in [
            "https://127.0.0.1/admin",
            "https://[::1]/",
            "https://169.254.169.254/latest/meta-data/",
            "https://localhost/",
            "https://intranet/",
            "http://example.com/plain",
            "file:///etc/passwd",
            "https://evil.example.net/resolves-to-private",
            "https://example.com:8080/other-port",
        ] {
            let w = web(&[("https://example.com/a", redirect(target))]);
            let err = run(fetch(&dns, &w, &u("https://example.com/a"))).unwrap_err();
            assert!(
                matches!(
                    err,
                    FetchError::Blocked | FetchError::NotHttps | FetchError::InvalidUrl
                ),
                "{target}: {err:?}"
            );
            assert_eq!(
                w.seen.lock().unwrap().len(),
                1,
                "{target}: the second request must never be sent"
            );
        }
    }

    #[test]
    fn dns_rebinding_is_defeated_by_validating_every_answer_and_pinning() {
        // a name that answers public first and private afterwards
        let dns = Dns::default().with("rebind.example.com", &[&["93.184.216.34"], &["127.0.0.1"]]);
        let w = web(&[
            (
                "https://rebind.example.com/a",
                redirect("https://rebind.example.com/b"),
            ),
            (
                "https://rebind.example.com/b",
                page(200, "text/plain", "secret"),
            ),
        ]);
        let err = run(fetch(&dns, &w, &u("https://rebind.example.com/a"))).unwrap_err();
        assert_eq!(err, FetchError::Blocked);
        // a name with ONE private answer among public ones is refused outright
        let dns = Dns::default().with("mixed.example.com", &[&["93.184.216.34", "192.168.1.10"]]);
        let w = web(&[("https://mixed.example.com/a", page(200, "text/plain", "x"))]);
        assert_eq!(
            run(fetch(&dns, &w, &u("https://mixed.example.com/a"))).unwrap_err(),
            FetchError::Blocked
        );
        assert!(w.seen.lock().unwrap().is_empty(), "no request at all");
        // an empty or failing lookup
        let dns = Dns::default().with("empty.example.com", &[&[]]);
        assert_eq!(
            run(fetch(&dns, &w, &u("https://empty.example.com/a"))).unwrap_err(),
            FetchError::Dns
        );
        assert_eq!(
            run(fetch(&dns, &w, &u("https://unknown.example.com/a"))).unwrap_err(),
            FetchError::Dns
        );
    }

    #[test]
    fn redirect_chains_are_bounded() {
        let dns = Dns::default().with("example.com", &[&["93.184.216.34"]]);
        let mut pages = Vec::new();
        for i in 0..10 {
            pages.push((
                format!("https://example.com/{i}"),
                redirect(&format!("/{}", i + 1)),
            ));
        }
        let w = Web {
            pages: pages.into_iter().collect(),
            seen: Mutex::default(),
        };
        assert_eq!(
            run(fetch(&dns, &w, &u("https://example.com/0"))).unwrap_err(),
            FetchError::TooManyRedirects
        );
        assert_eq!(w.seen.lock().unwrap().len(), MAX_REDIRECTS + 1);
        // a loop
        let w = web(&[("https://example.com/loop", redirect("/loop"))]);
        assert_eq!(
            run(fetch(&dns, &w, &u("https://example.com/loop"))).unwrap_err(),
            FetchError::TooManyRedirects
        );
        // a redirect without a target
        let w = web(&[(
            "https://example.com/x",
            Ok(Response {
                status: 302,
                location: None,
                content_type: None,
                body: vec![],
            }),
        )]);
        assert_eq!(
            run(fetch(&dns, &w, &u("https://example.com/x"))).unwrap_err(),
            FetchError::Network
        );
    }

    #[test]
    fn an_ip_literal_is_checked_without_dns_and_never_resolved() {
        let dns = Dns::default();
        let w = web(&[("https://8.8.8.8/a.txt", page(200, "text/plain", "x"))]);
        assert!(run(fetch(&dns, &w, &u("https://8.8.8.8/a.txt"))).is_ok());
        assert!(dns.calls.lock().unwrap().is_empty());
    }

    /// Needs the network, so it is not part of the normal run:
    /// `cargo test -- --ignored real_https_fetch`. Checks the TLS setup, the pinned
    /// connection, redirects and the content-type handling against a real server.
    #[test]
    #[ignore = "needs internet access"]
    fn real_https_fetch_of_a_public_document() {
        let url =
            normalize("https://github.com/endlessnights/peachterm/blob/main/LICENSE").unwrap();
        assert_eq!(url.host_str(), Some("raw.githubusercontent.com"));
        let got = run(fetch_system(&url)).expect("a public file can be fetched");
        assert_eq!(got.format, DocFormat::Text);
        assert!(got.text.contains("Apache License"));
        // a private destination is refused before any connection is made
        assert_eq!(
            run(fetch_system(&u("https://127.0.0.1/"))).unwrap_err(),
            FetchError::Blocked
        );
    }

    #[test]
    fn nothing_but_the_document_is_requested() {
        // the transport receives exactly one URL per hop and the real client is built
        // without cookies, proxies or credentials (see ReqwestTransport::get)
        let src = include_str!("remote.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        for needle in [
            "cookie_store",
            "bearer_auth",
            "basic_auth",
            "danger_accept_invalid",
            "http_proxy",
        ] {
            assert!(!code.contains(needle), "{needle}");
        }
        assert!(code.contains(".https_only(true)"));
        assert!(code.contains("Policy::none()"));
        assert!(code.contains(".no_proxy()"));
    }
}
