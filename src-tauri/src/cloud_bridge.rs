//! Production cloud bridge: WebView → named IPC → Rust CloudTransport.
//!
//! IPC surface: `operationId` + JSON business `input` only.
//! Bearer / URL / method / headers / tenant / subject / workspace never cross IPC.

use crate::auth::{perform_logout, AuthStore};
use crate::cloud_transport::{
    map_transport_public, CloudTransport, HttpBackend, ReqwestBackend, SessionLifecycleHooks,
    TransportError,
};
use crate::security_cutoff::SecurityCutoff;
use crate::vault::{VaultError, VaultService};
use crate::vault_os_sleep::ObserverHealth;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

/// Exact IPC arguments for `cloud_call` (camelCase wire names).
/// Debug is redacted — business input may contain passwords.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudCallArgs {
    pub operation_id: String,
    #[serde(default)]
    pub input: Value,
}

impl std::fmt::Debug for CloudCallArgs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudCallArgs")
            .field("operation_id", &self.operation_id)
            .field("input", &"<redacted>")
            .finish()
    }
}

/// Required secret-free session-invalidated emitter (never optional).
pub trait SessionInvalidatedEmitter: Send + Sync {
    fn emit_session_invalidated(&self);
}

/// Test spy emitter.
#[cfg(test)]
#[derive(Debug, Default)]
pub struct SpyEmitter {
    pub count: AtomicUsize,
}

#[cfg(test)]
impl SpyEmitter {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn count(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
impl SessionInvalidatedEmitter for SpyEmitter {
    fn emit_session_invalidated(&self) {
        self.count.fetch_add(1, Ordering::SeqCst);
    }
}

impl SessionInvalidatedEmitter for Arc<dyn SessionInvalidatedEmitter> {
    fn emit_session_invalidated(&self) {
        (**self).emit_session_invalidated()
    }
}

/// Production 401 hooks: conditional auth clear + SSH cutoff + **real** Stronghold seal + emit.
pub struct ProductionLifecycleHooks {
    auth: Arc<AuthStore>,
    cutoff: Arc<SecurityCutoff>,
    /// Real vault service — sealed on 401/logout (not the SecurityCutoff bool alone).
    vault: Arc<VaultService>,
    emitter: Arc<dyn SessionInvalidatedEmitter>,
    /// Ordered event log for tests (empty in production).
    #[cfg(test)]
    order: std::sync::Mutex<Vec<&'static str>>,
}

impl ProductionLifecycleHooks {
    pub fn new(
        auth: Arc<AuthStore>,
        cutoff: Arc<SecurityCutoff>,
        vault: Arc<VaultService>,
        emitter: Arc<dyn SessionInvalidatedEmitter>,
    ) -> Self {
        Self {
            auth,
            cutoff,
            vault,
            emitter,
            #[cfg(test)]
            order: std::sync::Mutex::new(Vec::new()),
        }
    }

    #[cfg(test)]
    pub fn order(&self) -> Vec<&'static str> {
        self.order.lock().map(|g| g.clone()).unwrap_or_default()
    }

    #[cfg(test)]
    fn push_order(&self, s: &'static str) {
        if let Ok(mut g) = self.order.lock() {
            g.push(s);
        }
    }

    /// SSH generation cutoff then real Stronghold seal (logout reason). Fail-closed attempt always.
    fn seal_real_vault_logout(&self) {
        self.cutoff.lock_vault();
        // Always attempt Stronghold seal even if already locked / storage errors.
        let _ = self.vault.on_logout();
    }
}

impl SessionLifecycleHooks for ProductionLifecycleHooks {
    fn try_clear_auth_for_epoch(&self, epoch: u64) -> Result<bool, ()> {
        #[cfg(test)]
        self.push_order("try_clear_auth_for_epoch");
        self.auth
            .mark_reauth_required_if_epoch(epoch)
            .map_err(|_| ())
    }

    fn close_all_ssh(&self) -> Result<(), ()> {
        #[cfg(test)]
        self.push_order("close_all_ssh");
        let _ = self.cutoff.close_all_ssh();
        Ok(())
    }

    fn lock_vault(&self) -> Result<(), ()> {
        #[cfg(test)]
        self.push_order("lock_vault");
        // SecurityCutoff gate + real Stronghold seal (logout reason for 401 lifecycle).
        self.seal_real_vault_logout();
        Ok(())
    }

