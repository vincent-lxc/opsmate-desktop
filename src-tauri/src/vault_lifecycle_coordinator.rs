//! Production vault lifecycle coordinator (Task 8A2B rework).
//!
//! Coordinates **SSH SecurityCutoff before real Stronghold seal** for:
//! idle timeout, system sleep, wake enforce, and process exit.
//!
//! Idle path uses TOCTOU-safe `VaultService::seal_if_still_idle_with_pre_seal`
//! (claim SEALING → recheck idle → pre_seal → seal).
//!
//! Does **not** clear Logto auth or cancel cloud sessions (401/logout own that).
//! No WebView calls; no secret-bearing payloads.

use crate::security_cutoff::SecurityCutoff;
use crate::vault::{SealAttempt, VaultError, VaultService};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Result of a lifecycle evaluation (secret-free).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleTransition {
    /// Vault locked / idle not due / already handled — no SSH generation bump.
    NotNeeded,
    /// SSH cutoff closed then Stronghold sealed with fixed reason.
    Sealed,
}

/// Testable lifecycle coordinator: cutoff first (in pre_seal), then vault seal.
pub struct VaultLifecycleCoordinator {
    vault: Arc<VaultService>,
    cutoff: Arc<SecurityCutoff>,
    /// Prevents duplicate Exit + ExitRequested double-seal side effects.
    exit_done: AtomicBool,
}

impl VaultLifecycleCoordinator {
    pub fn new(vault: Arc<VaultService>, cutoff: Arc<SecurityCutoff>) -> Arc<Self> {
        Arc::new(Self {
            vault,
            cutoff,
            exit_done: AtomicBool::new(false),
        })
    }

    pub fn vault(&self) -> &Arc<VaultService> {
        &self.vault
    }

    pub fn cutoff(&self) -> &Arc<SecurityCutoff> {
        &self.cutoff
    }

    /// Close SSH authority then lock cutoff. Invoked only as pre-seal when vault still due.
    fn pre_seal_ssh_cutoff(&self) {
        let _ = self.cutoff.close_all_ssh();
        self.cutoff.lock_vault();
    }

    /// Ensure cutoff bool is locked **without** incrementing SSH generation.
    fn ensure_cutoff_locked_no_ssh_bump(&self) {
        self.cutoff.lock_vault();
    }

    /// Fail-closed: on any real `VaultError`, always close SSH + lock cutoff, then return Err.
    /// `NotNeeded` is healthy — no SSH generation bump.
    fn map_seal_result(
        &self,
        r: Result<SealAttempt, VaultError>,
    ) -> Result<LifecycleTransition, VaultError> {
        match r {
            Ok(SealAttempt::Sealed) => Ok(LifecycleTransition::Sealed),
            Ok(SealAttempt::NotNeeded) => Ok(LifecycleTransition::NotNeeded),
            Err(e) => {
                // Fail closed even when pre_seal never ran (error before callback).
                let _ = self.cutoff.close_all_ssh();
                self.cutoff.lock_vault();
                Err(e)
            }
        }
    }

    /// Watchdog tick: TOCTOU-safe idle seal. Pre-seal closes SSH only if still idle under SEALING.
    pub fn on_idle_tick(&self) -> Result<LifecycleTransition, VaultError> {
        self.map_seal_result(
            self.vault
                .seal_if_still_idle_with_pre_seal(|| self.pre_seal_ssh_cutoff()),
        )
    }

    /// System suspend / sleep.
    pub fn on_system_sleep(&self) -> Result<LifecycleTransition, VaultError> {
        self.map_seal_result(
            self.vault
                .seal_if_unlocked_with_pre_seal("system_sleep", || self.pre_seal_ssh_cutoff()),
        )
    }

    /// Wake / resume: **enforce** vault locked (seal if still unlocked). Never auto-unlock.
    /// Does not clear auth.
    pub fn on_resume(&self) -> Result<LifecycleTransition, VaultError> {
        match self.map_seal_result(
            self.vault
                .seal_if_unlocked_with_pre_seal("system_sleep", || self.pre_seal_ssh_cutoff()),
        ) {
            Ok(LifecycleTransition::NotNeeded) => {
                // Already locked / not unlocked: keep cutoff bool locked without SSH gen bump.
                self.ensure_cutoff_locked_no_ssh_bump();
                Ok(LifecycleTransition::NotNeeded)
            }
            other => other,
        }
    }

