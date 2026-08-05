//! Session invalidation lifecycle (401) — auth-epoch high-watermark design.
//!
//! Cancel and lifecycle completion use **bounded atomic watermarks** (not HashSets):
//! - `cancelled_through`: all auth epochs `<=` this value are cancelled
//! - `lifecycle_done_through`: lifecycle already ran for all epochs `<=` this value
//!
//! Monotonic auth epochs + out-of-order stale 401 (e.g. E3 then E2) are safe.
//! Strictly newer epochs remain unaffected until their own watermark advance.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::sync::watch;

/// Ordered security hooks for 401 invalidation of a specific auth epoch.
///
/// Exact order:
/// 1. cancel in-flight/queued for epochs `<=` request epoch (watermark)
/// 2. `try_clear_auth_for_epoch`
/// 3. On `Ok(true)` or `Err` (fail closed): SSH → vault → emit
///    On `Ok(false)` (genuine stale): skip SSH/vault/emit
pub trait SessionLifecycleHooks: Send + Sync {
    /// `Ok(true)` cleared current; `Ok(false)` stale; `Err` internal/untrusted.
    /// Unit `Err` is intentional: callers map to fixed public codes without payload leakage.
    #[allow(clippy::result_unit_err)]
    fn try_clear_auth_for_epoch(&self, epoch: u64) -> Result<bool, ()>;
    #[allow(clippy::result_unit_err)] // secret-free fail-closed; no error payload
    fn close_all_ssh(&self) -> Result<(), ()>;
    #[allow(clippy::result_unit_err)] // secret-free fail-closed; no error payload
    fn lock_vault(&self) -> Result<(), ()>;
    fn emit_session_invalidated(&self);
}

#[cfg(test)]
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopLifecycleHooks;

#[cfg(test)]
impl SessionLifecycleHooks for NoopLifecycleHooks {
    fn try_clear_auth_for_epoch(&self, _epoch: u64) -> Result<bool, ()> {
        Ok(true)
    }
    fn close_all_ssh(&self) -> Result<(), ()> {
        Ok(())
    }
    fn lock_vault(&self) -> Result<(), ()> {
        Ok(())
    }
    fn emit_session_invalidated(&self) {}
}

