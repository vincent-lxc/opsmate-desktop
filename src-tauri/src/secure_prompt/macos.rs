//! macOS AppKit secure prompts (NSSecureTextField / NSTextField).
//! Secret strings are wrapped in `Zeroizing` at the native capture boundary.

use super::{NativeSecurePrompt, PromptError, SecurePrompt};
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSAlertStyle, NSSecureTextField,
    NSTextField, NSView,
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
        // Wrap immediately — no raw secret String local before trim/return.
        let secret = Zeroizing::new(field.stringValue().to_string());
        if secret.trim().is_empty() {
            return Err(PromptError::Cancelled);
        }
        Ok(secret)
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
            let secret = Zeroizing::new(
                std::fs::read_to_string(&path).map_err(|e| PromptError::Native(e.to_string()))?,
            );
            if secret.trim().is_empty() {
                return Err(PromptError::Cancelled);
            }
            Ok(secret)
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
