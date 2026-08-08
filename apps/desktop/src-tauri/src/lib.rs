//! OpsMate Desktop library entry.
//!
//! Plugin boundary:
//! - opener / deep-link registered for **Rust** only (no WebView permissions).
//! - stronghold is **never** registered as a Tauri plugin; vault uses Rust Client API only.
//! - Vault IPC never accepts tenant_id / user_id / snapshot_path from WebView.

// Intentional test/IPC hooks and platform stubs retained for security surface coverage.
// Clippy -D warnings still enforces correctness/style lints; dead_code is not a gate for hooks.
#![allow(dead_code)]

mod auth;
mod cloud_proxy;
mod cloud_terminal;
mod secure_prompt;
mod security_cutoff;
mod ssh_ipc;
mod ssh_registry;
mod ssh_session;
mod ssh_transport;
mod upload;
mod vault;
mod vault_idle_watchdog;
mod vault_lifecycle;

use auth::{
    map_auth_public, perform_begin_logto, perform_handle_deep_link, perform_logout,
    perform_on_unauthorized, perform_session_status, AuthBeginResponse, AuthError,
    AuthSessionStatus, AuthStore, BrowserOpener, SecRandomSource, TokioAuthHttp,
    AUTH_SESSION_EVENT,
};
use cloud_proxy::http::ReqwestBackend;
use cloud_proxy::{map_proxy_public, CloudProxy, CloudRequest, CloudResponse, ProxyError};
use cloud_terminal::{
    perform_cloud_terminal_close, perform_cloud_terminal_open, perform_cloud_terminal_resize,
    perform_cloud_terminal_write, CloudTerminalCloseRequest, CloudTerminalOpenRequest,
    CloudTerminalResizeRequest, CloudTerminalSessionManager, CloudTerminalWriteRequest,
};
use secure_prompt::{NativeSecurePrompt, SecurePrompt};
use security_cutoff::{
    run_auth_session_teardown, CompositeTerminalLifecycleSink, ProductionSecurityCutoff,
    SecurityCutoff, SessionInvalidatedEmitter, SESSION_INVALIDATED_EVENT,
};
use ssh_ipc::{
    map_ssh_user, perform_local_ssh_close, perform_local_ssh_open, perform_local_ssh_resize,
    perform_local_ssh_write, LocalSshOutputEmitter, LocalSshOutputEvent, LOCAL_SSH_OUTPUT_EVENT,
};
use ssh_registry::{
    LocalSshCloseRequest, LocalSshResizeRequest, LocalSshSessionManager, LocalSshWriteRequest,
};
use ssh_session::{LocalSshOpenRequest, LocalSshOpenResponse, SshSessionError};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use upload::{
    confirm_on_app_main_thread, perform_cloud_delete, perform_cloud_upload, CloudConfirmPrompt,
    CloudCustodyConfirmer, CloudCustodyError, CloudCustodyResponse, CloudDeleteRequest,
    CloudUploadRequest, NativeCloudCustodyConfirmer, ReqwestCloudCustodyHttp,
};
use vault::{
    default_snapshot_path, VaultDeleteLocalRequest, VaultError, VaultImportRequest,
    VaultImportResponse, VaultMetaItem, VaultService, VaultStatus,
};
use vault_idle_watchdog::{VaultIdleWatchdog, DEFAULT_IDLE_POLL};
use vault_lifecycle::register_vault_lifecycle;

struct TauriBrowserOpener {
    app: AppHandle,
}

impl BrowserOpener for TauriBrowserOpener {
    fn open_url(&self, url: &str) -> Result<(), AuthError> {
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| AuthError::BrowserOpen(e.to_string()))
    }
}

fn map_auth(e: AuthError) -> String {
    // Fixed public codes only — never Display of free-form Exchange/Http payloads.
    map_auth_public(e).to_string()
}

/// Emit secret-free session status to WebView (never includes bearer/subject/tenant).
fn emit_auth_session_status(app: &AppHandle, store: &AuthStore) {
    if let Ok(status) = perform_session_status(store) {
        let _ = app.emit(AUTH_SESSION_EVENT, status);
    }
}

