//! Windows power + session lock observers (Task 4).
//!
//! Message-only window: `WM_POWERBROADCAST` + `WM_WTSSESSION_CHANGE`.
//! - Startup **Result handshake** after window create + WTS register
//! - Drop / ready-timeout: stop flag, **`PostMessage(WM_CLOSE)` before direct join**
//! - **Single ownership** of `WindowState`: `CreateWindowExW` with `lpParam=None`;
//!   `Box::into_raw` only after HWND success + `SetWindowLongPtrW` (no WM_NCCREATE
//!   pointer takeover; Create fail drops the local Box — never double `from_raw`)
//! - WTS: after successful register, destroy paths unregister **exactly once** via
//!   `wts_registered` flag **before** `DestroyWindow` (no dual unregister)
//! - ready Ok send fail after WTS: unregister/destroy before return
//! - After handshake: GetMessage error / window death without cancel →
//!   **mark unhealthy + `on_system_sleep`** (explicit stop does not mark unhealthy)
//! - `WM_NCDESTROY`: exact-once Box cleanup then **`DefWindowProcW`**

use super::ObserverHealth;
use crate::vault_lifecycle_coordinator::VaultLifecycleCoordinator;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

struct WindowState {
    coordinator: Mutex<Option<Arc<VaultLifecycleCoordinator>>>,
    health: Arc<ObserverHealth>,
    /// True only after a successful `WTSRegisterSessionNotification`.
    /// Cleared atomically on the single unregister path before `DestroyWindow`.
    wts_registered: AtomicBool,
}

pub struct Registration {
    stop: Arc<AtomicBool>,
    hwnd_slot: Arc<Mutex<Option<isize>>>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl Registration {
    /// Start worker; `Ok` only after HWND + WTS registration handshake.
    pub fn try_new(
        coordinator: Arc<VaultLifecycleCoordinator>,
        health: Arc<ObserverHealth>,
    ) -> Result<Self, ()> {
        let stop = Arc::new(AtomicBool::new(false));
        let hwnd_slot = Arc::new(Mutex::new(None));
        let stop_t = Arc::clone(&stop);
        let hwnd_t = Arc::clone(&hwnd_slot);
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<(), ()>>(1);

        let join = std::thread::Builder::new()
            .name("opsmate-vault-os-sleep-win".into())
            .spawn(move || {
                let result =
                    unsafe { run_message_loop(coordinator, health, stop_t, hwnd_t, &ready_tx) };
                if result.is_err() {
                    let _ = ready_tx.send(Err(()));
                }
            })
            .map_err(|_| ())?;

        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => Ok(Self {
                stop,
                hwnd_slot,
                join: Mutex::new(Some(join)),
            }),
            Ok(Err(())) | Err(_) => {
                stop.store(true, Ordering::SeqCst);
                // Ready timeout / setup fail: post WM_CLOSE before direct join (unblocks GetMessage).
                post_close_if_hwnd(&hwnd_slot);
                let _ = join.join();
                Err(())
            }
        }
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        post_close_if_hwnd(&self.hwnd_slot);
        if let Ok(mut g) = self.join.lock() {
            if let Some(h) = g.take() {
                // Direct join only — no detached helper thread.
                let _ = h.join();
            }
        }
    }
}

fn post_close_if_hwnd(hwnd_slot: &Mutex<Option<isize>>) {
    if let Ok(g) = hwnd_slot.lock() {
        if let Some(raw) = *g {
            let hwnd = windows::Win32::Foundation::HWND(raw as *mut _);
            unsafe {
                let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                    Some(hwnd),
                    windows::Win32::UI::WindowsAndMessaging::WM_CLOSE,
                    windows::Win32::Foundation::WPARAM(0),
                    windows::Win32::Foundation::LPARAM(0),
                );
            }
        }
    }
}

/// Unexpected listener death: mark unhealthy under latch mutex, then seal after release.
fn seal_take_unhealthy(
    health: &ObserverHealth,
    coord: &Mutex<Option<Arc<VaultLifecycleCoordinator>>>,
) {
    health.mark_unhealthy_then(|| {
        if let Ok(mut g) = coord.lock() {
            if let Some(c) = g.take() {
                let _ = c.on_system_sleep();
            }
        }
    });
}

