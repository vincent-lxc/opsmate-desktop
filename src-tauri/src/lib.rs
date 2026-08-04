//! OpsMate Desktop library entry.
//!
//! Capability boundary:
//! - WebView gets `core:default` only (no shell / opener / deep-link / stronghold).
//! - opener + deep-link plugins are registered for **Rust** only.
//! - Public auth IPC: `auth_begin_logto`, `auth_session_status`, `auth_logout`.
//! - Public cloud IPC: `cloud_call` (operationId + business input only; no bearer/URL).
//! - Public vault IPC: named vault_* only (credentialId max; passwords/PEM via native prompt).
//! - CSP `connect-src 'self'` — WebView still has no network access (Rust owns HTTPS).
//! - Auth/cloud/vault IPC errors are fixed public codes only (never raw HTTP/IdP/secret text).

pub mod auth;
pub mod cloud_bridge;
pub mod cloud_transport;
/// Local SSH preparation boundary (8B1) — crate-internal only; no IPC registration.
pub(crate) mod local_ssh;
pub mod secure_prompt;
pub mod security_cutoff;
/// Stronghold vault core + runtime (no Stronghold plugin registration).
pub mod vault;
pub mod vault_idle_watchdog;
pub mod vault_lifecycle_coordinator;
pub mod vault_os_sleep;

use auth::{
    map_auth_public, perform_begin_logto_arc, perform_handle_deep_link, perform_session_status,
    AuthBeginResponse, AuthBinding, AuthError, AuthStore, BrowserOpener, SecRandomSource,
    SessionStatus, TokioAuthHttp,
};
use cloud_bridge::{map_cloud_public, CloudBridge, CloudCallArgs, SessionInvalidatedEmitter};
use cloud_transport::HttpBackend;
use local_ssh::attach_session_manager_to_vault;
use secure_prompt::{NativeSecurePrompt, SecurePrompt};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use vault::{
    default_snapshot_path, VaultDeleteLocalRequest, VaultError, VaultImportRequest,
    VaultImportResponse, VaultMetaItem, VaultService, VaultStatus,
};
use vault_idle_watchdog::{VaultIdleWatchdog, DEFAULT_IDLE_POLL};
use vault_lifecycle_coordinator::VaultLifecycleCoordinator;
use zeroize::Zeroizing;

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

