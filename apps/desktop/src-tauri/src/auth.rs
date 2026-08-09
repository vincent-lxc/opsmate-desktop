//! Desktop Logto PKCE auth (Task D2 + Task 4 native-only session).
//!
//! Security invariants:
//! - Public IPC commands: `auth_begin_logto`, `auth_logout`, `auth_session_status`,
//!   `auth_on_unauthorized` — response structs never include token/state/codeVerifier.
//! - Deep link: scheme `opsmate`, host `auth`, path `/callback` exactly (via `tauri::Url`).
//! - Verifier/state zeroized; stack RNG buffers zeroized after use.
//! - Bearer, subject, tenant_id, workspace_id stay native-only (never WebView IPC/localStorage).
//! - WebView receives only secret-free `AuthSessionStatus` via IPC / `opsmate:auth-session`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::Url;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Exact desktop Logto redirect (backend allowlist + Logto app config).
pub const DESKTOP_REDIRECT_URI: &str = "https://app.itops.sh/login/desktop/callback";
/// OpsMate API origin for desktop privilege UI.
pub const API_BASE_URL: &str = "https://app.itops.sh";
pub const LOGTO_CONFIG_URL: &str = "https://app.itops.sh/api/auth/logto/config";
pub const LOGTO_EXCHANGE_URL: &str = "https://app.itops.sh/api/auth/logto/exchange";

/// Fixed Tauri event for secret-free session status (payload: `AuthSessionStatus` only).
pub const AUTH_SESSION_EVENT: &str = "opsmate:auth-session";

// ─── Errors ───────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("random source failed")]
    Random,
    #[error("http error: {0}")]
    Http(String),
    #[error("logto not enabled")]
    LogtoDisabled,
    #[error("invalid logto config")]
    InvalidConfig,
    #[error("browser open failed: {0}")]
    BrowserOpen(String),
    #[error("invalid deep link")]
    InvalidDeepLink,
    #[error("state missing or mismatched")]
    StateMismatch,
    #[error("state replay rejected")]
    StateReplay,
    /// Exchange failed. String is a short public/oauth code only — never upstream body.
    #[error("exchange failed: {0}")]
    Exchange(String),
    #[error("invalid session")]
    InvalidSession,
    #[error("session expired or unauthorized")]
    Unauthorized,
    #[error("internal: {0}")]
    Internal(String),
}

/// Fixed public codes for IPC / logs — never free-form HTTP bodies, tokens, or URLs.
pub fn map_auth_public(err: AuthError) -> &'static str {
    match err {
        AuthError::Random => "random",
        AuthError::Http(_) => "transport",
        AuthError::LogtoDisabled => "logto_disabled",
        AuthError::InvalidConfig => "invalid_config",
        AuthError::BrowserOpen(_) => "browser_open",
        AuthError::InvalidDeepLink => "invalid_deep_link",
        AuthError::StateMismatch => "state_mismatch",
        AuthError::StateReplay => "state_replay",
        AuthError::Exchange(_) => "exchange",
        AuthError::InvalidSession => "invalid_session",
        AuthError::Unauthorized => "unauthorized",
        AuthError::Internal(_) => "internal",
    }
}

// ─── Injectable adapters ─────────────────────────────────────────────────────

pub trait RandomSource: Send + Sync {
    fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), AuthError>;
}

pub trait AuthHttp: Send + Sync {
    fn get_text(&self, url: &str) -> Result<String, AuthError>;
    fn post_json(&self, url: &str, body: &Value) -> Result<String, AuthError>;
}

pub trait BrowserOpener: Send + Sync {
    fn open_url(&self, url: &str) -> Result<(), AuthError>;
}

// ─── Production random (macOS Security.framework) ─────────────────────────────

#[derive(Debug, Default, Clone, Copy)]
pub struct SecRandomSource;

