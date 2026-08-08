//! Unified security cutoff for 401 / logout / session transition.
//!
//! Binds real `LocalSshSessionManager` and `VaultService` — no hollow SSH stubs.
//! Exact 401 order (plan):
//!   close_all_ssh → lock_vault → clear_auth → emit_session_invalidated

use crate::auth::{AuthStore, NativePrincipal};
use crate::cloud_terminal::CloudTerminalSessionManager;
use crate::ssh_registry::LocalSshSessionManager;
use crate::vault::{SessionLifecycleSink, VaultService};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Required secret-free session-invalidated emitter (never optional).
pub trait SessionInvalidatedEmitter: Send + Sync {
    fn emit_session_invalidated(&self);
}

impl SessionInvalidatedEmitter for Arc<dyn SessionInvalidatedEmitter> {
    fn emit_session_invalidated(&self) {
        (**self).emit_session_invalidated()
    }
}

/// Ordered security actions invoked on 401 / session invalidation.
pub trait SecurityActions: Send + Sync {
    fn close_all_ssh(&self);
    fn lock_vault(&self);
    fn clear_auth(&self);
    fn emit_session_invalidated(&self);
}

/// Run the plan-mandated cutoff order. Fail-closed: each step is best-effort.
pub fn run_session_invalidation_cutoff<A: SecurityActions + ?Sized>(actions: &A) {
    actions.close_all_ssh();
    actions.lock_vault();
    actions.clear_auth();
    actions.emit_session_invalidated();
}

/// Process-wide SSH generation watermark + production cutoff bindings.
#[derive(Debug)]
pub struct SecurityCutoff {
    /// Incremented on every SSH close_all (401 / logout / session transition).
    ssh_generation: AtomicU64,
}

impl SecurityCutoff {
    pub fn new() -> Self {
        Self {
            ssh_generation: AtomicU64::new(0),
        }
    }

