//! Fixed-origin native HTTP broker for the Admin UI.
//!
//! - Route allowlist from generated `routes` (Task 2).
//! - Rust owns Authorization bearer, origin, method validation, caps, 401 cutoff.
//! - WebView only supplies `CloudRequest` path/method/body/locale — never tokens/URLs.

pub mod error;
pub mod http;
pub mod routes;
pub mod sanitize;
pub mod terminal_ai_redact;
pub mod ws_token;

#[cfg(test)]
mod tests;

use crate::auth::AuthStore;
use crate::security_cutoff::{run_session_invalidation_cutoff, SecurityActions};
pub use error::ProxyError;
use http::{
    validate_fixed_origin_url, BackendResponse, BuiltRequest, HttpBackend, BASE_ORIGIN,
    MAX_REQUEST_BODY_BYTES,
};
use routes::match_request;
use sanitize::sanitize_response_json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::watch;
use zeroize::Zeroizing;

/// WebView-facing cloud request envelope (deny unknown fields).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub locale: Option<String>,
}

impl fmt::Debug for CloudRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CloudRequest")
            .field("method", &self.method)
            .field("path", &self.path)
            .field("body", &self.body.as_ref().map(|_| "<redacted>"))
            .field("locale", &self.locale)
            .finish()
    }
}

/// Secret-free public response — no upstream headers/URLs.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudResponse {
    pub status: u16,
    pub body: Option<Value>,
}

/// Cancellation control for in-flight cloud requests (auth-epoch watermark).
pub struct InvalidationControl {
    cancel_tx: watch::Sender<u64>,
    cancelled_through: AtomicU64,
    global_cancel_gen: AtomicU64,
}

impl Default for InvalidationControl {
    fn default() -> Self {
        Self::new()
    }
}

impl InvalidationControl {
    pub fn new() -> Self {
        let (cancel_tx, _rx) = watch::channel(1u64);
        Self {
            cancel_tx,
            cancelled_through: AtomicU64::new(0),
            global_cancel_gen: AtomicU64::new(0),
        }
    }

