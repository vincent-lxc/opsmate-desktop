//! Constrained native cloud transport client.
//!
//! WebView/business IPC may only supply operation id + JSON business fields.
//! Method, origin, URL, headers, Authorization, and Content-Type are Rust-owned.
//! Sole business entry: `CloudTransport::invoke_ipc` (async; Available + IpcViaRust).
//!
//! Production path moves `BuiltRequest` into the backend (no bearer/body Clone).

use super::error::TransportError;
use super::lifecycle::{InvalidationControl, SessionLifecycleHooks};
use super::operations::{
    from_id, is_callable, is_ipc_callable, spec, Availability, Invocation, Method, OperationSpec,
    BASE_ORIGIN,
};
use super::sanitize::sanitize_response_json;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::future::Future;
use std::sync::Arc;

/// Fully built request — never constructed from caller-controlled URL/method/headers.
/// Debug redacts Authorization values and body (may hold passwords).
/// Clone is test-only (mock recording); production moves the request into the backend.
#[cfg_attr(test, derive(Clone))]
pub struct BuiltRequest {
    pub method: Method,
    pub url: String,
    /// Only Rust-owned headers (Content-Type, Authorization).
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

/// Structured backend response (status + raw body bytes). Never logged.
#[derive(Debug)]
pub struct BackendResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Injectable async HTTP backend (RPITIT; no async-trait dependency).
/// Production takes ownership of `BuiltRequest` (no secret Clone).
pub trait HttpBackend: Send + Sync {
    fn execute(
        &self,
        request: BuiltRequest,
    ) -> impl Future<Output = Result<BackendResponse, TransportError>> + Send;
}

/// Async cloud transport: planner + backend + cancellation + 401 lifecycle.
///
/// Production requires explicit `SessionLifecycleHooks` — no silent no-op default
/// that would drop 401 security cleanup on the floor.
pub struct CloudTransport<B, H> {
    backend: B,
    hooks: H,
    control: Arc<InvalidationControl>,
}

impl<B: HttpBackend, H: SessionLifecycleHooks> CloudTransport<B, H> {
    pub fn new(backend: B, hooks: H) -> Self {
        Self {
            backend,
            hooks,
            control: Arc::new(InvalidationControl::new()),
        }
    }

    pub fn control(&self) -> &InvalidationControl {
        &self.control
    }

    pub fn cancel_inflight(&self) {
        self.control.cancel_inflight();
    }

    pub fn cancel_auth_epoch(&self, auth_epoch: u64) {
        self.control.cancel_auth_epoch(auth_epoch);
    }

    /// Execute a WebView/business IPC operation (async).
    ///
    /// Reject paths never call the backend. In-flight work races **auth-epoch**
    /// cancellation. 401 runs lifecycle once for `auth_epoch` (conditional clear).
    ///
    /// `auth_epoch` is the `NativeAuthSnapshot::epoch` captured before the call
    /// (None only for unauthenticated ops). Never from WebView input.
    pub async fn invoke_ipc(
        &self,
        operation_id: &str,
        business_input: &Value,
        bearer: Option<&str>,
        auth_epoch: Option<u64>,
    ) -> Result<Value, TransportError> {
        let wait = self.control.waiter_token(auth_epoch);
        if self.control.is_cancelled_token(&wait) {
            return Err(Self::map_cancel_error(&self.control, &wait, auth_epoch));
        }

        let op = from_id(operation_id).ok_or(TransportError::UnknownOperation)?;
        let s = spec(op);

        require_available(s.availability)?;
        if !is_callable(op) {
            return Err(TransportError::NotAvailable);
        }

        require_ipc_invocation(s.invocation)?;
        if !is_ipc_callable(op) {
            return Err(match s.invocation {
                Invocation::NativeOnly => TransportError::NativeOnly,
                Invocation::IpcViaRust => TransportError::InvalidInvocation,
            });
        }

        let built = build_request(&s, business_input, bearer)?;

        if self.control.is_cancelled_token(&wait) {
            return Err(Self::map_cancel_error(&self.control, &wait, auth_epoch));
        }

        // Prefer a completed backend response over cancel when both are ready so
        // concurrent 401s still observe status=401 and run lifecycle dedupe.
        // Cancel still wins when the backend future is pending (hang / network).
        let result = tokio::select! {
            res = self.backend.execute(built) => res,
            _ = self.control.cancelled_token(wait) => {
                Err(TransportError::Cancelled)
            }
        };

        let response = match result {
            Ok(r) => r,
            Err(TransportError::Cancelled) => {
                return Err(Self::map_cancel_error(&self.control, &wait, auth_epoch));
            }
            Err(e) => return Err(e),
        };

        // 401 must run epoch lifecycle even if a peer already cancelled this epoch
        // (otherwise concurrent 401s would surface as Cancelled and skip dedupe/clear).
        if response.status == 401 {
            return self.handle_backend_response(response, auth_epoch);
        }

        if self.control.is_cancelled_token(&wait) {
            return Err(Self::map_cancel_error(&self.control, &wait, auth_epoch));
        }

        self.handle_backend_response(response, auth_epoch)
    }