fn map_vault(e: VaultError) -> String {
    // Sanitize — never include secret material
    e.to_string()
}

fn map_cloud(e: CloudCustodyError) -> String {
    e.user_message()
}

/// Confirmer that always runs the native dialog on the App main thread.
struct MainThreadCloudConfirmer {
    app: AppHandle,
    inner: Arc<dyn CloudCustodyConfirmer>,
}

impl CloudCustodyConfirmer for MainThreadCloudConfirmer {
    fn confirm(&self, prompt: &CloudConfirmPrompt) -> Result<(), CloudCustodyError> {
        confirm_on_app_main_thread(&self.app, Arc::clone(&self.inner), prompt.clone())
    }
}

/// Emit local-SSH terminal output to the privileged **main** window only.
struct TauriMainSshEmitter {
    app: AppHandle,
}

impl LocalSshOutputEmitter for TauriMainSshEmitter {
    fn emit_to_main(&self, event: &LocalSshOutputEvent) -> Result<(), SshSessionError> {
        let window = self
            .app
            .get_webview_window("main")
            .ok_or(SshSessionError::Internal)?;
        window
            .emit(LOCAL_SSH_OUTPUT_EVENT, event)
            .map_err(|_| SshSessionError::Internal)
    }
}

// ─── Local SSH IPC (D4B2c) ───────────────────────────────────────────────────

/// Open local SSH: prepare → lease → russh connector → register → bind output sink.
/// Runs on a blocking pool — never blocks the UI/main thread with network I/O.
#[tauri::command]
async fn local_ssh_open(
    app: AppHandle,
    auth: State<'_, Arc<AuthStore>>,
    vault: State<'_, Arc<VaultService>>,
    sessions: State<'_, Arc<LocalSshSessionManager>>,
    req: LocalSshOpenRequest,
) -> Result<LocalSshOpenResponse, String> {
    let auth = Arc::clone(auth.inner());
    let vault = Arc::clone(vault.inner());
    let sessions = Arc::clone(sessions.inner());
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| map_ssh_user(SshSessionError::Internal))?;
    let emitter: Arc<dyn LocalSshOutputEmitter> = Arc::new(TauriMainSshEmitter { app });
    tauri::async_runtime::spawn_blocking(move || {
        perform_local_ssh_open(auth, vault, sessions, req, app_data, emitter).map_err(map_ssh_user)
    })
    .await
    .map_err(|_| map_ssh_user(SshSessionError::Internal))?
}

#[tauri::command]
async fn local_ssh_write(
    auth: State<'_, Arc<AuthStore>>,
    sessions: State<'_, Arc<LocalSshSessionManager>>,
    req: LocalSshWriteRequest,
) -> Result<(), String> {
    let auth = Arc::clone(auth.inner());
    let sessions = Arc::clone(sessions.inner());
    tauri::async_runtime::spawn_blocking(move || {
        perform_local_ssh_write(auth.as_ref(), sessions.as_ref(), &req).map_err(map_ssh_user)
    })
    .await
    .map_err(|_| map_ssh_user(SshSessionError::Internal))?
}

#[tauri::command]
async fn local_ssh_resize(
    auth: State<'_, Arc<AuthStore>>,
    sessions: State<'_, Arc<LocalSshSessionManager>>,
    req: LocalSshResizeRequest,
) -> Result<(), String> {
    let auth = Arc::clone(auth.inner());
    let sessions = Arc::clone(sessions.inner());
    tauri::async_runtime::spawn_blocking(move || {
        perform_local_ssh_resize(auth.as_ref(), sessions.as_ref(), &req).map_err(map_ssh_user)
    })
    .await
    .map_err(|_| map_ssh_user(SshSessionError::Internal))?
}

#[tauri::command]
async fn local_ssh_close(
    auth: State<'_, Arc<AuthStore>>,
    sessions: State<'_, Arc<LocalSshSessionManager>>,
    req: LocalSshCloseRequest,
) -> Result<(), String> {
    let auth = Arc::clone(auth.inner());
    let sessions = Arc::clone(sessions.inner());
    tauri::async_runtime::spawn_blocking(move || {
        perform_local_ssh_close(auth.as_ref(), sessions.as_ref(), &req).map_err(map_ssh_user)
    })
    .await
    .map_err(|_| map_ssh_user(SshSessionError::Internal))?
}