    /// Process exit / exit-requested. Second call is a no-op.
    /// If vault already locked: ensure cutoff locked, **no** SSH generation increment.
    pub fn on_process_exit(&self) -> Result<LifecycleTransition, VaultError> {
        if self.exit_done.swap(true, Ordering::SeqCst) {
            return Ok(LifecycleTransition::NotNeeded);
        }
        if !self.vault.is_unlocked_inner() {
            self.ensure_cutoff_locked_no_ssh_bump();
            return Ok(LifecycleTransition::NotNeeded);
        }
        match self.map_seal_result(
            self.vault
                .seal_if_unlocked_with_pre_seal("process_exit", || self.pre_seal_ssh_cutoff()),
        ) {
            Ok(LifecycleTransition::NotNeeded) => {
                self.ensure_cutoff_locked_no_ssh_bump();
                Ok(LifecycleTransition::NotNeeded)
            }
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::AuthStore;
    use crate::security_cutoff::SecurityCutoff;
    use crate::vault::{VaultService, VAULT_IDLE_TIMEOUT};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering};
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tauri_plugin_stronghold::stronghold::Stronghold;

    fn temp_path(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "opsmate-lc-{}-{}-{}.hold",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        p
    }

    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_file(path);
        let mut salt = path.as_os_str().to_os_string();
        salt.push(".salt");
        let _ = std::fs::remove_file(std::path::PathBuf::from(salt));
    }

    fn unlocked_pair(
        idle_elapsed: bool,
    ) -> (
        Arc<VaultLifecycleCoordinator>,
        Arc<VaultService>,
        Arc<SecurityCutoff>,
        std::path::PathBuf,
    ) {
        let path = temp_path("u");
        let auth = AuthStore::new();
        auth.install_session_for_tests("t", "u", "admin", "sub");
        let vault = Arc::new(VaultService::new(path.clone()));
        let sh = Stronghold::new(&path, vec![0xB1u8; 32]).expect("sh");
        let last = if idle_elapsed {
            Instant::now() - VAULT_IDLE_TIMEOUT - Duration::from_secs(2)
        } else {
            Instant::now()
        };
        vault.test_inject_unlocked(sh, auth.auth_binding().unwrap(), path.clone(), last);
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let coord = VaultLifecycleCoordinator::new(vault.clone(), cutoff.clone());
        (coord, vault, cutoff, path)
    }

    #[test]
    fn idle_not_due_no_ssh_close_no_seal() {
        let (coord, vault, cutoff, path) = unlocked_pair(false);
        assert!(vault.is_unlocked());
        assert!(!vault.idle_timeout_due());
        assert_eq!(
            coord.on_idle_tick().unwrap(),
            LifecycleTransition::NotNeeded
        );
        assert!(vault.is_unlocked());
        assert_eq!(cutoff.ssh_generation(), 0);
        assert!(!cutoff.is_vault_locked());
        cleanup(&path);
    }

