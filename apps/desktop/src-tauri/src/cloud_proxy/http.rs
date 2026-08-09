//! Production HTTPS backend (reqwest + rustls) for fixed-origin cloud proxy.

use super::error::ProxyError;
use std::fmt;
use std::future::Future;
use std::time::Duration;

/// Fixed public API origin — never caller-controlled.
pub const BASE_ORIGIN: &str = "https://app.itops.sh";

/// Maximum accepted response body size (2 MiB) for successful 2xx responses.
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// Maximum accepted request body size (1 MiB).
pub const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Fully built request — never constructed from caller-controlled origin/headers.
#[cfg_attr(test, derive(Clone))]
pub struct BuiltRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl fmt::Debug for BuiltRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let headers: Vec<(&str, &str)> = self
            .headers
            .iter()
            .map(|(k, v)| {
                if k.eq_ignore_ascii_case("Authorization") {
                    (k.as_str(), "<redacted>")
                } else {
                    (k.as_str(), v.as_str())
                }
            })
            .collect();
        f.debug_struct("BuiltRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &headers)
            .field("body", &self.body.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Debug)]
pub struct BackendResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub trait HttpBackend: Send + Sync {
    fn execute(
        &self,
        request: BuiltRequest,
    ) -> impl Future<Output = Result<BackendResponse, ProxyError>> + Send;
}

pub(super) fn should_read_response_body(status: u16) -> bool {
    // Read limited bodies for 2xx and non-401 errors so clients get status+sanitized JSON.
    // Skip no-content and 401 (cutoff path; body never returned to WebView).
    if status == 204 || status == 304 || status == 401 {
        return false;
    }
    true
}

pub struct ReqwestBackend {
    client: reqwest::Client,
}

impl ReqwestBackend {
    pub fn new() -> Result<Self, ProxyError> {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| ProxyError::Transport)?;
        Ok(Self { client })
    }
}