#[cfg(target_os = "macos")]
impl RandomSource for SecRandomSource {
    fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), AuthError> {
        #[link(name = "Security", kind = "framework")]
        extern "C" {
            fn SecRandomCopyBytes(
                rnd: *const std::ffi::c_void,
                count: usize,
                bytes: *mut u8,
            ) -> i32;
        }
        let rc = unsafe { SecRandomCopyBytes(std::ptr::null(), dest.len(), dest.as_mut_ptr()) };
        if rc == 0 {
            Ok(())
        } else {
            Err(AuthError::Random)
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl RandomSource for SecRandomSource {
    fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), AuthError> {
        dest.fill(0);
        Err(AuthError::Random)
    }
}

// ─── PKCE helpers ────────────────────────────────────────────────────────────

const B64URL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn base64url_nopad(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        out.push(B64URL[((n >> 18) & 63) as usize] as char);
        out.push(B64URL[((n >> 12) & 63) as usize] as char);
        out.push(B64URL[((n >> 6) & 63) as usize] as char);
        out.push(B64URL[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = data.len() - i;
    if rem == 1 {
        let n = (data[i] as u32) << 16;
        out.push(B64URL[((n >> 18) & 63) as usize] as char);
        out.push(B64URL[((n >> 12) & 63) as usize] as char);
    } else if rem == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        out.push(B64URL[((n >> 18) & 63) as usize] as char);
        out.push(B64URL[((n >> 12) & 63) as usize] as char);
        out.push(B64URL[((n >> 6) & 63) as usize] as char);
    }
    out
}

pub fn pkce_s256_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    base64url_nopad(&digest)
}

pub fn generate_code_verifier<R: RandomSource>(rng: &R) -> Result<String, AuthError> {
    let mut buf = [0u8; 32];
    rng.fill_bytes(&mut buf)?;
    let out = base64url_nopad(&buf);
    buf.zeroize();
    Ok(out)
}

pub fn generate_state<R: RandomSource>(rng: &R) -> Result<String, AuthError> {
    let mut buf = [0u8; 16];
    rng.fill_bytes(&mut buf)?;
    let out = base64url_nopad(&buf);
    buf.zeroize();
    Ok(out)
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

/// Real backend `POST /api/auth/logto/exchange` session body (Logto desktop).
/// Field names are **snake_case**: `tenant_id`, `must_change_password`, `subject`,
/// optional `workspace_id`. Request body still uses camelCase `codeVerifier`/`redirectUri`.
#[derive(Debug, Clone, Deserialize)]
pub struct ExchangeSessionResponse {
    pub token: String,
    pub username: String,
    pub role: String,
    #[serde(default)]
    pub must_change_password: bool,
    /// Backend-verified tenant namespace (required nonempty after validation).
    #[serde(default)]
    pub tenant_id: Option<String>,
    /// Backend-verified Logto subject (required nonempty; never WebView-visible).
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

// ─── IPC-safe response types (no secrets) ────────────────────────────────────

/// Only public field allowed from `auth_begin_logto` / reauth begin.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthBeginResponse {
    pub started: bool,
}

/// Session status never includes token / verifier / state / subject / tenant / workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionStatus {
    pub authenticated: bool,
    pub username: Option<String>,
    pub role: Option<String>,
    pub must_change_password: bool,
    pub expires_at_unix: Option<u64>,
    pub reauth_required: bool,
}

/// Internal native principal for vault/SSH binding (never includes token).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativePrincipal {
    pub tenant_id: String,
    /// Display/local username (not used for Stronghold namespace).
    pub user_id: String,
    /// Server-verified Logto subject — vault namespace component (never WebView IPC).
    pub subject: String,
}

/// Crate-internal atomic auth view: principal + bearer + session epoch from one lock.
/// Not Clone / Serialize. Debug redacts bearer and identity fields.
pub struct NativeAuthSnapshot {
    pub principal: NativePrincipal,
    pub bearer: Zeroizing<String>,
    pub epoch: u64,
}

impl std::fmt::Debug for NativeAuthSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeAuthSnapshot")
            .field("principal", &"<redacted>")
            .field("bearer", &"<redacted>")
            .field("epoch", &"<redacted>")
            .finish()
    }
}

// ─── In-memory zeroized session store ────────────────────────────────────────

#[derive(Debug)]
struct PendingPkce {
    state: String,
    code_verifier: String,
}

impl Drop for PendingPkce {
    fn drop(&mut self) {
        self.state.zeroize();
        self.code_verifier.zeroize();
    }
}

