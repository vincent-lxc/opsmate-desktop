//! Rust-only Logto PKCE session (Task 5 + security rework).
//!
//! Security invariants:
//! - Public IPC: `auth_begin_logto`, `auth_session_status`, `auth_logout` only.
//! - Responses never include token / verifier / code / state / subject / tenant / workspace.
//! - IPC errors are fixed public codes only (`map_auth_public`) — never raw HTTP/IdP text.
//! - Deep link: scheme `opsmate`, host `auth`, path `/callback` exactly.
//! - IdP origin is exactly `https://auth.itops.sh` (root path only).
//! - System browser for authorize URL; never Logto inside WebView.
//! - No SPA token sync, no WebView eval bridge, no browser storage of session secrets.
//! - `auth.config` / `auth.exchange` remain native_only (never generic IPC operations).
//! - Pending PKCE has wall-clock expiry with generation-guarded timer cleanup.

mod http;
mod pkce;
mod session;

#[cfg(test)]
mod tests;

pub use http::{AuthHttp, ExchangeRequest, TokioAuthHttp};
pub use pkce::{
    base64url_nopad, generate_code_verifier, generate_state, percent_encode, pkce_s256_challenge,
    RandomSource, SecRandomSource,
};
pub use session::{
    AuthBeginResponse, AuthBinding, AuthStore, NativeAuthSnapshot, NativePrincipal, SessionStatus,
    DEFAULT_PENDING_TIMEOUT,
};

use crate::cloud_transport::BASE_ORIGIN;
use serde::Deserialize;
use session::{NativeSession, PendingPkce};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Url;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Public Logto IdP origin — exact, fixed.
pub const LOGTO_PUBLIC_ENDPOINT: &str = "https://auth.itops.sh";
/// OpsMate API origin (fixed).
pub const API_BASE_URL: &str = BASE_ORIGIN;
pub const LOGTO_CONFIG_URL: &str = "https://app.itops.sh/api/auth/logto/config";
pub const LOGTO_EXCHANGE_URL: &str = "https://app.itops.sh/api/auth/logto/exchange";

/// Exact desktop Logto redirect (backend allowlist + Logto app config).
/// Never register `opsmate://` as the Logto redirect_uri.
pub use crate::cloud_transport::DESKTOP_REDIRECT_URI;

// ─── Errors (no secret-bearing payloads) ─────────────────────────────────────

/// Auth errors never carry raw HTTP bodies, URLs, codes, tokens, or IdP text.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    #[error("auth_random_failed")]
    Random,
    #[error("auth_http_failed")]
    Http,
    #[error("auth_logto_disabled")]
    LogtoDisabled,
    #[error("auth_invalid_config")]
    InvalidConfig,
    #[error("auth_browser_open_failed")]
    BrowserOpen,
    #[error("auth_invalid_callback")]
    InvalidDeepLink,
    #[error("auth_state_mismatch")]
    StateMismatch,
    #[error("auth_state_replay")]
    StateReplay,
    #[error("auth_exchange_failed")]
    Exchange,
    #[error("auth_unauthorized")]
    Unauthorized,
    #[error("auth_invalid_session")]
    InvalidSession,
    #[error("auth_pending_expired")]
    PendingExpired,
    #[error("auth_internal_error")]
    Internal,
}

/// Map internal auth errors to fixed public IPC strings (never `Display` of secret data).
pub fn map_auth_public(e: AuthError) -> String {
    // AuthError Display is already a fixed code; still route explicitly for reviewability.
    match e {
        AuthError::Random => "auth_random_failed".into(),
        AuthError::Http => "auth_http_failed".into(),
        AuthError::LogtoDisabled => "auth_logto_disabled".into(),
        AuthError::InvalidConfig => "auth_invalid_config".into(),
        AuthError::BrowserOpen => "auth_browser_open_failed".into(),
        AuthError::InvalidDeepLink => "auth_invalid_callback".into(),
        AuthError::StateMismatch => "auth_state_mismatch".into(),
        AuthError::StateReplay => "auth_state_replay".into(),
        AuthError::Exchange => "auth_exchange_failed".into(),
        AuthError::Unauthorized => "auth_unauthorized".into(),
        AuthError::InvalidSession => "auth_invalid_session".into(),
        AuthError::PendingExpired => "auth_pending_expired".into(),
        AuthError::Internal => "auth_internal_error".into(),
    }
}