    fn emit_session_invalidated(&self) {
        #[cfg(test)]
        self.push_order("emit_session_invalidated");
        self.emitter.emit_session_invalidated();
    }
}

impl SessionLifecycleHooks for Arc<ProductionLifecycleHooks> {
    fn try_clear_auth_for_epoch(&self, epoch: u64) -> Result<bool, ()> {
        (**self).try_clear_auth_for_epoch(epoch)
    }
    fn close_all_ssh(&self) -> Result<(), ()> {
        (**self).close_all_ssh()
    }
    fn lock_vault(&self) -> Result<(), ()> {
        (**self).lock_vault()
    }
    fn emit_session_invalidated(&self) {
        (**self).emit_session_invalidated()
    }
}

/// Managed Rust cloud stack (not WebView-reachable state).
pub struct CloudBridge<B: HttpBackend = ReqwestBackend> {
    pub transport: CloudTransport<B, Arc<ProductionLifecycleHooks>>,
    pub cutoff: Arc<SecurityCutoff>,
    pub auth: Arc<AuthStore>,
    pub vault: Arc<VaultService>,
    pub hooks: Arc<ProductionLifecycleHooks>,
    /// Shared OS sleep observer health (Task 4). Unlock gates fail closed when unhealthy.
    pub observer_health: Arc<ObserverHealth>,
}

impl CloudBridge<ReqwestBackend> {
    /// Fallible production construction: real reqwest + **required** emitter + managed vault.
    pub fn new(
        auth: Arc<AuthStore>,
        vault: Arc<VaultService>,
        emitter: Arc<dyn SessionInvalidatedEmitter>,
    ) -> Result<Self, TransportError> {
        let cutoff = Arc::new(SecurityCutoff::new());
        let observer_health = ObserverHealth::new_healthy();
        let hooks = Arc::new(ProductionLifecycleHooks::new(
            auth.clone(),
            cutoff.clone(),
            vault.clone(),
            emitter,
        ));
        let backend = ReqwestBackend::new()?;
        let transport = CloudTransport::new(backend, hooks.clone());
        Ok(Self {
            transport,
            cutoff,
            auth,
            vault,
            hooks,
            observer_health,
        })
    }
}

impl<B: HttpBackend> CloudBridge<B> {
    /// Test-only: inject mock backend + required spy emitter + vault.
    #[cfg(test)]
    pub fn with_backend(
        auth: Arc<AuthStore>,
        vault: Arc<VaultService>,
        backend: B,
        emitter: Arc<dyn SessionInvalidatedEmitter>,
    ) -> Self {
        let cutoff = Arc::new(SecurityCutoff::new());
        let hooks = Arc::new(ProductionLifecycleHooks::new(
            auth.clone(),
            cutoff.clone(),
            vault.clone(),
            emitter,
        ));
        let transport = CloudTransport::new(backend, hooks.clone());
        Self {
            transport,
            cutoff,
            auth,
            vault,
            hooks,
            observer_health: ObserverHealth::new_healthy(),
        }
    }

    #[cfg(test)]
    pub fn with_backend_cutoff(
        auth: Arc<AuthStore>,
        vault: Arc<VaultService>,
        backend: B,
        cutoff: Arc<SecurityCutoff>,
        emitter: Arc<dyn SessionInvalidatedEmitter>,
    ) -> Self {
        let hooks = Arc::new(ProductionLifecycleHooks::new(
            auth.clone(),
            cutoff.clone(),
            vault.clone(),
            emitter,
        ));
        let transport = CloudTransport::new(backend, hooks.clone());
        Self {
            transport,
            cutoff,
            auth,
            vault,
            hooks,
            observer_health: ObserverHealth::new_healthy(),
        }
    }

    /// Shared observer-health latch (passed into `OsSleepRegistration::register`).
    pub fn observer_health(&self) -> &Arc<ObserverHealth> {
        &self.observer_health
    }

    /// Core cloud call: snapshot bearer+epoch under one lock, then await without holding it.
    pub async fn call(
        &self,
        operation_id: &str,
        business_input: &Value,
    ) -> Result<Value, TransportError> {
        use crate::cloud_transport::{from_id, is_ipc_callable, spec};

        let op = from_id(operation_id).ok_or(TransportError::UnknownOperation)?;
        let s = spec(op);
        if !is_ipc_callable(op) {
            return Err(match s.invocation {
                crate::cloud_transport::Invocation::NativeOnly => TransportError::NativeOnly,
                crate::cloud_transport::Invocation::IpcViaRust => TransportError::InvalidInvocation,
            });
        }

        let (bearer_owned, epoch) = if s.authenticated {
            let snap = self
                .auth
                .native_auth_snapshot()
                .ok_or(TransportError::Unauthenticated)?;
            (Some(snap.bearer), Some(snap.epoch))
        } else {
            (None, None)
        };

        let bearer_ref = bearer_owned.as_ref().map(|b| b.as_str());
        self.transport
            .invoke_ipc(operation_id, business_input, bearer_ref, epoch)
            .await
    }

