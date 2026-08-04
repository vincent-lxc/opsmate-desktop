//! OpsMate Desktop library entry.
//!
//! Capability boundary:
//! - WebView gets `core:default` only (no shell / opener / deep-link / stronghold).
//! - opener + deep-link plugins are registered for **Rust** only.
//! - Public auth IPC: `auth_begin_logto`, `auth_session_status`, `auth_logout`.
//! - Cloud transport is allowlist-only (`cloud_transport::operations`); full HTTPS later.
//! - Auth IPC errors are fixed public codes only (never raw HTTP/IdP/callback text).

pub mod auth;
pub mod cloud_transport;

use auth::{
    map_auth_public, perform_begin_logto_arc, perform_handle_deep_link, perform_logout,
    perform_session_status, AuthBeginResponse, AuthError, AuthStore, BrowserOpener,
    SecRandomSource, SessionStatus, TokioAuthHttp,
};
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

struct TauriBrowserOpener {
    app: AppHandle,
}

impl BrowserOpener for TauriBrowserOpener {
    fn open_url(&self, url: &str) -> Result<(), AuthError> {
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|_| AuthError::BrowserOpen)
    }
}

/// Fixed public IPC error codes — never Display of secret-bearing payloads.
fn map_auth(e: AuthError) -> String {
    map_auth_public(e)
}

/// Start Logto PKCE login in the system browser. Response is secret-free.
#[tauri::command]
fn auth_begin_logto(
    app: AppHandle,
    store: State<'_, Arc<AuthStore>>,
) -> Result<AuthBeginResponse, String> {
    let http = TokioAuthHttp::new();
    let opener = TauriBrowserOpener { app };
    let rng = SecRandomSource;
    let store = Arc::clone(store.inner());
    perform_begin_logto_arc(store, &rng, &http, &opener).map_err(map_auth)
}

/// Secret-free session status for React (no token / subject / tenant / workspace).
#[tauri::command]
fn auth_session_status(store: State<'_, Arc<AuthStore>>) -> Result<SessionStatus, String> {
    perform_session_status(store.inner()).map_err(map_auth)
}

/// Clear native session + pending PKCE.
#[tauri::command]
fn auth_logout(store: State<'_, Arc<AuthStore>>) -> Result<(), String> {
    perform_logout(store.inner()).map_err(map_auth)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let auth_store = Arc::new(AuthStore::new());

    tauri::Builder::default()
        // Rust-only plugins — capabilities must NOT grant WebView opener/deep-link perms.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(auth_store.clone())
        .setup({
            let auth_store = auth_store.clone();
            move |app| {
                let store = auth_store.clone();
                app.deep_link().on_open_url(move |event| {
                    for u in event.urls() {
                        // Never log the raw deep-link URL (contains code/state).
                        let s = u.to_string();
                        let http = TokioAuthHttp::new();
                        let _ = perform_handle_deep_link(store.as_ref(), &http, &s);
                    }
                });
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            auth_begin_logto,
            auth_session_status,
            auth_logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpsMate Desktop");
}

#[cfg(test)]
mod tests {
    use super::map_auth;
    use crate::auth::AuthError;

    #[test]
    fn foundation_crate_builds() {
        assert_eq!(env!("CARGO_PKG_NAME"), "opsmate-desktop");
    }

    #[test]
    fn frontend_dist_is_independent_dist() {
        let conf = include_str!("../tauri.conf.json");
        assert!(
            conf.contains("\"frontendDist\": \"../dist\""),
            "frontendDist must be independent ../dist"
        );
        assert!(
            !conf.contains("../../admin/dist"),
            "must not reference monorepo admin/dist"
        );
        assert!(
            !conf.contains("ops-ai/apps/admin"),
            "must not reference ops-ai admin path"
        );
    }

    #[test]
    fn foundation_csp_is_self_only_connect() {
        let conf = include_str!("../tauri.conf.json");
        assert!(
            conf.contains("connect-src 'self'"),
            "foundation CSP connect-src must be self only"
        );
        assert!(
            !conf.contains("connect-src https://app.itops.sh"),
            "cloud connect-src is deferred until native transport lands"
        );
    }

    #[test]
    fn default_capability_has_no_shell_or_opener() {
        let cap = include_str!("../capabilities/default.json");
        assert!(cap.contains("core:default"));
        assert!(!cap.contains("shell:"));
        assert!(!cap.contains("opener:"));
        assert!(!cap.contains("stronghold:"));
        assert!(!cap.contains("deep-link:"));
    }

    #[test]
    fn deep_link_scheme_configured_for_opsmate() {
        let conf = include_str!("../tauri.conf.json");
        assert!(
            conf.contains("\"schemes\"") && conf.contains("opsmate"),
            "tauri.conf must register opsmate deep-link scheme for OS delivery to Rust"
        );
    }

    #[test]
    fn map_auth_never_leaks_secret_bearing_error_text() {
        const ALLOWED: &[&str] = &[
            "auth_random_failed",
            "auth_http_failed",
            "auth_logto_disabled",
            "auth_invalid_config",
            "auth_browser_open_failed",
            "auth_invalid_callback",
            "auth_state_mismatch",
            "auth_state_replay",
            "auth_exchange_failed",
            "auth_unauthorized",
            "auth_invalid_session",
            "auth_pending_expired",
            "auth_internal_error",
        ];
        for e in [
            AuthError::Http,
            AuthError::Exchange,
            AuthError::BrowserOpen,
            AuthError::Internal,
            AuthError::InvalidSession,
            AuthError::PendingExpired,
            AuthError::StateMismatch,
            AuthError::StateReplay,
            AuthError::InvalidDeepLink,
            AuthError::InvalidConfig,
            AuthError::LogtoDisabled,
            AuthError::Unauthorized,
            AuthError::Random,
        ] {
            let s = map_auth(e);
            assert!(ALLOWED.contains(&s.as_str()), "unexpected public error {s}");
            for forbidden in [
                "http://",
                "https://",
                "token=",
                "verifier",
                "code_verifier",
                "codeVerifier",
                "Bearer ",
                "opsmate://",
                "jwt-",
                "eyJ",
                "SECRET",
            ] {
                assert!(!s.contains(forbidden), "leaked {forbidden:?} in {s}");
            }
        }
    }
}