// ─── Injectable adapters ─────────────────────────────────────────────────────

pub trait BrowserOpener: Send + Sync {
    fn open_url(&self, url: &str) -> Result<(), AuthError>;
}

// ─── Config / exchange DTOs ──────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogtoPublicConfig {
    pub enabled: bool,
    pub endpoint: Option<String>,
    pub app_id: Option<String>,
    #[serde(default)]
    pub redirect_uri: Option<String>,
    #[serde(default)]
    pub desktop_redirect_uri: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
}

/// Backend `POST /api/auth/logto/exchange` body (`AuthSessionResponse`).
/// Snake_case: `tenant_id` (required), `must_change_password`, `workspace_id` (nullable), `subject`.
#[derive(Debug, Clone, Deserialize)]
pub struct ExchangeSessionResponse {
    pub token: String,
    pub username: String,
    pub role: String,
    #[serde(default)]
    pub must_change_password: bool,
    /// Required nonempty tenant namespace (Task 4 backend contract).
    pub tenant_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Server-verified Logto subject — never accept client override on request.
    pub subject: String,
}

// ─── Core operations ─────────────────────────────────────────────────────────

/// Exact origin `https://auth.itops.sh` with root path only.
/// After surrounding-whitespace trim, accepts **only** the exact strings
/// `https://auth.itops.sh` and `https://auth.itops.sh/`. Rejects multi-slash
/// (`//`, `///`, …), other hosts, userinfo, **explicit port including :443**,
/// query, fragment, or non-root path (Url's `port()` would hide default :443).
pub fn validate_logto_endpoint(endpoint: &str) -> Result<(), AuthError> {
    let trimmed = endpoint.trim();
    // Exact allowlist only — do not strip repeated trailing slashes.
    let canonical = if trimmed == LOGTO_PUBLIC_ENDPOINT {
        LOGTO_PUBLIC_ENDPOINT
    } else if trimmed.len() == LOGTO_PUBLIC_ENDPOINT.len() + 1
        && trimmed.starts_with(LOGTO_PUBLIC_ENDPOINT)
        && trimmed.ends_with('/')
    {
        LOGTO_PUBLIC_ENDPOINT
    } else {
        return Err(AuthError::InvalidConfig);
    };
    // Defensive parse: must still be a valid absolute HTTPS URL.
    let parsed = Url::parse(canonical).map_err(|_| AuthError::InvalidConfig)?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("auth.itops.sh") {
        return Err(AuthError::InvalidConfig);
    }
    Ok(())
}

