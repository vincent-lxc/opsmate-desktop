//! Native secure input (Task D3 / D3B).
//! Password / PEM paste use NSSecureTextField / NSTextField on macOS only.
//! File-vs-paste import choice is native-only (never a WebView flag).
//! Non-macOS fails closed. Tests inject `SecurePrompt` mocks (no GUI).

use thiserror::Error;
use zeroize::Zeroizing;

#[derive(Debug, Error)]
pub enum PromptError {
    #[error("user cancelled")]
    Cancelled,
    #[error("unsupported platform for secure prompts")]
    UnsupportedPlatform,
    #[error("native prompt failed: {0}")]
    Native(String),
}

pub trait SecurePrompt: Send + Sync {
    fn prompt_password(&self, title: &str, message: &str)
        -> Result<Zeroizing<String>, PromptError>;
    fn prompt_passphrase(
        &self,
        title: &str,
        message: &str,
    ) -> Result<Option<Zeroizing<String>>, PromptError>;
    fn pick_pem_file(&self) -> Result<Option<std::path::PathBuf>, PromptError>;
    fn prompt_pem_paste(&self, title: &str) -> Result<Zeroizing<String>, PromptError>;
    /// Native-only choice: file picker or paste. WebView never selects the mode.
    fn choose_pem_import(&self) -> Result<Zeroizing<String>, PromptError>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct NativeSecurePrompt;

/// Compile-time / link-time proof that NSSecureTextField types are available on macOS.
#[cfg(target_os = "macos")]
pub fn macos_secure_types_linked() -> bool {
    use objc2_app_kit::NSSecureTextField;
    let _ = std::any::type_name::<NSSecureTextField>();
    true
}

#[cfg(not(target_os = "macos"))]
pub fn macos_secure_types_linked() -> bool {
    false
}

#[cfg(target_os = "macos")]
mod macos_impl {
    use super::{NativeSecurePrompt, PromptError, SecurePrompt};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSAlertStyle,
        NSSecureTextField, NSTextField, NSView,
    };
    use objc2_foundation::{NSRect, NSString};
    use zeroize::Zeroizing;

    impl SecurePrompt for NativeSecurePrompt {
        fn prompt_password(
            &self,
            title: &str,
            message: &str,
        ) -> Result<Zeroizing<String>, PromptError> {
            let s = run_secure_alert(title, message)?;
            if s.is_empty() {
                return Err(PromptError::Cancelled);
            }
            Ok(s)
        }

        fn prompt_passphrase(
            &self,
            title: &str,
            message: &str,
        ) -> Result<Option<Zeroizing<String>>, PromptError> {
            let s = run_secure_alert(title, message)?;
            if s.is_empty() {
                Ok(None)
            } else {
                Ok(Some(s))
            }
        }

        fn pick_pem_file(&self) -> Result<Option<std::path::PathBuf>, PromptError> {
            Ok(rfd::FileDialog::new()
                .add_filter("PEM / key", &["pem", "key", "txt"])
                .set_title("Import SSH private key")
                .pick_file())
        }

        fn prompt_pem_paste(&self, title: &str) -> Result<Zeroizing<String>, PromptError> {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| PromptError::Native("main thread required".into()))?;
            let alert = NSAlert::new(mtm);
            alert.setAlertStyle(NSAlertStyle::Informational);
            alert.setMessageText(&NSString::from_str(title));
            alert.setInformativeText(&NSString::from_str(
                "Paste PEM private key (never entered in WebView)",
            ));
            alert.addButtonWithTitle(&NSString::from_str("OK"));
            alert.addButtonWithTitle(&NSString::from_str("Cancel"));

            let field = NSTextField::new(mtm);
            let frame = NSRect {
                origin: objc2_foundation::NSPoint { x: 0.0, y: 0.0 },
                size: objc2_foundation::NSSize {
                    width: 320.0,
                    height: 100.0,
                },
            };
            field.setFrame(frame);
            let view: &NSView = field.as_ref();
            alert.setAccessoryView(Some(view));