    /// Rust-only native cloud call (e.g. `servers.host_key` CAS).
    ///
    /// Same auth snapshot / epoch cancel / 401 lifecycle as [`call`], but only
    /// for `Invocation::NativeOnly` operations. WebView `cloud_call` must never
    /// reach this path.
    pub async fn call_native(
        &self,
        operation_id: &str,
        business_input: &Value,
    ) -> Result<Value, TransportError> {
        use crate::cloud_transport::{from_id, spec, Invocation};

        let op = from_id(operation_id).ok_or(TransportError::UnknownOperation)?;
        let s = spec(op);
        if !matches!(s.invocation, Invocation::NativeOnly) {
            return Err(TransportError::InvalidInvocation);
        }

        let (bearer_owned, epoch) = if s.authenticated {
            let snap = self
                .auth
                .native_auth_snapshot()
                .ok_or(TransportError::Unauthenticated)?;
            (Some(snap.bearer), Some(snap.epoch))
        } else {
            (None, None)
        };

        let bearer_ref = bearer_owned.as_ref().map(|b| b.as_str());
        self.transport
            .invoke_native(operation_id, business_input, bearer_ref, epoch)
            .await
    }

    /// After successful native login: cancel prior-epoch cloud work, advance SSH,
    /// seal **real** Stronghold as principal_changed. Does **not** use global cancel.
    pub fn on_successful_session_install(&self) {
        if let Some(snap) = self.auth.native_auth_snapshot() {
            let e = snap.epoch;
            if e > 0 {
                // Invalidate all older epochs; current epoch remains active.
                self.transport
                    .control()
                    .cancel_auth_epoch(e.wrapping_sub(1));
            }
        }
        let _ = self.cutoff.close_all_ssh();
        self.cutoff.lock_vault();
        // Real vault seal for session transition (even if already locked).
        let _ = self.vault.seal_for_principal_change();
    }

    /// Explicit logout order: cancel → attempt auth clear → SSH cutoff → real Stronghold seal.
    ///
    /// SSH + real vault seal always run even when auth clear returns `Err` (fail closed).
    pub fn perform_secure_logout(&self) -> Result<(), crate::auth::AuthError> {
        self.transport.cancel_inflight();
        let auth_result = perform_logout(self.auth.as_ref());
        let _ = self.cutoff.close_all_ssh();
        self.cutoff.lock_vault();
        let _ = self.vault.on_logout();
        auth_result
    }

    /// Notify SecurityCutoff that the real vault is unlocked (Task 8 unlock path only).
    ///
    /// Health check and cutoff unlock share one critical section via
    /// [`ObserverHealth::run_if_healthy`] — no TOCTOU with concurrent listener death.
    pub fn notify_vault_unlocked(&self) -> Result<(), VaultError> {
        self.observer_health
            .run_if_healthy(|| {
                self.cutoff.unlock_vault_for_task8();
            })
            .map_err(|_| VaultError::ObserverUnavailable)
    }

    /// Notify SecurityCutoff that the real vault is locked/sealed.
    ///
    /// **Does not** advance SSH generation — use [`Self::perform_user_vault_lock`] for
    /// explicit user lock (SSH close + cutoff **before** Stronghold seal).
    pub fn notify_vault_locked(&self) {
        self.cutoff.lock_vault();
    }

    /// After Stronghold unlocked but observer health failed: SSH close + cutoff lock +
    /// real seal before returning a fixed public error to IPC.
    pub fn fail_closed_after_observer_loss(&self) {
        let _ = self.perform_user_vault_lock();
        // Ensure sticky locked even if seal was NotNeeded / error.
        self.cutoff.lock_vault();
    }

    /// Pre-unlock gate used by IPC / tests: fixed public error when observers are dead.
    pub fn require_observer_healthy(&self) -> Result<(), VaultError> {
        if self.observer_health.is_healthy() {
            Ok(())
        } else {
            Err(VaultError::ObserverUnavailable)
        }
    }