/// Unregister WTS at most once (swap flag false), always before DestroyWindow callers.
unsafe fn unregister_wts_once(hwnd: windows::Win32::Foundation::HWND, st: &WindowState) {
    use windows::Win32::System::RemoteDesktop::WTSUnRegisterSessionNotification;
    if st.wts_registered.swap(false, Ordering::SeqCst) {
        let _ = WTSUnRegisterSessionNotification(hwnd);
    }
}

unsafe fn run_message_loop(
    coordinator: Arc<VaultLifecycleCoordinator>,
    health: Arc<ObserverHealth>,
    stop: Arc<AtomicBool>,
    hwnd_slot: Arc<Mutex<Option<isize>>>,
    ready_tx: &std::sync::mpsc::SyncSender<Result<(), ()>>,
) -> Result<(), ()> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::HINSTANCE;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::UI::WindowsAndMessaging::*;

    let module = GetModuleHandleW(None).map_err(|_| ())?;
    let hinstance = HINSTANCE::from(module);
    let class_name = w!("OpsMateVaultOsSleepMsgWnd");

    let wc = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(wnd_proc),
        hInstance: hinstance,
        lpszClassName: class_name,
        hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
        ..Default::default()
    };
    let _ = RegisterClassW(&wc);

    // Local ownership until HWND is successfully created. Never into_raw before CreateWindowExW:
    // if Create fails after WM_NCCREATE/NCDESTROY, we must not also from_raw a leaked pointer.
    let state = Box::new(WindowState {
        coordinator: Mutex::new(Some(coordinator)),
        health,
        wts_registered: AtomicBool::new(false),
    });

    let hwnd = match CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        class_name,
        PCWSTR::null(),
        WINDOW_STYLE::default(),
        0,
        0,
        0,
        0,
        Some(HWND_MESSAGE),
        None,
        Some(hinstance),
        None, // lpParam: no raw pointer through create (single ownership)
    ) {
        Ok(h) => h,
        Err(_) => {
            // `state` drops here — no from_raw, no double free.
            drop(state);
            return Err(());
        }
    };

    // Only after successful HWND: transfer ownership into GWLP_USERDATA.
    let state_ptr = Box::into_raw(state);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize);
    if let Ok(mut g) = hwnd_slot.lock() {
        *g = Some(hwnd.0 as isize);
    }

    if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION).is_err() {
        // Never registered — destroy without WTS unregister (flag still false).
        let _ = hwnd_slot.lock().map(|mut g| *g = None);
        clear_and_destroy(hwnd, /*fail_closed*/ false);
        return Err(());
    }
    // Mark registered only after success so destroy paths unregister exactly once.
    if let Some(st) = user_state(hwnd) {
        st.wts_registered.store(true, Ordering::SeqCst);
    }

    // Startup handshake: window + WTS live. If receiver gone, unregister/destroy before return.
    if ready_tx.send(Ok(())).is_err() {
        let _ = hwnd_slot.lock().map(|mut g| *g = None);
        clear_and_destroy(hwnd, /*fail_closed*/ false);
        return Err(());
    }

    let mut msg = MSG::default();
    let mut unexpected_exit = false;
    while !stop.load(Ordering::SeqCst) {
        let gm = GetMessageW(&mut msg, Some(hwnd), 0, 0);
        match gm.0 {
            -1 => {
                // GetMessage error — not explicit cancel.
                unexpected_exit = true;
                break;
            }
            0 => {
                // WM_QUIT / loop end without stop flag.
                unexpected_exit = true;
                break;
            }
            _ => {
                let _ = TranslateMessage(&msg);
                let _ = DispatchMessageW(&msg);
            }
        }
        if !IsWindow(Some(hwnd)).as_bool() {
            // Window died without stop (unexpected); stop path sets flag before WM_CLOSE.
            if !stop.load(Ordering::SeqCst) {
                unexpected_exit = true;
            }
            break;
        }
    }

    // Listener death after handshake without cancel: mark unhealthy then seal
    // only while the message HWND is still alive. If already destroyed, NCDESTROY
    // fail-closed path may have sealed + marked.
    if unexpected_exit && !stop.load(Ordering::SeqCst) && IsWindow(Some(hwnd)).as_bool() {
        if let Some(st) = user_state(hwnd) {
            seal_take_unhealthy(&st.health, &st.coordinator);
        }
    }

    // Teardown if still alive: WTS unregister (once, if registered) **before** destroy.
    if IsWindow(Some(hwnd)).as_bool() {
        clear_and_destroy(hwnd, /*fail_closed*/ false);
    }
    if let Ok(mut g) = hwnd_slot.lock() {
        *g = None;
    }
    Ok(())
}

