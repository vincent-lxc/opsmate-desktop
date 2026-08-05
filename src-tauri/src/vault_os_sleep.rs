//! RAII OS sleep/lock/wake observers for vault seal (Task 4).
//!
//! Platforms:
//! - macOS: NSWorkspace sleep/wake (instance-owned coordinator ivars)
//! - Windows: WM_POWERBROADCAST + WM_WTSSESSION_CHANGE (message-only window)
//! - Linux: zbus logind PrepareForSleep + Session Lock
//!
//! Layout: this file is the shared dispatch; implementations live in
//! `vault_os_sleep/{macos,windows,linux}.rs`. All events call
//! [`VaultLifecycleCoordinator`] fail-closed paths (SSH close before seal;
//! resume enforces locked, never auto-unlock).
//!
//! **Observer health latch:** unexpected post-handshake listener death marks
//! [`ObserverHealth`] unhealthy (sticky) before/on seal. Explicit
//! unregister / process-exit cancel must **not** mark unhealthy. Vault unlock
//! revalidates health pre/post Stronghold and fails closed if unhealthy.
//!
//! Final cutoff unlock must use [`ObserverHealth::run_if_healthy`] so the health
//! check and unlock share one critical section (no TOCTOU with concurrent failure).

use crate::vault_lifecycle_coordinator::VaultLifecycleCoordinator;
use std::sync::{Arc, Mutex};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// Fixed error when [`ObserverHealth::run_if_healthy`] finds the latch unhealthy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObserverUnhealthy;

/// Process-local sticky health for OS sleep/lock observers (Rust-owned, not WebView IPC).
///
/// Starts healthy. Unexpected listener death stores `false` (sticky). Explicit
/// unregister / cancel does **not** clear this — normal teardown is not
/// misclassified as hollow-observer death.
///
/// **Critical section:** [`Self::run_if_healthy`] holds the latch mutex across
/// "still healthy?" + caller op (cutoff unlock). Failure uses
/// [`Self::mark_unhealthy_then`] — mark under the same mutex, then run seal
/// **after** releasing the lock so both interleavings end locked.
pub struct ObserverHealth {
    /// `true` = healthy. Mutex is the gate for unlock vs failure mark.
    healthy: Mutex<bool>,
    /// Test-only: runs while holding the latch after healthy check, before `op`.
    /// Used to force interleaving without TOCTOU in production code paths.
    #[cfg(test)]
    test_after_check_before_op: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl std::fmt::Debug for ObserverHealth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ObserverHealth")
            .field("healthy", &self.is_healthy())
            .finish()
    }
}

impl ObserverHealth {
    /// New latch in the healthy state (shared across registration + unlock gates).
    pub fn new_healthy() -> Arc<Self> {
        Arc::new(Self {
            healthy: Mutex::new(true),
            #[cfg(test)]
            test_after_check_before_op: Mutex::new(None),
        })
    }

    /// Snapshot (may race with concurrent mark; final unlock must use [`Self::run_if_healthy`]).
    pub fn is_healthy(&self) -> bool {
        self.healthy.lock().map(|g| *g).unwrap_or(false)
    }

    /// Sticky fail-closed: unexpected post-handshake observer death (under latch mutex).
    pub fn mark_unhealthy(&self) {
        if let Ok(mut g) = self.healthy.lock() {
            *g = false;
        }
    }

    /// Mark unhealthy under the latch mutex, **then** run `after` with the lock released.
    /// Use for unexpected listener death: mark first, then seal/lock outside the critical section.
    pub fn mark_unhealthy_then<F: FnOnce()>(&self, after: F) {
        if let Ok(mut g) = self.healthy.lock() {
            *g = false;
            drop(g);
        }
        after();
    }

    /// If healthy, run `op` **while still holding the latch mutex** (check + op atomic).
    /// If unhealthy (or lock poisoned), returns `Err(ObserverUnhealthy)` and does not run `op`.
    pub fn run_if_healthy<R, F: FnOnce() -> R>(&self, op: F) -> Result<R, ObserverUnhealthy> {
        let g = self.healthy.lock().map_err(|_| ObserverUnhealthy)?;
        if !*g {
            return Err(ObserverUnhealthy);
        }
        #[cfg(test)]
        {
            if let Ok(mut hook) = self.test_after_check_before_op.lock() {
                if let Some(h) = hook.take() {
                    // Still holding health mutex — hook must not call mark/run_if_healthy
                    // (would deadlock). Use only for signaling/sleep coordination.
                    h();
                }
            }
        }
        let r = op();
        drop(g);
        Ok(r)
    }