    /// Explicit user vault lock: close all SSH authority + lock SecurityCutoff **before**
    /// real Stronghold seal (`locked` reason). IPC `vault_lock` must call this — not
    /// `vault.lock()` then `notify_vault_locked()` (bool-only notify leaves SSH open).
    ///
    /// On seal error: ensure SSH generation advanced exactly once if pre_seal did not run,
    /// always lock cutoff, return original `VaultError`. Uses generation-before comparison
    /// only — a locked cutoff bool is not proof SSH was closed (bool can be sticky while
    /// an old SSH generation remains live).
    pub fn perform_user_vault_lock(
        &self,
    ) -> Result<crate::vault::VaultStatus, crate::vault::VaultError> {
        use crate::vault::SealAttempt;

        let gen_before = self.cutoff.ssh_generation();
        match self.vault.seal_if_unlocked_with_pre_seal("locked", || {
            let _ = self.cutoff.close_all_ssh();
            self.cutoff.lock_vault();
        }) {
            Ok(SealAttempt::Sealed) => self.vault.status(),
            Ok(SealAttempt::NotNeeded) => {
                // Already sealed: ensure cutoff bool without SSH generation bump.
                self.cutoff.lock_vault();
                self.vault.status()
            }
            Err(e) => {
                // Fail-closed via generation: pre_seal may have already advanced gen.
                // Never use the cutoff vault-locked bool to decide whether to close SSH.
                if self.cutoff.ssh_generation() == gen_before {
                    let _ = self.cutoff.close_all_ssh();
                }
                self.cutoff.lock_vault();
                Err(e)
            }
        }
    }
}

/// Map transport errors to fixed public IPC strings.
pub fn map_cloud_public(err: TransportError) -> String {
    map_transport_public(err).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_transport::client::MockHttpBackend;
    use serde_json::json;
    use std::sync::Arc;

    fn spy() -> Arc<SpyEmitter> {
        Arc::new(SpyEmitter::new())
    }

    fn test_vault() -> Arc<VaultService> {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "opsmate-bridge-vault-{}-{}.hold",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Arc::new(VaultService::new(path))
    }

    #[tokio::test]
    async fn cloud_call_fetches_bearer_internally_and_sanitizes() {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let backend = MockHttpBackend::new(r#"{"id":"1","token":"LEAK","name":"ok"}"#);
        let bridge = CloudBridge::with_backend(auth, test_vault(), backend.clone(), spy());
        let out = bridge
            .call("servers.get", &json!({"id": "srv-1"}))
            .await
            .unwrap();
        assert_eq!(out["name"], "ok");
        assert!(out.get("token").is_none());
        let req = backend.last_request().unwrap();
        assert!(req
            .headers
            .iter()
            .any(|(k, v)| k == "Authorization" && v.starts_with("Bearer ")));
        let s = out.to_string();
        assert!(!s.contains("sub-1"));
        assert!(!s.contains("test-token"));
    }

    #[tokio::test]
    async fn cloud_call_unauthenticated_fails_before_outbound() {
        let auth = Arc::new(AuthStore::new());
        let backend = MockHttpBackend::new("{}");
        let bridge = CloudBridge::with_backend(auth, test_vault(), backend.clone(), spy());
        let err = bridge.call("auth.me", &json!({})).await.unwrap_err();
        assert_eq!(err, TransportError::Unauthenticated);
        assert_eq!(backend.request_count(), 0);
    }

    #[tokio::test]
    async fn current_epoch_401_exact_order() {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let backend = MockHttpBackend::new("{}");
        backend.set_status(401);
        let cutoff = Arc::new(SecurityCutoff::new());
        let emitter = spy();
        // unlock so we can observe lock transition to true after 401
        cutoff.unlock_vault_for_tests();
        assert!(!cutoff.is_vault_locked());
        let bridge = CloudBridge::with_backend_cutoff(
            auth.clone(),
            test_vault(),
            backend,
            cutoff.clone(),
            emitter.clone(),
        );
        let err = bridge.call("auth.me", &json!({})).await.unwrap_err();
        assert_eq!(err, TransportError::SessionInvalidated);
        assert!(auth.native_auth_snapshot().is_none());
        assert_eq!(cutoff.ssh_generation(), 1);
        assert!(cutoff.is_vault_locked());
        assert_eq!(emitter.count(), 1);
        assert_eq!(
            bridge.hooks.order(),
            vec![
                "try_clear_auth_for_epoch",
                "close_all_ssh",
                "lock_vault",
                "emit_session_invalidated",
            ]
        );
        // Cancel watermark advanced before clear (epoch covered).
        assert!(bridge.transport.control().cancelled_through() >= 1);
    }

    #[tokio::test]
    async fn delayed_old_epoch_401_with_pending_new_epoch_call() {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let old_epoch = auth.native_auth_snapshot().unwrap().epoch;

        // New session installed (successful login transition).
        auth.install_session_for_tests("t1", "bob", "admin", "sub-2");
        let new_epoch = auth.native_auth_snapshot().unwrap().epoch;
        assert_ne!(old_epoch, new_epoch);
        assert!(old_epoch < new_epoch);

        let hang_backend = MockHttpBackend::new(r#"{"ok":true}"#);
        hang_backend.set_hang(true);
        let cutoff = Arc::new(SecurityCutoff::new());
        let emitter = spy();
        let bridge = Arc::new(CloudBridge::with_backend_cutoff(
            auth.clone(),
            test_vault(),
            hang_backend.clone(),
            cutoff.clone(),
            emitter.clone(),
        ));

        // Watermark-only transition: older epochs cancelled; new epoch stays live.
        bridge.on_successful_session_install();
        let ssh_after_login = cutoff.ssh_generation();
        assert!(cutoff.is_vault_locked());

        let b = Arc::clone(&bridge);
        let pending = tokio::spawn(async move {
            b.transport
                .invoke_ipc("auth.me", &json!({}), Some("new-tok"), Some(new_epoch))
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(hang_backend.request_count(), 1);
        assert_eq!(hang_backend.completed_count(), 0);

        // Stale old-epoch 401: no clear of bob, no emit, no extra SSH.
        let _ = bridge
            .transport
            .control()
            .run_401_for_auth_epoch(old_epoch, bridge.hooks.as_ref());
        assert!(auth.native_auth_snapshot().is_some());
        assert_eq!(
            auth.native_auth_snapshot().unwrap().principal.user_id,
            "bob"
        );
        assert_eq!(emitter.count(), 0);
        assert_eq!(cutoff.ssh_generation(), ssh_after_login);

        // New-epoch pending still hanging (not cancelled by stale old-epoch path).
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(hang_backend.completed_count(), 0);
        assert!(!pending.is_finished());

        // Teardown.
        bridge.transport.cancel_inflight();
        let end = tokio::time::timeout(std::time::Duration::from_millis(200), pending)
            .await
            .expect("pending should finish after cancel_all");
        assert!(matches!(
            end.unwrap().unwrap_err(),
            TransportError::Cancelled
        ));
    }

    #[tokio::test]
    async fn secure_logout_order_and_state() {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let backend = MockHttpBackend::new("{}");
        let bridge = CloudBridge::with_backend(auth.clone(), test_vault(), backend, spy());
        bridge.perform_secure_logout().unwrap();
        assert!(auth.native_auth_snapshot().is_none());
        assert!(bridge.cutoff.is_vault_locked());
        assert!(bridge.cutoff.ssh_generation() >= 1);
        assert!(!bridge.vault.is_unlocked());
    }

    fn inject_unlocked_vault(auth: &AuthStore) -> (Arc<VaultService>, std::path::PathBuf) {
        use std::time::Instant;
        use tauri_plugin_stronghold::stronghold::Stronghold;
        let mut path = std::env::temp_dir();
        path.push(format!(
            "opsmate-bridge-inject-{}-{}.hold",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let sh = Stronghold::new(&path, vec![0x91u8; 32]).expect("stronghold");
        let vault = Arc::new(VaultService::new(path.clone()));
        vault.test_inject_unlocked(
            sh,
            auth.auth_binding().expect("binding"),
            path.clone(),
            Instant::now(),
        );
        (vault, path)
    }

    fn cleanup_hold(path: &std::path::Path) {
        let _ = std::fs::remove_file(path);
        let mut salt = path.as_os_str().to_os_string();
        salt.push(".salt");
        let _ = std::fs::remove_file(std::path::PathBuf::from(salt));
    }

    #[tokio::test]
    async fn current_epoch_401_seals_real_managed_vault() {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let (vault, path) = inject_unlocked_vault(&auth);
        assert!(vault.is_unlocked());

        let backend = MockHttpBackend::new("{}");
        backend.set_status(401);
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let bridge = CloudBridge::with_backend_cutoff(
            auth.clone(),
            vault.clone(),
            backend,
            cutoff.clone(),
            spy(),
        );
        let err = bridge.call("auth.me", &json!({})).await.unwrap_err();
        assert_eq!(err, TransportError::SessionInvalidated);
        assert!(!vault.is_unlocked());
        assert!(cutoff.is_vault_locked());
        let _ = vault.lock();
        cleanup_hold(&path);
    }

    #[tokio::test]
    async fn logout_seals_real_managed_vault() {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let (vault, path) = inject_unlocked_vault(&auth);
        assert!(vault.is_unlocked());
        let bridge = CloudBridge::with_backend(
            auth.clone(),
            vault.clone(),
            MockHttpBackend::new("{}"),
            spy(),
        );
        bridge.perform_secure_logout().unwrap();
        assert!(!vault.is_unlocked());
        assert_eq!(
            vault.status().unwrap().locked_reason.as_deref(),
            Some("logout")
        );
        cleanup_hold(&path);
    }

    #[tokio::test]
    async fn new_session_seals_real_vault_principal_changed() {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let (vault, path) = inject_unlocked_vault(&auth);
        assert!(vault.is_unlocked());
        // Simulate successful re-login (new principal/epoch).
        auth.install_session_for_tests("t1", "bob", "admin", "sub-2");
        let bridge =
            CloudBridge::with_backend(auth, vault.clone(), MockHttpBackend::new("{}"), spy());
        bridge.on_successful_session_install();
        assert!(!vault.is_unlocked());
        assert_eq!(
            vault.status().unwrap().locked_reason.as_deref(),
            Some("principal_changed")
        );
        cleanup_hold(&path);
    }

    #[tokio::test]
    async fn stale_epoch_401_does_not_seal_newer_session_vault() {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let old_epoch = auth.native_auth_snapshot().unwrap().epoch;
        // New session + unlock vault under new binding.
        auth.install_session_for_tests("t1", "bob", "admin", "sub-2");
        let (vault, path) = inject_unlocked_vault(&auth);
        assert!(vault.is_unlocked());

        let bridge = CloudBridge::with_backend(
            auth.clone(),
            vault.clone(),
            MockHttpBackend::new("{}"),
            spy(),
        );
        // Stale old-epoch 401 must not clear bob or seal vault.
        let _ = bridge
            .transport
            .control()
            .run_401_for_auth_epoch(old_epoch, bridge.hooks.as_ref());
        assert!(auth.native_auth_snapshot().is_some());
        assert_eq!(
            auth.native_auth_snapshot().unwrap().principal.user_id,
            "bob"
        );
        assert!(
            vault.is_unlocked(),
            "stale-epoch 401 must not seal newer session vault"
        );
        let _ = vault.lock();
        cleanup_hold(&path);
    }

    #[tokio::test]
    async fn secure_logout_applies_cutoffs_even_when_auth_clear_fails() {
        // Required proof: auth-clear Err must still seal the **same** real Stronghold vault.
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let (vault, path) = inject_unlocked_vault(&auth);
        assert!(
            vault.is_unlocked(),
            "precondition: real managed vault must start unlocked"
        );
        let backend = MockHttpBackend::new("{}");
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let bridge = CloudBridge::with_backend_cutoff(
            auth.clone(),
            vault.clone(),
            backend,
            cutoff.clone(),
            spy(),
        );
        auth.poison_lock_for_tests();
        let err = bridge.perform_secure_logout();
        assert!(err.is_err(), "auth clear must fail closed (poisoned lock)");
        assert_eq!(cutoff.ssh_generation(), 1);
        assert!(cutoff.is_vault_locked());
        // Same Arc<VaultService> sealed with logout reason — not merely SecurityCutoff bool.
        assert!(!vault.is_unlocked());
        assert_eq!(
            vault.status().unwrap().locked_reason.as_deref(),
            Some("logout")
        );
        cleanup_hold(&path);
    }

    /// Behavioral order proof: unlocked real VaultService + unlocked cutoff → pre_seal
    /// advances SSH gen while Stronghold still unlocked → then seal with `locked`.
    /// Not a fake label Vec: uses after-pre_seal fail arm + success path.
    #[tokio::test]
    async fn perform_user_vault_lock_ssh_before_stronghold_and_locked_reason() {
        use crate::vault::{VaultError, VaultService};
        use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let (vault, path) = inject_unlocked_vault(&auth);
        assert!(vault.is_unlocked());

        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        assert!(!cutoff.is_vault_locked());
        assert_eq!(cutoff.ssh_generation(), 0);

        // Phase 1 — order proof: arm error *after* pre_seal so SSH/cutoff run while
        // Stronghold remains unlocked (real generation/cutoff, not label vector).
        vault.test_arm_lifecycle_seal_error_after_pre_seal();
        let bridge = CloudBridge::with_backend_cutoff(
            auth.clone(),
            vault.clone(),
            MockHttpBackend::new("{}"),
            cutoff.clone(),
            spy(),
        );
        let err = bridge
            .perform_user_vault_lock()
            .expect_err("armed seal error");
        assert!(matches!(err, VaultError::Storage));
        assert!(
            vault.is_unlocked(),
            "Stronghold must still be unlocked when seal fails after pre_seal"
        );
        assert!(
            cutoff.is_vault_locked(),
            "cutoff must remain closed after pre_seal even when seal fails"
        );
        assert_eq!(
            cutoff.ssh_generation(),
            1,
            "exactly one SSH generation transition on user lock pre_seal"
        );
        // Fixed public code path (IPC maps Storage → vault_storage_error).
        assert_eq!(VaultService::map_vault_public(err), "vault_storage_error");

        // Phase 2 — success: complete user lock on same still-unlocked Stronghold.
        let gen_before_ok = cutoff.ssh_generation();
        // Cutoff already locked; pre_seal still bumps SSH once more when sealing succeeds.
        // Unlock cutoff bool only so we can observe lock again; gen continues from 1.
        cutoff.unlock_vault_for_tests();
        let st = bridge.perform_user_vault_lock().expect("user lock");
        assert!(!st.unlocked);
        assert_eq!(st.locked_reason.as_deref(), Some("locked"));
        assert!(!vault.is_unlocked());
        assert!(cutoff.is_vault_locked());
        assert_eq!(
            cutoff.ssh_generation(),
            gen_before_ok + 1,
            "success path: exactly one further generation transition"
        );

        // Already-locked path: NotNeeded — no extra SSH generation.
        let gen_locked = cutoff.ssh_generation();
        let st2 = bridge.perform_user_vault_lock().expect("idempotent");
        assert!(!st2.unlocked);
        assert_eq!(cutoff.ssh_generation(), gen_locked);
        assert!(cutoff.is_vault_locked());

        // Source wiring: production helper uses pre_seal primitive (not lock-then-notify).
        let saw_unlocked_in_primitive = AtomicBool::new(false);
        // Re-inject for isolated primitive order observation (callback while unlocked).
        let (vault2, path2) = inject_unlocked_vault(&auth);
        let cutoff2 = Arc::new(SecurityCutoff::new());
        cutoff2.unlock_vault_for_tests();
        let vref = vault2.clone();
        let cref = cutoff2.clone();
        vault2
            .seal_if_unlocked_with_pre_seal("locked", || {
                assert!(
                    vref.is_unlocked(),
                    "pre_seal must observe vault still unlocked"
                );
                saw_unlocked_in_primitive.store(true, AtomicOrdering::SeqCst);
                let _ = cref.close_all_ssh();
                cref.lock_vault();
                assert!(cref.is_vault_locked());
                assert!(vref.is_unlocked(), "still unlocked after SSH/cutoff");
            })
            .unwrap();
        assert!(saw_unlocked_in_primitive.load(AtomicOrdering::SeqCst));
        assert!(!vault2.is_unlocked());
        assert_eq!(
            vault2.status().unwrap().locked_reason.as_deref(),
            Some("locked")
        );
        assert_eq!(cutoff2.ssh_generation(), 1);

        let src = include_str!("cloud_bridge.rs");
        let helper = src
            .split("fn perform_user_vault_lock")
            .nth(1)
            .expect("helper")
            .split("/// Map transport")
            .next()
            .unwrap();
        assert!(helper.contains("seal_if_unlocked_with_pre_seal"));
        assert!(helper.contains("close_all_ssh"));
        assert!(helper.contains("\"locked\""));
        let lib = include_str!("lib.rs");
        let lock_fn = lib
            .split("fn vault_lock")
            .nth(1)
            .unwrap()
            .split("#[tauri::command]")
            .next()
            .unwrap();
        assert!(lock_fn.contains("perform_user_vault_lock"));
        assert!(!lock_fn.contains("vault.lock()"));
        assert!(!lock_fn.contains("notify_vault_locked"));

        cleanup_hold(&path);
        cleanup_hold(&path2);
    }

    #[tokio::test]
    async fn perform_user_vault_lock_error_before_pre_seal_fail_closed() {
        use crate::vault::VaultError;

        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let (vault, path) = inject_unlocked_vault(&auth);
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        assert!(!cutoff.is_vault_locked());
        assert_eq!(cutoff.ssh_generation(), 0);

        vault.test_arm_lifecycle_seal_error_before_pre_seal();
        let bridge = CloudBridge::with_backend_cutoff(
            auth,
            vault.clone(),
            MockHttpBackend::new("{}"),
            cutoff.clone(),
            spy(),
        );
        let err = bridge
            .perform_user_vault_lock()
            .expect_err("before pre_seal");
        assert!(matches!(err, VaultError::Storage));
        assert!(
            cutoff.is_vault_locked(),
            "fail-closed must lock cutoff when pre_seal never ran"
        );
        assert_eq!(cutoff.ssh_generation(), 1);
        // Vault may remain unlocked (seal never reached); authority is still closed.
        assert!(vault.is_unlocked());
        cleanup_hold(&path);
    }

    /// Critical: locked cutoff bool must NOT skip SSH close on Err before pre_seal.
    /// Bool-only check would leave old generation live (is_vault_locked true + gen valid).
    #[tokio::test]
    async fn perform_user_vault_lock_err_before_pre_seal_when_cutoff_bool_already_locked() {
        use crate::vault::VaultError;

        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let (vault, path) = inject_unlocked_vault(&auth);
        assert!(vault.is_unlocked(), "precondition: real vault unlocked");

        // Default SecurityCutoff starts vault_locked=true; do NOT unlock.
        // Simulate sticky locked bool while SSH generation is still live/valid.
        let cutoff = Arc::new(SecurityCutoff::new());
        assert!(
            cutoff.is_vault_locked(),
            "precondition: cutoff bool starts locked"
        );
        let captured_gen = cutoff.ssh_generation();
        assert_eq!(captured_gen, 0);
        assert!(
            cutoff.ssh_session_still_valid(captured_gen),
            "precondition: captured generation still valid (old SSH live)"
        );

        vault.test_arm_lifecycle_seal_error_before_pre_seal();
        let bridge = CloudBridge::with_backend_cutoff(
            auth,
            vault.clone(),
            MockHttpBackend::new("{}"),
            cutoff.clone(),
            spy(),
        );
        let err = bridge
            .perform_user_vault_lock()
            .expect_err("error before pre_seal");
        assert!(matches!(err, VaultError::Storage));
        assert_eq!(
            cutoff.ssh_generation(),
            captured_gen + 1,
            "generation must advance exactly once despite locked bool"
        );
        assert!(
            !cutoff.ssh_session_still_valid(captured_gen),
            "prior SSH capture must be invalidated"
        );
        assert!(cutoff.is_vault_locked());
        // Vault may remain unlocked; authority is closed.
        assert!(vault.is_unlocked());

        // Helper must not use is_vault_locked() for SSH fail-closed decision.
        let helper = include_str!("cloud_bridge.rs")
            .split("fn perform_user_vault_lock")
            .nth(1)
            .expect("helper")
            .split("/// Map transport")
            .next()
            .unwrap();
        assert!(
            helper.contains("gen_before"),
            "Err path must compare generation before seal"
        );
        assert!(
            !helper.contains("is_vault_locked()"),
            "must not infer SSH closed from cutoff bool"
        );

        cleanup_hold(&path);
    }

    #[tokio::test]
    async fn auth_clear_internal_err_fail_closed_cuts_and_emits() {
        // Controlled failing hook via spy always_clear=false path on transport.
        use crate::cloud_transport::lifecycle::{InvalidationControl, SpyLifecycleHooks};
        use std::sync::atomic::Ordering;
        let c = InvalidationControl::new();
        let hooks = SpyLifecycleHooks::new();
        hooks.always_clear.store(false, Ordering::SeqCst);
        assert!(c.run_401_for_auth_epoch(9, &hooks));
        assert_eq!(
            hooks.events(),
            vec![
                "try_clear_auth_for_epoch",
                "close_all_ssh",
                "lock_vault",
                "emit_session_invalidated",
            ]
        );
    }

    #[tokio::test]
    async fn concurrent_same_epoch_401_dedupe_single_emit() {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let snap = auth.native_auth_snapshot().unwrap();
        let epoch = snap.epoch;
        let backend = MockHttpBackend::new("{}");
        backend.set_status(401);
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let emitter = spy();
        let bridge = Arc::new(CloudBridge::with_backend_cutoff(
            auth.clone(),
            test_vault(),
            backend,
            cutoff.clone(),
            emitter.clone(),
        ));
        let mut joins = Vec::new();
        for _ in 0..6 {
            let b = Arc::clone(&bridge);
            joins.push(tokio::spawn(async move {
                b.transport
                    .invoke_ipc("auth.me", &json!({}), Some("tok"), Some(epoch))
                    .await
            }));
        }
        for j in joins {
            assert_eq!(
                j.await.unwrap().unwrap_err(),
                TransportError::SessionInvalidated
            );
        }
        assert_eq!(emitter.count(), 1);
        assert_eq!(cutoff.ssh_generation(), 1);
        assert!(auth.native_auth_snapshot().is_none());
    }

    #[test]
    fn cloud_call_args_redacted_debug_and_deny_secrets() {
        let args = CloudCallArgs {
            operation_id: "auth.me".into(),
            input: json!({"password":"SENTINEL_PASSWORD_9f3a","sshKey":"SECRETKEY"}),
        };
        let dbg = format!("{args:?}");
        assert!(!dbg.contains("SENTINEL_PASSWORD_9f3a"));
        assert!(!dbg.contains("SECRETKEY"));
        assert!(dbg.contains("<redacted>"));

        let bad = serde_json::from_str::<CloudCallArgs>(
            r#"{"operationId":"auth.me","input":{},"bearer":"x"}"#,
        );
        assert!(bad.is_err());
    }

    #[test]
    fn production_constructors_require_emitter_source() {
        let src = std::fs::read_to_string(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/cloud_bridge.rs"),
        )
        .unwrap();
        assert!(src.contains("emitter: Arc<dyn SessionInvalidatedEmitter>"));
        // Production hooks store required emitter field (no optional set_emit API).
        assert!(src.contains("emitter: Arc<dyn SessionInvalidatedEmitter>"));
        assert!(src.contains("#[cfg(test)]"));
        assert!(src.contains("pub fn with_backend"));
        let prod = src.split("#[cfg(test)]").next().unwrap_or("");
        assert!(
            !prod.contains("Option<Arc<dyn Fn") && !prod.contains("Mutex<Option"),
            "production path must not use optional emitter"
        );
    }
}