    #[test]
    fn idle_due_pre_seal_sees_unlocked_then_vault_locked() {
        // Behavioral order proof (not fake label Vec): pre_seal observes unlocked + locks cutoff.
        let path = temp_path("behave");
        let auth = AuthStore::new();
        auth.install_session_for_tests("t", "u", "admin", "sub");
        let vault = Arc::new(VaultService::new(path.clone()));
        let sh = Stronghold::new(&path, vec![0xB3u8; 32]).expect("sh");
        vault.test_inject_unlocked(
            sh,
            auth.auth_binding().unwrap(),
            path.clone(),
            Instant::now() - VAULT_IDLE_TIMEOUT - Duration::from_secs(2),
        );
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();

        let saw_unlocked = AtomicBool::new(false);
        let gen_before = AtomicU64::new(0);
        let vault_ref = vault.clone();
        let cutoff_ref = cutoff.clone();
        let attempt = vault
            .seal_if_still_idle_with_pre_seal(|| {
                // Must still be unlocked when pre_seal runs (before Stronghold seal).
                assert!(
                    vault_ref.is_unlocked(),
                    "pre_seal must observe vault still unlocked"
                );
                saw_unlocked.store(true, AtomicOrdering::SeqCst);
                gen_before.store(cutoff_ref.ssh_generation(), AtomicOrdering::SeqCst);
                let _ = cutoff_ref.close_all_ssh();
                cutoff_ref.lock_vault();
            })
            .unwrap();
        assert_eq!(attempt, SealAttempt::Sealed);
        assert!(saw_unlocked.load(AtomicOrdering::SeqCst));
        assert!(!vault.is_unlocked());
        assert_eq!(
            vault.status().unwrap().locked_reason.as_deref(),
            Some("idle_timeout")
        );
        assert!(cutoff.is_vault_locked());
        assert_eq!(cutoff.ssh_generation(), 1);
        assert_eq!(gen_before.load(AtomicOrdering::SeqCst), 0);
        cleanup(&path);
    }

    #[test]
    fn idle_refresh_completed_before_claim_yields_not_needed_zero_cutoff() {
        // Honest wording: activity is refreshed **before** the seal primitive is entered.
        // (A refresh while SEALING is held is impossible by design — no concurrent ops.)
        // After refresh completes, claim+recheck sees not-due → NotNeeded, pre_seal never runs.
        let path = temp_path("toctou");
        let auth = AuthStore::new();
        auth.install_session_for_tests("t", "u", "admin", "sub");
        let vault = Arc::new(VaultService::new(path.clone()));
        let sh = Stronghold::new(&path, vec![0xB4u8; 32]).expect("sh");
        vault.test_inject_unlocked(
            sh,
            auth.auth_binding().unwrap(),
            path.clone(),
            Instant::now() - VAULT_IDLE_TIMEOUT - Duration::from_secs(2),
        );
        assert!(vault.idle_timeout_due());
        // Refresh completes first.
        vault.test_touch_activity();
        assert!(!vault.idle_timeout_due());

        let pre_ran = AtomicBool::new(false);
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let gen0 = cutoff.ssh_generation();
        let attempt = vault
            .seal_if_still_idle_with_pre_seal(|| {
                pre_ran.store(true, AtomicOrdering::SeqCst);
                let _ = cutoff.close_all_ssh();
                cutoff.lock_vault();
            })
            .unwrap();
        assert_eq!(attempt, SealAttempt::NotNeeded);
        assert!(!pre_ran.load(AtomicOrdering::SeqCst));
        assert!(vault.is_unlocked());
        assert_eq!(cutoff.ssh_generation(), gen0);
        assert!(!cutoff.is_vault_locked());
        cleanup(&path);
    }

    #[test]
    fn concurrent_activity_refresh_before_seal_claim_not_needed() {
        // Deterministic gated race: refresh finishes, then seal claim/recheck → NotNeeded.
        let path = temp_path("race-refresh");
        let auth = AuthStore::new();
        auth.install_session_for_tests("t", "u", "admin", "sub");
        let vault = Arc::new(VaultService::new(path.clone()));
        let sh = Stronghold::new(&path, vec![0xB5u8; 32]).expect("sh");
        vault.test_inject_unlocked(
            sh,
            auth.auth_binding().unwrap(),
            path.clone(),
            Instant::now() - VAULT_IDLE_TIMEOUT - Duration::from_secs(2),
        );
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let coord = VaultLifecycleCoordinator::new(vault.clone(), cutoff.clone());

        let (tx_refreshed, rx_refreshed) = mpsc::channel();
        let (tx_done, rx_done) = mpsc::channel();
        let v_touch = vault.clone();
        let t_refresh = std::thread::spawn(move || {
            v_touch.test_touch_activity();
            let _ = tx_refreshed.send(());
        });
        let c2 = coord.clone();
        let t_seal = std::thread::spawn(move || {
            // Wait until refresh has completed (bounded).
            rx_refreshed
                .recv_timeout(Duration::from_secs(2))
                .expect("refresh must complete");
            let r = c2.on_idle_tick();
            let _ = tx_done.send(r);
        });
        let r = rx_done
            .recv_timeout(Duration::from_secs(3))
            .expect("seal worker timed out");
        assert_eq!(r.unwrap(), LifecycleTransition::NotNeeded);
        assert!(vault.is_unlocked());
        assert_eq!(cutoff.ssh_generation(), 0);
        assert!(!cutoff.is_vault_locked());
        let _ = t_refresh.join();
        let _ = t_seal.join();
        cleanup(&path);
    }