/// Clear coordinator (optional fail-closed seal), unregister WTS at most once, then DestroyWindow.
unsafe fn clear_and_destroy(hwnd: windows::Win32::Foundation::HWND, fail_closed: bool) {
    use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;

    if let Some(st) = user_state(hwnd) {
        if fail_closed {
            seal_take_unhealthy(&st.health, &st.coordinator);
        } else if let Ok(mut g) = st.coordinator.lock() {
            *g = None;
        }
        // Exact-once: only if WTS register succeeded.
        unregister_wts_once(hwnd, st);
    }
    let _ = DestroyWindow(hwnd);
}

unsafe fn user_state<'a>(hwnd: windows::Win32::Foundation::HWND) -> Option<&'a WindowState> {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWLP_USERDATA};
    let p = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    if p == 0 {
        None
    } else {
        Some(&*(p as *const WindowState))
    }
}

unsafe extern "system" fn wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::WindowsAndMessaging::*;

    match msg {
        WM_CLOSE => {
            // Order: clear coord (no seal — explicit stop/Drop) → WTS once → DestroyWindow.
            if let Some(st) = user_state(hwnd) {
                if let Ok(mut g) = st.coordinator.lock() {
                    *g = None;
                }
                unregister_wts_once(hwnd, st);
            }
            let _ = DestroyWindow(hwnd);
            return LRESULT(0);
        }
        WM_POWERBROADCAST => {
            let ev = wparam.0 as u32;
            if let Some(st) = user_state(hwnd) {
                if let Ok(g) = st.coordinator.lock() {
                    if let Some(c) = g.as_ref() {
                        match ev {
                            PBT_APMSUSPEND | PBT_APMSTANDBY => {
                                let _ = c.on_system_sleep();
                            }
                            PBT_APMRESUMEAUTOMATIC
                            | PBT_APMRESUMESUSPEND
                            | PBT_APMRESUMESTANDBY
                            | PBT_APMRESUMECRITICAL => {
                                let _ = c.on_resume();
                            }
                            _ => {}
                        }
                    }
                }
            }
            return LRESULT(1);
        }
        WM_WTSSESSION_CHANGE => {
            let code = wparam.0 as u32;
            if let Some(st) = user_state(hwnd) {
                if let Ok(g) = st.coordinator.lock() {
                    if let Some(c) = g.as_ref() {
                        if code == WTS_SESSION_LOCK {
                            let _ = c.on_system_sleep();
                        } else if code == WTS_SESSION_UNLOCK {
                            let _ = c.on_resume();
                        }
                    }
                }
            }
            return LRESULT(0);
        }
        WM_NCDESTROY => {
            // Exact-once Box cleanup: clear USERDATA before from_raw.
            // WTS already unregistered in WM_CLOSE / clear_and_destroy (flag false here).
            let p = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if p != 0 {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                let boxed = Box::from_raw(p as *mut WindowState);
                // Safety net: if WTS still marked registered (unexpected path), unregister once.
                unregister_wts_once(hwnd, &boxed);
                // If coordinator still present, window died without explicit clear → fail closed.
                // (Explicit WM_CLOSE clears coord first without mark_unhealthy.)
                if boxed
                    .coordinator
                    .lock()
                    .map(|g| g.is_some())
                    .unwrap_or(false)
                {
                    seal_take_unhealthy(&boxed.health, &boxed.coordinator);
                } else if let Ok(mut g) = boxed.coordinator.lock() {
                    *g = None;
                }
                drop(boxed);
            }
            // Always hand off to DefWindowProc after cleanup.
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}