#[derive(Debug)]
struct NativeSession {
    token: String,
    username: String,
    role: String,
    must_change_password: bool,
    expires_at_unix: Option<u64>,
    /// Required nonempty after exchange validation.
    tenant_id: String,
    /// Required nonempty backend-verified subject.
    subject: String,
    /// Nullable workspace; never serialized to WebView.
    #[allow(dead_code)]
    workspace_id: Option<String>,
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

fn nonempty(s: &str) -> bool {
    !s.trim().is_empty()
}

#[derive(Debug, Default)]
struct AuthMemory {
    pending: Option<PendingPkce>,
    session: Option<NativeSession>,
    used_states: HashSet<String>,
    reauth_required: bool,
    /// Monotonic session generation; bumps on every install/clear/exchange.
    session_epoch: u64,
}

#[derive(Debug, Default)]
pub struct AuthStore {
    inner: Mutex<AuthMemory>,
}

impl AuthStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AuthMemory::default()),
        }
    }

    fn bump_epoch_locked(mem: &mut AuthMemory) {
        mem.session_epoch = mem.session_epoch.wrapping_add(1);
    }

    fn clear_native_locked(mem: &mut AuthMemory) {
        mem.pending = None;
        mem.session = None;
        Self::bump_epoch_locked(mem);
    }

    /// Fail-closed native wipe (pending + session).
    pub fn clear_native(&self) -> Result<(), AuthError> {
        let mut mem = self
            .inner
            .lock()
            .map_err(|e| AuthError::Internal(e.to_string()))?;
        Self::clear_native_locked(&mut mem);
        Ok(())
    }

    /// Internal accessor: tenant_id + username only. Never returns token.
    /// Returns `None` when unauthenticated or tenant_id is missing/empty.
    pub fn native_principal(&self) -> Option<NativePrincipal> {
        let mem = self.inner.lock().ok()?;
        Self::principal_from_session(mem.session.as_ref()?)
    }

    fn principal_from_session(s: &NativeSession) -> Option<NativePrincipal> {
        let tenant_id = s.tenant_id.trim();
        let subject = s.subject.trim();
        if tenant_id.is_empty() || subject.is_empty() || s.username.trim().is_empty() {
            return None;
        }
        if s.token.trim().is_empty() {
            return None;
        }
        Some(NativePrincipal {
            tenant_id: tenant_id.to_string(),
            user_id: s.username.clone(),
            subject: subject.to_string(),
        })
    }

    /// One mutex acquisition: principal + Zeroizing bearer + epoch from the same session.
    pub(crate) fn native_auth_snapshot(&self) -> Option<NativeAuthSnapshot> {
        let mem = self.inner.lock().ok()?;
        let s = mem.session.as_ref()?;
        let principal = Self::principal_from_session(s)?;
        let token = s.token.trim();
        if token.is_empty() {
            return None;
        }
        Some(NativeAuthSnapshot {
            principal,
            bearer: Zeroizing::new(token.to_string()),
            epoch: mem.session_epoch,
        })
    }

    /// D4B-style revalidation: current session must match bound principal + epoch exactly.
    /// Does not accept WebView input; reads only AuthStore. Logout+relogin (same tenant/user)
    /// advances epoch and fails. Does not require bearer-bearing snapshot.
    pub(crate) fn session_binding_current(&self, principal: &NativePrincipal, epoch: u64) -> bool {
        let Ok(mem) = self.inner.lock() else {
            return false;
        };
        if mem.session_epoch != epoch {
            return false;
        }
        let Some(s) = mem.session.as_ref() else {
            return false;
        };
        let Some(p) = Self::principal_from_session(s) else {
            return false;
        };
        p == *principal
    }

    /// True iff current native session is still exactly the snapshot (epoch + principal).
    /// Logout+relogin same tenant/user fails because epoch advances.
    pub(crate) fn snapshot_still_current(&self, snap: &NativeAuthSnapshot) -> bool {
        self.session_binding_current(&snap.principal, snap.epoch)
    }

    /// Install a principal-bearing native session for unit tests (no WebView surface).
    #[cfg(test)]
    pub fn install_session_for_tests(
        &self,
        tenant_id: impl Into<String>,
        username: impl Into<String>,
        role: impl Into<String>,
    ) {
        let username = username.into();
        let mut mem = self.inner.lock().expect("auth store lock");
        mem.session = Some(NativeSession {
            token: "test-token-not-for-ipc".into(),
            username: username.clone(),
            role: role.into(),
            must_change_password: false,
            expires_at_unix: None,
            tenant_id: tenant_id.into(),
            subject: format!("sub:{username}"),
            workspace_id: None,
        });
        mem.reauth_required = false;
        Self::bump_epoch_locked(&mut mem);
    }
}

