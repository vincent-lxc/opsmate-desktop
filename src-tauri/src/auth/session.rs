//! Native-only session store.
//!
//! - Access token lives in `Zeroizing<String>` (wiped on drop).
//! - Verifier stored as `Zeroizing<String>` in pending PKCE.
//! - Verified `subject` / `tenant_id` / `workspace_id` stay native-only.
//! - IPC-facing `SessionStatus` never serializes secrets or identity namespaces.
//! - Pending PKCE carries a generation + wall-clock expiry for timer cleanup.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use zeroize::{Zeroize, Zeroizing};

use super::AuthError;

/// Default pending PKCE lifetime (wall clock). Production begin arms a timer with this.
pub const DEFAULT_PENDING_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Only public field allowed from `auth_begin_logto`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthBeginResponse {
    pub started: bool,
}

/// Secret-free session status returned to React over IPC.
///
/// Field names are camelCase on the wire (`reauthRequired`).
/// Never includes: token, verifier, code, state, subject, tenant_id, workspace_id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub reauth_required: bool,
}

/// Internal native principal for vault / transport binding (never includes token).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativePrincipal {
    pub tenant_id: String,
    /// Stable local user namespace: authenticated username.
    pub user_id: String,
    /// Server-verified Logto subject (never exposed over WebView IPC).
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

#[derive(Debug)]
pub(crate) struct PendingPkce {
    pub state: Zeroizing<String>,
    pub code_verifier: Zeroizing<String>,
    /// Monotonic pending generation; old timers must not clear a newer login.
    pub generation: u64,
    /// Wall-clock expiry instant.
    pub expires_at: Instant,
}

impl Drop for PendingPkce {
    fn drop(&mut self) {
        self.state.zeroize();
        self.code_verifier.zeroize();
    }
}

/// Native session: token material is always `Zeroizing<String>`.
/// `tenant_id` and `subject` are required nonempty after exchange validation.
/// `workspace_id` remains nullable. Never serialized into IPC `SessionStatus`.
#[derive(Debug)]
pub(crate) struct NativeSession {
    pub token: Zeroizing<String>,
    pub username: String,
    pub role: String,
    #[allow(dead_code)]
    pub must_change_password: bool,
    pub subject: String,
    pub tenant_id: String,
    #[allow(dead_code)]
    pub workspace_id: Option<String>,
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

#[derive(Debug)]
pub(crate) struct AuthMemory {
    pub pending: Option<PendingPkce>,
    pub session: Option<NativeSession>,
    pub used_states: HashSet<String>,
    pub reauth_required: bool,
    /// Monotonic session generation; bumps on every install/clear/exchange.
    pub session_epoch: u64,
    /// Monotonic pending generation; bumps whenever a new pending is installed.
    pub pending_generation: u64,
}

impl Default for AuthMemory {
    fn default() -> Self {
        Self {
            pending: None,
            session: None,
            used_states: HashSet::new(),
            reauth_required: false,
            session_epoch: 0,
            pending_generation: 0,
        }
    }
}

#[derive(Debug, Default)]
pub struct AuthStore {
    pub(crate) inner: Mutex<AuthMemory>,
}

impl AuthStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AuthMemory::default()),
        }
    }

    pub(crate) fn bump_epoch_locked(mem: &mut AuthMemory) {
        mem.session_epoch = mem.session_epoch.wrapping_add(1);
    }

    pub(crate) fn clear_native_locked(mem: &mut AuthMemory) {
        mem.pending = None;
        mem.session = None;
        Self::bump_epoch_locked(mem);
    }

    /// Fail-closed native wipe (pending + session).
    pub fn clear_native(&self) -> Result<(), AuthError> {
        let mut mem = self.inner.lock().map_err(|_| AuthError::Internal)?;
        Self::clear_native_locked(&mut mem);
        Ok(())
    }

    /// Clear pending PKCE only (e.g. fail-closed begin).
    pub fn clear_pending(&self) -> Result<(), AuthError> {
        let mut mem = self.inner.lock().map_err(|_| AuthError::Internal)?;
        mem.pending = None;
        Ok(())
    }

    /// Clear pending only if it still matches `generation` (old timer safety).
    /// Returns true if a matching pending was cleared.
    pub fn clear_pending_if_generation(&self, generation: u64) -> bool {
        let Ok(mut mem) = self.inner.lock() else {
            return false;
        };
        match mem.pending.as_ref() {
            Some(p) if p.generation == generation => {
                mem.pending = None;
                true
            }
            _ => false,
        }
    }

    /// Wall-clock expiry: clear pending if `now >= expires_at`.
    /// Returns true if pending was cleared due to expiry.
    pub fn expire_due_pending(&self, now: Instant) -> bool {
        let Ok(mut mem) = self.inner.lock() else {
            return false;
        };
        match mem.pending.as_ref() {
            Some(p) if now >= p.expires_at => {
                mem.pending = None;
                true
            }
            _ => false,
        }
    }

    /// Install pending PKCE; returns the new generation for timer arming.
    pub(crate) fn install_pending(
        &self,
        state: Zeroizing<String>,
        code_verifier: Zeroizing<String>,
        timeout: Duration,
        now: Instant,
    ) -> Result<u64, AuthError> {
        let mut mem = self.inner.lock().map_err(|_| AuthError::Internal)?;
        mem.pending_generation = mem.pending_generation.wrapping_add(1);
        let generation = mem.pending_generation;
        mem.pending = Some(PendingPkce {
            state,
            code_verifier,
            generation,
            expires_at: now + timeout,
        });
        Ok(generation)
    }

    /// Arm a Tokio async timer that clears pending only if `generation` is still current.
    ///
    /// Uses the ambient runtime when present (Tauri / `#[tokio::test]`); otherwise a
    /// process-wide single-worker timer runtime. **No OS thread per login** — replacement
    /// logins only install a new generation; old timers no-op via generation guard.
    /// Fail-closed: timer runtime construction panics at process init if impossible;
    /// `spawn` itself cannot silently drop the task on a live runtime.
    pub fn arm_pending_timeout(
        store: std::sync::Arc<AuthStore>,
        generation: u64,
        duration: Duration,
    ) {
        let task = async move {
            tokio::time::sleep(duration).await;
            store.clear_pending_if_generation(generation);
        };
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            // JoinHandle is intentionally not joined; task runs to completion on the runtime.
            handle.spawn(task);
            return;
        }
        pending_timer_runtime().spawn(task);
    }
}