/// Build authorize URL always on `https://auth.itops.sh` after validating config endpoint.
pub fn build_authorize_url(
    config: &LogtoPublicConfig,
    state: &str,
    code_challenge: &str,
) -> Result<String, AuthError> {
    if !config.enabled {
        return Err(AuthError::LogtoDisabled);
    }
    let endpoint = config
        .endpoint
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or(AuthError::InvalidConfig)?;
    validate_logto_endpoint(endpoint)?;
    let app_id = config
        .app_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or(AuthError::InvalidConfig)?;

    // Always use the fixed public origin (do not trust path-bearing endpoint strings).
    let base = LOGTO_PUBLIC_ENDPOINT;
    let scopes = if config.scopes.is_empty() {
        "openid profile email".to_string()
    } else {
        config.scopes.join(" ")
    };

    let mut url = format!("{base}/oidc/auth?");
    let params = [
        ("client_id", app_id),
        ("redirect_uri", DESKTOP_REDIRECT_URI),
        ("response_type", "code"),
        ("scope", scopes.as_str()),
        ("state", state),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
    ];
    for (i, (k, v)) in params.iter().enumerate() {
        if i > 0 {
            url.push('&');
        }
        url.push_str(k);
        url.push('=');
        url.push_str(&percent_encode(v));
    }
    Ok(url)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeepLinkParams {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// Strict deep-link parse via `tauri::Url`.
///
/// Requires: scheme=`opsmate`, host=`auth`, path=`/callback` exactly.
/// Allowlisted query keys: `code`, `state`, `error`, `error_description`.
/// `error_description` is accepted for parse but **never** returned.
pub fn parse_deep_link(raw: &str) -> Result<DeepLinkParams, AuthError> {
    let raw = raw.trim();
    if has_malformed_percent(raw) {
        return Err(AuthError::InvalidDeepLink);
    }

    let url = Url::parse(raw).map_err(|_| AuthError::InvalidDeepLink)?;
    if url.scheme() != "opsmate" {
        return Err(AuthError::InvalidDeepLink);
    }
    if url.host_str() != Some("auth") {
        return Err(AuthError::InvalidDeepLink);
    }
    if url.path() != "/callback" {
        return Err(AuthError::InvalidDeepLink);
    }

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut error: Option<String> = None;
    let mut seen_code = false;
    let mut seen_state = false;
    let mut seen_error = false;
    let mut seen_error_description = false;

    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => {
                if seen_code {
                    return Err(AuthError::InvalidDeepLink);
                }
                seen_code = true;
                if v.is_empty() {
                    return Err(AuthError::InvalidDeepLink);
                }
                code = Some(v.into_owned());
            }
            "state" => {
                if seen_state {
                    return Err(AuthError::InvalidDeepLink);
                }
                seen_state = true;
                if v.is_empty() {
                    return Err(AuthError::InvalidDeepLink);
                }
                state = Some(v.into_owned());
            }
            "error" => {
                if seen_error {
                    return Err(AuthError::InvalidDeepLink);
                }
                seen_error = true;
                if v.is_empty() {
                    return Err(AuthError::InvalidDeepLink);
                }
                error = Some(v.into_owned());
            }
            "error_description" => {
                if seen_error_description {
                    return Err(AuthError::InvalidDeepLink);
                }
                seen_error_description = true;
                // Intentionally drop value.
            }
            _ => return Err(AuthError::InvalidDeepLink),
        }
    }

    if code.is_some() && error.is_some() {
        return Err(AuthError::InvalidDeepLink);
    }

    Ok(DeepLinkParams { code, state, error })
}