// ─── Core auth operations ────────────────────────────────────────────────────

/// Require absolute HTTPS Logto endpoint before opening a browser.
pub fn validate_logto_endpoint(endpoint: &str) -> Result<(), AuthError> {
    let parsed = Url::parse(endpoint).map_err(|_| AuthError::InvalidConfig)?;
    if parsed.scheme() != "https" {
        return Err(AuthError::InvalidConfig);
    }
    if parsed.host_str().map(|h| h.is_empty()).unwrap_or(true) {
        return Err(AuthError::InvalidConfig);
    }
    Ok(())
}

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

    let base = endpoint.trim_end_matches('/');
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

pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeepLinkParams {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// Strict deep-link parse via `tauri::Url` (url crate re-export; no extra dep).
///
/// Requires: scheme=`opsmate`, host=`auth`, path=`/callback` exactly.
/// Allowlisted query keys only: `code`, `state`, `error`, `error_description`.
/// `error_description` is accepted for parse but **never** returned/surfaced.
/// Rejects: callbackevil path, wrong host/scheme, duplicates, ambiguous
/// code+error, unknown keys, malformed percent-encoding, empty values.
pub fn parse_deep_link(raw: &str) -> Result<DeepLinkParams, AuthError> {
    let raw = raw.trim();
    // Reject unescaped malformed % sequences before Url soft-handles them.
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
    // Path must be exactly /callback (reject /callbackevil, /callback/, etc.)
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
                // Allowed key (OAuth), but never stored or forwarded to callers.
                if seen_error_description {
                    return Err(AuthError::InvalidDeepLink);
                }
                seen_error_description = true;
                // Intentionally drop value.
            }
            _ => {
                // Reject unexpected security-relevant / unknown query keys.
                return Err(AuthError::InvalidDeepLink);
            }
        }
    }

    // Ambiguous success+error
    if code.is_some() && error.is_some() {
        return Err(AuthError::InvalidDeepLink);
    }

    Ok(DeepLinkParams { code, state, error })
}

/// Sanitize OAuth `error` code for Exchange errors — never forward free-form
/// attacker-controlled strings or `error_description`.
fn sanitize_oauth_error_code(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return "oauth_error".into();
    }
    if trimmed
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    {
        trimmed.to_string()
    } else {
        "oauth_error".into()
    }
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

/// Start Logto login: generate PKCE, store secrets natively, open system browser.
/// On config/build/open failure, pending is cleared (fail-closed).
pub fn perform_begin_logto<R: RandomSource, H: AuthHttp, O: BrowserOpener>(
    store: &AuthStore,
    rng: &R,
    http: &H,
    opener: &O,
) -> Result<AuthBeginResponse, AuthError> {
    let code_verifier = generate_code_verifier(rng)?;
    let state = generate_state(rng)?;
    let challenge = pkce_s256_challenge(&code_verifier);

    {
        let mut mem = store
            .inner
            .lock()
            .map_err(|e| AuthError::Internal(e.to_string()))?;
        mem.pending = Some(PendingPkce {
            state: state.clone(),
            code_verifier,
        });
        mem.reauth_required = false;
    }

    let result = (|| {
        let raw = http.get_text(LOGTO_CONFIG_URL)?;
        let config: LogtoPublicConfig =
            serde_json::from_str(&raw).map_err(|e| AuthError::Http(e.to_string()))?;
        let auth_url = build_authorize_url(&config, &state, &challenge)?;
        opener.open_url(&auth_url)?;
        Ok(AuthBeginResponse { started: true })
    })();

    let mut state_local = state;
    state_local.zeroize();

    if result.is_err() {
        // Fail-closed: drop pending PKCE secrets if config/build/open fails.
        if let Ok(mut mem) = store.inner.lock() {
            mem.pending = None;
        }
    }
    result
}