// ─── Cloud terminal IPC (native WSS; WebView never sees tokens) ───────────────

#[tauri::command]
async fn cloud_terminal_open(
    app: AppHandle,
    auth: State<'_, Arc<AuthStore>>,
    sessions: State<'_, Arc<CloudTerminalSessionManager>>,
    proxy: State<'_, CloudProxy<ReqwestBackend, Arc<ProductionSecurityCutoff>>>,
    req: CloudTerminalOpenRequest,
) -> Result<LocalSshOpenResponse, String> {
    // Token via fixed-origin CloudProxy (401/403 → ProductionSecurityCutoff).
    let token = proxy.fetch_ws_token().await.map_err(|e| match e {
        ProxyError::SessionInvalidated | ProxyError::Unauthenticated => {
            map_ssh_user(SshSessionError::Unauthenticated)
        }
        other => map_proxy_public(other),
    })?;
    let auth = Arc::clone(auth.inner());
    let sessions = Arc::clone(sessions.inner());
    let emitter: Arc<dyn LocalSshOutputEmitter> = Arc::new(TauriMainSshEmitter { app });
    tauri::async_runtime::spawn_blocking(move || {
        perform_cloud_terminal_open(auth, sessions, req, emitter, token).map_err(map_ssh_user)
    })
    .await
    .map_err(|_| map_ssh_user(SshSessionError::Internal))?
}

#[tauri::command]
async fn cloud_terminal_write(
    auth: State<'_, Arc<AuthStore>>,
    sessions: State<'_, Arc<CloudTerminalSessionManager>>,
    req: CloudTerminalWriteRequest,
) -> Result<(), String> {
    let auth = Arc::clone(auth.inner());
    let sessions = Arc::clone(sessions.inner());
    tauri::async_runtime::spawn_blocking(move || {
        perform_cloud_terminal_write(auth.as_ref(), sessions.as_ref(), &req).map_err(map_ssh_user)
    })
    .await
    .map_err(|_| map_ssh_user(SshSessionError::Internal))?
}

#[tauri::command]
async fn cloud_terminal_resize(
    auth: State<'_, Arc<AuthStore>>,
    sessions: State<'_, Arc<CloudTerminalSessionManager>>,
    req: CloudTerminalResizeRequest,
) -> Result<(), String> {
    let auth = Arc::clone(auth.inner());
    let sessions = Arc::clone(sessions.inner());
    tauri::async_runtime::spawn_blocking(move || {
        perform_cloud_terminal_resize(auth.as_ref(), sessions.as_ref(), &req).map_err(map_ssh_user)
    })
    .await
    .map_err(|_| map_ssh_user(SshSessionError::Internal))?
}

#[tauri::command]
async fn cloud_terminal_close(
    auth: State<'_, Arc<AuthStore>>,
    sessions: State<'_, Arc<CloudTerminalSessionManager>>,
    req: CloudTerminalCloseRequest,
) -> Result<(), String> {
    let auth = Arc::clone(auth.inner());
    let sessions = Arc::clone(sessions.inner());
    tauri::async_runtime::spawn_blocking(move || {
        perform_cloud_terminal_close(auth.as_ref(), sessions.as_ref(), &req).map_err(map_ssh_user)
    })
    .await
    .map_err(|_| map_ssh_user(SshSessionError::Internal))?
}

// ─── Auth IPC ────────────────────────────────────────────────────────────────

#[tauri::command]
fn auth_begin_logto(
    app: AppHandle,
    store: State<'_, Arc<AuthStore>>,
) -> Result<AuthBeginResponse, String> {
    let http = TokioAuthHttp::new();
    let opener = TauriBrowserOpener { app };
    let rng = SecRandomSource;
    perform_begin_logto(store.inner(), &rng, &http, &opener).map_err(map_auth)
}

