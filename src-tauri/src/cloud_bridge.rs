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

/// Production 401 hooks: conditional auth clear + security cutoffs + required emit.
pub struct ProductionLifecycleHooks {
    auth: Arc<AuthStore>,
    cutoff: Arc<SecurityCutoff>,
    emitter: Arc<dyn SessionInvalidatedEmitter>,
    /// Ordered event log for tests (empty in production).
    #[cfg(test)]
    order: std::sync::Mutex<Vec<&'static str>>,
}

impl ProductionLifecycleHooks {
    pub fn new(
        auth: Arc<AuthStore>,
        cutoff: Arc<SecurityCutoff>,
        emitter: Arc<dyn SessionInvalidatedEmitter>,
    ) -> Self {
        Self {
            auth,
            cutoff,
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
        self.cutoff.lock_vault();
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
    pub hooks: Arc<ProductionLifecycleHooks>,
}

impl CloudBridge<ReqwestBackend> {
    /// Fallible production construction: real reqwest + **required** emitter.
    pub fn new(
        auth: Arc<AuthStore>,
        emitter: Arc<dyn SessionInvalidatedEmitter>,
    ) -> Result<Self, TransportError> {
        let cutoff = Arc::new(SecurityCutoff::new());
        let hooks = Arc::new(ProductionLifecycleHooks::new(
            auth.clone(),
            cutoff.clone(),
            emitter,
        ));
        let backend = ReqwestBackend::new()?;
        let transport = CloudTransport::new(backend, hooks.clone());
        Ok(Self {
            transport,
            cutoff,
            auth,
            hooks,
        })
    }
}

impl<B: HttpBackend> CloudBridge<B> {
    /// Test-only: inject mock backend + required spy emitter.
    #[cfg(test)]
    pub fn with_backend(
        auth: Arc<AuthStore>,
        backend: B,
        emitter: Arc<dyn SessionInvalidatedEmitter>,
    ) -> Self {
        let cutoff = Arc::new(SecurityCutoff::new());
        let hooks = Arc::new(ProductionLifecycleHooks::new(
            auth.clone(),
            cutoff.clone(),
            emitter,
        ));
        let transport = CloudTransport::new(backend, hooks.clone());
        Self {
            transport,
            cutoff,
            auth,
            hooks,
        }
    }

    #[cfg(test)]
    pub fn with_backend_cutoff(
        auth: Arc<AuthStore>,
        backend: B,
        cutoff: Arc<SecurityCutoff>,
        emitter: Arc<dyn SessionInvalidatedEmitter>,
    ) -> Self {
        let hooks = Arc::new(ProductionLifecycleHooks::new(
            auth.clone(),
            cutoff.clone(),
            emitter,
        ));
        let transport = CloudTransport::new(backend, hooks.clone());
        Self {
            transport,
            cutoff,
            auth,
            hooks,
        }
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

    /// After successful native login: cancel prior-epoch cloud work, advance SSH,
    /// keep vault locked. Does **not** use global cancel (new-epoch calls stay live).
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
    }

    /// Explicit logout order: cancel → attempt auth clear → SSH cutoff → vault lock.
    ///
    /// SSH/vault always run even when auth clear returns `Err` (fail closed).
    pub fn perform_secure_logout(&self) -> Result<(), crate::auth::AuthError> {
        self.transport.cancel_inflight();
        let auth_result = perform_logout(self.auth.as_ref());
        let _ = self.cutoff.close_all_ssh();
        self.cutoff.lock_vault();
        auth_result
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

    #[tokio::test]
    async fn cloud_call_fetches_bearer_internally_and_sanitizes() {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let backend = MockHttpBackend::new(r#"{"id":"1","token":"LEAK","name":"ok"}"#);
        let bridge = CloudBridge::with_backend(auth, backend.clone(), spy());
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
        let bridge = CloudBridge::with_backend(auth, backend.clone(), spy());
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
        let bridge = CloudBridge::with_backend(auth.clone(), backend, spy());
        bridge.perform_secure_logout().unwrap();
        assert!(auth.native_auth_snapshot().is_none());
        assert!(bridge.cutoff.is_vault_locked());
        assert!(bridge.cutoff.ssh_generation() >= 1);
    }

    #[tokio::test]
    async fn secure_logout_applies_cutoffs_even_when_auth_clear_fails() {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let backend = MockHttpBackend::new("{}");
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let bridge = CloudBridge::with_backend_cutoff(auth.clone(), backend, cutoff.clone(), spy());
        auth.poison_lock_for_tests();
        let err = bridge.perform_secure_logout();
        assert!(err.is_err());
        assert_eq!(cutoff.ssh_generation(), 1);
        assert!(cutoff.is_vault_locked());
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
