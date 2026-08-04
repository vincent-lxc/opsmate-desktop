//! HTTP adapter for Logto public config + code exchange (rustls only).
//!
//! Production uses reqwest + rustls. Tests inject `AuthHttp` mocks — no network.
//!
//! # Verifier / secret handling
//! Exchange uses a dedicated `ExchangeRequest` with `Zeroizing` fields. Production
//! serializes a transient JSON body for TLS; that buffer is stack-owned for the
//! request lifetime and dropped immediately after send. We cannot force zeroization
//! of TLS/OS kernel buffers or reqwest internal copies — documented honestly.

use zeroize::Zeroizing;

use super::AuthError;

/// Native-owned exchange body. Never log or Debug this struct.
pub struct ExchangeRequest {
    pub code: Zeroizing<String>,
    pub code_verifier: Zeroizing<String>,
    pub redirect_uri: &'static str,
}

impl std::fmt::Debug for ExchangeRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExchangeRequest")
            .field("code", &"<redacted>")
            .field("code_verifier", &"<redacted>")
            .field("redirect_uri", &self.redirect_uri)
            .finish()
    }
}

impl ExchangeRequest {
    /// Build a short-lived JSON body for the wire. Caller must drop the returned
    /// `Zeroizing` immediately after the HTTP send completes.
    pub fn to_json_bytes(&self) -> Result<Zeroizing<Vec<u8>>, AuthError> {
        // Manual JSON avoids serde_json::Value tree that would own long-lived String copies.
        let mut out = String::with_capacity(
            64 + self.code.len() + self.code_verifier.len() + self.redirect_uri.len(),
        );
        out.push_str("{\"code\":");
        push_json_string(&mut out, self.code.as_str());
        out.push_str(",\"codeVerifier\":");
        push_json_string(&mut out, self.code_verifier.as_str());
        out.push_str(",\"redirectUri\":");
        push_json_string(&mut out, self.redirect_uri);
        out.push('}');
        Ok(Zeroizing::new(out.into_bytes()))
    }
}

fn push_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                for b in c.encode_utf8(&mut [0; 4]).as_bytes() {
                    out.push_str(&format!("\\u00{b:02x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Injectable HTTP surface for config GET and exchange POST.
pub trait AuthHttp: Send + Sync {
    fn get_text(&self, url: &str) -> Result<String, AuthError>;
    /// POST exchange. Implementations must not retain `code_verifier` after return.
    fn post_exchange(&self, url: &str, req: &ExchangeRequest) -> Result<String, AuthError>;
}

/// Production HTTP adapter (blocking wrapper around reqwest + rustls).
pub struct TokioAuthHttp {
    client: reqwest::Client,
}

impl Default for TokioAuthHttp {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .use_rustls_tls()
                .build()
                .expect("reqwest client"),
        }
    }
}

impl TokioAuthHttp {
    pub fn new() -> Self {
        Self::default()
    }

    fn block_on_safe<F, T>(fut: F) -> Result<T, AuthError>
    where
        F: std::future::Future<Output = Result<T, AuthError>> + Send + 'static,
        T: Send + 'static,
    {
        if tokio::runtime::Handle::try_current().is_ok() {
            return std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| AuthError::Http)?;
                rt.block_on(fut)
            })
            .join()
            .map_err(|_| AuthError::Internal)?;
        }
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| AuthError::Http)?;
        rt.block_on(fut)
    }
}

impl AuthHttp for TokioAuthHttp {
    fn get_text(&self, url: &str) -> Result<String, AuthError> {
        let client = self.client.clone();
        let url = url.to_string();
        Self::block_on_safe(async move {
            let res = client.get(&url).send().await.map_err(|_| AuthError::Http)?;
            if !res.status().is_success() {
                return Err(AuthError::Http);
            }
            res.text().await.map_err(|_| AuthError::Http)
        })
    }

    fn post_exchange(&self, url: &str, req: &ExchangeRequest) -> Result<String, AuthError> {
        let client = self.client.clone();
        let url = url.to_string();
        // Transient wire bytes; Zeroizing drops wipe our copy after the future ends.
        let body = req.to_json_bytes()?;
        let body_owned = body.to_vec();
        // Note: body_owned is an ordinary Vec required to move into the async block.
        // It is not retained after this function returns; TLS stack copies are OS-owned.
        let _wipe_on_drop = body;
        Self::block_on_safe(async move {
            let res = client
                .post(&url)
                .header("content-type", "application/json")
                .body(body_owned)
                .send()
                .await
                .map_err(|_| AuthError::Http)?;
            let status = res.status();
            // Intentionally discard response body text on error (may contain diagnostics).
            let text = res.text().await.map_err(|_| AuthError::Http)?;
            if status.as_u16() == 401 {
                return Err(AuthError::Unauthorized);
            }
            if !status.is_success() {
                // Drop text without embedding it in the error.
                drop(text);
                return Err(AuthError::Exchange);
            }
            Ok(text)
        })
    }
}