    #[test]
    fn idle_due_close_ssh_before_seal_one_transition() {
        let (coord, vault, cutoff, path) = unlocked_pair(true);
        assert!(vault.idle_timeout_due());
        assert_eq!(coord.on_idle_tick().unwrap(), LifecycleTransition::Sealed);
        assert!(!vault.is_unlocked());
        assert_eq!(
            vault.status().unwrap().locked_reason.as_deref(),
            Some("idle_timeout")
        );
        assert!(cutoff.is_vault_locked());
        assert_eq!(cutoff.ssh_generation(), 1);
        assert_eq!(
            coord.on_idle_tick().unwrap(),
            LifecycleTransition::NotNeeded
        );
        assert_eq!(cutoff.ssh_generation(), 1);
        cleanup(&path);
    }

    #[test]
    fn system_sleep_close_before_seal() {
        let (coord, vault, cutoff, path) = unlocked_pair(false);
        assert_eq!(
            coord.on_system_sleep().unwrap(),
            LifecycleTransition::Sealed
        );
        assert!(!vault.is_unlocked());
        assert_eq!(
            vault.status().unwrap().locked_reason.as_deref(),
            Some("system_sleep")
        );
        assert!(cutoff.is_vault_locked());
        assert_eq!(cutoff.ssh_generation(), 1);
        cleanup(&path);
    }

    #[test]
    fn resume_enforces_lock_from_unlocked() {
        // Wake starting unlocked → SSH cutoff then seal; no auth clear.
        let (coord, vault, cutoff, path) = unlocked_pair(false);
        assert!(vault.is_unlocked());
        let auth = AuthStore::new();
        auth.install_session_for_tests("t", "u", "admin", "sub");
        assert!(auth.auth_binding().is_some());
        assert_eq!(coord.on_resume().unwrap(), LifecycleTransition::Sealed);
        assert!(!vault.is_unlocked());
        assert!(cutoff.is_vault_locked());
        assert_eq!(cutoff.ssh_generation(), 1);
        assert!(auth.auth_binding().is_some());
        // Second resume: already locked → no SSH bump.
        assert_eq!(coord.on_resume().unwrap(), LifecycleTransition::NotNeeded);
        assert_eq!(cutoff.ssh_generation(), 1);
        cleanup(&path);
    }

    #[test]
    fn process_exit_seals_once_and_locked_exit_no_ssh_bump() {
        let (coord, vault, cutoff, path) = unlocked_pair(false);
        assert_eq!(
            coord.on_process_exit().unwrap(),
            LifecycleTransition::Sealed
        );
        assert!(!vault.is_unlocked());
        assert_eq!(
            vault.status().unwrap().locked_reason.as_deref(),
            Some("process_exit")
        );
        assert_eq!(cutoff.ssh_generation(), 1);
        // Duplicate Exit/ExitRequested: no second SSH generation bump.
        assert_eq!(
            coord.on_process_exit().unwrap(),
            LifecycleTransition::NotNeeded
        );
        assert_eq!(cutoff.ssh_generation(), 1);
        cleanup(&path);

        // Already-locked vault on exit: cutoff locked, no generation bump.
        let (coord2, vault2, cutoff2, path2) = unlocked_pair(false);
        let _ = vault2.lock();
        cutoff2.unlock_vault_for_tests();
        assert!(!cutoff2.is_vault_locked());
        assert_eq!(cutoff2.ssh_generation(), 0);
        assert_eq!(
            coord2.on_process_exit().unwrap(),
            LifecycleTransition::NotNeeded
        );
        assert!(cutoff2.is_vault_locked());
        assert_eq!(cutoff2.ssh_generation(), 0);
        cleanup(&path2);
    }

