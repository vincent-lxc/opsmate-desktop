//! Constrained native cloud transport client (reject-before-transport core).
//!
//! WebView/business IPC may only supply operation id + JSON business fields.
//! Method, origin, URL, headers, Authorization, and Content-Type are Rust-owned.
//! Sole business entry: `invoke_ipc` (always enforces IpcViaRust + Available).

use super::error::TransportError;
use super::operations::{
    from_id, is_callable, is_ipc_callable, spec, Availability, Invocation, Method, OperationSpec,
    BASE_ORIGIN,
};
use super::sanitize::sanitize_response_json;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fmt;

/// Fully built request — never constructed from caller-controlled URL/method/headers.
/// Debug redacts Authorization values and body (may hold passwords).
/// Clone is test-only (mock recording); production avoids cloning secret-bearing requests.
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
            .field(
                "body",
                &self.body.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// Injectable HTTP backend boundary (sync; no new async-trait dependency).
/// Task 6B will provide the production reqwest implementation.
pub trait HttpBackend: Send + Sync {
    fn execute(&self, request: &BuiltRequest) -> Result<String, TransportError>;
}

/// Test double that records call count and last request (test builds only).
#[cfg(test)]
#[derive(Debug)]
pub struct MockHttpBackend {
    request_count: std::sync::atomic::AtomicUsize,
    last_request: std::sync::Mutex<Option<BuiltRequest>>,
    response_body: std::sync::Mutex<String>,
    fail: std::sync::Mutex<bool>,
}

#[cfg(test)]
impl MockHttpBackend {
    pub fn new(response_body: impl Into<String>) -> Self {
        Self {
            request_count: std::sync::atomic::AtomicUsize::new(0),
            last_request: std::sync::Mutex::new(None),
            response_body: std::sync::Mutex::new(response_body.into()),
            fail: std::sync::Mutex::new(false),
        }
    }

    pub fn request_count(&self) -> usize {
        self.request_count
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn last_request(&self) -> Option<BuiltRequest> {
        self.last_request
            .lock()
            .ok()
            .and_then(|g| g.clone())
    }

    pub fn set_response(&self, body: impl Into<String>) {
        if let Ok(mut g) = self.response_body.lock() {
            *g = body.into();
        }
    }

    pub fn set_fail(&self, fail: bool) {
        if let Ok(mut g) = self.fail.lock() {
            *g = fail;
        }
    }
}

#[cfg(test)]
impl HttpBackend for MockHttpBackend {
    fn execute(&self, request: &BuiltRequest) -> Result<String, TransportError> {
        self.request_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut g) = self.last_request.lock() {
            *g = Some(request.clone());
        }
        if self.fail.lock().map(|g| *g).unwrap_or(false) {
            return Err(TransportError::Transport);
        }
        self.response_body
            .lock()
            .map(|g| g.clone())
            .map_err(|_| TransportError::Transport)
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

/// Validate native-owned bearer for authenticated ops.
///
/// Fail closed:
/// - authenticated + missing → Unauthenticated
/// - empty / whitespace-only after trim → Unauthenticated
/// - surrounding whitespace (token not equal to trim) → Unauthenticated
/// - any whitespace or control character inside token → Unauthenticated
/// - unauthenticated ops never receive a bearer (returns None even if provided)
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
    // Reject surrounding whitespace — do not silently accept padded tokens.
    if raw != trimmed {
        return Err(TransportError::Unauthenticated);
    }
    if trimmed
        .chars()
        .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(TransportError::Unauthenticated);
    }
    Ok(Some(trimmed))
}

/// Execute a WebView/business IPC operation.
///
/// Sole public business entry: always requires known operation + Available +
/// IpcViaRust. `business_input` keys are only allowlisted path/query/body fields.
/// `bearer` is native-owned only (not from input).
pub fn invoke_ipc<B: HttpBackend>(
    backend: &B,
    operation_id: &str,
    business_input: &Value,
    bearer: Option<&str>,
) -> Result<Value, TransportError> {
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
    let raw = backend.execute(&built)?;
    let sanitized = sanitize_response_json(&raw).map_err(|_| TransportError::InvalidResponse)?;
    Ok(sanitized)
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

    // Reject forbidden transport-control / secret keys (case-insensitive).
    for key in obj.keys() {
        if is_forbidden_input_key(key) {
            return Err(TransportError::InvalidInput);
        }
        // Fixed body fields are Rust-owned — caller cannot set/override them.
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
        headers.push((
            "Content-Type".to_string(),
            "application/json".to_string(),
        ));
        Some(
            serde_json::to_string(&Value::Object(map))
                .map_err(|_| TransportError::InvalidInput)?,
        )
    } else if matches!(s.method, Method::Post | Method::Put | Method::Patch) {
        headers.push((
            "Content-Type".to_string(),
            "application/json".to_string(),
        ));
        Some("{}".to_string())
    } else {
        None
    };

    // Authorization only for authenticated specs, and only after validation.
    if let Some(token) = bearer {
        headers.push((
            "Authorization".to_string(),
            format!("Bearer {token}"),
        ));
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