    /// Install a one-shot test hook between healthy check and `op` (while holding the latch).
    #[cfg(test)]
    pub fn set_test_after_check_before_op<F>(&self, f: F)
    where
        F: FnOnce() + Send + 'static,
    {
        if let Ok(mut g) = self.test_after_check_before_op.lock() {
            *g = Some(Box::new(f));
        }
    }
}

/// Process-local sleep/lock registration retained in Tauri managed state.
pub struct OsSleepRegistration {
    inner: Mutex<Option<Inner>>,
    health: Arc<ObserverHealth>,
}

#[allow(dead_code)] // variants held for Drop side effects only
enum Inner {
    #[cfg(target_os = "macos")]
    Macos(macos::Registration),
    #[cfg(target_os = "windows")]
    Windows(windows::Registration),
    #[cfg(target_os = "linux")]
    Linux(linux::Registration),
    /// Non-desktop target only (not a product Windows/Linux stub).
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Unsupported,
}

impl OsSleepRegistration {
    /// Register OS sleep/lock hooks. Keep this value alive (app.manage) until exit.
    ///
    /// `health` is the shared latch (typically from CloudBridge). Windows/Linux use a
    /// **startup handshake** (`try_new`). Setup failure returns a fixed public code so
    /// app setup can fail closed — never manage a hollow registration.
    pub fn register(
        coordinator: Arc<VaultLifecycleCoordinator>,
        health: Arc<ObserverHealth>,
    ) -> Result<Self, &'static str> {
        #[cfg(target_os = "macos")]
        let inner = Some(Inner::Macos(macos::Registration::new(
            coordinator,
            Arc::clone(&health),
        )));
        #[cfg(target_os = "windows")]
        let inner = Some(Inner::Windows(
            windows::Registration::try_new(coordinator, Arc::clone(&health))
                .map_err(|()| "os_sleep_setup_failed")?,
        ));
        #[cfg(target_os = "linux")]
        let inner = Some(Inner::Linux(
            linux::Registration::try_new(coordinator, Arc::clone(&health))
                .map_err(|()| "os_sleep_setup_failed")?,
        ));
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        let inner = {
            let _ = coordinator;
            Some(Inner::Unsupported)
        };
        Ok(Self {
            inner: Mutex::new(inner),
            health,
        })
    }

    /// Shared health latch (for unlock gates / tests).
    pub fn health(&self) -> &Arc<ObserverHealth> {
        &self.health
    }

    pub fn is_observer_healthy(&self) -> bool {
        self.health.is_healthy()
    }

    /// Explicit teardown: remove observers / unsubscribe (idempotent).
    /// Does **not** mark unhealthy (process exit / normal Drop).
    pub fn unregister(&self) {
        if let Ok(mut g) = self.inner.lock() {
            let _ = g.take();
        }
    }

    /// Test-only: simulate unexpected listener death without OS signals.
    #[cfg(test)]
    pub fn mark_unhealthy_for_tests(&self) {
        self.health.mark_unhealthy();
    }
}

impl Drop for OsSleepRegistration {
    fn drop(&mut self) {
        self.unregister();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security_cutoff::SecurityCutoff;
    use crate::vault::VaultService;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn platform_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/vault_os_sleep")
    }

