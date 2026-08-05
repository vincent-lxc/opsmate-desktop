//! RAII OS sleep/wake observers for vault seal (Task 8A2B rework).
//!
//! macOS: NSWorkspaceWillSleep + NSWorkspaceDidWake with coordinator stored in
//! **observer ivars** (instance-owned; no process-global coordinator retention).
//! [`OsSleepRegistration::unregister`] and Drop both remove observers (idempotent).
//! Other platforms: empty RAII holding the coordinator Arc only.

use crate::vault_lifecycle_coordinator::VaultLifecycleCoordinator;
use std::sync::{Arc, Mutex};

/// Process-local sleep/wake registration retained in Tauri managed state.
pub struct OsSleepRegistration {
    inner: Mutex<Option<Inner>>,
}

#[allow(dead_code)] // variants held for Drop side effects only
enum Inner {
    #[cfg(target_os = "macos")]
    Macos(macos::Registration),
    #[cfg(not(target_os = "macos"))]
    Stub(Arc<VaultLifecycleCoordinator>),
}

impl OsSleepRegistration {
    /// Register sleep/wake hooks. Keep this value alive (app.manage) until exit.
    pub fn register(coordinator: Arc<VaultLifecycleCoordinator>) -> Self {
        #[cfg(target_os = "macos")]
        {
            Self {
                inner: Mutex::new(Some(Inner::Macos(macos::Registration::new(coordinator)))),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            Self {
                inner: Mutex::new(Some(Inner::Stub(coordinator))),
            }
        }
    }

    /// Explicit teardown: remove observers (idempotent). Safe from ExitRequested/Exit.
    pub fn unregister(&self) {
        if let Ok(mut g) = self.inner.lock() {
            let _ = g.take();
        }
    }
}

impl Drop for OsSleepRegistration {
    fn drop(&mut self) {
        self.unregister();
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::VaultLifecycleCoordinator;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{define_class, msg_send, AnyThread, DefinedClass};
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::{NSNotification, NSObject, NSObjectProtocol};
    use std::sync::{Arc, Mutex};

    /// Coordinator owned by the Objective-C observer instance (not process-global).
    struct Ivars {
        coordinator: Mutex<Option<Arc<VaultLifecycleCoordinator>>>,
    }

    define_class!(
        #[unsafe(super = NSObject)]
        #[name = "OpsMateVaultSleepWakeObserver"]
        #[ivars = Ivars]
        struct SleepWakeObserver;

        unsafe impl NSObjectProtocol for SleepWakeObserver {}

        impl SleepWakeObserver {
            #[unsafe(method(onWillSleep:))]
            fn on_will_sleep(&self, _notification: Option<&NSNotification>) {
                if let Ok(g) = self.ivars().coordinator.lock() {
                    if let Some(c) = g.as_ref() {
                        let _ = c.on_system_sleep();
                    }
                }
            }

            #[unsafe(method(onDidWake:))]
            fn on_did_wake(&self, _notification: Option<&NSNotification>) {
                if let Ok(g) = self.ivars().coordinator.lock() {
                    if let Some(c) = g.as_ref() {
                        let _ = c.on_resume();
                    }
                }
            }
        }
    );

    impl SleepWakeObserver {
        fn new(coordinator: Arc<VaultLifecycleCoordinator>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars {
                coordinator: Mutex::new(Some(coordinator)),
            });
            unsafe { msg_send![super(this), init] }
        }
    }

    pub struct Registration {
        observer: Retained<SleepWakeObserver>,
    }

    impl Registration {
        pub fn new(coordinator: Arc<VaultLifecycleCoordinator>) -> Self {
            let observer = SleepWakeObserver::new(coordinator);
            let workspace = NSWorkspace::sharedWorkspace();
            let center = workspace.notificationCenter();
            unsafe {
                center.addObserver_selector_name_object(
                    &observer,
                    objc2::sel!(onWillSleep:),
                    Some(NSWorkspaceWillSleepNotification),
                    None::<&AnyObject>,
                );
                center.addObserver_selector_name_object(
                    &observer,
                    objc2::sel!(onDidWake:),
                    Some(NSWorkspaceDidWakeNotification),
                    None::<&AnyObject>,
                );
            }
            Self { observer }
        }
    }

    impl Drop for Registration {
        fn drop(&mut self) {
            let workspace = NSWorkspace::sharedWorkspace();
            let center = workspace.notificationCenter();
            unsafe {
                center.removeObserver(&self.observer);
            }
            // Clear ivar so late callbacks cannot use coordinator after unregister.
            if let Ok(mut g) = self.observer.ivars().coordinator.lock() {
                *g = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn macos_sleep_wake_no_global_coordinator_slot() {
        let full = include_str!("vault_os_sleep.rs");
        // Production source only (avoid matching strings inside this test).
        let src = full.split("#[cfg(test)]").next().unwrap_or(full);
        assert!(src.contains("NSWorkspaceWillSleepNotification"));
        assert!(src.contains("NSWorkspaceDidWakeNotification"));
        assert!(src.contains("on_system_sleep"));
        assert!(src.contains("on_resume"));
        assert!(src.contains("removeObserver"));
        assert!(src.contains("OsSleepRegistration"));
        assert!(src.contains("fn unregister"));
        assert!(
            src.contains("impl Drop for OsSleepRegistration")
                || src.contains("impl Drop for Registration")
        );
        // Coordinator lives in observer ivars (instance-owned).
        assert!(src.contains("struct Ivars"));
        assert!(src.contains("coordinator: Mutex<Option<Arc<VaultLifecycleCoordinator>>>"));
        // No permanent global coordinator retention patterns in production code.
        assert!(!src.contains("active_slot"));
        assert!(!src.contains("static COORD"));
        assert!(!src.contains("static mut ACTIVE"));
        assert!(!src.contains("OnceLock"));
    }
}