/// Cancellation + 401 lifecycle control (auth-epoch high-watermark).
pub struct InvalidationControl {
    cancel_tx: watch::Sender<u64>,
    /// All auth epochs `<=` this value have been cancelled (monotonic watermark).
    cancelled_through: AtomicU64,
    /// Global logout generation (cancels every waiter).
    global_cancel_gen: AtomicU64,
    /// Lifecycle completed for all epochs `<=` this value.
    lifecycle_done_through: AtomicU64,
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
            cancelled_through: AtomicU64::new(0),
            global_cancel_gen: AtomicU64::new(0),
            lifecycle_done_through: AtomicU64::new(0),
            lifecycle_lock: Mutex::new(()),
        }
    }

    pub fn cancel_generation(&self) -> u64 {
        *self.cancel_tx.borrow()
    }

    pub fn global_cancel_generation(&self) -> u64 {
        self.global_cancel_gen.load(Ordering::SeqCst)
    }

    pub fn cancelled_through(&self) -> u64 {
        self.cancelled_through.load(Ordering::SeqCst)
    }

    pub fn lifecycle_done_through(&self) -> u64 {
        self.lifecycle_done_through.load(Ordering::SeqCst)
    }

    pub fn waiter_token(&self, auth_epoch: Option<u64>) -> CancelWaitToken {
        CancelWaitToken {
            auth_epoch,
            start_global: self.global_cancel_generation(),
        }
    }

    /// Epoch cancelled if watermark covers it; all waiters cancelled on global logout.
    pub fn is_cancelled_token(&self, token: &CancelWaitToken) -> bool {
        if self.global_cancel_generation() != token.start_global {
            return true;
        }
        match token.auth_epoch {
            None => false,
            Some(epoch) => self.cancelled_through() >= epoch,
        }
    }

    pub async fn cancelled_token(&self, token: CancelWaitToken) {
        let mut rx = self.cancel_tx.subscribe();
        loop {
            if self.is_cancelled_token(&token) {
                return;
            }
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// Raise cancel watermark to at least `auth_epoch` (401 path).
    pub fn cancel_auth_epoch(&self, auth_epoch: u64) {
        self.cancelled_through
            .fetch_max(auth_epoch, Ordering::SeqCst);
        self.cancel_tx.send_modify(|g| *g = g.wrapping_add(1));
    }

    /// Cancel all waiters (logout / session transition).
    pub fn cancel_all(&self) {
        self.global_cancel_gen.fetch_add(1, Ordering::SeqCst);
        // Raise watermark to max so any finite epoch is covered under global path via gen.
        self.cancel_tx.send_modify(|g| *g = g.wrapping_add(1));
    }

    pub fn cancel_inflight(&self) {
        self.cancel_all();
    }

    /// Run 401 lifecycle once for `auth_epoch` (dedupe via watermark).
    /// Returns true if this caller executed the lifecycle body (not deduped).
    pub fn run_401_for_auth_epoch<H: SessionLifecycleHooks>(
        &self,
        auth_epoch: u64,
        hooks: &H,
    ) -> bool {
        let _guard = self
            .lifecycle_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        if self.lifecycle_done_through.load(Ordering::SeqCst) >= auth_epoch {
            // Still ensure cancel watermark covers this epoch for any stragglers.
            self.cancel_auth_epoch(auth_epoch);
            return false;
        }

        // 1. Cancel same/older epochs (watermark).
        self.cancel_auth_epoch(auth_epoch);

        // 2. Conditional auth clear — distinguish stale vs failure.
        let apply_cutoffs = match hooks.try_clear_auth_for_epoch(auth_epoch) {
            Ok(true) => true,   // current epoch cleared
            Ok(false) => false, // genuine stale — leave newer session alone
            Err(()) => true,    // fail closed — auth untrusted
        };

        if apply_cutoffs {
            let _ = hooks.close_all_ssh();
            let _ = hooks.lock_vault();
            hooks.emit_session_invalidated();
        }

        self.lifecycle_done_through
            .fetch_max(auth_epoch, Ordering::SeqCst);
        true
    }
}

/// Opaque cancel wait state for one cloud call.
#[derive(Debug, Clone, Copy)]
pub struct CancelWaitToken {
    pub auth_epoch: Option<u64>,
    /// Global logout generation at call start (durable cancel for logout).
    pub start_global: u64,
}

#[cfg(test)]
mod spy {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

    #[derive(Debug, Default)]
    pub struct SpyLifecycleHooks {
        pub events: Mutex<Vec<&'static str>>,
        pub fail_ssh: AtomicBool,
        pub fail_vault: AtomicBool,
        pub reauth_marked: AtomicBool,
        pub cleared_epochs: Mutex<Vec<u64>>,
        pub clear_only_epoch: Mutex<Option<u64>>,
        pub always_clear: AtomicBool,
    }

    impl SpyLifecycleHooks {
        pub fn new() -> Self {
            let s = Self::default();
            s.always_clear.store(true, Ordering::SeqCst);
            s
        }

        pub fn events(&self) -> Vec<&'static str> {
            self.events.lock().map(|g| g.clone()).unwrap_or_default()
        }
    }

    impl SessionLifecycleHooks for SpyLifecycleHooks {
        fn try_clear_auth_for_epoch(&self, epoch: u64) -> Result<bool, ()> {
            if let Ok(mut g) = self.events.lock() {
                g.push("try_clear_auth_for_epoch");
            }
            if let Ok(only) = self.clear_only_epoch.lock() {
                if let Some(e) = *only {
                    if e != epoch {
                        return Ok(false);
                    }
                }
            }
            if !self.always_clear.load(Ordering::SeqCst) {
                return Err(());
            }
            self.reauth_marked.store(true, Ordering::SeqCst);
            if let Ok(mut g) = self.cleared_epochs.lock() {
                g.push(epoch);
            }
            Ok(true)
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

    /// Records cancel watermark advances for order tests (wraps real control).
    #[derive(Debug, Default)]
    pub struct OrderedSpyHooks {
        pub inner: SpyLifecycleHooks,
        pub order: Mutex<Vec<&'static str>>,
    }

    impl OrderedSpyHooks {
        pub fn new() -> Self {
            Self {
                inner: SpyLifecycleHooks::new(),
                order: Mutex::new(Vec::new()),
            }
        }
        pub fn order(&self) -> Vec<&'static str> {
            self.order.lock().map(|g| g.clone()).unwrap_or_default()
        }
    }

    impl SessionLifecycleHooks for OrderedSpyHooks {
        fn try_clear_auth_for_epoch(&self, epoch: u64) -> Result<bool, ()> {
            if let Ok(mut o) = self.order.lock() {
                o.push("try_clear_auth_for_epoch");
            }
            self.inner.try_clear_auth_for_epoch(epoch)
        }
        fn close_all_ssh(&self) -> Result<(), ()> {
            if let Ok(mut o) = self.order.lock() {
                o.push("close_all_ssh");
            }
            self.inner.close_all_ssh()
        }
        fn lock_vault(&self) -> Result<(), ()> {
            if let Ok(mut o) = self.order.lock() {
                o.push("lock_vault");
            }
            self.inner.lock_vault()
        }
        fn emit_session_invalidated(&self) {
            if let Ok(mut o) = self.order.lock() {
                o.push("emit_session_invalidated");
            }
            self.inner.emit_session_invalidated()
        }
    }
}

#[cfg(test)]
pub use spy::{OrderedSpyHooks, SpyLifecycleHooks};

#[cfg(test)]
mod watermark_tests {
    use super::*;

    #[test]
    fn watermark_cancel_covers_older_not_newer() {
        let c = InvalidationControl::new();
        c.cancel_auth_epoch(5);
        assert!(c.is_cancelled_token(&CancelWaitToken {
            auth_epoch: Some(5),
            start_global: 0,
        }));
        assert!(c.is_cancelled_token(&CancelWaitToken {
            auth_epoch: Some(3),
            start_global: 0,
        }));
        assert!(!c.is_cancelled_token(&CancelWaitToken {
            auth_epoch: Some(6),
            start_global: 0,
        }));
    }

    #[test]
    fn clear_err_fail_closed_still_cuts_and_emits() {
        let c = InvalidationControl::new();
        let hooks = SpyLifecycleHooks::new();
        hooks.always_clear.store(false, Ordering::SeqCst);
        assert!(c.run_401_for_auth_epoch(4, &hooks));
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

    #[test]
    fn out_of_order_e3_then_e2_dedupes_without_hashset() {
        let c = InvalidationControl::new();
        let hooks = SpyLifecycleHooks::new();
        assert!(c.run_401_for_auth_epoch(3, &hooks));
        assert_eq!(c.cancelled_through(), 3);
        assert_eq!(c.lifecycle_done_through(), 3);
        // Stale E2 after E3
        assert!(!c.run_401_for_auth_epoch(2, &hooks));
        assert_eq!(hooks.events().len(), 4); // only first lifecycle
                                             // Production control fields use atomics (source contract).
        let src = include_str!("lifecycle.rs");
        assert!(src.contains("cancelled_through: AtomicU64"));
        assert!(src.contains("lifecycle_done_through: AtomicU64"));
        let prod = src.split("mod watermark_tests").next().unwrap_or("");
        assert!(
            !prod.contains("collections::"),
            "production lifecycle must not use collections for epoch tracking"
        );
    }

    #[test]
    fn many_epochs_watermark_stays_bounded() {
        let c = InvalidationControl::new();
        let hooks = SpyLifecycleHooks::new();
        for e in 1..=200u64 {
            let _ = c.run_401_for_auth_epoch(e, &hooks);
        }
        assert_eq!(c.lifecycle_done_through(), 200);
        assert_eq!(c.cancelled_through(), 200);
        // Only one atomics pair — re-run old epoch dedupes
        let before = hooks.events().len();
        assert!(!c.run_401_for_auth_epoch(50, &hooks));
        assert_eq!(hooks.events().len(), before);
    }
}