/// Process-wide one-worker runtime dedicated to pending-PKCE timers when no ambient
/// Tokio handle exists (sync Tauri commands). Created once — not per login.
fn pending_timer_runtime() -> &'static tokio::runtime::Runtime {
    use std::sync::OnceLock;
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_time()
            .thread_name("auth-pending-timer")
            .build()
            .expect("auth pending timer runtime must start")
    })
}

impl AuthStore {
    /// Internal accessor: tenant + username + subject. Never returns token.
    pub fn native_principal(&self) -> Option<NativePrincipal> {
        let mem = self.inner.lock().ok()?;
        Self::principal_from_session(mem.session.as_ref()?)
    }

    pub(crate) fn principal_from_session(s: &NativeSession) -> Option<NativePrincipal> {
        let tenant_id = s.tenant_id.trim();
        if tenant_id.is_empty() || s.username.trim().is_empty() || s.subject.trim().is_empty() {
            return None;
        }
        if s.token.trim().is_empty() || s.role.trim().is_empty() {
            return None;
        }
        Some(NativePrincipal {
            tenant_id: tenant_id.to_string(),
            user_id: s.username.clone(),
            subject: s.subject.clone(),
        })
    }

    /// One mutex acquisition: principal + Zeroizing bearer + epoch.
    pub fn native_auth_snapshot(&self) -> Option<NativeAuthSnapshot> {
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

    /// Bearer for native HTTPS only — Zeroizing so drop wipes.
    pub fn auth_native_bearer(&self) -> Option<Zeroizing<String>> {
        let mem = self.inner.lock().ok()?;
        let s = mem.session.as_ref()?;
        // Only expose bearer when principal is valid.
        Self::principal_from_session(s)?;
        Some(Zeroizing::new(s.token.as_str().to_string()))
    }

    /// Clear session + mark reauth only if `expected_epoch` still matches.
    ///
    /// Atomic under the auth lock.
    /// - `Ok(true)` — cleared current session for this epoch
    /// - `Ok(false)` — genuine stale epoch (newer session already installed)
    /// - `Err` — lock/internal failure (caller must fail closed)
    ///
    /// Never exposes epoch over IPC.
    pub fn mark_reauth_required_if_epoch(&self, expected_epoch: u64) -> Result<bool, AuthError> {
        let mut mem = self.inner.lock().map_err(|_| AuthError::Internal)?;
        if mem.session_epoch != expected_epoch {
            return Ok(false);
        }
        // Only clear when a session is present for this epoch.
        if mem.session.is_none() {
            return Ok(false);
        }
        Self::clear_native_locked(&mut mem);
        mem.reauth_required = true;
        Ok(true)
    }

    /// Current session epoch (crate tests / native only — not IPC).
    #[cfg(test)]
    pub fn session_epoch_for_tests(&self) -> u64 {
        self.inner.lock().map(|m| m.session_epoch).unwrap_or(0)
    }

    /// Poison the auth mutex for fail-closed logout / clear tests.
    #[cfg(test)]
    pub fn poison_lock_for_tests(&self) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = self.inner.lock().expect("auth store lock");
            panic!("intentional auth store poison");
        }));
    }

    /// Install a principal-bearing native session for unit tests (no WebView surface).
    #[cfg(test)]
    pub fn install_session_for_tests(
        &self,
        tenant_id: impl Into<String>,
        username: impl Into<String>,
        role: impl Into<String>,
        subject: impl Into<String>,
    ) {
        let mut mem = self.inner.lock().expect("auth store lock");
        mem.session = Some(NativeSession {
            token: Zeroizing::new("test-token-not-for-ipc".into()),
            username: username.into(),
            role: role.into(),
            must_change_password: false,
            subject: subject.into(),
            tenant_id: tenant_id.into(),
            workspace_id: None,
        });
        mem.reauth_required = false;
        Self::bump_epoch_locked(&mut mem);
    }

    /// Install pending with explicit expiry for deterministic timeout tests.
    #[cfg(test)]
    pub fn install_pending_for_tests(
        &self,
        state: impl Into<String>,
        code_verifier: impl Into<String>,
        expires_at: Instant,
    ) -> u64 {
        let mut mem = self.inner.lock().expect("auth store lock");
        mem.pending_generation = mem.pending_generation.wrapping_add(1);
        let generation = mem.pending_generation;
        mem.pending = Some(PendingPkce {
            state: Zeroizing::new(state.into()),
            code_verifier: Zeroizing::new(code_verifier.into()),
            generation,
            expires_at,
        });
        generation
    }
}