    /// Map cancel to `session_invalidated` when peer 401 covered this auth epoch.
    fn map_cancel_error(
        control: &super::lifecycle::InvalidationControl,
        wait: &super::lifecycle::CancelWaitToken,
        auth_epoch: Option<u64>,
    ) -> TransportError {
        if control.global_cancel_generation() != wait.start_global {
            return TransportError::Cancelled;
        }
        if let Some(e) = auth_epoch {
            if control.cancelled_through() >= e {
                return TransportError::SessionInvalidated;
            }
        }
        TransportError::Cancelled
    }

    fn handle_backend_response(
        &self,
        response: BackendResponse,
        auth_epoch: Option<u64>,
    ) -> Result<Value, TransportError> {
        if response.status == 401 {
            if let Some(epoch) = auth_epoch {
                self.control.run_401_for_auth_epoch(epoch, &self.hooks);
            }
            return Err(TransportError::SessionInvalidated);
        }
        if !(200..300).contains(&response.status) {
            return Err(TransportError::HttpStatus);
        }
        let raw =
            std::str::from_utf8(&response.body).map_err(|_| TransportError::InvalidResponse)?;
        let sanitized = sanitize_response_json(raw).map_err(|_| TransportError::InvalidResponse)?;
        Ok(sanitized)
    }
}

/// Test-only convenience: no-op lifecycle hooks (never for production 401 path).
#[cfg(test)]
impl<B: HttpBackend> CloudTransport<B, super::lifecycle::NoopLifecycleHooks> {
    pub fn with_backend(backend: B) -> Self {
        Self::new(backend, super::lifecycle::NoopLifecycleHooks)
    }
}

// ─── Test mock backend ───────────────────────────────────────────────────────

/// Shared counters/state for async mock (Arc so futures can complete independently).
#[cfg(test)]
#[derive(Debug, Default)]
struct MockState {
    request_started: std::sync::atomic::AtomicUsize,
    request_completed: std::sync::atomic::AtomicUsize,
    last_request: std::sync::Mutex<Option<BuiltRequest>>,
    response_body: std::sync::Mutex<Vec<u8>>,
    status: std::sync::atomic::AtomicU16,
    hang: std::sync::atomic::AtomicBool,
    delay_ms: std::sync::atomic::AtomicU64,
    fail: std::sync::atomic::AtomicBool,
}

/// Test double: async, optional hang/delay/status, completion counter.
#[cfg(test)]
#[derive(Debug, Clone)]
pub struct MockHttpBackend {
    state: Arc<MockState>,
}

#[cfg(test)]
impl MockHttpBackend {
    pub fn new(response_body: impl Into<String>) -> Self {
        let state = Arc::new(MockState {
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

    /// Outbound completions (not incremented if cancelled while hanging).
    pub fn completed_count(&self) -> usize {
        self.state
            .request_completed
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn last_request(&self) -> Option<BuiltRequest> {
        self.state.last_request.lock().ok().and_then(|g| g.clone())
    }

    pub fn set_response(&self, body: impl Into<String>) {
        if let Ok(mut g) = self.state.response_body.lock() {
            *g = body.into().into_bytes();
        }
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

    pub fn set_fail(&self, fail: bool) {
        self.state
            .fail
            .store(fail, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
impl HttpBackend for MockHttpBackend {
    fn execute(
        &self,
        request: BuiltRequest,
    ) -> impl Future<Output = Result<BackendResponse, TransportError>> + Send {
        let state = Arc::clone(&self.state);
        state
            .request_started
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut g) = state.last_request.lock() {
            *g = Some(request);
        }
        let status = state.status.load(std::sync::atomic::Ordering::SeqCst);
        let hang = state.hang.load(std::sync::atomic::Ordering::SeqCst);
        let delay_ms = state.delay_ms.load(std::sync::atomic::Ordering::SeqCst);
        let fail = state.fail.load(std::sync::atomic::Ordering::SeqCst);
        let body = state
            .response_body
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        async move {
            if hang {
                std::future::pending::<()>().await;
            }
            if delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
            if fail {
                return Err(TransportError::Transport);
            }
            state
                .request_completed
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(BackendResponse { status, body })
        }
    }
}

/// Keys that must never appear in caller business input (transport control / secrets).
const FORBIDDEN_INPUT_KEYS: &[&str] = &[
    "method",
    "url",
    "uri",
    "origin",
    "host",
    "headers",
    "header",
    "authorization",
    "bearer",
    "token",
    "access_token",
    "refresh_token",
    "content-type",
    "content_type",
    "contenttype",
];

/// Fail-closed availability gate (unit-testable without a blocked catalog entry).
pub fn require_available(availability: Availability) -> Result<(), TransportError> {
    match availability {
        Availability::Available => Ok(()),
        Availability::BlockedPendingTenantIsolation => Err(TransportError::NotAvailable),
    }
}

/// Fail-closed invocation gate for WebView-requested business calls.
pub fn require_ipc_invocation(invocation: Invocation) -> Result<(), TransportError> {
    match invocation {
        Invocation::IpcViaRust => Ok(()),
        Invocation::NativeOnly => Err(TransportError::NativeOnly),
    }
}

fn validate_native_bearer(
    bearer: Option<&str>,
    authenticated: bool,
) -> Result<Option<&str>, TransportError> {
    if !authenticated {
        return Ok(None);
    }
    let Some(raw) = bearer else {
        return Err(TransportError::Unauthenticated);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(TransportError::Unauthenticated);
    }
    if raw != trimmed {
        return Err(TransportError::Unauthenticated);
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(TransportError::Unauthenticated);
    }
    Ok(Some(trimmed))
}

/// Build a fully constrained request or fail before any transport call.
pub fn build_request(
    s: &OperationSpec,
    business_input: &Value,
    bearer: Option<&str>,
) -> Result<BuiltRequest, TransportError> {
    let bearer = validate_native_bearer(bearer, s.authenticated)?;

    let obj = match business_input {
        Value::Object(m) => m,
        Value::Null => {
            return build_request(s, &Value::Object(Map::new()), bearer);
        }
        _ => return Err(TransportError::InvalidInput),
    };

    for key in obj.keys() {
        if is_forbidden_input_key(key) {
            return Err(TransportError::InvalidInput);
        }
        for (fixed_key, _) in s.fixed_body_fields {
            if key == fixed_key || key.eq_ignore_ascii_case(fixed_key) {
                return Err(TransportError::InvalidInput);
            }
        }
    }

    let mut path_values: BTreeMap<String, String> = BTreeMap::new();
    let mut query_values: BTreeMap<String, String> = BTreeMap::new();
    let mut body_values: BTreeMap<String, Value> = BTreeMap::new();

    for (key, value) in obj {
        let as_str = |v: &Value| -> Result<String, TransportError> {
            match v {
                Value::String(s) => Ok(s.clone()),
                Value::Number(n) => Ok(n.to_string()),
                Value::Bool(b) => Ok(b.to_string()),
                Value::Null => Err(TransportError::InvalidInput),
                _ => Err(TransportError::InvalidInput),
            }
        };

        if s.path_params.iter().any(|p| *p == key) {
            if path_values.contains_key(key) {
                return Err(TransportError::InvalidInput);
            }
            let raw = as_str(value)?;
            validate_path_param_value(&raw)?;
            path_values.insert(key.clone(), raw);
        } else if s.query_fields.iter().any(|q| *q == key) {
            if query_values.contains_key(key) {
                return Err(TransportError::InvalidInput);
            }
            let raw = as_str(value)?;
            validate_query_value(&raw)?;
            query_values.insert(key.clone(), raw);
        } else if s.body_fields.iter().any(|b| *b == key) {
            if body_values.contains_key(key) {
                return Err(TransportError::InvalidInput);
            }
            body_values.insert(key.clone(), value.clone());
        } else {
            return Err(TransportError::InvalidInput);
        }
    }

    for p in s.path_params {
        if !path_values.contains_key(*p) {
            return Err(TransportError::InvalidInput);
        }
    }

    let path = materialize_path(s.path, &path_values)?;
    if !path.starts_with("/api/") || path.contains("://") {
        return Err(TransportError::PathSmuggling);
    }

    let mut url = String::with_capacity(BASE_ORIGIN.len() + path.len() + 32);
    url.push_str(BASE_ORIGIN);
    url.push_str(&path);

    if !query_values.is_empty() {
        url.push('?');
        let mut first = true;
        for (k, v) in &query_values {
            if !first {
                url.push('&');
            }
            first = false;
            url.push_str(&percent_encode_component(k));
            url.push('=');
            url.push_str(&percent_encode_component(v));
        }
    }

    let mut headers: Vec<(String, String)> = Vec::new();
    let body = if !s.body_fields.is_empty() || !s.fixed_body_fields.is_empty() {
        let mut map = Map::new();
        for (k, v) in &body_values {
            map.insert(k.clone(), v.clone());
        }
        for (k, v) in s.fixed_body_fields {
            map.insert((*k).to_string(), Value::String((*v).to_string()));
        }
        headers.push(("Content-Type".to_string(), "application/json".to_string()));
        Some(serde_json::to_string(&Value::Object(map)).map_err(|_| TransportError::InvalidInput)?)
    } else if matches!(s.method, Method::Post | Method::Put | Method::Patch) {
        headers.push(("Content-Type".to_string(), "application/json".to_string()));
        Some("{}".to_string())
    } else {
        None
    };

    if let Some(token) = bearer {
        headers.push(("Authorization".to_string(), format!("Bearer {token}")));
    }

    if !url.starts_with(BASE_ORIGIN) {
        return Err(TransportError::PathSmuggling);
    }

    Ok(BuiltRequest {
        method: s.method,
        url,
        headers,
        body,
    })
}

fn is_forbidden_input_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    FORBIDDEN_INPUT_KEYS
        .iter()
        .any(|f| *f == lower.as_str() || f.replace('_', "-") == lower)
}

/// Reject raw / encoded traversal and control characters in path parameter values.
pub fn validate_path_param_value(raw: &str) -> Result<(), TransportError> {
    if raw.is_empty() {
        return Err(TransportError::InvalidInput);
    }
    if raw.chars().any(|c| c.is_control() || c == '\0') {
        return Err(TransportError::PathSmuggling);
    }
    if raw.contains('/')
        || raw.contains('\\')
        || raw.contains('?')
        || raw.contains('#')
        || raw.contains("..")
    {
        return Err(TransportError::PathSmuggling);
    }
    if raw == "." {
        return Err(TransportError::PathSmuggling);
    }
    if contains_encoded_smuggle(raw) {
        return Err(TransportError::PathSmuggling);
    }
    if raw.contains('%') {
        let decoded = percent_decode_lenient(raw);
        if decoded.contains('/')
            || decoded.contains('\\')
            || decoded.contains('?')
            || decoded.contains('#')
            || decoded.contains("..")
            || decoded == "."
            || decoded.chars().any(|c| c.is_control())
            || contains_encoded_smuggle(&decoded)
        {
            return Err(TransportError::PathSmuggling);
        }
    }
    Ok(())
}

fn validate_query_value(raw: &str) -> Result<(), TransportError> {
    if raw.chars().any(|c| c.is_control() || c == '\0') {
        return Err(TransportError::InvalidInput);
    }
    if contains_encoded_smuggle(raw)
        && (raw.to_ascii_lowercase().contains("%2f")
            || raw.to_ascii_lowercase().contains("%5c")
            || raw.contains(".."))
        && (raw.contains("..") || raw.to_ascii_lowercase().contains("%2e%2e"))
    {
        return Err(TransportError::PathSmuggling);
    }
    Ok(())
}

fn contains_encoded_smuggle(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    const PATS: &[&str] = &[
        "%2e", "%2f", "%5c", "%00", "%3f", "%23", "%252e", "%252f", "%255c",
    ];
    PATS.iter().any(|p| lower.contains(p))
}

fn percent_decode_lenient(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h1 = from_hex(bytes[i + 1]);
            let h2 = from_hex(bytes[i + 2]);
            if let (Some(a), Some(b)) = (h1, h2) {
                out.push((a << 4) | b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn materialize_path(
    template: &str,
    values: &BTreeMap<String, String>,
) -> Result<String, TransportError> {
    let mut out = String::with_capacity(template.len() + 16);
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let (head, after) = rest.split_at(start);
        out.push_str(head);
        let after = &after[1..];
        let end = after.find('}').ok_or(TransportError::InvalidInput)?;
        let name = &after[..end];
        let value = values.get(name).ok_or(TransportError::InvalidInput)?;
        out.push_str(&percent_encode_component(value));
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    if out.contains('{') || out.contains('}') || out.contains('\\') {
        return Err(TransportError::PathSmuggling);
    }
    if out.split('/').any(|seg| seg == ".." || seg == ".") {
        return Err(TransportError::PathSmuggling);
    }
    Ok(out)
}

/// RFC 3986 percent-encode for path/query components (encode all but unreserved).
pub fn percent_encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                out.push(HEX[(b >> 4) as usize] as char);
                out.push(HEX[(b & 0xf) as usize] as char);
            }
        }
    }
    out
}