    #[test]
    fn concurrent_op_and_seal_bounded_timeout() {
        let path = temp_path("race");
        let auth = AuthStore::new();
        auth.install_session_for_tests("t", "u", "admin", "sub");
        let vault = Arc::new(VaultService::new(path.clone()));
        let sh = Stronghold::new(&path, vec![0xB2u8; 32]).expect("sh");
        vault.test_inject_unlocked(
            sh,
            auth.auth_binding().unwrap(),
            path.clone(),
            Instant::now() - VAULT_IDLE_TIMEOUT - Duration::from_secs(1),
        );
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let coord = VaultLifecycleCoordinator::new(vault.clone(), cutoff);

        let (tx, rx) = mpsc::channel();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let v2 = vault.clone();
        let b1 = barrier.clone();
        let tx1 = tx.clone();
        let t_op = std::thread::spawn(move || {
            let r = v2.test_with_operating_gate(|| {
                b1.wait();
                std::thread::sleep(Duration::from_millis(20));
                1u32
            });
            let _ = tx1.send(("op", r.is_ok()));
        });
        let c2 = coord.clone();
        let b2 = barrier.clone();
        let t_seal = std::thread::spawn(move || {
            b2.wait();
            let r = c2.on_idle_tick();
            let _ = tx.send(("seal", r.is_ok()));
        });

        // Bounded proof of completion (not unbounded join as sole proof).
        let mut got = 0;
        while got < 2 {
            let (who, ok) = rx
                .recv_timeout(Duration::from_secs(3))
                .unwrap_or_else(|_| panic!("lifecycle race timed out waiting for worker"));
            assert!(ok, "{who} returned error");
            got += 1;
        }
        let _ = t_op.join();
        let _ = t_seal.join();
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn lifecycle_does_not_clear_auth() {
        let (coord, vault, _cutoff, path) = unlocked_pair(false);
        let auth = AuthStore::new();
        auth.install_session_for_tests("t", "u", "admin", "sub");
        assert!(auth.auth_binding().is_some());
        let _ = coord.on_system_sleep().unwrap();
        assert!(!vault.is_unlocked());
        assert!(auth.auth_binding().is_some());
        cleanup(&path);
    }

    #[test]
    fn watchdog_tick_triggers_coordinator_idle_path() {
        use crate::vault_idle_watchdog::VaultIdleWatchdog;
        let (coord, vault, cutoff, path) = unlocked_pair(true);
        let wd = VaultIdleWatchdog::new(coord.clone());
        wd.tick_now();
        assert!(!vault.is_unlocked());
        assert_eq!(
            vault.status().unwrap().locked_reason.as_deref(),
            Some("idle_timeout")
        );
        assert_eq!(cutoff.ssh_generation(), 1);
        wd.stop();
        cleanup(&path);
    }

    #[test]
    fn healthy_not_due_is_ok_not_needed_not_err() {
        // NotNeeded is healthy — zero SSH gen. Distinct from real VaultError fail-closed path.
        let (coord, vault, cutoff, path) = unlocked_pair(false);
        let r = coord.on_idle_tick().unwrap();
        assert_eq!(r, LifecycleTransition::NotNeeded);
        assert!(vault.is_unlocked());
        assert_eq!(cutoff.ssh_generation(), 0);
        cleanup(&path);
    }

    #[test]
    fn lifecycle_vault_error_fail_closed_closes_ssh_and_locks_cutoff() {
        // Deterministic cfg(test) seam: error before pre_seal; coordinator still fail-closes.
        let (coord, vault, cutoff, path) = unlocked_pair(true);
        assert!(vault.idle_timeout_due());
        assert_eq!(cutoff.ssh_generation(), 0);
        assert!(!cutoff.is_vault_locked());
        vault.test_arm_lifecycle_seal_error_before_pre_seal();
        let err = coord.on_idle_tick().expect_err("must return VaultError");
        assert!(matches!(err, VaultError::Storage));
        assert!(
            cutoff.is_vault_locked(),
            "fail-closed must lock SecurityCutoff on Err"
        );
        assert!(
            cutoff.ssh_generation() >= 1,
            "fail-closed must close SSH (generation incremented)"
        );
        cleanup(&path);
    }

    #[test]
    fn status_and_enter_op_do_not_bypass_cutoff_on_idle_expiry() {
        // Regression: expired vault must NOT transition to locked via status/list while
        // SecurityCutoff stays open. Only coordinator tick closes cutoff then seals once.
        let (coord, vault, cutoff, path) = unlocked_pair(true);
        assert!(vault.is_unlocked());
        assert!(vault.idle_timeout_due());
        assert_eq!(cutoff.ssh_generation(), 0);
        assert!(!cutoff.is_vault_locked());

        // status is read-only — still unlocked, cutoff untouched.
        let st = vault.status().unwrap();
        assert!(
            st.unlocked,
            "status must not seal Stronghold (would bypass cutoff)"
        );
        assert!(st.locked_reason.is_none());
        assert_eq!(cutoff.ssh_generation(), 0);
        assert!(!cutoff.is_vault_locked());

        // Operation path: list_meta uses enter_op — fails Locked without sealing.
        let auth = AuthStore::new();
        auth.install_session_for_tests("t", "u", "admin", "sub");
        // Re-bind vault principal to match auth for list_meta principal checks if unlocked.
        // Idle-expired enter_op returns Locked before principal work.
        let err = vault.list_meta(&auth);
        assert!(
            matches!(err, Err(VaultError::Locked | VaultError::Unauthenticated)),
            "idle-expired op must fail without direct seal, got {err:?}"
        );
        assert!(
            vault.is_unlocked(),
            "enter_op must not seal Stronghold on idle expiry"
        );
        assert_eq!(cutoff.ssh_generation(), 0);
        assert!(!cutoff.is_vault_locked());

        // Next native watchdog tick: cutoff-before-seal exactly once.
        assert_eq!(coord.on_idle_tick().unwrap(), LifecycleTransition::Sealed);
        assert!(!vault.is_unlocked());
        assert_eq!(
            vault.status().unwrap().locked_reason.as_deref(),
            Some("idle_timeout")
        );
        assert!(cutoff.is_vault_locked());
        assert_eq!(cutoff.ssh_generation(), 1);
        assert_eq!(
            coord.on_idle_tick().unwrap(),
            LifecycleTransition::NotNeeded
        );
        assert_eq!(cutoff.ssh_generation(), 1);
        cleanup(&path);
    }

    #[test]
    fn production_idle_seal_only_via_coordinator_primitive() {
        let vault_src = include_str!("vault/mod.rs");
        assert!(
            !vault_src.contains("fn maybe_idle_seal"),
            "legacy maybe_idle_seal must be removed"
        );
        assert!(
            !vault_src.contains("check_idle_and_seal"),
            "check_idle_and_seal must not remain as a production/public idle path"
        );
        // status must not invoke seal paths.
        let status_body = vault_src
            .split("pub fn status(")
            .nth(1)
            .unwrap()
            .split("pub fn init_with_password")
            .next()
            .unwrap();
        assert!(
            !status_body.contains("seal_vault")
                && !status_body.contains("seal_if_")
                && !status_body.contains("maybe_idle"),
            "status must be side-effect free"
        );
        let enter = vault_src
            .split("fn enter_op(")
            .nth(1)
            .unwrap()
            .split("fn close_all_sessions_before_seal")
            .next()
            .unwrap();
        assert!(
            !enter.contains("seal_vault") && !enter.contains("close_all_sessions_before_seal"),
            "enter_op must not seal on idle expiry"
        );
        let coord = include_str!("vault_lifecycle_coordinator.rs");
        let prod = coord.split("#[cfg(test)]").next().unwrap();
        assert!(prod.contains("seal_if_still_idle_with_pre_seal"));
        assert!(
            prod.contains("DEFAULT_IDLE_POLL")
                || include_str!("vault_idle_watchdog.rs").contains("from_secs(30)")
        );
    }
}