/// Handle `opsmate://auth/callback` after system-browser Logto redirect.
/// Token + subject/tenant/workspace stay native-only (no WebView write).
pub fn perform_handle_deep_link<H: AuthHttp>(
    store: &AuthStore,
    http: &H,
    deep_link_url: &str,
) -> Result<(), AuthError> {
    let params = parse_deep_link(deep_link_url)?;

    // OAuth error path: only cancel pending when state exactly matches.
    // Unauthenticated external `?error=...` without matching state must not
    // cancel an in-flight login.
    if let Some(err) = params.error {
        let incoming_state = match params.state {
            Some(s) if !s.is_empty() => s,
            _ => return Err(AuthError::StateMismatch),
        };
        let mut mem = store
            .inner
            .lock()
            .map_err(|e| AuthError::Internal(e.to_string()))?;
        if mem.used_states.contains(&incoming_state) {
            return Err(AuthError::StateReplay);
        }
        match mem.pending.as_ref() {
            Some(p) if p.state == incoming_state => {
                mem.pending = None; // Drop zeroizes secrets
                mem.used_states.insert(incoming_state);
                return Err(AuthError::Exchange(sanitize_oauth_error_code(&err)));
            }
            Some(_) | None => {
                // Preserve pending; external/mismatched error cannot cancel login.
                return Err(AuthError::StateMismatch);
            }
        }
    }

    let code = params.code.ok_or(AuthError::InvalidDeepLink)?;
    let incoming_state = params.state.ok_or(AuthError::StateMismatch)?;

    let code_verifier = {
        let mut mem = store
            .inner
            .lock()
            .map_err(|e| AuthError::Internal(e.to_string()))?;
        if mem.used_states.contains(&incoming_state) {
            return Err(AuthError::StateReplay);
        }
        let pending = mem.pending.take().ok_or(AuthError::StateMismatch)?;
        if pending.state != incoming_state {
            mem.pending = Some(pending);
            return Err(AuthError::StateMismatch);
        }
        mem.used_states.insert(incoming_state.clone());
        pending.code_verifier.clone()
    };

    let body = json!({
        "code": code,
        "codeVerifier": code_verifier,
        "redirectUri": DESKTOP_REDIRECT_URI,
    });
    let raw = match http.post_json(LOGTO_EXCHANGE_URL, &body) {
        Ok(r) => r,
        Err(e) => {
            let mut v = code_verifier;
            v.zeroize();
            return Err(e);
        }
    };
    let mut verifier_wipe = code_verifier;
    verifier_wipe.zeroize();

    let session: ExchangeSessionResponse =
        serde_json::from_str(&raw).map_err(|_| AuthError::Exchange("invalid_response".into()))?;

    let ExchangeSessionResponse {
        token,
        username,
        role,
        must_change_password,
        tenant_id,
        subject,
        workspace_id,
    } = session;

    let tenant_id = tenant_id.unwrap_or_default();
    let subject = subject.unwrap_or_default();
    if !nonempty(&token)
        || !nonempty(&username)
        || !nonempty(&role)
        || !nonempty(&tenant_id)
        || !nonempty(&subject)
    {
        let mut tok = token;
        tok.zeroize();
        return Err(AuthError::InvalidSession);
    }

    {
        let mut mem = store
            .inner
            .lock()
            .map_err(|e| AuthError::Internal(e.to_string()))?;
        mem.session = Some(NativeSession {
            token,
            username,
            role,
            must_change_password,
            expires_at_unix: None,
            tenant_id,
            subject,
            workspace_id,
        });
        mem.reauth_required = false;
        AuthStore::bump_epoch_locked(&mut mem);
    }
    Ok(())
}

/// Fail-closed logout: clear native pending/session.
pub fn perform_logout(store: &AuthStore) -> Result<(), AuthError> {
    let mut mem = store
        .inner
        .lock()
        .map_err(|e| AuthError::Internal(e.to_string()))?;
    AuthStore::clear_native_locked(&mut mem);
    mem.reauth_required = false;
    Ok(())
}