fn has_malformed_percent(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if i + 2 >= b.len() {
                return true;
            }
            let hi = b[i + 1] as char;
            let lo = b[i + 2] as char;
            if hi.to_digit(16).is_none() || lo.to_digit(16).is_none() {
                return true;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    false
}

fn nonempty(s: &str) -> bool {
    !s.trim().is_empty()
}

/// Reject blank subject/tenant/token/username/role before install.
pub fn validate_exchange_session(session: &ExchangeSessionResponse) -> Result<(), AuthError> {
    if !nonempty(&session.token)
        || !nonempty(&session.username)
        || !nonempty(&session.role)
        || !nonempty(&session.subject)
        || !nonempty(&session.tenant_id)
    {
        return Err(AuthError::InvalidSession);
    }
    Ok(())
}

/// Start Logto login (borrowed store). Does **not** arm a wall-clock thread;
/// use `perform_begin_logto_arc` in production so the timer holds the live store.
pub fn perform_begin_logto<R: RandomSource, H: AuthHttp, O: BrowserOpener>(
    store: &AuthStore,
    rng: &R,
    http: &H,
    opener: &O,
) -> Result<AuthBeginResponse, AuthError> {
    perform_begin_logto_with_timeout(
        store,
        rng,
        http,
        opener,
        DEFAULT_PENDING_TIMEOUT,
        Instant::now(),
    )
}

/// Testable begin with explicit timeout and clock (no background thread).
pub fn perform_begin_logto_with_timeout<R: RandomSource, H: AuthHttp, O: BrowserOpener>(
    store: &AuthStore,
    rng: &R,
    http: &H,
    opener: &O,
    timeout: Duration,
    now: Instant,
) -> Result<AuthBeginResponse, AuthError> {
    {
        let mut mem = store.inner.lock().map_err(|_| AuthError::Internal)?;
        mem.pending = None;
        mem.reauth_required = false;
    }

    let code_verifier = Zeroizing::new(generate_code_verifier(rng)?);
    let state = Zeroizing::new(generate_state(rng)?);
    let challenge = pkce_s256_challenge(code_verifier.as_str());

    let _generation = store.install_pending(
        Zeroizing::new(state.as_str().to_string()),
        Zeroizing::new(code_verifier.as_str().to_string()),
        timeout,
        now,
    )?;

    let result = (|| {
        let raw = http.get_text(LOGTO_CONFIG_URL)?;
        let config: LogtoPublicConfig =
            serde_json::from_str(&raw).map_err(|_| AuthError::InvalidConfig)?;
        let auth_url = build_authorize_url(&config, state.as_str(), &challenge)?;
        opener.open_url(&auth_url)?;
        Ok(AuthBeginResponse { started: true })
    })();

    if result.is_err() {
        let _ = store.clear_pending();
    }
    result
}

/// Begin login using a shared `Arc<AuthStore>` and arm a wall-clock timer that
/// clears only this pending generation after `timeout`.
pub fn perform_begin_logto_arc<R: RandomSource, H: AuthHttp, O: BrowserOpener>(
    store: Arc<AuthStore>,
    rng: &R,
    http: &H,
    opener: &O,
) -> Result<AuthBeginResponse, AuthError> {
    perform_begin_logto_arc_with_timeout(
        store,
        rng,
        http,
        opener,
        DEFAULT_PENDING_TIMEOUT,
        Instant::now(),
        true,
    )
}

pub fn perform_begin_logto_arc_with_timeout<R: RandomSource, H: AuthHttp, O: BrowserOpener>(
    store: Arc<AuthStore>,
    rng: &R,
    http: &H,
    opener: &O,
    timeout: Duration,
    now: Instant,
    arm_timer: bool,
) -> Result<AuthBeginResponse, AuthError> {
    {
        let mut mem = store.inner.lock().map_err(|_| AuthError::Internal)?;
        mem.pending = None;
        mem.reauth_required = false;
    }

    let code_verifier = Zeroizing::new(generate_code_verifier(rng)?);
    let state = Zeroizing::new(generate_state(rng)?);
    let challenge = pkce_s256_challenge(code_verifier.as_str());

    let generation = store.install_pending(
        Zeroizing::new(state.as_str().to_string()),
        Zeroizing::new(code_verifier.as_str().to_string()),
        timeout,
        now,
    )?;

    let result = (|| {
        let raw = http.get_text(LOGTO_CONFIG_URL)?;
        let config: LogtoPublicConfig =
            serde_json::from_str(&raw).map_err(|_| AuthError::InvalidConfig)?;
        let auth_url = build_authorize_url(&config, state.as_str(), &challenge)?;
        opener.open_url(&auth_url)?;
        Ok(AuthBeginResponse { started: true })
    })();

    if result.is_err() {
        let _ = store.clear_pending();
        return result;
    }

    if arm_timer {
        AuthStore::arm_pending_timeout(store, generation, timeout);
    }

    result
}

/// Handle `opsmate://auth/callback` after system-browser Logto redirect.
/// Token + subject/tenant/workspace stay native-only.
pub fn perform_handle_deep_link<H: AuthHttp>(
    store: &AuthStore,
    http: &H,
    deep_link_url: &str,
) -> Result<(), AuthError> {
    perform_handle_deep_link_at(store, http, deep_link_url, Instant::now())
}

pub fn perform_handle_deep_link_at<H: AuthHttp>(
    store: &AuthStore,
    http: &H,
    deep_link_url: &str,
    now: Instant,
) -> Result<(), AuthError> {
    // Wall-clock expiry before processing.
    if store.expire_due_pending(now) {
        // Continue; may still get StateMismatch if no pending.
    }

    let params = parse_deep_link(deep_link_url)?;

    if let Some(_err) = params.error {
        let incoming_state = match params.state {
            Some(s) if !s.is_empty() => s,
            _ => return Err(AuthError::StateMismatch),
        };
        let mut mem = store.inner.lock().map_err(|_| AuthError::Internal)?;
        if mem.used_states.contains(&incoming_state) {
            return Err(AuthError::StateReplay);
        }
        match mem.pending.as_ref() {
            Some(p) if p.state.as_str() == incoming_state => {
                if now >= p.expires_at {
                    mem.pending = None;
                    return Err(AuthError::PendingExpired);
                }
                mem.pending = None;
                mem.used_states.insert(incoming_state);
                // OAuth error with matching state: clear pending; fixed public code only.
                return Err(AuthError::Exchange);
            }
            Some(_) | None => {
                // Preserve pending on wrong-state / external error.
                return Err(AuthError::StateMismatch);
            }
        }
    }

    let code = params.code.ok_or(AuthError::InvalidDeepLink)?;
    let incoming_state = params.state.ok_or(AuthError::StateMismatch)?;

    let code_verifier = {
        let mut mem = store.inner.lock().map_err(|_| AuthError::Internal)?;
        if mem.used_states.contains(&incoming_state) {
            return Err(AuthError::StateReplay);
        }
        let mut pending = mem.pending.take().ok_or(AuthError::StateMismatch)?;
        if now >= pending.expires_at {
            return Err(AuthError::PendingExpired);
        }
        if pending.state.as_str() != incoming_state {
            // Restore pending so a wrong-state callback cannot cancel login.
            mem.pending = Some(pending);
            return Err(AuthError::StateMismatch);
        }
        mem.used_states.insert(incoming_state.clone());
        // Move the Zeroizing wrapper out without cloning secret text. PendingPkce
        // implements Drop so fields cannot be partially moved; mem::take leaves an
        // empty Zeroizing behind for Drop to wipe, while we own the original.
        std::mem::take(&mut pending.code_verifier)
    };

    let req = ExchangeRequest {
        code: Zeroizing::new(code),
        code_verifier,
        redirect_uri: DESKTOP_REDIRECT_URI,
    };

    let raw = match http.post_exchange(LOGTO_EXCHANGE_URL, &req) {
        Ok(r) => r,
        Err(e) => {
            // req (incl. verifier) drops here and zeroizes.
            return Err(e);
        }
    };
    // Drop exchange request (zeroizes code + verifier) before parsing response.
    drop(req);

    let session: ExchangeSessionResponse =
        serde_json::from_str(&raw).map_err(|_| AuthError::Exchange)?;

    // Destructure so token moves into Zeroizing without an intermediate clone.
    let ExchangeSessionResponse {
        token,
        username,
        role,
        must_change_password,
        tenant_id,
        workspace_id,
        subject,
    } = session;

    if !nonempty(&token)
        || !nonempty(&username)
        || !nonempty(&role)
        || !nonempty(&subject)
        || !nonempty(&tenant_id)
    {
        let mut tok = token;
        tok.zeroize();
        return Err(AuthError::InvalidSession);
    }

    {
        let mut mem = store.inner.lock().map_err(|_| AuthError::Internal)?;
        mem.session = Some(NativeSession {
            token: Zeroizing::new(token),
            username,
            role,
            must_change_password,
            subject,
            tenant_id,
            workspace_id,
        });
        mem.reauth_required = false;
        AuthStore::bump_epoch_locked(&mut mem);
    }
    Ok(())
}

/// Fail-closed logout: clear native pending + session.
pub fn perform_logout(store: &AuthStore) -> Result<(), AuthError> {
    let mut mem = store.inner.lock().map_err(|_| AuthError::Internal)?;
    AuthStore::clear_native_locked(&mut mem);
    mem.reauth_required = false;
    Ok(())
}

pub fn perform_session_status(store: &AuthStore) -> Result<SessionStatus, AuthError> {
    let mem = store.inner.lock().map_err(|_| AuthError::Internal)?;
    match &mem.session {
        Some(s) if AuthStore::principal_from_session(s).is_some() => Ok(SessionStatus {
            authenticated: true,
            username: Some(s.username.clone()),
            role: Some(s.role.clone()),
            reauth_required: mem.reauth_required,
        }),
        // Invalid principal: never report authenticated.
        Some(_) | None => Ok(SessionStatus {
            authenticated: false,
            username: None,
            role: None,
            reauth_required: mem.reauth_required,
        }),
    }
}

/// Mark reauth required and clear session (used by future 401 path; not a public IPC).
pub fn mark_reauth_required(store: &AuthStore) -> Result<(), AuthError> {
    let mut mem = store.inner.lock().map_err(|_| AuthError::Internal)?;
    AuthStore::clear_native_locked(&mut mem);
    mem.reauth_required = true;
    Ok(())
}

// Silence unused PendingPkce import warning when only used via session module re-exports.
#[allow(dead_code)]
fn _pending_type_link(_: &PendingPkce) {}
