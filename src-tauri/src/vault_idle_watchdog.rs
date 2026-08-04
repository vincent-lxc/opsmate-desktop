//! Proactive vault idle seal watchdog (Task 8A2B).
//!
//! Production: background poll calls [`VaultLifecycleCoordinator::on_idle_tick`].
//! Tests: [`VaultIdleWatchdog::tick_now`] — no 15-minute sleep, no immortal threads.

use crate::vault_lifecycle_coordinator::VaultLifecycleCoordinator;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Production idle poll interval: **30 seconds** (policy explicit).
/// Distinct from [`crate::vault::VAULT_IDLE_TIMEOUT`] (15 minutes inactivity before seal).
pub const DEFAULT_IDLE_POLL: Duration = Duration::from_secs(30);

/// Runtime observer: seals idle vault even when WebView is quiet.
pub struct VaultIdleWatchdog {
    coordinator: Arc<VaultLifecycleCoordinator>,
    stop: Arc<AtomicBool>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl VaultIdleWatchdog {
    pub fn new(coordinator: Arc<VaultLifecycleCoordinator>) -> Arc<Self> {
        Arc::new(Self {
            coordinator,
            stop: Arc::new(AtomicBool::new(false)),
            join: Mutex::new(None),
        })
    }

    /// Deterministic test/control path: one idle evaluation without sleeping.
    pub fn tick_now(&self) {
        let _ = self.coordinator.on_idle_tick();
    }

    /// Spawn a bounded poller. Safe to call once; subsequent calls are no-ops.
    pub fn spawn_background(self: &Arc<Self>, poll: Duration) {
        let mut slot = match self.join.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if slot.is_some() {
            return;
        }
        let coord = Arc::clone(&self.coordinator);
        let stop = Arc::clone(&self.stop);
        let poll = if poll.is_zero() {
            DEFAULT_IDLE_POLL
        } else {
            poll
        };
        *slot = Some(thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                let _ = coord.on_idle_tick();
                // Park in small slices so stop is responsive (does not block process exit long).
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
        if let Ok(mut g) = self.join.lock() {
            if let Some(h) = g.take() {
                let _ = h.join();
            }
        }
    }
}