/// Close local + cloud terminals, seal vault, then clear native session (exact order).
#[tauri::command]
fn auth_logout(
    app: AppHandle,
    store: State<'_, Arc<AuthStore>>,
    vault: State<'_, Arc<VaultService>>,
    ssh: State<'_, Arc<LocalSshSessionManager>>,
    cloud: State<'_, Arc<CloudTerminalSessionManager>>,
) -> Result<(), String> {
    let store_arc = Arc::clone(store.inner());
    let vault_arc = Arc::clone(vault.inner());
    let ssh_arc = Arc::clone(ssh.inner());
    let cloud_arc = Arc::clone(cloud.inner());
    let mut logout_err: Option<AuthError> = None;
    run_auth_session_teardown(
        || ssh_arc.close_all(),
        || cloud_arc.close_all(),
        || {
            let _ = vault_arc.on_logout();
        },
        || {
            if let Err(e) = perform_logout(store_arc.as_ref()) {
                logout_err = Some(e);
            }
        },
    );
    if let Some(e) = logout_err {
        return Err(map_auth(e));
    }
    emit_auth_session_status(&app, store.inner());
    Ok(())
}

#[tauri::command]
fn auth_session_status(store: State<'_, Arc<AuthStore>>) -> Result<AuthSessionStatus, String> {
    perform_session_status(store.inner()).map_err(map_auth)
}

/// Close terminals + seal vault, then reauth begin (native-only, no WebView token write).
#[tauri::command]
fn auth_on_unauthorized(
    app: AppHandle,
    store: State<'_, Arc<AuthStore>>,
    vault: State<'_, Arc<VaultService>>,
    ssh: State<'_, Arc<LocalSshSessionManager>>,
    cloud: State<'_, Arc<CloudTerminalSessionManager>>,
) -> Result<AuthBeginResponse, String> {
    let _store_arc = Arc::clone(store.inner());
    let vault_arc = Arc::clone(vault.inner());
    let ssh_arc = Arc::clone(ssh.inner());
    let cloud_arc = Arc::clone(cloud.inner());
    // Terminals + vault seal first; auth clear happens inside perform_on_unauthorized.
    run_auth_session_teardown(
        || ssh_arc.close_all(),
        || cloud_arc.close_all(),
        || {
            let _ = vault_arc.on_logout();
        },
        || {},
    );
    let http = TokioAuthHttp::new();
    let opener = TauriBrowserOpener { app: app.clone() };
    let rng = SecRandomSource;
    let resp = perform_on_unauthorized(store.inner(), &rng, &http, &opener).map_err(map_auth)?;
    emit_auth_session_status(&app, store.inner());
    Ok(resp)
}

// ─── Vault IPC (secret-free responses; no tenant/user/path from WebView) ─────

#[tauri::command]
fn vault_status(vault: State<'_, Arc<VaultService>>) -> Result<VaultStatus, String> {
    vault.status().map_err(map_vault)
}

#[tauri::command]
fn vault_init(vault: State<'_, Arc<VaultService>>) -> Result<VaultStatus, String> {
    let prompt = NativeSecurePrompt;
    let pw = prompt
        .prompt_password("Initialize vault", "Choose a vault password")
        .map_err(|e| map_vault(e.into()))?;
    vault.init_with_password(None, pw).map_err(map_vault)
}

#[tauri::command]
fn vault_unlock(
    vault: State<'_, Arc<VaultService>>,
    auth: State<'_, Arc<AuthStore>>,
) -> Result<VaultStatus, String> {
    let prompt = NativeSecurePrompt;
    let pw = prompt
        .prompt_password("Unlock vault", "Enter vault password")
        .map_err(|e| map_vault(e.into()))?;
    vault
        .unlock_with_password(auth.inner(), pw)
        .map_err(map_vault)
}

