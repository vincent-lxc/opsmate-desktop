//! Proactive vault idle seal watchdog (D4B1 repair).
//!
//! Production: background poll thread calls `VaultService::check_idle_and_seal`.
//! Tests: use `tick_now()` only — no 15-minute sleep, no immortal threads.

use crate::vault::VaultService;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Default production poll interval (not the idle timeout itself).
pub const DEFAULT_IDLE_POLL: Duration = Duration::from_secs(30);

/// Runtime observer that seals an idle vault even when WebView is quiet.
pub struct VaultIdleWatchdog {
    vault: Arc<VaultService>,
    stop: Arc<AtomicBool>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl VaultIdleWatchdog {
    pub fn new(vault: Arc<VaultService>) -> Arc<Self> {
        Arc::new(Self {
            vault,
            stop: Arc::new(AtomicBool::new(false)),
            join: Mutex::new(None),
        })
    }

    /// Deterministic test/control path: one idle evaluation without sleeping.
    pub fn tick_now(&self) {
        let _ = self.vault.check_idle_and_seal();
    }

    /// Spawn a bounded poller. Safe to call once; subsequent calls are no-ops.
    /// Thread exits when `stop()` is called or process ends.
    pub fn spawn_background(self: &Arc<Self>, poll: Duration) {
        let mut slot = match self.join.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if slot.is_some() {
            return;
        }
        let vault = Arc::clone(&self.vault);
        let stop = Arc::clone(&self.stop);
        let poll = if poll.is_zero() {
            DEFAULT_IDLE_POLL
        } else {
            poll
        };
        *slot = Some(thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                let _ = vault.check_idle_and_seal();
                // Park in small slices so stop is responsive.
                let slice = Duration::from_millis(100).min(poll);
                let mut waited = Duration::ZERO;
                while waited < poll && !stop.load(Ordering::SeqCst) {
                    thread::sleep(slice);
                    waited = waited.saturating_add(slice);
                }
            }
        }));
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut g) = self.join.lock() {
            if let Some(h) = g.take() {
                let _ = h.join();
            }
        }
    }
}

impl Drop for VaultIdleWatchdog {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Best-effort join without blocking forever on poisoned mutex.
        if let Ok(mut g) = self.join.lock() {
            if let Some(h) = g.take() {
                let _ = h.join();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::AuthStore;
    use crate::ssh_registry::{LocalSshConnector, LocalSshSessionManager, LocalSshTransport};
    use crate::ssh_session::{PreparedSshTarget, SshSessionError};
    use crate::vault::VAULT_IDLE_TIMEOUT;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Instant;

    struct NopTransport {
        closes: Arc<AtomicUsize>,
        closed: AtomicBool,
    }
    impl LocalSshTransport for NopTransport {
        fn write(&self, _: &[u8]) -> Result<(), SshSessionError> {
            Ok(())
        }
        fn resize(&self, _: u32, _: u32) -> Result<(), SshSessionError> {
            Ok(())
        }
        fn close(&self) -> Result<(), SshSessionError> {
            if !self.closed.swap(true, Ordering::SeqCst) {
                self.closes.fetch_add(1, Ordering::SeqCst);
            }
            Ok(())
        }
    }
    struct NopConnector {
        closes: Arc<AtomicUsize>,
    }
    impl LocalSshConnector for NopConnector {
        fn connect(
            &self,
            _: &PreparedSshTarget,
        ) -> Result<Arc<dyn LocalSshTransport>, SshSessionError> {
            Ok(Arc::new(NopTransport {
                closes: Arc::clone(&self.closes),
                closed: AtomicBool::new(false),
            }))
        }
    }

    #[test]
    fn vault_idle_watchdog_tick_closes_sessions_without_status_api() {
        let path = std::env::temp_dir().join(format!(
            "opsmate-watchdog-{}-{}.hold",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let auth = AuthStore::new();
        auth.install_session_for_tests("tnt", "user", "admin");
        let vault = Arc::new(crate::vault::VaultService::new(path.clone()));
        let mgr = Arc::new(LocalSshSessionManager::new());
        vault.set_session_lifecycle_sink(mgr.clone());

        let closes = Arc::new(AtomicUsize::new(0));
        let conn = NopConnector {
            closes: Arc::clone(&closes),
        };
        let snap = auth.native_auth_snapshot().unwrap();
        let target = PreparedSshTarget {
            server_id: "s".into(),
            name: "n".into(),
            host: "1.1.1.1".into(),
            port: 22,
            username: "u".into(),
            credential_id: "c".into(),
            host_key_status: crate::ssh_session::HostKeyStatus::Unpinned,
            host_key_type: None,
            host_key_fingerprint: None,
            principal: snap.principal.clone(),
            session_epoch: snap.epoch,
        };
        let rng = crate::auth::SecRandomSource;
        mgr.open_session(&auth, &target, &conn, &rng).unwrap();
        assert_eq!(mgr.session_count(), 1);

        {
            use tauri_plugin_stronghold::stronghold::Stronghold;
            let sh = Stronghold::new(&path, vec![0x77u8; 32]).unwrap();
            sh.create_client(b"opsmate-vault-client").unwrap();
            vault.test_inject_unlocked(
                sh,
                snap.principal.clone(),
                path.clone(),
                Instant::now() - VAULT_IDLE_TIMEOUT - Duration::from_secs(2),
            );
        }

        let wd = VaultIdleWatchdog::new(vault.clone());
        // Sole trigger path: watchdog tick — not status/list/import/delete.
        wd.tick_now();

        assert_eq!(mgr.session_count(), 0);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        // Peek locked without calling maybe_idle again via status's side effects is ok;
        // but task forbids status as the *trigger*. Reading after is fine for assertion.
        let st = vault.status().unwrap();
        assert!(!st.unlocked);
        assert_eq!(st.locked_reason.as_deref(), Some("idle_timeout"));

        wd.stop();
        let _ = std::fs::remove_file(&path);
    }
}