            let response = alert.runModal();
            if response != NSAlertFirstButtonReturn {
                return Err(PromptError::Cancelled);
            }
            let s = field.stringValue().to_string();
            if s.trim().is_empty() {
                return Err(PromptError::Cancelled);
            }
            Ok(Zeroizing::new(s))
        }

        fn choose_pem_import(&self) -> Result<Zeroizing<String>, PromptError> {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| PromptError::Native("main thread required".into()))?;
            let alert = NSAlert::new(mtm);
            alert.setAlertStyle(NSAlertStyle::Informational);
            alert.setMessageText(&NSString::from_str("Import SSH private key"));
            alert.setInformativeText(&NSString::from_str(
                "Choose a key file or paste PEM. Selection stays native (never WebView).",
            ));
            alert.addButtonWithTitle(&NSString::from_str("Choose File"));
            alert.addButtonWithTitle(&NSString::from_str("Paste Key"));
            alert.addButtonWithTitle(&NSString::from_str("Cancel"));
            let response = alert.runModal();
            if response == NSAlertFirstButtonReturn {
                let path = self.pick_pem_file()?.ok_or(PromptError::Cancelled)?;
                let s = std::fs::read_to_string(&path)
                    .map_err(|e| PromptError::Native(e.to_string()))?;
                if s.trim().is_empty() {
                    return Err(PromptError::Cancelled);
                }
                Ok(Zeroizing::new(s))
            } else if response == NSAlertSecondButtonReturn {
                self.prompt_pem_paste("Paste SSH private key")
            } else {
                Err(PromptError::Cancelled)
            }
        }
    }

    /// Cancel button → `Err(Cancelled)`. OK with empty field → `Ok("")`.
    fn run_secure_alert(title: &str, message: &str) -> Result<Zeroizing<String>, PromptError> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| PromptError::Native("main thread required".into()))?;
        let alert = NSAlert::new(mtm);
        alert.setAlertStyle(NSAlertStyle::Informational);
        alert.setMessageText(&NSString::from_str(title));
        alert.setInformativeText(&NSString::from_str(message));
        alert.addButtonWithTitle(&NSString::from_str("OK"));
        alert.addButtonWithTitle(&NSString::from_str("Cancel"));

        let field = NSSecureTextField::new(mtm);
        let frame = NSRect {
            origin: objc2_foundation::NSPoint { x: 0.0, y: 0.0 },
            size: objc2_foundation::NSSize {
                width: 280.0,
                height: 24.0,
            },
        };
        field.setFrame(frame);
        let view: &NSView = field.as_ref();
        alert.setAccessoryView(Some(view));

        let response = alert.runModal();
        if response != NSAlertFirstButtonReturn {
            return Err(PromptError::Cancelled);
        }
        Ok(Zeroizing::new(field.stringValue().to_string()))
    }
}

#[cfg(not(target_os = "macos"))]
impl SecurePrompt for NativeSecurePrompt {
    fn prompt_password(
        &self,
        _title: &str,
        _message: &str,
    ) -> Result<Zeroizing<String>, PromptError> {
        Err(PromptError::UnsupportedPlatform)
    }
    fn prompt_passphrase(
        &self,
        _title: &str,
        _message: &str,
    ) -> Result<Option<Zeroizing<String>>, PromptError> {
        Err(PromptError::UnsupportedPlatform)
    }
    fn pick_pem_file(&self) -> Result<Option<std::path::PathBuf>, PromptError> {
        Err(PromptError::UnsupportedPlatform)
    }
    fn prompt_pem_paste(&self, _title: &str) -> Result<Zeroizing<String>, PromptError> {
        Err(PromptError::UnsupportedPlatform)
    }
    fn choose_pem_import(&self) -> Result<Zeroizing<String>, PromptError> {
        Err(PromptError::UnsupportedPlatform)
    }
}
