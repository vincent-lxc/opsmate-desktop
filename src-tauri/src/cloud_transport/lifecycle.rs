//! Session invalidation lifecycle (401) — hooks for auth clear, SSH, vault.
//!
//! Task 8 modules do not exist yet: production wiring is 6B2/Task8.
//! This module defines the ordered hook trait + cancellation generation only.
//! Do not claim real SSH/vault closure here.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::sync::watch;

/// Ordered security hooks invoked once per session epoch on 401 invalidation.
///
/// Exact order (enforced by `InvalidationControl::run_401_lifecycle_once`):
/// 1. cancel in-flight / queued requests
/// 2. `mark_reauth_required_and_clear_auth` (cannot be skipped)
/// 3. `close_all_ssh` (attempted even if it errors)
/// 4. `lock_vault` (attempted even if it errors)
/// 5. `emit_session_invalidated` (secret-free)
pub trait SessionLifecycleHooks: Send + Sync {
    /// Mark reauth required and clear native auth session (always runs on 401).
    fn mark_reauth_required_and_clear_auth(&self);

    /// Close all SSH sessions. Errors are ignored so later hooks still run.
    fn close_all_ssh(&self) -> Result<(), ()>;

    /// Lock vault. Errors are ignored so later hooks still run.
    fn lock_vault(&self) -> Result<(), ()>;

    /// Emit secret-free session-invalidated signal (no token/body/URL).
    fn emit_session_invalidated(&self);
}

/// No-op hooks for reject-path unit tests that do not exercise 401.
/// Production must never default to this — 401 would silently skip real cleanup.
#[cfg(test)]
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopLifecycleHooks;

#[cfg(test)]
impl SessionLifecycleHooks for NoopLifecycleHooks {
    fn mark_reauth_required_and_clear_auth(&self) {}
    fn close_all_ssh(&self) -> Result<(), ()> {
        Ok(())
    }
    fn lock_vault(&self) -> Result<(), ()> {
        Ok(())
    }
    fn emit_session_invalidated(&self) {}
}

/// Cancellation + session-epoch control owned by Rust (not WebView).
///
/// Cancellation uses a `tokio::sync::watch` generation channel so the current
/// generation is durable: waiters observe cancel even if it happened before they
/// polled (no Notify lost-wakeup race).
///
/// - `session_epoch` identifies authenticated session generations for 401 dedup.
/// - Lifecycle and `begin_session_epoch` share one mutex so an old-session
///   lifecycle cannot clear a newly established session.
pub struct InvalidationControl {
    cancel_tx: watch::Sender<u64>,
    session_epoch: AtomicU64,
    /// Epoch for which 401 lifecycle already completed (`0` = none).
    lifecycle_done_epoch: AtomicU64,
    /// Serializes 401 lifecycle and session epoch bumps.
    lifecycle_lock: Mutex<()>,
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
            // Start at 1 so "done epoch 0" means no lifecycle yet.
            session_epoch: AtomicU64::new(1),
            lifecycle_done_epoch: AtomicU64::new(0),
            lifecycle_lock: Mutex::new(()),
        }
    }

    /// Snapshot cancellation generation at call start.
    pub fn cancel_generation(&self) -> u64 {
        *self.cancel_tx.borrow()
    }

    pub fn session_epoch(&self) -> u64 {
        self.session_epoch.load(Ordering::SeqCst)
    }

    /// True if cancellation generation changed since `start_gen`.
    pub fn is_cancelled(&self, start_gen: u64) -> bool {
        *self.cancel_tx.borrow() != start_gen
    }

    /// Wait until cancellation generation differs from `start_gen`.
    ///
    /// Uses watch's durable observed state — safe if cancel already happened.
    pub async fn cancelled(&self, start_gen: u64) {
        let mut rx = self.cancel_tx.subscribe();
        if *rx.borrow_and_update() != start_gen {
            return;
        }
        loop {
            if rx.changed().await.is_err() {
                // Sender dropped — treat as terminal cancel.
                return;
            }
            if *rx.borrow_and_update() != start_gen {
                return;
            }
        }
    }

    /// Abort in-flight and fail-closed queued work (no hooks).
    pub fn cancel_inflight(&self) {
        self.cancel_tx.send_modify(|g| *g = g.wrapping_add(1));
    }

    /// Begin a new authenticated session epoch (allows a future 401 lifecycle).
    ///
    /// Serialized with `run_401_lifecycle_once` so an in-flight old-session
    /// lifecycle cannot interleave with establishing a new session.
    pub fn begin_session_epoch(&self) {
        let _guard = self
            .lifecycle_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.session_epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Run 401 lifecycle exactly once for the current session epoch.
    /// Concurrent callers for the same epoch skip duplicate hooks.
    ///
    /// Returns `true` if this caller executed the hooks, `false` if deduped.
    pub fn run_401_lifecycle_once<H: SessionLifecycleHooks>(&self, hooks: &H) -> bool {
        let _guard = self
            .lifecycle_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let epoch = self.session_epoch.load(Ordering::SeqCst);
        if self.lifecycle_done_epoch.load(Ordering::SeqCst) == epoch {
            return false;
        }

        // 1. Cancel requests (durable generation bump).
        self.cancel_tx.send_modify(|g| *g = g.wrapping_add(1));

        // 2. Auth clear — cannot be skipped.
        hooks.mark_reauth_required_and_clear_auth();

        // 3–4. Attempt even if earlier non-auth hook errors.
        let _ = hooks.close_all_ssh();
        let _ = hooks.lock_vault();

        // 5. Secret-free emit.
        hooks.emit_session_invalidated();

        self.lifecycle_done_epoch.store(epoch, Ordering::SeqCst);
        true
    }
}

#[cfg(test)]
mod spy {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

    /// Test spy recording ordered lifecycle events.
    #[derive(Debug, Default)]
    pub struct SpyLifecycleHooks {
        pub events: Mutex<Vec<&'static str>>,
        pub fail_ssh: AtomicBool,
        pub fail_vault: AtomicBool,
        pub reauth_marked: AtomicBool,
    }

    impl SpyLifecycleHooks {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn events(&self) -> Vec<&'static str> {
            self.events.lock().map(|g| g.clone()).unwrap_or_default()
        }
    }

    impl SessionLifecycleHooks for SpyLifecycleHooks {
        fn mark_reauth_required_and_clear_auth(&self) {
            self.reauth_marked.store(true, Ordering::SeqCst);
            if let Ok(mut g) = self.events.lock() {
                g.push("mark_reauth_required_and_clear_auth");
            }
        }

        fn close_all_ssh(&self) -> Result<(), ()> {
            if let Ok(mut g) = self.events.lock() {
                g.push("close_all_ssh");
            }
            if self.fail_ssh.load(Ordering::SeqCst) {
                Err(())
            } else {
                Ok(())
            }
        }

        fn lock_vault(&self) -> Result<(), ()> {
            if let Ok(mut g) = self.events.lock() {
                g.push("lock_vault");
            }
            if self.fail_vault.load(Ordering::SeqCst) {
                Err(())
            } else {
                Ok(())
            }
        }

        fn emit_session_invalidated(&self) {
            if let Ok(mut g) = self.events.lock() {
                g.push("emit_session_invalidated");
            }
        }
    }
}

#[cfg(test)]
pub use spy::SpyLifecycleHooks;
