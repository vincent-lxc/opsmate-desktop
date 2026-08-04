//! OpsMate Desktop library entry.
//!
//! Capability boundary:
//! - WebView gets `core:default` only (no shell / opener / deep-link / stronghold).
//! - opener + deep-link plugins are registered for **Rust** only.
//! - Public auth IPC: `auth_begin_logto`, `auth_session_status`, `auth_logout`.
//! - Public cloud IPC: `cloud_call` (operationId + business input only; no bearer/URL).
//! - CSP `connect-src 'self'` — WebView still has no network access (Rust owns HTTPS).
//! - Auth/cloud IPC errors are fixed public codes only (never raw HTTP/IdP/callback text).

pub mod auth;
pub mod cloud_bridge;
pub mod cloud_transport;
pub mod security_cutoff;

use auth::{
    map_auth_public, perform_begin_logto_arc, perform_handle_deep_link, perform_session_status,
    AuthBeginResponse, AuthError, AuthStore, BrowserOpener, SecRandomSource, SessionStatus,
    TokioAuthHttp,
};
use cloud_bridge::{map_cloud_public, CloudBridge, CloudCallArgs, SessionInvalidatedEmitter};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
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

/// Tauri secret-free session-invalidated emitter (required, not optional).
struct TauriSessionEmitter {
    app: AppHandle,
}

impl SessionInvalidatedEmitter for TauriSessionEmitter {
    fn emit_session_invalidated(&self) {
        // Empty payload — no token/URL/body/epoch.
        let _ = self.app.emit("session-invalidated", ());
    }
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

/// Logout: cancel cloud → clear auth → SSH cutoff → vault lock.
#[tauri::command]
fn auth_logout(cloud: State<'_, Arc<CloudBridge>>) -> Result<(), String> {
    cloud.inner().perform_secure_logout().map_err(map_auth)
}

/// Named business cloud call. Input: operationId + JSON business fields only.
#[tauri::command]
async fn cloud_call(
    cloud: State<'_, Arc<CloudBridge>>,
    args: CloudCallArgs,
) -> Result<serde_json::Value, String> {
    cloud
        .inner()
        .call(&args.operation_id, &args.input)
        .await
        .map_err(map_cloud_public)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let auth_store = Arc::new(AuthStore::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(auth_store.clone())
        .setup({
            let auth_store = auth_store.clone();
            move |app| {
                // Build CloudBridge only after AppHandle exists (required emitter).
                let emitter: Arc<dyn SessionInvalidatedEmitter> = Arc::new(TauriSessionEmitter {
                    app: app.handle().clone(),
                });
                let cloud = CloudBridge::new(auth_store.clone(), emitter).map_err(|_| {
                    // Fixed public setup error — no raw client text.
                    "cloud_setup_failed"
                })?;
                let cloud = Arc::new(cloud);
                app.manage(cloud.clone());

                // Deep-link after emitter/cloud managed: success → session transition cutoffs.
                let store = auth_store.clone();
                let cloud_dl = cloud.clone();
                app.deep_link().on_open_url(move |event| {
                    for u in event.urls() {
                        let s = u.to_string();
                        let http = TokioAuthHttp::new();
                        if perform_handle_deep_link(store.as_ref(), &http, &s).is_ok() {
                            // New native session installed — kill prior cloud authority.
                            cloud_dl.on_successful_session_install();
                        }
                    }
                });
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            auth_begin_logto,
            auth_session_status,
            auth_logout,
            cloud_call,
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

    #[test]
    fn cloud_bridge_built_in_setup_with_required_emitter() {
        let lib = include_str!("lib.rs");
        assert!(lib.contains("CloudBridge::new"));
        assert!(lib.contains("TauriSessionEmitter"));
        assert!(lib.contains("session-invalidated"));
        assert!(lib.contains("on_successful_session_install"));
        assert!(lib.contains("perform_secure_logout"));
        assert!(lib.contains("SessionInvalidatedEmitter"));
        assert!(!lib.contains(".expect(\"cloud transport"));
    }
}
