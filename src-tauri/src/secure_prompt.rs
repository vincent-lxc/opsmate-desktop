//! Native secure input (Task 3).
//!
//! Password / passphrase / PEM paste use **native OS controls only**
//! (macOS AppKit, Windows Win32 EDIT, Linux GTK3). File pick uses `rfd`.
//! Secrets are wrapped in `Zeroizing<String>` immediately — never WebView/IPC.
//!
//! Layout: this file holds shared trait/dispatch; platform impls live in
//! `secure_prompt/{macos,windows,linux}.rs`.

use thiserror::Error;
use zeroize::Zeroizing;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

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

/// Production native prompt dispatcher (platform `SecurePrompt` impl).
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

/// Non-target OS (not macOS/Windows/Linux): fail closed with UnsupportedPlatform.
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
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
