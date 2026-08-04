//! Production HTTPS backend (reqwest + rustls).
//!
//! - Fixed origin `https://app.itops.sh` only; revalidated immediately before send
//!   and against the final response URL. Fragments rejected.
//! - Redirects disabled; bounded connect/request timeouts.
//! - Only 2xx responses buffer a size-limited body; 401/4xx/5xx/redirects return
//!   empty body so oversized error payloads cannot become `response_too_large`
//!   and bypass session invalidation.
//! - Never logs request secrets or response bodies.
//! - No cookies, no generic URL API, no WebView token.

use super::client::{BackendResponse, BuiltRequest, HttpBackend};
use super::error::TransportError;
use super::operations::{Method, BASE_ORIGIN};
use std::time::Duration;

/// Maximum accepted response body size (2 MiB) for successful 2xx responses.
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// Connect timeout for production cloud calls.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Overall request timeout for production cloud calls.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Whether the backend should read/buffer the HTTP response body.
///
/// Only 2xx success responses are buffered (with size cap). All other statuses
/// — including 401 — return an empty body so a malicious oversize payload
/// cannot convert invalidation into `response_too_large`.
///
/// Crate-internal policy (not a public crate re-export).
pub(super) fn should_read_response_body(status: u16) -> bool {
    (200..300).contains(&status)
}

/// Reqwest-backed HTTPS client (rustls). Construct once; share across calls.
pub struct ReqwestBackend {
    client: reqwest::Client,
}

impl ReqwestBackend {
    pub fn new() -> Result<Self, TransportError> {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| TransportError::Transport)?;
        Ok(Self { client })
    }
}

impl HttpBackend for ReqwestBackend {
    fn execute(
        &self,
        request: BuiltRequest,
    ) -> impl std::future::Future<Output = Result<BackendResponse, TransportError>> + Send {
        let client = self.client.clone();
        async move {
            // Revalidate planned URL before any network I/O.
            validate_fixed_origin_url(&request.url)?;

            let mut builder = match request.method {
                Method::Get => client.get(&request.url),
                Method::Post => client.post(&request.url),
                Method::Put => client.put(&request.url),
                Method::Patch => client.patch(&request.url),
                Method::Delete => client.delete(&request.url),
            };

            // Headers are Rust-owned only (Content-Type / Authorization).
            for (name, value) in request.headers {
                builder = builder.header(name, value);
            }

            // Move body — no clone of password-bearing JSON.
            if let Some(body) = request.body {
                builder = builder.body(body);
            }

            let response = builder
                .send()
                .await
                .map_err(|_| TransportError::Transport)?;

            // Revalidate final URL (redirects disabled; still fail closed).
            validate_fixed_origin_url(response.url().as_str())?;

            let status = response.status().as_u16();
            if !should_read_response_body(status) {
                // Do not buffer error / redirect bodies (incl. oversize 401).
                drop(response);
                return Ok(BackendResponse {
                    status,
                    body: vec![],
                });
            }

            let body = read_body_limited(response, MAX_RESPONSE_BYTES).await?;
            Ok(BackendResponse { status, body })
        }
    }
}

/// Exact origin/path guard for planned and final request URLs.
pub fn validate_fixed_origin_url(url: &str) -> Result<(), TransportError> {
    if !url.starts_with(BASE_ORIGIN) {
        return Err(TransportError::PathSmuggling);
    }
    // Reject fragments (raw or parsed) — not part of allowlisted transport surface.
    if url.contains('#') {
        return Err(TransportError::PathSmuggling);
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| TransportError::PathSmuggling)?;
    if parsed.fragment().is_some() {
        return Err(TransportError::PathSmuggling);
    }
    if parsed.scheme() != "https" {
        return Err(TransportError::PathSmuggling);
    }
    if parsed.host_str() != Some("app.itops.sh") {
        return Err(TransportError::PathSmuggling);
    }
    // Reject explicit ports (including :443) — only default HTTPS.
    if parsed.port().is_some() {
        return Err(TransportError::PathSmuggling);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(TransportError::PathSmuggling);
    }
    let path = parsed.path();
    if !path.starts_with("/api/") {
        return Err(TransportError::PathSmuggling);
    }
    // Remainder after BASE_ORIGIN must be path/query only (no alternate host).
    let rest = &url[BASE_ORIGIN.len()..];
    if rest.is_empty() || !rest.starts_with('/') {
        return Err(TransportError::PathSmuggling);
    }
    Ok(())
}

/// Reject oversize Content-Length before reading.
///
/// Compare as `u64` only: never cast attacker-controlled Content-Length to
/// `usize` before comparison (truncation on narrow platforms could accept
/// `u64::MAX` as a small length).
pub fn check_content_length(content_length: Option<u64>, max: usize) -> Result<(), TransportError> {
    if let Some(len) = content_length {
        let max_u64 = max as u64; // widening: always safe
        if len > max_u64 {
            return Err(TransportError::ResponseTooLarge);
        }
    }
    Ok(())
}

/// Accumulate body chunks with a hard cap (works for chunked / unknown length).
pub async fn read_body_limited(
    mut response: reqwest::Response,
    max: usize,
) -> Result<Vec<u8>, TransportError> {
    check_content_length(response.content_length(), max)?;

    let mut buf = Vec::new();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|_| TransportError::Transport)?;
        let Some(bytes) = chunk else {
            break;
        };
        if buf.len().saturating_add(bytes.len()) > max {
            return Err(TransportError::ResponseTooLarge);
        }
        buf.extend_from_slice(&bytes);
    }
    Ok(buf)
}

/// Pure helper for tests: enforce size while folding chunks (no network).
pub fn accumulate_chunks_limited(
    chunks: impl IntoIterator<Item = Vec<u8>>,
    max: usize,
) -> Result<Vec<u8>, TransportError> {
    let mut buf = Vec::new();
    for chunk in chunks {
        if buf.len().saturating_add(chunk.len()) > max {
            return Err(TransportError::ResponseTooLarge);
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}
