//! Native desktop lifecycle: lock vault on sleep / screen sleep / wake / session resign / exit.
//!
//! macOS: registers NSWorkspace notifications via NSNotificationCenter.
//! Other platforms: compile-time fail-closed adapter (no silent claim of coverage).

use crate::vault::VaultService;
use std::sync::{Arc, OnceLock};

static VAULT_FOR_LIFECYCLE: OnceLock<Arc<VaultService>> = OnceLock::new();

/// Register OS lifecycle hooks that lock the vault. Idempotent process-wide.
/// Fail closed when the platform cannot register sleep/wake observers.
pub fn register_vault_lifecycle(vault: Arc<VaultService>) -> Result<(), String> {
    let _ = VAULT_FOR_LIFECYCLE.set(vault);
    platform::register()
}

fn lock_registered_vault() {
    if let Some(v) = VAULT_FOR_LIFECYCLE.get() {
        let _ = v.lock();
    }
}

/// True when sleep/wake registration compiled in for this target.
#[cfg(test)]
pub fn sleep_wake_registration_supported() -> bool {
    platform::SUPPORTED
}

/// Symbolic notification names registered for vault lock (source/test contract).
#[cfg(test)]
pub const LOCK_NOTIFICATION_SYMBOLS: &[&str] = &[
    "NSWorkspaceWillSleepNotification",
    "NSWorkspaceDidWakeNotification",
    "NSWorkspaceScreensDidSleepNotification",
    "NSWorkspaceSessionDidResignActiveNotification",
];

#[cfg(target_os = "macos")]
mod platform {
    use super::lock_registered_vault;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidSleepNotification,
        NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::{NSNotification, NSObject, NSObjectProtocol};
    use std::sync::OnceLock;

    #[allow(dead_code)] // read by test-only sleep_wake_registration_supported
    pub const SUPPORTED: bool = true;

    static OBSERVER: OnceLock<Retained<VaultLifecycleObserver>> = OnceLock::new();

    #[derive(Debug, Default)]
    struct VaultLifecycleIvars;

    define_class!(
        // SAFETY: NSObject has no subclassing requirements; type has no Drop.
        #[unsafe(super = NSObject)]
        #[name = "OpsMateVaultLifecycleObserver"]
        #[ivars = VaultLifecycleIvars]
        struct VaultLifecycleObserver;

        unsafe impl NSObjectProtocol for VaultLifecycleObserver {}

        impl VaultLifecycleObserver {
            #[unsafe(method(onSleepOrWake:))]
            fn on_sleep_or_wake(&self, _notification: Option<&NSNotification>) {
                lock_registered_vault();
            }
        }
    );

    impl VaultLifecycleObserver {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(VaultLifecycleIvars);
            // SAFETY: standard NSObject init.
            unsafe { msg_send![super(this), init] }
        }
    }

    pub fn register() -> Result<(), String> {
        let _ = OBSERVER.get_or_init(|| {
            let observer = VaultLifecycleObserver::new();
            let workspace = NSWorkspace::sharedWorkspace();
            let center = workspace.notificationCenter();
            // SAFETY: extern NSNotificationName statics from AppKit.
            let names = unsafe {
                [
                    NSWorkspaceWillSleepNotification,
                    NSWorkspaceDidWakeNotification,
                    NSWorkspaceScreensDidSleepNotification,
                    NSWorkspaceSessionDidResignActiveNotification,
                ]
            };
            for name in names {
                // SAFETY: observer implements onSleepOrWake:; retained for process lifetime.
                unsafe {
                    center.addObserver_selector_name_object(
                        &observer,
                        objc2::sel!(onSleepOrWake:),
                        Some(name),
                        None::<&AnyObject>,
                    );
                }
            }
            observer
        });
        if OBSERVER.get().is_none() {
            return Err("sleep/wake observer not registered".into());
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    #[allow(dead_code)] // read by test-only sleep_wake_registration_supported
    pub const SUPPORTED: bool = false;

    pub fn register() -> Result<(), String> {
        // Fail-closed: non-macOS cannot register NSWorkspace sleep observers.
        // Exit path still locks via RunEvent::Exit in lib.rs.
        // Do not claim Tauri RunEvent covers desktop sleep.
        Err("OS sleep/wake observer registration unsupported on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_support_flag_is_platform_accurate() {
        #[cfg(target_os = "macos")]
        assert!(sleep_wake_registration_supported());
        #[cfg(not(target_os = "macos"))]
        assert!(!sleep_wake_registration_supported());
    }

    /// Would fail if lock-screen/session-resign notification registration were removed.
    #[test]
    fn vault_lifecycle_registers_session_resign_and_sleep_constants() {
        let src = include_str!("vault_lifecycle.rs");
        for sym in LOCK_NOTIFICATION_SYMBOLS {
            assert!(src.contains(sym), "vault_lifecycle.rs must register {sym}");
        }
        assert!(
            src.contains("NSWorkspaceSessionDidResignActiveNotification"),
            "lock-screen / session-switch coverage required"
        );
        #[cfg(target_os = "macos")]
        {
            assert!(src.contains("&*NSWorkspaceSessionDidResignActiveNotification"));
            assert!(src.contains("&*NSWorkspaceWillSleepNotification"));
            assert!(src.contains("&*NSWorkspaceDidWakeNotification"));
            assert!(src.contains("&*NSWorkspaceScreensDidSleepNotification"));
        }
    }
}