#[tauri::command]
fn vault_lock(vault: State<'_, Arc<VaultService>>) -> Result<VaultStatus, String> {
    vault.lock().map_err(map_vault)
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

// Note: public tenant-switch vault IPC is intentionally absent.
// Principal change is detected via observe_principal on vault ops + auth identity flow.

// ─── Cloud custody IPC (D5) ──────────────────────────────────────────────────

/// Upload local vault credential to cloud after native UPLOAD confirmation.
#[tauri::command]
async fn request_cloud_upload(
    app: AppHandle,
    auth: State<'_, Arc<AuthStore>>,
    vault: State<'_, Arc<VaultService>>,
    req: CloudUploadRequest,
) -> Result<CloudCustodyResponse, String> {
    let auth = Arc::clone(auth.inner());
    let vault = Arc::clone(vault.inner());
    let confirmer: Arc<dyn CloudCustodyConfirmer> = Arc::new(MainThreadCloudConfirmer {
        app,
        inner: Arc::new(NativeCloudCustodyConfirmer),
    });
    tauri::async_runtime::spawn_blocking(move || {
        let http = ReqwestCloudCustodyHttp::new();
        let mut steps = Vec::new();
        perform_cloud_upload(
            auth.as_ref(),
            vault.as_ref(),
            &http,
            confirmer.as_ref(),
            &req.credential_id,
            &mut steps,
        )
        .map_err(map_cloud)
    })
    .await
    .map_err(|_| map_cloud(CloudCustodyError::Internal))?
}

/// Delete cloud-hosted secret after native DELETE CLOUD confirmation (no local vault).
#[tauri::command]
async fn request_cloud_delete(
    app: AppHandle,
    auth: State<'_, Arc<AuthStore>>,
    req: CloudDeleteRequest,
) -> Result<CloudCustodyResponse, String> {
    let auth = Arc::clone(auth.inner());
    let confirmer: Arc<dyn CloudCustodyConfirmer> = Arc::new(MainThreadCloudConfirmer {
        app,
        inner: Arc::new(NativeCloudCustodyConfirmer),
    });
    tauri::async_runtime::spawn_blocking(move || {
        let http = ReqwestCloudCustodyHttp::new();
        let mut steps = Vec::new();
        perform_cloud_delete(
            auth.as_ref(),
            &http,
            confirmer.as_ref(),
            &req.credential_id,
            &mut steps,
        )
        .map_err(map_cloud)
    })
    .await
    .map_err(|_| map_cloud(CloudCustodyError::Internal))?
}

struct TauriSessionInvalidatedEmitter {
    app: AppHandle,
}

impl SessionInvalidatedEmitter for TauriSessionInvalidatedEmitter {
    fn emit_session_invalidated(&self) {
        let _ = self.app.emit(SESSION_INVALIDATED_EVENT, ());
    }
}

/// Sole WebView cloud IPC entry — fixed-origin allowlisted proxy.
#[tauri::command]
async fn cloud_request(
    proxy: State<'_, CloudProxy<ReqwestBackend, Arc<ProductionSecurityCutoff>>>,
    req: CloudRequest,
) -> Result<CloudResponse, String> {
    proxy.call(req).await.map_err(map_proxy_public)
}

// ─── Fixed external navigation (Task 9) ──────────────────────────────────────
// WebView may only send a validated route ID. Opener stays Rust-only; never
// accept caller URL/scheme/host/path. Checkout opens the account subscription
// page so Stripe checkout creation runs in the system browser context.

/// Compile-time fixed targets for `open_external_route`.
const EXTERNAL_URL_ACCOUNT_SUBSCRIPTION: &str = "https://app.itops.sh/account?tab=subscription";
const EXTERNAL_URL_CHECKOUT: &str = "https://app.itops.sh/account?tab=subscription";
const EXTERNAL_URL_TERMS: &str = "https://itops.sh/terms.html";
const EXTERNAL_URL_PRIVACY: &str = "https://itops.sh/privacy.html";

/// Inner body under the Tauri `req` parameter (`camelCase`).
/// Deny unknown fields so a URL/scheme/host/path cannot be smuggled beside the id.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenExternalRouteRequest {
    route_id: String,
}

/// Full invoke envelope matching Admin `buildOpenExternalRouteArgs`:
/// `{ "req": { "routeId": "<id>" } }` — same `req` convention as vault/cloud cmds.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenExternalRouteIpcArgs {
    req: OpenExternalRouteRequest,
}