impl HttpBackend for ReqwestBackend {
    fn execute(
        &self,
        request: BuiltRequest,
    ) -> impl Future<Output = Result<BackendResponse, ProxyError>> + Send {
        let client = self.client.clone();
        async move {
            validate_fixed_origin_url(&request.url)?;

            let method = request.method.to_ascii_uppercase();
            let mut builder = match method.as_str() {
                "GET" => client.get(&request.url),
                "POST" => client.post(&request.url),
                "PUT" => client.put(&request.url),
                "PATCH" => client.patch(&request.url),
                "DELETE" => client.delete(&request.url),
                _ => return Err(ProxyError::InvalidInput),
            };

            for (name, value) in request.headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = request.body {
                builder = builder.body(body);
            }

            let response = builder.send().await.map_err(|_| ProxyError::Transport)?;

            validate_fixed_origin_url(response.url().as_str())?;

            let status = response.status().as_u16();
            if !should_read_response_body(status) {
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

pub fn validate_fixed_origin_url(url: &str) -> Result<(), ProxyError> {
    if !url.starts_with(BASE_ORIGIN) {
        return Err(ProxyError::PathSmuggling);
    }
    if url.contains('#') {
        return Err(ProxyError::PathSmuggling);
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| ProxyError::PathSmuggling)?;
    if parsed.fragment().is_some() {
        return Err(ProxyError::PathSmuggling);
    }
    if parsed.scheme() != "https" {
        return Err(ProxyError::PathSmuggling);
    }
    if parsed.host_str() != Some("app.itops.sh") {
        return Err(ProxyError::PathSmuggling);
    }
    if parsed.port().is_some() {
        return Err(ProxyError::PathSmuggling);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ProxyError::PathSmuggling);
    }
    let path = parsed.path();
    if !path.starts_with("/api/") {
        return Err(ProxyError::PathSmuggling);
    }
    let rest = &url[BASE_ORIGIN.len()..];
    if rest.is_empty() || !rest.starts_with('/') {
        return Err(ProxyError::PathSmuggling);
    }
    Ok(())
}

pub fn check_content_length(content_length: Option<u64>, max: usize) -> Result<(), ProxyError> {
    if let Some(len) = content_length {
        if len > max as u64 {
            return Err(ProxyError::ResponseTooLarge);
        }
    }
    Ok(())
}

pub async fn read_body_limited(
    mut response: reqwest::Response,
    max: usize,
) -> Result<Vec<u8>, ProxyError> {
    check_content_length(response.content_length(), max)?;
    let mut buf = Vec::new();
    loop {
        let chunk = response.chunk().await.map_err(|_| ProxyError::Transport)?;
        let Some(bytes) = chunk else {
            break;
        };
        if buf.len().saturating_add(bytes.len()) > max {
            return Err(ProxyError::ResponseTooLarge);
        }
        buf.extend_from_slice(&bytes);
    }
    Ok(buf)
}

#[cfg(test)]
pub fn accumulate_chunks_limited(
    chunks: impl IntoIterator<Item = Vec<u8>>,
    max: usize,
) -> Result<Vec<u8>, ProxyError> {
    let mut buf = Vec::new();
    for chunk in chunks {
        if buf.len().saturating_add(chunk.len()) > max {
            return Err(ProxyError::ResponseTooLarge);
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

// ─── Test mock backend ───────────────────────────────────────────────────────

#[cfg(test)]
#[derive(Debug, Default)]
struct MockState {
    request_started: std::sync::atomic::AtomicUsize,
    last_request: std::sync::Mutex<Option<BuiltRequest>>,
    response_body: std::sync::Mutex<Vec<u8>>,
    status: std::sync::atomic::AtomicU16,
    hang: std::sync::atomic::AtomicBool,
    delay_ms: std::sync::atomic::AtomicU64,
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub struct MockHttpBackend {
    state: std::sync::Arc<MockState>,
}

#[cfg(test)]
impl MockHttpBackend {
    pub fn new(response_body: impl Into<String>) -> Self {
        let state = std::sync::Arc::new(MockState {
            response_body: std::sync::Mutex::new(response_body.into().into_bytes()),
            status: std::sync::atomic::AtomicU16::new(200),
            ..MockState::default()
        });
        Self { state }
    }

    pub fn request_count(&self) -> usize {
        self.state
            .request_started
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn last_request(&self) -> Option<BuiltRequest> {
        self.state.last_request.lock().ok().and_then(|g| g.clone())
    }

    pub fn set_status(&self, status: u16) {
        self.state
            .status
            .store(status, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn set_hang(&self, hang: bool) {
        self.state
            .hang
            .store(hang, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn set_delay_ms(&self, ms: u64) {
        self.state
            .delay_ms
            .store(ms, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
impl HttpBackend for MockHttpBackend {
    fn execute(
        &self,
        request: BuiltRequest,
    ) -> impl Future<Output = Result<BackendResponse, ProxyError>> + Send {
        let state = std::sync::Arc::clone(&self.state);
        state
            .request_started
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // Revalidate planned URL like production.
        let url_check = validate_fixed_origin_url(&request.url);
        if let Ok(mut g) = state.last_request.lock() {
            *g = Some(request);
        }
        let status = state.status.load(std::sync::atomic::Ordering::SeqCst);
        let hang = state.hang.load(std::sync::atomic::Ordering::SeqCst);
        let delay_ms = state.delay_ms.load(std::sync::atomic::Ordering::SeqCst);
        let body = state
            .response_body
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        async move {
            url_check?;
            if hang {
                std::future::pending::<()>().await;
            }
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            if !should_read_response_body(status) {
                return Ok(BackendResponse {
                    status,
                    body: vec![],
                });
            }
            if body.len() > MAX_RESPONSE_BYTES {
                return Err(ProxyError::ResponseTooLarge);
            }
            Ok(BackendResponse { status, body })
        }
    }
}
