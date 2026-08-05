//! macOS NSWorkspace sleep/wake observers (Task 4 refactor; behavior unchanged).

use super::ObserverHealth;
use crate::vault_lifecycle_coordinator::VaultLifecycleCoordinator;
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
    /// Held so Drop/unregister of observers does not need to touch health (explicit stop stays healthy).
    #[allow(dead_code)]
    health: Arc<ObserverHealth>,
}

impl Registration {
    pub fn new(coordinator: Arc<VaultLifecycleCoordinator>, health: Arc<ObserverHealth>) -> Self {
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
        Self { observer, health }
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
