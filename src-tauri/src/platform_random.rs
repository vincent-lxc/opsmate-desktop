//! Cross-platform production CSPRNG (Task 2).
//!
//! Rust-owned adapter over the pinned `getrandom` crate. No platform FFI,
//! no zero-fill fallback, no WebView/JS randomness.

use crate::auth::{AuthError, RandomSource};

/// Production random source for Logto PKCE, session ids, and vault salt.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemRandomSource;

impl RandomSource for SystemRandomSource {
    fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), AuthError> {
        getrandom::fill(dest).map_err(|_| AuthError::Random)
    }
}