fn map_vault(e: VaultError) -> String {
    VaultService::map_vault_public(e).to_string()
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

// ─── Auth IPC ────────────────────────────────────────────────────────────────

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

/// Logout: cancel cloud → clear auth → SSH cutoff → real Stronghold seal.
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

// ─── Vault IPC (secret-free; WebView may only send credentialId) ─────────────

#[tauri::command]
fn vault_status(vault: State<'_, Arc<VaultService>>) -> Result<VaultStatus, String> {
    vault.status().map_err(map_vault)
}

/// Init: AuthBinding before password prompt; revalidate after; password never from WebView.
#[tauri::command]
fn vault_init(
    vault: State<'_, Arc<VaultService>>,
    auth: State<'_, Arc<AuthStore>>,
) -> Result<VaultStatus, String> {
    let expected = auth
        .auth_binding()
        .ok_or_else(|| map_vault(VaultError::Unauthenticated))?;
    let prompt = NativeSecurePrompt;
    let pw: Zeroizing<String> = prompt
        .prompt_password("Initialize vault", "Choose a vault password")
        .map_err(|e| map_vault(e.into()))?;
    if !auth.binding_still_current(&expected) {
        return Err(map_vault(VaultError::Unauthenticated));
    }
    let st = vault.init_with_password(None, pw).map_err(map_vault)?;
    if !auth.binding_still_current(&expected) {
        return Err(map_vault(VaultError::Unauthenticated));
    }
    Ok(st)
}

/// After successful Stronghold unlock: require **fresh** AuthBinding match before
/// unlocking SecurityCutoff or returning success. On mismatch: seal real vault,
/// keep cutoff locked, return vault_unauthenticated.
fn finalize_vault_unlock<B: HttpBackend>(
    vault: &VaultService,
    auth: &AuthStore,
    cloud: &CloudBridge<B>,
    expected: &AuthBinding,
    st: VaultStatus,
) -> Result<VaultStatus, String> {
    if !auth.binding_still_current(expected) {
        let _ = vault.on_logout();
        // Never notify_vault_unlocked — leave / force SecurityCutoff locked.
        cloud.notify_vault_locked();
        return Err(map_vault(VaultError::Unauthenticated));
    }
    if st.unlocked {
        cloud.notify_vault_unlocked();
    }
    Ok(st)
}

/// Unlock: capture AuthBinding before password prompt; revalidate via for_binding path
/// **and** again after unlock before cutoff unlock / success return.
#[tauri::command]
fn vault_unlock(
    vault: State<'_, Arc<VaultService>>,
    auth: State<'_, Arc<AuthStore>>,
    cloud: State<'_, Arc<CloudBridge>>,
) -> Result<VaultStatus, String> {
    let expected = auth
        .auth_binding()
        .ok_or_else(|| map_vault(VaultError::Unauthenticated))?;
    let prompt = NativeSecurePrompt;
    let pw: Zeroizing<String> = prompt
        .prompt_password("Unlock vault", "Enter vault password")
        .map_err(|e| map_vault(e.into()))?;
    if !auth.binding_still_current(&expected) {
        let _ = vault.on_logout();
        cloud.notify_vault_locked();
        return Err(map_vault(VaultError::Unauthenticated));
    }
    let st = vault
        .unlock_with_password_for_binding(auth.inner(), &expected, pw)
        .map_err(map_vault)?;
    finalize_vault_unlock(vault.inner(), auth.inner(), cloud.inner(), &expected, st)
}

/// Explicit user lock: SSH authority + SecurityCutoff close **before** Stronghold seal.
/// Secret-free signature (no password/pem/path).
#[tauri::command]
fn vault_lock(cloud: State<'_, Arc<CloudBridge>>) -> Result<VaultStatus, String> {
    cloud.inner().perform_user_vault_lock().map_err(map_vault)
}

#[tauri::command]
fn vault_import(
    vault: State<'_, Arc<VaultService>>,
    auth: State<'_, Arc<AuthStore>>,
    req: VaultImportRequest,
) -> Result<VaultImportResponse, String> {
    let prompt = NativeSecurePrompt;
    vault
        .import_begin_native(auth.inner(), &prompt, &req)
        .map_err(map_vault)
}

#[tauri::command]
fn vault_list_meta(
    vault: State<'_, Arc<VaultService>>,
    auth: State<'_, Arc<AuthStore>>,
) -> Result<Vec<VaultMetaItem>, String> {
    vault.list_meta(auth.inner()).map_err(map_vault)
}

#[tauri::command]
fn vault_delete_local(
    vault: State<'_, Arc<VaultService>>,
    auth: State<'_, Arc<AuthStore>>,
    req: VaultDeleteLocalRequest,
) -> Result<(), String> {
    vault
        .delete_local(auth.inner(), &req.credential_id)
        .map_err(map_vault)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let auth_store = Arc::new(AuthStore::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        // Stronghold is a Rust library only — never register as a Tauri plugin.
        .manage(auth_store.clone())
        .setup({
            let auth_store = auth_store.clone();
            move |app| {
                // Snapshot path fixed by Rust app data dir — never from WebView.
                // Fail closed on missing app data dir (never use an ephemeral insecure path).
                let data_dir = app
                    .path()
                    .app_data_dir()
                    .map_err(|_| "app_data_dir_unavailable")?;
                let vault = Arc::new(VaultService::new(default_snapshot_path(&data_dir)));
                app.manage(vault.clone());

                // Build CloudBridge with the same managed vault (401/logout seal real Stronghold).
                let emitter: Arc<dyn SessionInvalidatedEmitter> = Arc::new(TauriSessionEmitter {
                    app: app.handle().clone(),
                });
                let cloud =
                    CloudBridge::new(auth_store.clone(), vault.clone(), emitter).map_err(|_| {
                        // Fixed public setup error — no raw client text.
                        "cloud_setup_failed"
                    })?;
                let cloud = Arc::new(cloud);
                app.manage(cloud.clone());

                // 8B2: one session manager Arc — vault lifecycle sink + managed state for later IPC.
                let ssh_sessions = attach_session_manager_to_vault(
                    auth_store.clone(),
                    vault.clone(),
                    cloud.cutoff.clone(),
                );
                app.manage(ssh_sessions);

                // Lifecycle: idle watchdog + sleep/exit coordinator (SSH cutoff before seal).
                let lifecycle = VaultLifecycleCoordinator::new(vault, cloud.cutoff.clone());
                app.manage(lifecycle.clone());
                // RAII sleep/wake observers (Drop removes both); retained in managed state.
                let os_sleep = vault_os_sleep::OsSleepRegistration::register(lifecycle.clone());
                app.manage(os_sleep);
                let watchdog = VaultIdleWatchdog::new(lifecycle);
                watchdog.spawn_background(DEFAULT_IDLE_POLL);
                app.manage(watchdog);

                // Deep-link after emitter/cloud managed: success → session transition cutoffs.
                let store = auth_store.clone();
                let cloud_dl = cloud.clone();
                app.deep_link().on_open_url(move |event| {
                    for u in event.urls() {
                        let s = u.to_string();
                        let http = TokioAuthHttp::new();
                        if perform_handle_deep_link(store.as_ref(), &http, &s).is_ok() {
                            // New native session installed — kill prior cloud authority + seal vault.
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
            vault_status,
            vault_init,
            vault_unlock,
            vault_lock,
            vault_import,
            vault_list_meta,
            vault_delete_local,
        ])
        .build(tauri::generate_context!())
        .expect("error while building OpsMate Desktop")
        .run(|app_handle, event| {
            // Empty/secret-free lifecycle only — no payloads with tokens/paths.
            match event {
                // Prefer ExitRequested for seal; Exit re-enters on_process_exit which
                // is deduped (no second SSH generation / double seal).
                RunEvent::ExitRequested { .. } => {
                    if let Some(reg) = app_handle.try_state::<vault_os_sleep::OsSleepRegistration>()
                    {
                        reg.unregister();
                    }
                    if let Some(lc) = app_handle.try_state::<Arc<VaultLifecycleCoordinator>>() {
                        let _ = lc.on_process_exit();
                    }
                    if let Some(wd) = app_handle.try_state::<Arc<VaultIdleWatchdog>>() {
                        wd.stop();
                    }
                }
                RunEvent::Exit => {
                    // Fail-closed if ExitRequested was skipped; still deduped.
                    if let Some(reg) = app_handle.try_state::<vault_os_sleep::OsSleepRegistration>()
                    {
                        reg.unregister();
                    }
                    if let Some(lc) = app_handle.try_state::<Arc<VaultLifecycleCoordinator>>() {
                        let _ = lc.on_process_exit();
                    }
                    // Watchdog stop on Exit fallback (not only ExitRequested).
                    if let Some(wd) = app_handle.try_state::<Arc<VaultIdleWatchdog>>() {
                        wd.stop();
                    }
                }
                RunEvent::Resumed => {
                    // Wake: enforce locked (seal if unlocked); never auto-unlock.
                    if let Some(lc) = app_handle.try_state::<Arc<VaultLifecycleCoordinator>>() {
                        let _ = lc.on_resume();
                    }
                }
                // Desktop may also deliver suspend as a window event on some platforms;
                // mobile exposes Suspended on WindowEvent.
                RunEvent::WindowEvent { event, .. } => {
                    #[cfg(mobile)]
                    {
                        use tauri::WindowEvent;
                        if let WindowEvent::Suspended = event {
                            if let Some(lc) =
                                app_handle.try_state::<Arc<VaultLifecycleCoordinator>>()
                            {
                                let _ = lc.on_system_sleep();
                            }
                        }
                    }
                    let _ = event;
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::finalize_vault_unlock;
    use super::map_auth;
    use super::map_vault;
    use crate::auth::AuthError;
    use crate::vault::{VaultError, VaultStatus};

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
    fn map_vault_errors_are_fixed_public_codes_secret_free() {
        const ALLOWED: &[&str] = &[
            "vault_locked",
            "vault_already_unlocked",
            "vault_not_initialized",
            "vault_already_initialized",
            "vault_invalid_password",
            "vault_invalid_identity",
            "vault_unauthenticated",
            "vault_not_found",
            "vault_invalid_private_key",
            "vault_prompt_cancelled",
            "vault_prompt_failed",
            "vault_storage_error",
            "vault_internal_error",
        ];
        for e in [
            VaultError::Locked,
            VaultError::AlreadyUnlocked,
            VaultError::NotInitialized,
            VaultError::AlreadyInitialized,
            VaultError::InvalidPassword,
            VaultError::InvalidIdentity,
            VaultError::Unauthenticated,
            VaultError::NotFound,
            VaultError::InvalidPrivateKey,
            VaultError::PromptCancelled,
            VaultError::PromptFailed,
            VaultError::Storage,
            VaultError::Internal,
        ] {
            let s = map_vault(e);
            assert!(
                ALLOWED.contains(&s.as_str()),
                "unexpected vault public error {s}"
            );
            for forbidden in [
                "BEGIN",
                "PRIVATE KEY",
                "passphrase",
                "token=",
                "eyJ",
                "Bearer ",
                "http://",
                "https://",
            ] {
                assert!(!s.contains(forbidden), "leaked {forbidden:?} in {s}");
            }
            // Fixed codes may contain the substring "password" only as the code id.
            assert!(s.starts_with("vault_"), "must be vault_* code: {s}");
        }
    }

    #[test]
    fn vault_ipc_handler_allowlist_and_secret_free_signatures() {
        let lib = include_str!("lib.rs");
        // Production surface only (ignore cfg(test) assertions that quote banned tokens).
        let prod = lib.split("#[cfg(test)]").next().unwrap_or(lib);
        for name in [
            "vault_status",
            "vault_init",
            "vault_unlock",
            "vault_lock",
            "vault_import",
            "vault_list_meta",
            "vault_delete_local",
        ] {
            assert!(prod.contains(name), "missing vault command {name}");
            assert!(
                prod.contains(&format!("fn {name}")),
                "handler fn {name} missing"
            );
        }
        assert!(prod.contains("vault_delete_local,"));
        assert!(!prod.contains("fn vault_on_tenant_switch"));
        assert!(!prod.contains("VaultUnlockRequest"));
        // Stronghold is library-only: no plugin() registration in production setup.
        let setup = prod
            .split("pub fn run()")
            .nth(1)
            .unwrap_or(prod)
            .split("invoke_handler")
            .next()
            .unwrap_or("");
        assert!(
            !setup.contains("stronghold::init"),
            "must not register Stronghold plugin in run/setup"
        );
        // Commands must not accept password/pem/path from WebView args.
        let vault_region = prod
            .split("// ─── Vault IPC")
            .nth(1)
            .unwrap_or(prod)
            .split("#[cfg_attr(mobile")
            .next()
            .unwrap_or("");
        for banned in [
            "password:",
            "passphrase:",
            "pem:",
            "snapshot_path",
            "snapshotPath",
            "tenant_id",
            "tenantId",
            "subject:",
            "token:",
            "epoch:",
        ] {
            assert!(
                !vault_region.contains(banned),
                "vault IPC region must not expose {banned}"
            );
        }
        assert!(vault_region.contains("NativeSecurePrompt"));
        assert!(vault_region.contains("auth_binding"));
        assert!(vault_region.contains("binding_still_current"));
        assert!(vault_region.contains("unlock_with_password_for_binding"));
    }

    #[test]
    fn cloud_bridge_built_in_setup_with_required_emitter_and_vault() {
        let lib = include_str!("lib.rs");
        assert!(lib.contains("CloudBridge::new"));
        assert!(lib.contains("TauriSessionEmitter"));
        assert!(lib.contains("session-invalidated"));
        assert!(lib.contains("on_successful_session_install"));
        assert!(lib.contains("perform_secure_logout"));
        assert!(lib.contains("SessionInvalidatedEmitter"));
        assert!(lib.contains("VaultService::new"));
        assert!(lib.contains("default_snapshot_path"));
        assert!(lib.contains("app_data_dir"));
        assert!(!lib.contains(".expect(\"cloud transport"));
    }

    #[test]
    fn production_wires_idle_watchdog_and_run_event_lifecycle() {
        let lib = include_str!("lib.rs");
        let prod = lib.split("#[cfg(test)]").next().unwrap_or(lib);
        assert!(prod.contains("VaultLifecycleCoordinator::new"));
        assert!(prod.contains("VaultIdleWatchdog::new"));
        assert!(prod.contains("spawn_background"));
        assert!(prod.contains("DEFAULT_IDLE_POLL"));
        assert!(prod.contains("RunEvent::Exit"));
        assert!(prod.contains("ExitRequested"));
        assert!(prod.contains("on_process_exit"));
        assert!(prod.contains("RunEvent::Resumed"));
        assert!(prod.contains("on_resume"));
        // build().run for lifecycle events (not bare .run(generate_context)).
        assert!(prod.contains(".build(tauri::generate_context!())"));
        assert!(prod.contains("OsSleepRegistration::register"));
        assert!(prod.contains("on_process_exit"));
        // Explicit unregister on both ExitRequested and Exit.
        assert!(prod.contains("reg.unregister()"));
        assert!(prod.matches("wd.stop()").count() >= 2);
    }

    #[test]
    fn production_wires_local_ssh_session_manager_as_vault_sink() {
        let lib = include_str!("lib.rs");
        let prod = lib.split("#[cfg(test)]").next().unwrap_or(lib);
        assert!(prod.contains("attach_session_manager_to_vault"));
        assert!(prod.contains("app.manage(ssh_sessions)"));
        // No broad crate-level clippy allow block.
        assert!(!prod.contains("clippy::borrow_deref_ref"));
        assert!(!prod.contains("clippy::large_enum_variant"));
    }

    #[test]
    fn production_vault_path_fail_closed_no_temp_fallback() {
        let lib = include_str!("lib.rs");
        let prod = lib.split("#[cfg(test)]").next().unwrap_or(lib);
        let setup = prod
            .split("pub fn run()")
            .nth(1)
            .unwrap_or(prod)
            .split("invoke_handler")
            .next()
            .unwrap_or("");
        assert!(
            setup.contains("app_data_dir_unavailable"),
            "setup must fail closed with fixed code when app_data_dir fails"
        );
        assert!(
            setup.contains("map_err(|_| \"app_data_dir_unavailable\")")
                || setup.contains("app_data_dir_unavailable"),
            "must map app_data_dir failure to fixed non-secret code"
        );
        assert!(
            !setup.contains("temp_dir"),
            "production vault path must never fall back to temp_dir"
        );
        assert!(
            !setup.contains("unwrap_or_else"),
            "production vault path must not unwrap_or_else to insecure location"
        );
    }

    #[test]
    fn vault_unlock_revalidates_binding_before_cutoff_unlock() {
        let lib = include_str!("lib.rs");
        let prod = lib.split("#[cfg(test)]").next().unwrap_or(lib);
        assert!(
            prod.contains("fn finalize_vault_unlock"),
            "post-unlock finalize helper required"
        );
        // Order in finalize: binding check → seal on mismatch → notify_unlocked only if still current.
        let fin = prod
            .split("fn finalize_vault_unlock")
            .nth(1)
            .unwrap()
            .split("#[tauri::command]")
            .next()
            .unwrap();
        assert!(fin.contains("binding_still_current"));
        assert!(fin.contains("on_logout"));
        assert!(fin.contains("notify_vault_locked"));
        assert!(fin.contains("notify_vault_unlocked"));
        let mismatch_pos = fin
            .find("!auth.binding_still_current")
            .expect("mismatch check");
        let unlocked_notify = fin.find("notify_vault_unlocked").expect("unlock notify");
        assert!(
            mismatch_pos < unlocked_notify,
            "must revalidate binding before notify_vault_unlocked"
        );
        // vault_unlock must call finalize after unlock_with_password_for_binding
        let unlock_fn = prod
            .split("fn vault_unlock")
            .nth(1)
            .unwrap()
            .split("fn vault_lock")
            .next()
            .unwrap();
        let for_bind = unlock_fn
            .find("unlock_with_password_for_binding")
            .expect("for_binding");
        let finalize = unlock_fn
            .find("finalize_vault_unlock")
            .expect("finalize call");
        assert!(
            for_bind < finalize,
            "finalize must run after Stronghold unlock"
        );
        assert!(
            !unlock_fn.contains("notify_vault_unlocked"),
            "vault_unlock must not notify unlock except via finalize"
        );
    }

    #[tokio::test]
    async fn finalize_vault_unlock_mismatch_seals_and_keeps_cutoff_locked() {
        use crate::auth::AuthStore;
        use crate::cloud_bridge::{CloudBridge, SpyEmitter};
        use crate::cloud_transport::client::MockHttpBackend;
        use crate::security_cutoff::SecurityCutoff;
        use crate::vault::VaultService;
        use std::sync::Arc;
        use std::time::Instant;
        use tauri_plugin_stronghold::stronghold::Stronghold;

        let mut path = std::env::temp_dir();
        path.push(format!(
            "opsmate-finalize-unlock-{}-{}.hold",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("t1", "alice", "admin", "sub-1");
        let expected = auth.auth_binding().unwrap();
        let sh = Stronghold::new(&path, vec![0xA1u8; 32]).expect("sh");
        let vault = Arc::new(VaultService::new(path.clone()));
        // Simulate post-unlock unlocked state.
        vault.test_inject_unlocked(sh, expected.clone(), path.clone(), Instant::now());
        assert!(vault.is_unlocked());

        let cutoff = Arc::new(SecurityCutoff::new());
        // Pretend cutoff was still locked (as at process start / after seal).
        assert!(cutoff.is_vault_locked());
        let cloud = CloudBridge::with_backend_cutoff(
            auth.clone(),
            vault.clone(),
            MockHttpBackend::new("{}"),
            cutoff.clone(),
            Arc::new(SpyEmitter::new()),
        );

        // Session switches after unlock work but before finalize.
        let _ = auth.clear_native();
        auth.install_session_for_tests("t1", "alice", "admin", "sub-new");
        assert!(!auth.binding_still_current(&expected));

        let st = VaultStatus {
            unlocked: true,
            locked_reason: None,
        };
        let err = finalize_vault_unlock(&vault, &auth, &cloud, &expected, st).unwrap_err();
        assert_eq!(err, "vault_unauthenticated");
        assert!(!vault.is_unlocked());
        assert!(
            cutoff.is_vault_locked(),
            "cutoff must remain locked when binding mismatches after unlock"
        );
        let _ = std::fs::remove_file(&path);
    }
}