pub fn perform_session_status(store: &AuthStore) -> Result<AuthSessionStatus, AuthError> {
    let mem = store
        .inner
        .lock()
        .map_err(|e| AuthError::Internal(e.to_string()))?;
    match &mem.session {
        Some(s) if AuthStore::principal_from_session(s).is_some() => Ok(AuthSessionStatus {
            authenticated: true,
            username: Some(s.username.clone()),
            role: Some(s.role.clone()),
            must_change_password: s.must_change_password,
            expires_at_unix: s.expires_at_unix,
            reauth_required: mem.reauth_required,
        }),
        // Invalid principal: never report authenticated (no secret leak).
        Some(_) | None => Ok(AuthSessionStatus {
            authenticated: false,
            username: None,
            role: None,
            must_change_password: false,
            expires_at_unix: None,
            reauth_required: mem.reauth_required,
        }),
    }
}

/// On API 401: clear native session, mark reauth, then begin fresh login.
pub fn perform_on_unauthorized<R: RandomSource, H: AuthHttp, O: BrowserOpener>(
    store: &AuthStore,
    rng: &R,
    http: &H,
    opener: &O,
) -> Result<AuthBeginResponse, AuthError> {
    {
        let mut mem = store
            .inner
            .lock()
            .map_err(|e| AuthError::Internal(e.to_string()))?;
        AuthStore::clear_native_locked(&mut mem);
        mem.reauth_required = true;
    }
    perform_begin_logto(store, rng, http, opener)
}

/// Bearer for native HTTPS only — Zeroizing so drop wipes.
pub fn auth_native_bearer(store: &AuthStore) -> Option<Zeroizing<String>> {
    let mem = store.inner.lock().ok()?;
    mem.session
        .as_ref()
        .map(|s| Zeroizing::new(s.token.clone()))
}

/// Run a closure with a temporary Zeroizing bearer (preferred over returning String).
pub fn with_native_bearer<T>(store: &AuthStore, f: impl FnOnce(&str) -> T) -> Option<T> {
    let bearer = auth_native_bearer(store)?;
    Some(f(bearer.as_str()))
}

// ─── Production HTTP adapter ─────────────────────────────────────────────────

pub struct TokioAuthHttp {
    client: reqwest::Client,
}

impl Default for TokioAuthHttp {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .use_rustls_tls()
                .build()
                .expect("reqwest client"),
        }
    }
}

impl TokioAuthHttp {
    pub fn new() -> Self {
        Self::default()
    }

    fn block_on_safe<F, T>(fut: F) -> Result<T, AuthError>
    where
        F: std::future::Future<Output = Result<T, AuthError>> + Send + 'static,
        T: Send + 'static,
    {
        if tokio::runtime::Handle::try_current().is_ok() {
            return std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|e| AuthError::Http(e.to_string()))?;
                rt.block_on(fut)
            })
            .join()
            .map_err(|_| AuthError::Internal("http worker join failed".into()))?;
        }
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| AuthError::Http(e.to_string()))?;
        rt.block_on(fut)
    }
}

impl AuthHttp for TokioAuthHttp {
    fn get_text(&self, url: &str) -> Result<String, AuthError> {
        let client = self.client.clone();
        let url = url.to_string();
        Self::block_on_safe(async move {
            let res = client
                .get(&url)
                .send()
                .await
                .map_err(|e| AuthError::Http(e.to_string()))?;
            if !res.status().is_success() {
                return Err(AuthError::Http(format!("GET {url} -> {}", res.status())));
            }
            res.text().await.map_err(|e| AuthError::Http(e.to_string()))
        })
    }

    fn post_json(&self, url: &str, body: &Value) -> Result<String, AuthError> {
        let client = self.client.clone();
        let url = url.to_string();
        let body = body.clone();
        Self::block_on_safe(async move {
            let res = client
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(|e| AuthError::Http(e.to_string()))?;
            let status = res.status();
            let text = res
                .text()
                .await
                .map_err(|e| AuthError::Http(e.to_string()))?;
            if status.as_u16() == 401 {
                // Drop body without logging — may contain tokens.
                drop(text);
                return Err(AuthError::Unauthorized);
            }
            if !status.is_success() {
                // Never attach upstream body/URL/token material to the error.
                drop(text);
                return Err(AuthError::Exchange("http_status".into()));
            }
            Ok(text)
        })
    }
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
