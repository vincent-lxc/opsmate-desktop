//! PKCE (RFC 7636) helpers and CSPRNG adapters.
//!
//! Secrets (verifier / state raw buffers) are zeroized after encoding.

use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use super::AuthError;

/// Adapter for cryptographic random bytes (testable).
pub trait RandomSource: Send + Sync {
    fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), AuthError>;
}

/// Production random via macOS Security.framework `SecRandomCopyBytes`.
#[derive(Debug, Default, Clone, Copy)]
pub struct SecRandomSource;

#[cfg(target_os = "macos")]
impl RandomSource for SecRandomSource {
    fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), AuthError> {
        #[link(name = "Security", kind = "framework")]
        extern "C" {
            fn SecRandomCopyBytes(
                rnd: *const std::ffi::c_void,
                count: usize,
                bytes: *mut u8,
            ) -> i32;
        }
        let rc = unsafe { SecRandomCopyBytes(std::ptr::null(), dest.len(), dest.as_mut_ptr()) };
        if rc == 0 {
            Ok(())
        } else {
            Err(AuthError::Random)
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl RandomSource for SecRandomSource {
    fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), AuthError> {
        dest.fill(0);
        Err(AuthError::Random)
    }
}

const B64URL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn base64url_nopad(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        out.push(B64URL[((n >> 18) & 63) as usize] as char);
        out.push(B64URL[((n >> 12) & 63) as usize] as char);
        out.push(B64URL[((n >> 6) & 63) as usize] as char);
        out.push(B64URL[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = data.len() - i;
    if rem == 1 {
        let n = (data[i] as u32) << 16;
        out.push(B64URL[((n >> 18) & 63) as usize] as char);
        out.push(B64URL[((n >> 12) & 63) as usize] as char);
    } else if rem == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        out.push(B64URL[((n >> 18) & 63) as usize] as char);
        out.push(B64URL[((n >> 12) & 63) as usize] as char);
        out.push(B64URL[((n >> 6) & 63) as usize] as char);
    }
    out
}

/// S256 code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier))) without padding.
pub fn pkce_s256_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    base64url_nopad(&digest)
}

pub fn generate_code_verifier<R: RandomSource>(rng: &R) -> Result<String, AuthError> {
    let mut buf = [0u8; 32];
    rng.fill_bytes(&mut buf)?;
    let out = base64url_nopad(&buf);
    buf.zeroize();
    Ok(out)
}

pub fn generate_state<R: RandomSource>(rng: &R) -> Result<String, AuthError> {
    let mut buf = [0u8; 16];
    rng.fill_bytes(&mut buf)?;
    let out = base64url_nopad(&buf);
    buf.zeroize();
    Ok(out)
}

pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