/// Map a fixed route ID to a compile-time URL. Arbitrary URL-like values and
/// unknown IDs fail closed (no open).
fn resolve_external_route_url(route_id: &str) -> Result<&'static str, &'static str> {
    match route_id {
        "account_subscription" => Ok(EXTERNAL_URL_ACCOUNT_SUBSCRIPTION),
        "checkout" => Ok(EXTERNAL_URL_CHECKOUT),
        "terms" => Ok(EXTERNAL_URL_TERMS),
        "privacy" => Ok(EXTERNAL_URL_PRIVACY),
        _ => Err("invalid_external_route"),
    }
}

/// Open a fixed external route in the system browser. Used by the IPC command
/// and unit-tested with a mock opener (zero opens on reject).
fn perform_open_external_route<O: BrowserOpener>(opener: &O, route_id: &str) -> Result<(), String> {
    let url = resolve_external_route_url(route_id).map_err(|e| e.to_string())?;
    opener.open_url(url).map_err(map_auth)
}

/// WebView entry: invoke args must be `{ req: { routeId } }` only — never a free-form URL.
#[tauri::command]
fn open_external_route(app: AppHandle, req: OpenExternalRouteRequest) -> Result<(), String> {
    let opener = TauriBrowserOpener { app };
    perform_open_external_route(&opener, &req.route_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let auth_store = Arc::new(AuthStore::new());
    let ssh_sessions = Arc::new(LocalSshSessionManager::new());
    let cloud_sessions = Arc::new(CloudTerminalSessionManager::new());
    let vault_holder: Arc<std::sync::Mutex<Option<Arc<VaultService>>>> =
        Arc::new(std::sync::Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        // Stronghold is NOT registered as a Tauri plugin (no WebView surface).
        .manage(auth_store.clone())
        .manage(ssh_sessions.clone())
        .manage(cloud_sessions.clone())
        .setup({
            let vault_holder = vault_holder.clone();
            let auth_store = auth_store.clone();
            let ssh_sessions = ssh_sessions.clone();
            let cloud_sessions = cloud_sessions.clone();
            move |app| {
                // Fail closed: never fall back to a temporary vault snapshot path.
                let data_dir = app.path().app_data_dir().map_err(|e| {
                    Box::<dyn std::error::Error>::from(format!("app_data_dir unavailable: {e}"))
                })?;
                std::fs::create_dir_all(&data_dir).map_err(|e| {
                    Box::<dyn std::error::Error>::from(format!("app_data_dir create failed: {e}"))
                })?;
                let vault = Arc::new(VaultService::new(default_snapshot_path(&data_dir)));
                // Idle / sleep / exit seal: close local + cloud terminals before Stronghold lock.
                let terminal_sink = Arc::new(CompositeTerminalLifecycleSink::new(
                    ssh_sessions.clone(),
                    cloud_sessions.clone(),
                ));
                vault.set_session_lifecycle_sink(terminal_sink);
                // Proactive idle watchdog: seals even when WebView is silent.
                let idle_wd = VaultIdleWatchdog::new(vault.clone());
                idle_wd.spawn_background(DEFAULT_IDLE_POLL);
                app.manage(idle_wd);
                app.manage(vault.clone());
                *vault_holder.lock().unwrap() = Some(vault.clone());
                // Fail closed if OS sleep/wake observer registration cannot run.
                register_vault_lifecycle(vault.clone()).map_err(|e| {
                    Box::<dyn std::error::Error>::from(format!("vault lifecycle: {e}"))
                })?;

                let handle = app.handle().clone();
                let store = auth_store.clone();
                app.deep_link().on_open_url(move |event| {
                    for u in event.urls() {
                        let s = u.to_string();
                        let http = TokioAuthHttp::new();
                        match perform_handle_deep_link(store.as_ref(), &http, &s) {
                            Ok(()) => emit_auth_session_status(&handle, store.as_ref()),
                            Err(e) => {
                                // Secret-free log only — never Display of free-form bodies/tokens.
                                eprintln!(
                                    "[auth] deep link handling failed: {}",
                                    map_auth_public(e)
                                );
                            }
                        }
                    }
                });

                // Rust-owned cloud proxy: fixed origin + route allowlist + 401 cutoff.
                let cutoff = Arc::new(SecurityCutoff::new());
                let emitter: Arc<dyn SessionInvalidatedEmitter> =
                    Arc::new(TauriSessionInvalidatedEmitter {
                        app: app.handle().clone(),
                    });
                let hooks = Arc::new(ProductionSecurityCutoff::new(
                    cutoff,
                    ssh_sessions.clone(),
                    cloud_sessions.clone(),
                    vault.clone(),
                    auth_store.clone(),
                    emitter,
                ));
                let backend = ReqwestBackend::new()
                    .map_err(|e| -> Box<dyn std::error::Error> { e.public_code().into() })?;
                let proxy = CloudProxy::new(backend, auth_store.clone(), hooks);
                app.manage(proxy);

                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            auth_begin_logto,
            auth_logout,
            auth_session_status,
            auth_on_unauthorized,
            vault_status,
            vault_init,
            vault_unlock,
            vault_lock,
            vault_import,
            vault_list_meta,
            vault_delete_local,
            local_ssh_open,
            local_ssh_write,
            local_ssh_resize,
            local_ssh_close,
            cloud_terminal_open,
            cloud_terminal_write,
            cloud_terminal_resize,
            cloud_terminal_close,
            request_cloud_upload,
            request_cloud_delete,
            cloud_request,
            open_external_route,
        ])
        .build(tauri::generate_context!())
        .expect("error while building OpsMate desktop")
        .run(move |_app, event| {
            // Exit: vault.lock → composite sink closes local+cloud, then Stronghold seal.
            // Sleep/wake is handled by vault_lifecycle (NSWorkspace) → vault.lock().
            if let RunEvent::Exit | RunEvent::ExitRequested { .. } = event {
                if let Ok(g) = vault_holder.lock() {
                    if let Some(v) = g.as_ref() {
                        let _ = v.lock();
                    }
                }
            }
        });
}

#[cfg(test)]
mod external_route_tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MockOpener {
        opened: Mutex<Vec<String>>,
    }

    impl BrowserOpener for MockOpener {
        fn open_url(&self, url: &str) -> Result<(), AuthError> {
            self.opened.lock().unwrap().push(url.to_string());
            Ok(())
        }
    }

    #[test]
    fn maps_all_four_fixed_route_ids() {
        assert_eq!(
            resolve_external_route_url("account_subscription").unwrap(),
            "https://app.itops.sh/account?tab=subscription"
        );
        assert_eq!(
            resolve_external_route_url("checkout").unwrap(),
            "https://app.itops.sh/account?tab=subscription"
        );
        assert_eq!(
            resolve_external_route_url("terms").unwrap(),
            "https://itops.sh/terms.html"
        );
        assert_eq!(
            resolve_external_route_url("privacy").unwrap(),
            "https://itops.sh/privacy.html"
        );
    }

    #[test]
    fn checkout_opens_account_subscription_page_not_stripe() {
        let url = resolve_external_route_url("checkout").unwrap();
        assert!(url.starts_with("https://app.itops.sh/"));
        assert!(url.contains("tab=subscription"));
        assert!(!url.contains("stripe.com"));
        assert!(!url.contains("checkout.stripe"));
    }

    #[test]
    fn rejects_arbitrary_urls_schemes_hosts_and_paths() {
        for bad in [
            "https://checkout.stripe.com/c/pay/cs_test",
            "https://evil.example/path",
            "http://app.itops.sh/account?tab=subscription",
            "https://app.itops.sh/account?tab=subscription",
            "opsmate://auth/callback",
            "tg://resolve?domain=x",
            "/account?tab=subscription",
            "account",
            "file:///etc/passwd",
            "",
            "account_subscription/extra",
            "CHECKOUT",
        ] {
            assert!(
                resolve_external_route_url(bad).is_err(),
                "expected reject for {bad:?}"
            );
        }
    }

    #[test]
    fn perform_open_opens_only_mapped_urls() {
        let opener = MockOpener::default();
        perform_open_external_route(&opener, "terms").unwrap();
        perform_open_external_route(&opener, "privacy").unwrap();
        perform_open_external_route(&opener, "checkout").unwrap();
        perform_open_external_route(&opener, "account_subscription").unwrap();
        let opened = opener.opened.lock().unwrap().clone();
        assert_eq!(
            opened,
            vec![
                "https://itops.sh/terms.html".to_string(),
                "https://itops.sh/privacy.html".to_string(),
                "https://app.itops.sh/account?tab=subscription".to_string(),
                "https://app.itops.sh/account?tab=subscription".to_string(),
            ]
        );
    }

    #[test]
    fn perform_open_zero_opens_on_reject() {
        let opener = MockOpener::default();
        for bad in [
            "https://checkout.stripe.com/c/pay/cs_test",
            "https://evil.example/",
            "open_url",
            "plugin:opener|open_url",
            "account",
        ] {
            assert!(perform_open_external_route(&opener, bad).is_err());
        }
        assert!(
            opener.opened.lock().unwrap().is_empty(),
            "reject must not open the system browser"
        );
    }

    /// Exact end-to-end wire shape shared with Admin `buildOpenExternalRouteArgs`.
    /// Tauri binds `fn open_external_route(..., req: OpenExternalRouteRequest)`
    /// from the top-level `req` key of the invoke payload.
    #[test]
    fn ipc_envelope_matches_ts_req_route_id_contract() {
        // Canonical Admin wire (one shape only — not bare { routeId }).
        let wires = [
            (
                r#"{"req":{"routeId":"account_subscription"}}"#,
                "account_subscription",
            ),
            (r#"{"req":{"routeId":"checkout"}}"#, "checkout"),
            (r#"{"req":{"routeId":"terms"}}"#, "terms"),
            (r#"{"req":{"routeId":"privacy"}}"#, "privacy"),
        ];
        for (json, expected_id) in wires {
            let args: OpenExternalRouteIpcArgs =
                serde_json::from_str(json).unwrap_or_else(|e| panic!("parse {json}: {e}"));
            assert_eq!(args.req.route_id, expected_id);
            let url = resolve_external_route_url(&args.req.route_id).unwrap();
            assert!(url.starts_with("https://"));
            assert!(!url.contains("stripe.com"));
        }

        // Bare { routeId } is NOT the command envelope (would leave `req` unbound).
        assert!(
            serde_json::from_str::<OpenExternalRouteIpcArgs>(r#"{"routeId":"checkout"}"#).is_err(),
            "bare routeId must not deserialize as the IPC envelope"
        );

        // Inner body alone still parses as OpenExternalRouteRequest (Tauri peels `req`),
        // but smuggled URL fields are always rejected.
        let inner: OpenExternalRouteRequest =
            serde_json::from_str(r#"{"routeId":"checkout"}"#).unwrap();
        assert_eq!(inner.route_id, "checkout");
        for smuggled in [
            r#"{"req":{"routeId":"checkout","url":"https://evil.example"}}"#,
            r#"{"req":{"url":"https://checkout.stripe.com/x"}}"#,
            r#"{"req":{"routeId":"checkout","scheme":"https","host":"evil.example","path":"/x"}}"#,
            r#"{"req":{"routeId":"checkout"},"url":"https://evil.example"}"#,
            r#"{"req":{"routeId":"checkout"},"scheme":"https"}"#,
        ] {
            assert!(
                serde_json::from_str::<OpenExternalRouteIpcArgs>(smuggled).is_err(),
                "must reject smuggled fields: {smuggled}"
            );
        }
    }

    #[test]
    fn ipc_envelope_then_open_zero_opens_on_invalid_id() {
        let opener = MockOpener::default();
        let args: OpenExternalRouteIpcArgs =
            serde_json::from_str(r#"{"req":{"routeId":"https://evil.example/x"}}"#).unwrap();
        assert!(perform_open_external_route(&opener, &args.req.route_id).is_err());
        assert!(opener.opened.lock().unwrap().is_empty());
    }
}