    pub fn close_all_ssh_generation(&self) -> u64 {
        self.ssh_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    #[cfg(test)]
    pub fn ssh_generation(&self) -> u64 {
        self.ssh_generation.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub fn ssh_session_still_valid(&self, captured_gen: u64) -> bool {
        self.ssh_generation() == captured_gen
    }
}

impl Default for SecurityCutoff {
    fn default() -> Self {
        Self::new()
    }
}

/// Production hooks: real SSH close_all + Stronghold seal + auth clear + emit.
pub struct ProductionSecurityCutoff {
    pub cutoff: Arc<SecurityCutoff>,
    pub ssh: Arc<LocalSshSessionManager>,
    pub cloud_terminal: Arc<CloudTerminalSessionManager>,
    pub vault: Arc<VaultService>,
    pub auth: Arc<AuthStore>,
    pub emitter: Arc<dyn SessionInvalidatedEmitter>,
}

impl ProductionSecurityCutoff {
    pub fn new(
        cutoff: Arc<SecurityCutoff>,
        ssh: Arc<LocalSshSessionManager>,
        cloud_terminal: Arc<CloudTerminalSessionManager>,
        vault: Arc<VaultService>,
        auth: Arc<AuthStore>,
        emitter: Arc<dyn SessionInvalidatedEmitter>,
    ) -> Self {
        Self {
            cutoff,
            ssh,
            cloud_terminal,
            vault,
            auth,
            emitter,
        }
    }
}

impl SecurityActions for ProductionSecurityCutoff {
    fn close_all_ssh(&self) {
        let _ = self.cutoff.close_all_ssh_generation();
        self.ssh.close_all();
        self.cloud_terminal.close_all();
    }

    fn lock_vault(&self) {
        let _ = self.vault.on_logout();
    }

    fn clear_auth(&self) {
        let _ = self.auth.clear_native();
    }

    fn emit_session_invalidated(&self) {
        self.emitter.emit_session_invalidated();
    }
}

impl SecurityActions for Arc<ProductionSecurityCutoff> {
    fn close_all_ssh(&self) {
        (**self).close_all_ssh()
    }
    fn lock_vault(&self) {
        (**self).lock_vault()
    }
    fn clear_auth(&self) {
        (**self).clear_auth()
    }
    fn emit_session_invalidated(&self) {
        (**self).emit_session_invalidated()
    }
}

/// Tauri event name for session invalidation (secret-free).
pub const SESSION_INVALIDATED_EVENT: &str = "opsmate:session-invalidated";

/// Vault sleep / idle / seal sink: close **local + cloud** terminals before Stronghold seal.
pub struct CompositeTerminalLifecycleSink {
    pub local: Arc<LocalSshSessionManager>,
    pub cloud: Arc<CloudTerminalSessionManager>,
    /// Test-only order recorder (production leaves `None`).
    #[cfg_attr(not(test), allow(dead_code))]
    pub order: Option<Arc<Mutex<Vec<&'static str>>>>,
}

impl CompositeTerminalLifecycleSink {
    pub fn new(
        local: Arc<LocalSshSessionManager>,
        cloud: Arc<CloudTerminalSessionManager>,
    ) -> Self {
        Self {
            local,
            cloud,
            order: None,
        }
    }

    fn note(&self, step: &'static str) {
        if let Some(log) = &self.order {
            if let Ok(mut g) = log.lock() {
                g.push(step);
            }
        }
    }
}

impl SessionLifecycleSink for CompositeTerminalLifecycleSink {
    fn close_all_sessions(&self) {
        self.note("close_local");
        self.local.close_all();
        self.note("close_cloud");
        self.cloud.close_all();
    }

    fn close_sessions_for_credential(&self, principal: &NativePrincipal, credential_id: &str) {
        // Cloud terminal is server-scoped (no vault credential binding); only local is filtered.
        self.local
            .close_for_principal_credential(principal, credential_id);
    }
}

/// Exact logout / unauthorized teardown order used by IPC handlers:
/// close local → close cloud → seal vault → clear auth.
pub fn run_auth_session_teardown(
    close_local: impl FnOnce(),
    close_cloud: impl FnOnce(),
    seal_vault: impl FnOnce(),
    clear_auth: impl FnOnce(),
) {
    close_local();
    close_cloud();
    seal_vault();
    clear_auth();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingActions {
        events: Mutex<Vec<&'static str>>,
    }

    impl SecurityActions for RecordingActions {
        fn close_all_ssh(&self) {
            self.events.lock().unwrap().push("close_all_ssh");
        }
        fn lock_vault(&self) {
            self.events.lock().unwrap().push("lock_vault");
        }
        fn clear_auth(&self) {
            self.events.lock().unwrap().push("clear_auth");
        }
        fn emit_session_invalidated(&self) {
            self.events.lock().unwrap().push("emit_session_invalidated");
        }
    }

    #[test]
    fn cutoff_order_is_exact() {
        let a = RecordingActions::default();
        run_session_invalidation_cutoff(&a);
        assert_eq!(
            *a.events.lock().unwrap(),
            vec![
                "close_all_ssh",
                "lock_vault",
                "clear_auth",
                "emit_session_invalidated",
            ]
        );
    }

    #[test]
    fn ssh_generation_advances() {
        let c = SecurityCutoff::new();
        assert_eq!(c.ssh_generation(), 0);
        let g = c.close_all_ssh_generation();
        assert_eq!(g, 1);
        assert!(!c.ssh_session_still_valid(0));
        assert!(c.ssh_session_still_valid(1));
    }

    #[test]
    fn composite_lifecycle_sink_closes_local_and_cloud_before_vault_would_seal() {
        use crate::auth::AuthStore;
        use crate::cloud_terminal::{
            ActorCmd, CloudServerEvent, CloudTerminalConnector, CloudTerminalOpenRequest,
            CloudTerminalSessionManager,
        };
        use crate::ssh_ipc::{LocalSshOutputEmitter, RecordingEmitter};
        use crate::ssh_registry::LocalSshSessionManager;
        use crate::vault::SessionLifecycleSink;
        use std::sync::Mutex;
        use tokio::sync::mpsc;

        struct ReadyConnector;
        impl CloudTerminalConnector for ReadyConnector {
            fn fetch_ws_token(
                &self,
                _: &str,
            ) -> Result<String, crate::ssh_session::SshSessionError> {
                Ok("t".into())
            }
            fn connect(
                &self,
                _: &str,
                _: &str,
                mut cmd_rx: mpsc::Receiver<ActorCmd>,
                on_event: Arc<dyn Fn(CloudServerEvent) + Send + Sync>,
            ) -> Result<(), crate::ssh_session::SshSessionError> {
                on_event(CloudServerEvent::Ready);
                while let Some(cmd) = cmd_rx.blocking_recv() {
                    if matches!(cmd, ActorCmd::Close) {
                        break;
                    }
                }
                on_event(CloudServerEvent::SocketClosed);
                Ok(())
            }
        }

        struct FixedRng;
        impl crate::auth::RandomSource for FixedRng {
            fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), crate::auth::AuthError> {
                for (i, b) in dest.iter_mut().enumerate() {
                    *b = i as u8;
                }
                Ok(())
            }
        }

        let auth = AuthStore::new();
        auth.install_session_for_tests("t", "u", "admin");
        let local = Arc::new(LocalSshSessionManager::new());
        let cloud = Arc::new(CloudTerminalSessionManager::new());
        let emitter: Arc<dyn LocalSshOutputEmitter> = Arc::new(RecordingEmitter::new());
        let connector: Arc<dyn CloudTerminalConnector> = Arc::new(ReadyConnector);
        let _ = cloud
            .open_session(
                &auth,
                &CloudTerminalOpenRequest {
                    server_id: "srv".into(),
                },
                connector,
                emitter,
                &FixedRng,
                None,
            )
            .expect("cloud open");
        assert_eq!(cloud.session_count(), 1);

        let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let sink = CompositeTerminalLifecycleSink {
            local: Arc::clone(&local),
            cloud: Arc::clone(&cloud),
            order: Some(Arc::clone(&order)),
        };
        // Lifecycle seal path (sleep / idle / exit vault.lock) must close every terminal transport.
        sink.close_all_sessions();
        assert_eq!(cloud.session_count(), 0);
        let steps = order.lock().unwrap().clone();
        assert!(
            steps.contains(&"close_local") && steps.contains(&"close_cloud"),
            "expected local+cloud close, got {steps:?}"
        );
    }

    #[test]
    fn auth_teardown_order_closes_terminals_before_vault_and_auth_clear() {
        let log = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let log2 = Arc::clone(&log);
        run_auth_session_teardown(
            || log2.lock().unwrap().push("close_local"),
            || log2.lock().unwrap().push("close_cloud"),
            || log2.lock().unwrap().push("seal_vault"),
            || log2.lock().unwrap().push("clear_auth"),
        );
        assert_eq!(
            *log.lock().unwrap(),
            vec!["close_local", "close_cloud", "seal_vault", "clear_auth"]
        );
    }
}