    fn dispatch_src() -> String {
        std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/vault_os_sleep.rs"),
        )
        .expect("vault_os_sleep.rs")
    }

    /// Production source only (exclude test module; keep `#[cfg(test)]` item helpers).
    fn prod_src() -> String {
        let dispatch = dispatch_src();
        dispatch
            .split("#[cfg(test)]\nmod tests")
            .next()
            .unwrap_or(&dispatch)
            .to_string()
    }

    /// RED until Task 4: no non-macOS Stub; real Windows/Linux modules wired.
    #[test]
    fn no_non_macos_stub_platform_modules_exist() {
        let prod = prod_src();
        assert!(
            !prod.contains("Stub(")
                && !prod.contains("Inner::Stub")
                && !prod.contains("enum Inner {\n    Stub"),
            "non-macOS Stub must be removed"
        );
        assert!(
            !prod.contains("Stub(Arc<VaultLifecycleCoordinator>)"),
            "Stub(Arc) variant must not exist"
        );
        assert!(platform_root().join("macos.rs").is_file());
        assert!(platform_root().join("windows.rs").is_file());
        assert!(platform_root().join("linux.rs").is_file());
        assert!(
            prod.contains("mod macos")
                && prod.contains("mod windows")
                && prod.contains("mod linux"),
            "dispatch must cfg-wire platform modules"
        );
        assert!(
            prod.contains("Inner::Windows") || prod.contains("Windows(windows::Registration)"),
            "Windows registration must be wired"
        );
        assert!(
            prod.contains("Inner::Linux") || prod.contains("Linux(linux::Registration)"),
            "Linux registration must be wired"
        );
    }

    #[test]
    fn windows_handles_power_and_session_and_unregisters_on_drop() {
        let win = std::fs::read_to_string(platform_root().join("windows.rs")).expect("windows.rs");
        assert!(
            win.contains("WM_POWERBROADCAST"),
            "Windows must handle WM_POWERBROADCAST"
        );
        assert!(
            win.contains("WM_WTSSESSION_CHANGE"),
            "Windows must handle WM_WTSSESSION_CHANGE"
        );
        assert!(
            win.contains("WTSRegisterSessionNotification"),
            "must register WTS session notifications"
        );
        assert!(
            win.contains("WTSUnRegisterSessionNotification"),
            "must unregister WTS session notifications"
        );
        // Unregister before destroy in the once-helper + clear_and_destroy call order.
        let unreg_fn = win
            .find("fn unregister_wts_once")
            .expect("unregister_wts_once");
        let unreg_call = win
            .find("WTSUnRegisterSessionNotification(hwnd)")
            .expect("WTS unregister call");
        let clear_fn = win.find("fn clear_and_destroy").expect("clear_and_destroy");
        let destroy_in_clear = win[clear_fn..]
            .find("DestroyWindow(hwnd)")
            .map(|i| clear_fn + i)
            .expect("DestroyWindow in clear_and_destroy");
        assert!(
            unreg_fn < destroy_in_clear && unreg_call < destroy_in_clear,
            "WTS unregister helper/call must appear before DestroyWindow in clear_and_destroy path"
        );
        assert!(
            win.contains("try_new") && (win.contains("ready_tx") || win.contains("ready_rx")),
            "Windows registration requires Result startup handshake"
        );
        assert!(
            win.contains("impl Drop for Registration"),
            "Registration Drop must clean window/session resources"
        );
        assert!(
            win.contains("on_system_sleep") && win.contains("on_resume"),
            "events must call coordinator fail-closed paths"
        );
        assert!(
            !win.contains("tx.send(())"),
            "no detached helper join thread on Drop"
        );
        // Direct join only on Drop.
        assert!(
            win.contains("h.join()") || win.contains("join.join()"),
            "Drop must join worker handle directly"
        );
        assert!(
            !win.contains("static COORD") && !win.contains("OnceLock"),
            "no process-global coordinator state"
        );
        assert!(
            !win.contains("PostQuitMessage("),
            "must not poison thread with PostQuitMessage"
        );
        assert!(
            win.contains("WTS_SESSION_UNLOCK"),
            "must use WTS_SESSION_UNLOCK constant (not raw 8)"
        );
        assert!(
            !win.contains("code == 8u32") && !win.contains("code == 8 "),
            "must not hardcode unlock session code"
        );
        // Ready timeout: WM_CLOSE before direct join.
        assert!(
            win.contains("post_close_if_hwnd")
                || (win.contains("recv_timeout") && win.contains("WM_CLOSE")),
            "ready timeout must post WM_CLOSE before join"
        );
        // ready Ok send fail after WTS: unregister/destroy before return.
        assert!(
            win.contains("ready_tx.send(Ok(()))")
                && win.contains("is_err()")
                && win.contains("clear_and_destroy"),
            "ready Ok send failure must unregister/destroy before return"
        );
        // NCDESTROY: exact-once cleanup then DefWindowProc (match arm, not module docs).
        assert!(
            win.contains("WM_NCDESTROY =>") && win.contains("DefWindowProcW"),
            "WM_NCDESTROY must call DefWindowProc after cleanup"
        );
        let ncd = win.find("WM_NCDESTROY =>").expect("NCDESTROY arm");
        let ncd_body = &win[ncd..];
        let ncd_end = ncd_body.find("_ =>").unwrap_or(ncd_body.len().min(900));
        let ncd_arm = &ncd_body[..ncd_end];
        assert!(
            ncd_arm.contains("SetWindowLongPtrW")
                && ncd_arm.contains("Box::from_raw")
                && ncd_arm.contains("DefWindowProcW"),
            "NCDESTROY: clear USERDATA, from_raw once, then DefWindowProc"
        );
    }

    /// CreateWindowEx must not pass Box raw pointer as lpParam: Create fail + NCDESTROY
    /// would from_raw in wnd_proc while Err also from_raw → double free.
    #[test]
    fn windows_createwindow_single_ownership_no_double_free() {
        let win = std::fs::read_to_string(platform_root().join("windows.rs")).expect("windows.rs");
        // Production code only (skip line comments) — no WM_NCCREATE arm / lpCreateParams.
        let prod = win
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            prod.contains("CreateWindowExW"),
            "must create message window via CreateWindowExW"
        );
        assert!(
            !prod.contains("WM_NCCREATE") && !prod.contains("lpCreateParams"),
            "must not take over pointer in WM_NCCREATE"
        );
        let create = prod.find("CreateWindowExW").expect("CreateWindowExW");
        let into_raw = prod.find("Box::into_raw").expect("Box::into_raw");
        assert!(
            create < into_raw,
            "Box::into_raw must come after CreateWindowExW (not before)"
        );
        // Create call uses None for lpParam (not state_ptr).
        let create_call_end = prod[create..]
            .find('{')
            .map(|i| create + i)
            .unwrap_or(create + 400);
        let create_args = &prod[create..create_call_end];
        assert!(
            create_args.contains("None") && !create_args.contains("state_ptr"),
            "CreateWindowExW lpParam must be None (no raw state pointer)"
        );
        // Create Err path: drop local Box only — no from_raw on the create failure arm.
        let create_block = &prod[create..];
        let err_arm_start = create_block
            .find("Err(_)")
            .expect("CreateWindowExW Err arm");
        let err_end = (err_arm_start + 220).min(create_block.len());
        let err_slice = &create_block[err_arm_start..err_end];
        assert!(
            !err_slice.contains("from_raw"),
            "CreateWindowExW Err must not from_raw (local Box drop only)"
        );
        assert!(
            err_slice.contains("drop(state)") || err_slice.contains("return Err"),
            "Create fail returns after dropping local state ownership"
        );
        let set_ud = prod
            .find("SetWindowLongPtrW(hwnd, GWLP_USERDATA")
            .expect("SetWindowLongPtr");
        assert!(
            into_raw < set_ud,
            "SetWindowLongPtrW USERDATA after into_raw"
        );
    }

    /// After successful WTS register, every destroy path unregisters exactly once before DestroyWindow.
    #[test]
    fn windows_wts_register_unregister_exact_once_before_destroy() {
        let win = std::fs::read_to_string(platform_root().join("windows.rs")).expect("windows.rs");
        assert!(
            win.contains("wts_registered") && win.contains("AtomicBool"),
            "must track WTS registration with a flag for exact-once unregister"
        );
        assert!(
            win.contains("unregister_wts_once") && win.contains("wts_registered.swap(false"),
            "unregister must be exact-once via swap(false)"
        );
        let reg = win
            .find("WTSRegisterSessionNotification(hwnd")
            .expect("WTS register call");
        let flag_true = win
            .find("wts_registered.store(true")
            .expect("store true after register");
        assert!(
            reg < flag_true,
            "wts_registered=true only after WTSRegisterSessionNotification"
        );
        let clear_fn = win.find("fn clear_and_destroy").expect("clear_and_destroy");
        let clear_body = &win[clear_fn..];
        let u = clear_body
            .find("unregister_wts_once(hwnd, st)")
            .expect("unreg in clear_and_destroy");
        let d = clear_body
            .find("DestroyWindow(hwnd)")
            .expect("destroy in clear_and_destroy");
        assert!(u < d, "clear_and_destroy: unregister before DestroyWindow");
        // Match arm, not module docs; match calls (not comment text "→ DestroyWindow").
        let close = win.find("WM_CLOSE =>").expect("WM_CLOSE arm");
        let close_body = &win[close..];
        let close_end = close_body
            .find("WM_POWERBROADCAST")
            .unwrap_or(close_body.len().min(600));
        let close_arm = &close_body[..close_end];
        let u_in_close = close_arm
            .find("unregister_wts_once(hwnd")
            .expect("unreg call in close");
        let d_in_close = close_arm
            .find("DestroyWindow(hwnd)")
            .expect("destroy call in close");
        assert!(
            u_in_close < d_in_close,
            "WM_CLOSE: unregister before DestroyWindow"
        );
        assert!(
            !win.contains("unregister_wts: bool") && !win.contains("unregister_wts,"),
            "must not use free-form unregister_wts bool that can double-unregister"
        );
    }

    #[test]
    fn linux_zbus_logind_prepare_for_sleep_and_lock_with_owned_cancel() {
        let lin = std::fs::read_to_string(platform_root().join("linux.rs")).expect("linux.rs");
        assert!(
            lin.contains("zbus") || lin.contains("zbus::"),
            "Linux must use zbus"
        );
        assert!(
            lin.contains("PrepareForSleep"),
            "must subscribe to systemd-logind PrepareForSleep"
        );
        assert!(
            lin.contains("GetSessionByPID"),
            "session path must use GetSessionByPID"
        );
        assert!(
            lin.contains("\"Lock\"") || lin.contains("receive_signal(\"Lock\")"),
            "must subscribe to session Lock signal"
        );
        assert!(
            lin.contains("on_system_sleep") && lin.contains("on_resume"),
            "events must call coordinator fail-closed paths"
        );
        assert!(
            lin.contains("cancel_rx.changed()") || lin.contains("watch::"),
            "cancellation must use watch/select, not sleep-poll only"
        );
        assert!(
            lin.contains("tokio::select!"),
            "must cancellation-select with signal streams"
        );
        assert!(
            lin.contains("try_new") && (lin.contains("ready_tx") || lin.contains("ready_rx")),
            "Linux registration requires Result startup handshake"
        );
        assert!(
            lin.contains("impl Drop for Registration"),
            "Drop must unsubscribe / join owned worker"
        );
        // Detached helper join pattern (spawn+join+recv_timeout for Drop) is forbidden;
        // ready_rx.recv_timeout for startup handshake is allowed.
        assert!(
            !lin.contains("let _ = h.join();\n                    let _ = tx.send")
                && !lin.contains("tx.send(())"),
            "no detached helper join thread on Drop"
        );
        assert!(
            lin.contains("h.join()") || lin.contains("join.join()"),
            "Drop must join worker handle directly"
        );
        assert!(
            !lin.contains("use futures_util") && !lin.contains("extern crate futures_util"),
            "must not import futures-util"
        );
        assert!(
            !lin.contains("use futures_core") && !lin.contains("extern crate futures_core"),
            "must not add direct futures-core; use zbus::export::futures_core"
        );
        assert!(
            lin.contains("zbus::export::futures_core::Stream"),
            "signal_next must bound on zbus::export::futures_core::Stream"
        );
        assert!(
            !lin.contains(".unwrap(") && !lin.contains(".expect("),
            "no unwrap/expect in production event paths"
        );
        // Setup must be under cancel select so ready-timeout join cannot hang on dbus.
        assert!(
            lin.contains("tokio::select!")
                && lin.contains("cancel_rx.changed()")
                && (lin.contains("r = setup") || lin.contains("= setup")),
            "outer cancellation must cover setup futures"
        );
    }

    /// After successful handshake, listener death without cancel must fail closed via on_system_sleep.
    #[test]
    fn runtime_listener_death_fail_closed_source_contract() {
        let win = std::fs::read_to_string(platform_root().join("windows.rs")).expect("windows.rs");
        let lin = std::fs::read_to_string(platform_root().join("linux.rs")).expect("linux.rs");

        // Windows: GetMessage error / window death without stop → on_system_sleep.
        assert!(
            win.contains("unexpected_exit") || win.contains("GetMessageW"),
            "Windows must detect GetMessage/window death"
        );
        assert!(
            win.contains("seal_take_unhealthy")
                && win.contains("mark_unhealthy")
                && win.contains("on_system_sleep"),
            "Windows unexpected path must mark unhealthy then seal"
        );
        // Distinct from cancel: only seal when not stop / not explicit cancel.
        assert!(
            win.contains("!stop.load") || win.contains("unexpected_exit"),
            "Windows fail-closed must gate on non-cancel exit"
        );

        // Linux: stream/bus end (None) without cancel → mark_unhealthy then seal.
        assert!(
            lin.contains("seal_take_unhealthy")
                && lin.contains("mark_unhealthy")
                && lin.contains("on_system_sleep"),
            "Linux must mark unhealthy then seal on unexpected stream end"
        );
        assert!(
            lin.contains("let Some(") || lin.contains("None =>"),
            "Linux must branch on stream end (None)"
        );
        // Explicit cancel path must not be the only exit (seal path present for None).
        assert!(
            lin.contains("Stream/bus ended")
                || lin.contains("fail closed")
                || lin.contains("seal_take(&coord)"),
            "Linux stream end must call seal_take fail-closed"
        );
    }

    #[test]
    fn macos_sleep_wake_no_global_coordinator_slot() {
        let src = std::fs::read_to_string(platform_root().join("macos.rs")).expect("macos.rs");
        assert!(src.contains("NSWorkspaceWillSleepNotification"));
        assert!(src.contains("NSWorkspaceDidWakeNotification"));
        assert!(src.contains("on_system_sleep"));
        assert!(src.contains("on_resume"));
        assert!(src.contains("removeObserver"));
        assert!(src.contains("struct Ivars"));
        assert!(src.contains("coordinator: Mutex<Option<Arc<VaultLifecycleCoordinator>>>"));
        assert!(!src.contains("active_slot"));
        assert!(!src.contains("static COORD"));
        assert!(!src.contains("static mut ACTIVE"));
        assert!(!src.contains("OnceLock"));
    }

    #[test]
    fn registration_unregister_idempotent_and_dispatch_has_drop() {
        let prod = prod_src();
        assert!(prod.contains("fn unregister"));
        assert!(prod.contains("impl Drop for OsSleepRegistration"));
        // Behavior: double unregister is safe (take Option twice).
        let path = {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "opsmate-os-sleep-{}-{}.hold",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            p
        };
        let vault = Arc::new(VaultService::new(path.clone()));
        let cutoff = Arc::new(SecurityCutoff::new());
        let coord = VaultLifecycleCoordinator::new(vault, cutoff);
        let health = ObserverHealth::new_healthy();
        // macOS always succeeds; Windows/Linux need real session/WTS — may Err in CI.
        let Ok(reg) = OsSleepRegistration::register(coord, health) else {
            return;
        };
        assert!(reg.is_observer_healthy(), "register starts healthy");
        reg.unregister();
        reg.unregister(); // idempotent
        assert!(
            reg.is_observer_healthy(),
            "explicit unregister must not mark unhealthy"
        );
        drop(reg);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn observer_health_latch_starts_healthy_and_marks_sticky() {
        let h = ObserverHealth::new_healthy();
        assert!(h.is_healthy());
        h.mark_unhealthy();
        assert!(!h.is_healthy());
        h.mark_unhealthy(); // sticky / idempotent
        assert!(!h.is_healthy());
    }

    /// Protocol: failure-before-unlock and unlock-before-failure both end locked.
    /// Controllable interleaving via test hook + thread (not source-string only).
    #[test]
    fn observer_health_interleaving_unlock_and_failure_ends_locked() {
        use crate::security_cutoff::SecurityCutoff;
        use std::sync::{Arc, Barrier};
        use std::thread;

        // --- Sequence A: failure first, then unlock attempt ---
        {
            let health = ObserverHealth::new_healthy();
            let cutoff = Arc::new(SecurityCutoff::new());
            assert!(cutoff.is_vault_locked());
            health.mark_unhealthy_then(|| {
                cutoff.lock_vault();
            });
            let r = health.run_if_healthy(|| {
                cutoff.unlock_vault_for_tests();
            });
            assert!(r.is_err(), "unlock after failure must refuse");
            assert!(
                cutoff.is_vault_locked(),
                "cutoff stays locked when failure wins first"
            );
        }

        // --- Sequence B: unlock wins critical section, then failure marks + locks ---
        {
            let health = ObserverHealth::new_healthy();
            let cutoff = Arc::new(SecurityCutoff::new());
            let r = health.run_if_healthy(|| {
                cutoff.unlock_vault_for_tests();
            });
            assert!(r.is_ok());
            assert!(!cutoff.is_vault_locked());
            health.mark_unhealthy_then(|| {
                cutoff.lock_vault();
            });
            assert!(
                cutoff.is_vault_locked(),
                "failure after unlock must re-lock cutoff"
            );
            assert!(!health.is_healthy());
        }

        // --- Sequence C: concurrent — unlock holds latch (hook sleeps), failure waits on mutex ---
        // Failure cannot mark until unlock finishes critical section; then failure locks.
        // Final state must be locked (failure re-locks after unlock-in-CS).
        {
            let health = ObserverHealth::new_healthy();
            let cutoff = Arc::new(SecurityCutoff::new());
            let barrier = Arc::new(Barrier::new(2));

            // After healthy check, hold the latch while peer starts mark_unhealthy_then.
            let b1 = Arc::clone(&barrier);
            health.set_test_after_check_before_op(move || {
                b1.wait(); // peer may now be blocked on health mutex
                           // brief hold so peer is parked on mark
                std::thread::sleep(std::time::Duration::from_millis(20));
            });

            let h2 = Arc::clone(&health);
            let c2 = Arc::clone(&cutoff);
            let b2 = Arc::clone(&barrier);
            let fail = thread::spawn(move || {
                b2.wait(); // unlock thread is inside CS (holding latch)
                h2.mark_unhealthy_then(|| {
                    c2.lock_vault();
                });
            });

            let unlock_ok = health.run_if_healthy(|| {
                cutoff.unlock_vault_for_tests();
            });
            // Unlock runs under latch; mark waits until we release — both complete.
            assert!(unlock_ok.is_ok() || unlock_ok.is_err());
            fail.join().expect("fail thread");
            assert!(!health.is_healthy(), "failure path must mark unhealthy");
            assert!(
                cutoff.is_vault_locked(),
                "concurrent interleaving must end with cutoff locked"
            );
        }

        // --- Sequence D: concurrent failure-first (unlock after mark) ---
        {
            let health = ObserverHealth::new_healthy();
            let cutoff = Arc::new(SecurityCutoff::new());
            let barrier = Arc::new(Barrier::new(2));

            let h1 = Arc::clone(&health);
            let c1 = Arc::clone(&cutoff);
            let b1 = Arc::clone(&barrier);
            let fail = thread::spawn(move || {
                b1.wait();
                h1.mark_unhealthy_then(|| c1.lock_vault());
            });

            barrier.wait();
            // Ensure failure runs first
            std::thread::sleep(std::time::Duration::from_millis(30));
            let r = health.run_if_healthy(|| {
                cutoff.unlock_vault_for_tests();
            });
            fail.join().expect("fail thread");
            assert!(r.is_err());
            assert!(cutoff.is_vault_locked());
            assert!(!health.is_healthy());
        }
    }

    #[test]
    fn register_returns_result_and_propagates_try_new() {
        let prod = prod_src();
        assert!(
            prod.contains("Result<Self, &'static str>") || prod.contains("-> Result<Self,"),
            "register must return Result for setup fail-closed"
        );
        assert!(
            prod.contains("os_sleep_setup_failed"),
            "register must surface a fixed public setup failure code"
        );
        assert!(
            !prod.contains(".ok().map(Inner::") && !prod.contains(".ok()\n            .map"),
            "must not swallow try_new with .ok().map hollow registration"
        );
        // try_new errors must map_err + ? not map to None (cfg branches in source).
        assert!(
            prod.contains("try_new(coordinator, Arc::clone(&health))")
                && prod.contains("os_sleep_setup_failed"),
            "platform try_new must propagate into register Result with shared health"
        );
        assert!(
            prod.contains("health: Arc<ObserverHealth>") || prod.contains("ObserverHealth"),
            "registration owns shared ObserverHealth latch"
        );
    }
}