    /// Cancel all in-flight requests (logout / global abort).
    /// Public for future logout wiring; exercised by transport cancellation tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn cancel_inflight(&self) {
        self.global_cancel_gen.fetch_add(1, Ordering::SeqCst);
        self.cancel_tx.send_modify(|g| *g = g.wrapping_add(1));
    }

    pub fn cancel_auth_epoch(&self, auth_epoch: u64) {
        self.cancelled_through
            .fetch_max(auth_epoch, Ordering::SeqCst);
        self.cancel_tx.send_modify(|g| *g = g.wrapping_add(1));
    }

    fn waiter_token(&self, auth_epoch: u64) -> CancelWaitToken {
        CancelWaitToken {
            auth_epoch,
            start_global: self.global_cancel_gen.load(Ordering::SeqCst),
        }
    }

    fn is_cancelled(&self, token: &CancelWaitToken) -> bool {
        if self.global_cancel_gen.load(Ordering::SeqCst) != token.start_global {
            return true;
        }
        self.cancelled_through.load(Ordering::SeqCst) >= token.auth_epoch
    }

    async fn cancelled(&self, token: CancelWaitToken) {
        let mut rx = self.cancel_tx.subscribe();
        loop {
            if self.is_cancelled(&token) {
                return;
            }
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct CancelWaitToken {
    auth_epoch: u64,
    start_global: u64,
}

/// Async cloud proxy: route allowlist + fixed origin + bearer + 401 cutoff.
pub struct CloudProxy<B, H> {
    backend: B,
    auth: Arc<AuthStore>,
    hooks: H,
    control: Arc<InvalidationControl>,
}

impl<B: HttpBackend, H: SecurityActions> CloudProxy<B, H> {
    pub fn new(backend: B, auth: Arc<AuthStore>, hooks: H) -> Self {
        Self {
            backend,
            auth,
            hooks,
            control: Arc::new(InvalidationControl::new()),
        }
    }

    /// Abort all in-flight cloud requests (e.g. before logout).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn cancel_inflight(&self) {
        self.control.cancel_inflight();
    }

    /// Execute an allowlisted cloud API request.
    ///
    /// Rejects unauthenticated callers before transport. Revalidates auth epoch
    /// after the backend await before returning a success response.
    pub async fn call(&self, req: CloudRequest) -> Result<CloudResponse, ProxyError> {
        let response = self.execute_allowlisted(&req).await?;

        // 2xx and non-401 errors: return status + sanitized body (never raw upstream secrets).
        // 401 already handled above as session_invalidated cutoff.
        let body = if response.body.is_empty() {
            None
        } else {
            let raw = match std::str::from_utf8(&response.body) {
                Ok(s) => s,
                Err(_) if !(200..300).contains(&response.status) => {
                    // Drop non-UTF8 error bodies; keep status for client mapping.
                    return Ok(CloudResponse {
                        status: response.status,
                        body: None,
                    });
                }
                Err(_) => return Err(ProxyError::InvalidResponse),
            };
            match sanitize_response_json(raw) {
                Ok(v) => Some(v),
                Err(_) if !(200..300).contains(&response.status) => None,
                Err(_) => return Err(ProxyError::InvalidResponse),
            }
        };

        Ok(CloudResponse {
            status: response.status,
            body,
        })
    }

    /// Short-lived WSS token via fixed-origin allowlisted broker.
    ///
    /// Uses the same auth / 401 cutoff / epoch revalidation as [`Self::call`].
    /// Response bytes are moved into [`Zeroizing`] and parsed as a typed native
    /// body (no `serde_json::Value`); the token `String` is moved into
    /// `Zeroizing<String>` without clone. 403 matches 401 cutoff semantics.
    pub async fn fetch_ws_token(&self) -> Result<Zeroizing<String>, ProxyError> {
        let req = CloudRequest {
            method: "POST".into(),
            path: "/api/auth/ws-token".into(),
            body: None,
            locale: None,
        };
        let response = self.execute_allowlisted(&req).await?;
        if response.status == 403 {
            if let Some(snap) = self.auth.native_auth_snapshot() {
                self.control.cancel_auth_epoch(snap.epoch);
            }
            run_session_invalidation_cutoff(&self.hooks);
            return Err(ProxyError::SessionInvalidated);
        }
        if !(200..300).contains(&response.status) {
            return Err(ProxyError::Transport);
        }
        // Move ordinary Vec body into Zeroizing immediately (no lingering plaintext buffer).
        let body = Zeroizing::new(response.body);
        ws_token::parse_ws_token_body(body)
    }

    /// Shared allowlisted transport: route check, Zeroizing bearer, 401 cutoff, epoch revalidation.
    async fn execute_allowlisted(&self, req: &CloudRequest) -> Result<BackendResponse, ProxyError> {
        if !match_request(&req.method, &req.path) {
            return Err(ProxyError::RouteNotAllowed);
        }

        let snap = self
            .auth
            .native_auth_snapshot()
            .ok_or(ProxyError::Unauthenticated)?;
        let epoch = snap.epoch;
        let principal = snap.principal.clone();
        let bearer = snap.bearer;

        let wait = self.control.waiter_token(epoch);
        if self.control.is_cancelled(&wait) {
            return Err(ProxyError::Cancelled);
        }

        let built = build_outbound_request(req, bearer.as_str())?;

        if self.control.is_cancelled(&wait) {
            return Err(ProxyError::Cancelled);
        }

        let result = tokio::select! {
            res = self.backend.execute(built) => res,
            _ = self.control.cancelled(wait) => Err(ProxyError::Cancelled),
        };

        let response = match result {
            Ok(r) => r,
            Err(ProxyError::Cancelled) => {
                if self.control.cancelled_through.load(Ordering::SeqCst) >= epoch {
                    return Err(ProxyError::SessionInvalidated);
                }
                return Err(ProxyError::Cancelled);
            }
            Err(e) => return Err(e),
        };

        if response.status == 401 {
            self.control.cancel_auth_epoch(epoch);
            run_session_invalidation_cutoff(&self.hooks);
            return Err(ProxyError::SessionInvalidated);
        }

        if !self.auth.session_binding_current(&principal, epoch) {
            return Err(ProxyError::SessionInvalidated);
        }

        if self.control.is_cancelled(&wait) {
            if self.control.cancelled_through.load(Ordering::SeqCst) >= epoch {
                return Err(ProxyError::SessionInvalidated);
            }
            return Err(ProxyError::Cancelled);
        }

        Ok(response)
    }
}

fn build_outbound_request(req: &CloudRequest, bearer: &str) -> Result<BuiltRequest, ProxyError> {
    if !req.path.starts_with('/') {
        return Err(ProxyError::PathSmuggling);
    }
    let url = format!("{BASE_ORIGIN}{}", req.path);
    validate_fixed_origin_url(&url)?;

    let method = req.method.to_ascii_uppercase();
    let mut headers = vec![
        ("Authorization".to_string(), format!("Bearer {bearer}")),
        ("Accept".to_string(), "application/json".to_string()),
    ];

    if let Some(locale) = req.locale.as_deref() {
        let locale = sanitize_locale(locale).ok_or(ProxyError::InvalidInput)?;
        headers.push(("Accept-Language".to_string(), locale));
    }

    let body = match &req.body {
        None => None,
        Some(v) => {
            // Terminal AI: copy + redact secrets and cap terminal_output (never mutate UI).
            let payload = if terminal_ai_redact::is_terminal_ai_path(&method, &req.path) {
                terminal_ai_redact::redact_terminal_ai_request_body(v)?
            } else {
                v.clone()
            };
            let s = serde_json::to_string(&payload).map_err(|_| ProxyError::InvalidInput)?;
            if s.len() > MAX_REQUEST_BODY_BYTES {
                return Err(ProxyError::RequestTooLarge);
            }
            headers.push(("Content-Type".to_string(), "application/json".to_string()));
            Some(s)
        }
    };

    Ok(BuiltRequest {
        method,
        url,
        headers,
        body,
    })
}

fn sanitize_locale(locale: &str) -> Option<String> {
    if locale.is_empty() || locale.len() > 64 {
        return None;
    }
    if !locale.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || b == b'-'
            || b == b'_'
            || b == b','
            || b == b' '
            || b == b';'
            || b == b'='
    }) {
        return None;
    }
    Some(locale.to_string())
}

/// Map proxy errors to fixed public IPC strings.
pub fn map_proxy_public(err: ProxyError) -> String {
    err.public_code().to_string()
}
