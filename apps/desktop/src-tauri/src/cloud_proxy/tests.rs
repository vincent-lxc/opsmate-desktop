//! Route catalog + cloud transport tests.
//! Fixture corpus for routes mirrors admin generated-api-routes tests.

use super::error::ProxyError;
use super::http::{
    accumulate_chunks_limited, check_content_length, validate_fixed_origin_url, BuiltRequest,
    MockHttpBackend, BASE_ORIGIN, MAX_RESPONSE_BYTES,
};
use super::routes::match_request;
use super::{map_proxy_public, CloudProxy, CloudRequest, CloudResponse};
use crate::auth::AuthStore;
use crate::security_cutoff::{
    run_session_invalidation_cutoff, SecurityActions, SessionInvalidatedEmitter,
};
use crate::ssh_registry::LocalSshSessionManager;
use crate::vault::VaultService;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

// ─── Route catalog (Task 2) ──────────────────────────────────────────────────

const ALLOWED: &[(&str, &str)] = &[
    ("GET", "/api/servers?page=1"),
    ("POST", "/api/servers/srv_1/terminal/ai"),
    ("GET", "/api/security/credentials"),
    ("GET", "/api/monitoring/patrol-records?limit=20"),
    ("GET", "/api/dashboard/overview"),
    ("GET", "/api/auth/me"),
    ("POST", "/api/auth/me"),
    ("DELETE", "/api/auth/me"),
    ("GET", "/api/auth/telegram-widget"),
    ("GET", "/api/subscription/ai"),
    ("POST", "/api/subscription/ai"),
    ("PATCH", "/api/servers/srv_1"),
    ("DELETE", "/api/servers/srv_1"),
    ("POST", "/api/security/credentials"),
    ("PATCH", "/api/security/credentials/cred_1"),
    ("DELETE", "/api/security/credentials/cred_1"),
    ("POST", "/api/monitoring/patrol-records"),
    ("GET", "/api/problems"),
    ("POST", "/api/problems"),
    ("GET", "/api/oncall/remediation-queue"),
    ("POST", "/api/oncall/remediation-queue"),
    ("GET", "/api/incident-reports"),
    ("POST", "/api/incident-reports"),
    ("GET", "/api/servers?page=1&q=100%25"),
    ("GET", "/api/monitoring/patrol-records?limit=20&label=a%20b"),
];

const REJECTED: &[(&str, &str, &str)] = &[
    ("POST", "/api/auth/logto/exchange", "blocked auth secret"),
    ("GET", "/api/auth/logto/config", "blocked auth secret"),
    ("POST", "/api/auth/login", "blocked auth secret"),
    ("POST", "/api/auth/refresh", "blocked auth secret"),
    ("POST", "https://evil.example/api/servers", "absolute URL"),
    ("GET", "http://evil.example/api/servers", "absolute URL"),
    ("GET", "//evil.example/api/servers", "protocol-relative URL"),
    ("GET", "/api/servers\\evil", "backslash"),
    ("GET", "\\api\\servers", "backslash"),
    ("GET", "/api/servers/%2e%2e/auth/me", "encoded dot segment"),
    (
        "GET",
        "/api/servers/%2E%2E/auth/me",
        "encoded dot segment upper",
    ),
    ("GET", "/api/servers/%2fadmin", "encoded slash"),
    ("GET", "/api/servers/%2Fadmin", "encoded slash upper"),
    ("GET", "/api/servers/%5cadmin", "encoded backslash"),
    ("GET", "/api/servers/%5Cadmin", "encoded backslash upper"),
    ("GET", "/api/servers/%2e%2e%2fauth/me", "encoded traversal"),
    ("GET", "/api/servers/%252e%252e/x", "double-encoded dot"),
    (
        "GET",
        "/api/servers/%252E%252E/x",
        "double-encoded dot upper",
    ),
    ("GET", "/api/servers/%252f", "double-encoded slash"),
    ("GET", "/api/servers/%252F", "double-encoded slash upper"),
    ("GET", "/api/servers/%255c", "double-encoded backslash"),
    (
        "GET",
        "/api/servers/%255C",
        "double-encoded backslash upper",
    ),
    ("GET", "/api/servers/%25", "encoded percent"),
    ("GET", "/api/servers/%00", "encoded NUL"),
    ("GET", "/api/servers/%01", "encoded SOH"),
    ("GET", "/api/servers/%1f", "encoded US"),
    ("GET", "/api/servers/%1F", "encoded US upper"),
    ("GET", "/api/servers/%7f", "encoded DEL"),
    ("GET", "/api/servers/%7F", "encoded DEL upper"),
    (
        "GET",
        "/api/servers/srv_%00/terminal",
        "encoded NUL mid-segment",
    ),
    ("GET", "/api/servers/../auth/me", "raw dotdot"),
    ("GET", "/api/servers/./auth", "raw dot segment"),
    ("GET", "/api/servers//terminal", "empty segment"),
    ("GET", "/api//servers", "empty segment after api"),
    ("GET", "", "empty path"),
    ("GET", "api/servers", "missing leading slash"),
    ("GET", "/servers", "not under /api/"),
    ("GET", "/api", "api root only"),
    ("GET", "/api/", "api root trailing"),
    ("GET", "/api/servers?page=1#frag", "fragment not allowed"),
    ("PUT", "/api/servers", "method not allowlisted"),
    (
        "DELETE",
        "/api/dashboard/overview",
        "method not allowlisted",
    ),
    (
        "POST",
        "/api/auth/telegram-widget",
        "method not allowlisted",
    ),
    ("PATCH", "/api/problems", "method not allowlisted"),
    ("DELETE", "/api/incident-reports", "method not allowlisted"),
    ("GET", "/api/servers_evil", "prefix boundary"),
    ("GET", "/api/monitoringX", "prefix boundary"),
];

#[test]
fn route_catalog_allows_web_ui_families() {
    for (method, path) in ALLOWED {
        assert!(
            match_request(method, path),
            "expected allow: {method} {path}"
        );
    }
}

#[test]
fn route_catalog_rejects_disallowed() {
    for (method, path, reason) in REJECTED {
        assert!(
            !match_request(method, path),
            "expected reject ({reason}): {method} {path}"
        );
    }
}

#[test]
fn route_catalog_plan_fixture_corpus() {
    assert!(match_request("GET", "/api/servers?page=1"));
    assert!(match_request("POST", "/api/servers/srv_1/terminal/ai"));
    assert!(match_request("GET", "/api/security/credentials"));
    assert!(match_request(
        "GET",
        "/api/monitoring/patrol-records?limit=20"
    ));
    assert!(!match_request("POST", "/api/auth/logto/exchange"));
    assert!(!match_request("POST", "https://evil.example/api/servers"));
    assert!(!match_request("GET", "/api/servers/%2e%2e/auth/me"));
}

#[test]
fn route_catalog_p2_double_encoded_and_controls() {
    assert!(!match_request("GET", "/api/servers/%252e%252e/x"));
    assert!(!match_request("GET", "/api/servers/%252f"));
    assert!(!match_request("GET", "/api/servers/%255c"));
    assert!(!match_request("GET", "/api/servers/%252E%252E/x"));
    assert!(!match_request("GET", "/api/servers/%252F"));
    assert!(!match_request("GET", "/api/servers/%255C"));
    assert!(!match_request("GET", "/api/servers/%00"));
    assert!(!match_request("GET", "/api/servers/%01"));
    assert!(!match_request("GET", "/api/servers/%1f"));
    assert!(!match_request("GET", "/api/servers/%7f"));
    assert!(match_request("GET", "/api/servers?page=1&q=100%25"));
}

#[test]
fn route_catalog() {
    route_catalog_allows_web_ui_families();
    route_catalog_rejects_disallowed();
    route_catalog_plan_fixture_corpus();
    route_catalog_p2_double_encoded_and_controls();
}

// ─── Transport helpers ───────────────────────────────────────────────────────

#[derive(Default)]
struct SpyEmitter {
    count: AtomicUsize,
}

impl SessionInvalidatedEmitter for SpyEmitter {
    fn emit_session_invalidated(&self) {
        self.count.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct RecordingHooks {
    events: Mutex<Vec<&'static str>>,
    emitter: SpyEmitter,
    auth: Option<Arc<AuthStore>>,
    ssh: Option<Arc<LocalSshSessionManager>>,
    vault: Option<Arc<VaultService>>,
}

impl RecordingHooks {
    fn with_bindings(
        auth: Arc<AuthStore>,
        ssh: Arc<LocalSshSessionManager>,
        vault: Arc<VaultService>,
    ) -> Self {
        Self {
            events: Mutex::new(Vec::new()),
            emitter: SpyEmitter::default(),
            auth: Some(auth),
            ssh: Some(ssh),
            vault: Some(vault),
        }
    }

    fn order(&self) -> Vec<&'static str> {
        self.events.lock().unwrap().clone()
    }
}

impl SecurityActions for RecordingHooks {
    fn close_all_ssh(&self) {
        self.events.lock().unwrap().push("close_all_ssh");
        if let Some(ssh) = &self.ssh {
            ssh.close_all();
        }
    }
    fn lock_vault(&self) {
        self.events.lock().unwrap().push("lock_vault");
        if let Some(vault) = &self.vault {
            let _ = vault.on_logout();
        }
    }
    fn clear_auth(&self) {
        self.events.lock().unwrap().push("clear_auth");
        if let Some(auth) = &self.auth {
            let _ = auth.clear_native();
        }
    }
    fn emit_session_invalidated(&self) {
        self.events.lock().unwrap().push("emit_session_invalidated");
        self.emitter.emit_session_invalidated();
    }
}

fn test_vault() -> Arc<VaultService> {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "opsmate-cloud-proxy-vault-{}-{}.hold",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    Arc::new(VaultService::new(path))
}

fn authed_store() -> Arc<AuthStore> {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("t1", "alice", "admin");
    auth
}

fn req(method: &str, path: &str) -> CloudRequest {
    CloudRequest {
        method: method.into(),
        path: path.into(),
        body: None,
        locale: None,
    }
}

// ─── Fixed origin ────────────────────────────────────────────────────────────

#[test]
fn fixed_origin_accepts_only_app_itops_sh_https() {
    assert!(validate_fixed_origin_url(&format!("{BASE_ORIGIN}/api/servers")).is_ok());
    assert!(validate_fixed_origin_url(&format!("{BASE_ORIGIN}/api/servers?page=1")).is_ok());
    assert_eq!(
        validate_fixed_origin_url("https://evil.example/api/servers"),
        Err(ProxyError::PathSmuggling)
    );
    assert_eq!(
        validate_fixed_origin_url("http://app.itops.sh/api/servers"),
        Err(ProxyError::PathSmuggling)
    );
    assert_eq!(
        validate_fixed_origin_url("https://app.itops.sh:443/api/servers"),
        Err(ProxyError::PathSmuggling)
    );
    assert_eq!(
        validate_fixed_origin_url("https://app.itops.sh/api/servers#x"),
        Err(ProxyError::PathSmuggling)
    );
}

// ─── Transport tests ─────────────────────────────────────────────────────────

#[tokio::test]
async fn unauthenticated_rejected_before_transport() {
    let auth = Arc::new(AuthStore::new());
    let backend = MockHttpBackend::new("{}");
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend.clone(), auth, hooks);
    let err = proxy.call(req("GET", "/api/servers")).await.unwrap_err();
    assert_eq!(err, ProxyError::Unauthenticated);
    assert_eq!(map_proxy_public(err), "unauthenticated");
    assert_eq!(backend.request_count(), 0);
}

#[tokio::test]
async fn route_catalog_enforced_before_transport() {
    let auth = authed_store();
    let backend = MockHttpBackend::new("{}");
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend.clone(), auth, hooks);
    let err = proxy
        .call(req("POST", "/api/auth/logto/exchange"))
        .await
        .unwrap_err();
    assert_eq!(err, ProxyError::RouteNotAllowed);
    assert_eq!(backend.request_count(), 0);
}

#[tokio::test]
async fn native_bearer_injected_not_from_webview() {
    let auth = authed_store();
    let backend = MockHttpBackend::new(r#"{"id":"1","name":"ok","token":"LEAK"}"#);
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend.clone(), auth, hooks);
    let mut r = req("GET", "/api/servers");
    // WebView cannot inject Authorization via body fields either.
    r.body = Some(json!({"authorization": "Bearer stolen", "token": "x"}));
    let out = proxy.call(r).await.unwrap();
    assert_eq!(out.status, 200);
    assert_eq!(out.body.as_ref().unwrap()["name"], "ok");
    assert!(out.body.as_ref().unwrap().get("token").is_none());
    let last = backend.last_request().unwrap();
    assert!(last
        .headers
        .iter()
        .any(|(k, v)| k == "Authorization" && v == "Bearer test-token-not-for-ipc"));
    assert!(last.url.starts_with(BASE_ORIGIN));
    assert_eq!(last.url, format!("{BASE_ORIGIN}/api/servers"));
    // Debug must not leak bearer.
    let dbg = format!("{last:?}");
    assert!(!dbg.contains("Bearer "));
    assert!(!dbg.contains("test-token-not-for-ipc"));
}

#[tokio::test]
async fn response_and_request_caps() {
    assert_eq!(
        check_content_length(Some((MAX_RESPONSE_BYTES as u64) + 1), MAX_RESPONSE_BYTES),
        Err(ProxyError::ResponseTooLarge)
    );
    assert_eq!(check_content_length(Some(100), MAX_RESPONSE_BYTES), Ok(()));
    let err = accumulate_chunks_limited(
        vec![vec![b'a'; 1024], vec![b'b'; MAX_RESPONSE_BYTES]],
        MAX_RESPONSE_BYTES,
    )
    .unwrap_err();
    assert_eq!(err, ProxyError::ResponseTooLarge);
    assert_eq!(map_proxy_public(err), "response_too_large");

    let auth = authed_store();
    let backend = MockHttpBackend::new("{}");
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend.clone(), auth, hooks);
    let huge = "x".repeat(super::http::MAX_REQUEST_BODY_BYTES + 1);
    let r = CloudRequest {
        method: "POST".into(),
        path: "/api/servers".into(),
        body: Some(json!(huge)),
        locale: None,
    };
    let err = proxy.call(r).await.unwrap_err();
    assert_eq!(err, ProxyError::RequestTooLarge);
    assert_eq!(backend.request_count(), 0);
}

#[tokio::test]
async fn cancellation_aborts_hanging_request() {
    let auth = authed_store();
    let backend = MockHttpBackend::new("{}");
    backend.set_hang(true);
    let hooks = RecordingHooks::default();
    let proxy = Arc::new(CloudProxy::new(backend.clone(), auth, hooks));
    let proxy2 = proxy.clone();
    let handle = tokio::spawn(async move { proxy2.call(req("GET", "/api/servers")).await });
    // Yield so the request starts, then cancel.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    proxy.cancel_inflight();
    let err = handle.await.unwrap().unwrap_err();
    assert_eq!(err, ProxyError::Cancelled);
    assert_eq!(map_proxy_public(err), "cancelled");
}

#[tokio::test]
async fn secret_free_errors_and_debug() {
    let auth = authed_store();
    let backend = MockHttpBackend::new("upstream-body-secret");
    backend.set_status(500);
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend.clone(), auth, hooks);
    // Non-401 errors return CloudResponse with status (sanitized/empty body) — not generic IPC loss.
    let out = proxy.call(req("GET", "/api/servers")).await.unwrap();
    assert_eq!(out.status, 500);
    let body_s = format!("{:?}", out.body);
    assert!(!body_s.contains("upstream-body-secret"));
    assert!(!body_s.contains("Bearer"));
    // BuiltRequest debug redaction
    let br = BuiltRequest {
        method: "GET".into(),
        url: format!("{BASE_ORIGIN}/api/servers"),
        headers: vec![("Authorization".into(), "Bearer super-secret".into())],
        body: Some(r#"{"password":"x"}"#.into()),
    };
    let d = format!("{br:?}");
    assert!(!d.contains("Bearer "));
    assert!(!d.contains("super-secret"));
    assert!(!d.contains("password"));
}

#[tokio::test]
async fn non_401_error_status_returns_sanitized_cloud_response() {
    let auth = authed_store();
    let backend = MockHttpBackend::new(r#"{"error":"not_found","token":"LEAK"}"#);
    backend.set_status(404);
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend, auth, hooks);
    let out = proxy
        .call(req("GET", "/api/servers/missing"))
        .await
        .unwrap();
    assert_eq!(out.status, 404);
    let body = out.body.expect("sanitized json body");
    assert_eq!(body["error"], "not_found");
    assert!(body.get("token").is_none());
}

#[tokio::test]
async fn status_500_json_returns_status_not_http_status_ipc_error() {
    let auth = authed_store();
    let backend = MockHttpBackend::new(r#"{"error":"boom","accessToken":"x"}"#);
    backend.set_status(500);
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend, auth, hooks);
    let out = proxy.call(req("GET", "/api/servers")).await.unwrap();
    assert_eq!(out.status, 500);
    let body = out.body.unwrap();
    assert_eq!(body["error"], "boom");
    assert!(body.get("accessToken").is_none());
}

#[tokio::test]
async fn epoch_revalidation_after_await_rejects_stale_session() {
    let auth = authed_store();
    let backend = MockHttpBackend::new(r#"{"ok":true}"#);
    backend.set_delay_ms(50);
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend.clone(), auth.clone(), hooks);
    let auth2 = auth.clone();
    let call = tokio::spawn(async move { proxy.call(req("GET", "/api/servers")).await });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    // Logout mid-flight advances epoch / clears session.
    let _ = auth2.clear_native();
    let err = call.await.unwrap().unwrap_err();
    assert_eq!(err, ProxyError::SessionInvalidated);
    assert_eq!(map_proxy_public(err), "session_invalidated");
}

#[tokio::test]
async fn cutoff_401_exact_order_and_no_secret_leak() {
    let auth = authed_store();
    let ssh = Arc::new(LocalSshSessionManager::new());
    let vault = test_vault();
    let backend = MockHttpBackend::new("upstream-body-401");
    backend.set_status(401);
    let hooks = Arc::new(RecordingHooks::with_bindings(auth.clone(), ssh, vault));
    struct ArcHooks(Arc<RecordingHooks>);
    impl SecurityActions for ArcHooks {
        fn close_all_ssh(&self) {
            self.0.close_all_ssh()
        }
        fn lock_vault(&self) {
            self.0.lock_vault()
        }
        fn clear_auth(&self) {
            self.0.clear_auth()
        }
        fn emit_session_invalidated(&self) {
            self.0.emit_session_invalidated()
        }
    }
    let proxy = CloudProxy::new(backend, auth.clone(), ArcHooks(hooks.clone()));
    let err = proxy.call(req("GET", "/api/auth/me")).await.unwrap_err();
    let public_error = map_proxy_public(err);
    let events = hooks.order();
    let debug_output = format!("{err:?} {public_error}");
    assert_eq!(
        events,
        vec![
            "close_all_ssh",
            "lock_vault",
            "clear_auth",
            "emit_session_invalidated",
        ]
    );
    assert_eq!(public_error, "session_invalidated");
    assert!(!debug_output.contains("Bearer"));
    assert!(!debug_output.contains("upstream-body"));
    assert!(auth.native_auth_snapshot().is_none());
    assert_eq!(hooks.emitter.count.load(Ordering::SeqCst), 1);
}

#[test]
fn cutoff_order_helper_matches_plan() {
    let hooks = RecordingHooks::default();
    run_session_invalidation_cutoff(&hooks);
    assert_eq!(
        hooks.order(),
        vec![
            "close_all_ssh",
            "lock_vault",
            "clear_auth",
            "emit_session_invalidated",
        ]
    );
}

#[tokio::test]
async fn fetch_ws_token_401_runs_session_invalidation_cutoff() {
    let auth = authed_store();
    let ssh = Arc::new(LocalSshSessionManager::new());
    let vault = test_vault();
    let backend = MockHttpBackend::new("ws-token-401-body");
    backend.set_status(401);
    let hooks = Arc::new(RecordingHooks::with_bindings(auth.clone(), ssh, vault));
    struct ArcHooks(Arc<RecordingHooks>);
    impl SecurityActions for ArcHooks {
        fn close_all_ssh(&self) {
            self.0.close_all_ssh()
        }
        fn lock_vault(&self) {
            self.0.lock_vault()
        }
        fn clear_auth(&self) {
            self.0.clear_auth()
        }
        fn emit_session_invalidated(&self) {
            self.0.emit_session_invalidated()
        }
    }
    let proxy = CloudProxy::new(backend, auth.clone(), ArcHooks(hooks.clone()));
    let err = proxy.fetch_ws_token().await.unwrap_err();
    assert_eq!(err, ProxyError::SessionInvalidated);
    assert_eq!(
        hooks.order(),
        vec![
            "close_all_ssh",
            "lock_vault",
            "clear_auth",
            "emit_session_invalidated",
        ]
    );
    assert!(auth.native_auth_snapshot().is_none());
}

#[tokio::test]
async fn fetch_ws_token_403_runs_same_cutoff() {
    let auth = authed_store();
    let ssh = Arc::new(LocalSshSessionManager::new());
    let vault = test_vault();
    let backend = MockHttpBackend::new(r#"{"error":"forbidden"}"#);
    backend.set_status(403);
    let hooks = Arc::new(RecordingHooks::with_bindings(auth.clone(), ssh, vault));
    struct ArcHooks(Arc<RecordingHooks>);
    impl SecurityActions for ArcHooks {
        fn close_all_ssh(&self) {
            self.0.close_all_ssh()
        }
        fn lock_vault(&self) {
            self.0.lock_vault()
        }
        fn clear_auth(&self) {
            self.0.clear_auth()
        }
        fn emit_session_invalidated(&self) {
            self.0.emit_session_invalidated()
        }
    }
    let proxy = CloudProxy::new(backend, auth.clone(), ArcHooks(hooks.clone()));
    let err = proxy.fetch_ws_token().await.unwrap_err();
    assert_eq!(err, ProxyError::SessionInvalidated);
    assert_eq!(
        hooks.order(),
        vec![
            "close_all_ssh",
            "lock_vault",
            "clear_auth",
            "emit_session_invalidated",
        ]
    );
    assert!(auth.native_auth_snapshot().is_none());
}

#[tokio::test]
async fn fetch_ws_token_success_returns_zeroizing_token_only() {
    let auth = authed_store();
    let backend = MockHttpBackend::new(r#"{"token":"short-lived-ws","expires_in_seconds":60}"#);
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend, auth, hooks);
    let tok = proxy.fetch_ws_token().await.unwrap();
    assert_eq!(tok.as_str(), "short-lived-ws");
}

#[tokio::test]
async fn terminal_ai_outbound_redacts_secrets_and_caps_output_before_transport() {
    use super::terminal_ai_redact::MAX_TERMINAL_AI_OUTPUT_BYTES;
    let auth = authed_store();
    let backend = MockHttpBackend::new(r#"{"reply":"ok","commands":[]}"#);
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend.clone(), auth, hooks);
    let pem_rsa =
        "-----BEGIN RSA PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END RSA PRIVATE KEY-----";
    let pem_pkcs8 = "-----BEGIN PRIVATE KEY-----\nPKCS8BODYSECRET\n-----END PRIVATE KEY-----";
    let pem_enc =
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nENCPKCS8BODY\n-----END ENCRYPTED PRIVATE KEY-----";
    // Secrets near the end so Unicode right-cap keeps the redacted region.
    let long = format!(
        "{}\n{pem_rsa}\n{pem_pkcs8}\n{pem_enc}\nBearer leaky.jwt.token\npassword=s3cret\n\"password\":\"json-secret\"\n\"token\":\"json-tok\"\n",
        "文".repeat(MAX_TERMINAL_AI_OUTPUT_BYTES)
    );
    let original = long.clone();
    let r = CloudRequest {
        method: "POST".into(),
        path: "/api/servers/srv_1/terminal/ai".into(),
        body: Some(json!({
            "messages": [{"role": "user", "content": "diag"}],
            "terminal_output": long,
            "extra_field": 42,
            "password": "extra-field-pw",
            "api_key": "ak_extra_secret",
            "meta": { "passphrase": "meta-ph", "note": "ok" }
        })),
        locale: None,
    };
    let out = proxy.call(r).await.unwrap();
    assert_eq!(out.status, 200);
    let captured = backend.last_request().unwrap();
    let body = captured.body.as_ref().expect("body sent");
    // Secrets never leave native transport body (incl. PKCS#8 forms).
    assert!(!body.contains("SECRETKEYMATERIAL"));
    assert!(!body.contains("PKCS8BODYSECRET"));
    assert!(!body.contains("ENCPKCS8BODY"));
    assert!(!body.contains("leaky.jwt.token"));
    assert!(!body.contains("s3cret"));
    assert!(!body.contains("json-secret"));
    assert!(!body.contains("json-tok"));
    assert!(!body.contains("extra-field-pw"));
    assert!(!body.contains("ak_extra_secret"));
    assert!(!body.contains("meta-ph"));
    assert!(body.contains("REDACTED") || body.contains("[REDACTED_SECRET]"));
    let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(parsed["extra_field"], 42);
    assert_eq!(parsed["password"], "[REDACTED_SECRET]");
    assert_eq!(parsed["api_key"], "[REDACTED_SECRET]");
    assert_eq!(parsed["meta"]["passphrase"], "[REDACTED_SECRET]");
    assert_eq!(parsed["meta"]["note"], "ok");
    let term = parsed["terminal_output"].as_str().unwrap();
    assert!(term.len() <= MAX_TERMINAL_AI_OUTPUT_BYTES);
    assert!(std::str::from_utf8(term.as_bytes()).is_ok());
    // Original input string still holds secrets (we only copy).
    assert!(original.contains("SECRETKEYMATERIAL"));
    assert!(original.contains("PKCS8BODYSECRET"));
    // Debug must not print body secrets.
    let dbg = format!("{captured:?}");
    assert!(!dbg.contains("SECRETKEYMATERIAL"));
    assert!(!dbg.contains("s3cret"));
    assert!(!dbg.contains("extra-field-pw"));
}

#[tokio::test]
async fn terminal_ai_malformed_body_fails_closed_without_transport() {
    let auth = authed_store();
    let backend = MockHttpBackend::new("{}");
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend.clone(), auth, hooks);
    let r = CloudRequest {
        method: "POST".into(),
        path: "/api/servers/srv_1/terminal/ai".into(),
        body: Some(json!(["not", "an", "object"])),
        locale: None,
    };
    let err = proxy.call(r).await.unwrap_err();
    assert_eq!(err, ProxyError::InvalidInput);
    assert_eq!(backend.request_count(), 0);
}

#[tokio::test]
async fn fetch_ws_token_rejects_oversize_and_illegal_shape() {
    let auth = authed_store();
    let huge = format!(r#"{{"token":"{}"}}"#, "a".repeat(5000));
    let backend = MockHttpBackend::new(&huge);
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend, auth.clone(), hooks);
    assert!(proxy.fetch_ws_token().await.is_err());

    let backend = MockHttpBackend::new(r#"{"token":"has space"}"#);
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend, auth, hooks);
    assert!(proxy.fetch_ws_token().await.is_err());
}

#[test]
fn fetch_ws_token_impl_source_avoids_value_and_to_string() {
    // Runtime-adjacent source contract: mint path must not reintroduce Value/clone.
    let mod_src = include_str!("mod.rs");
    let start = mod_src
        .find("pub async fn fetch_ws_token")
        .expect("fetch_ws_token present");
    let end = mod_src[start..]
        .find("/// Shared allowlisted transport")
        .map(|i| start + i)
        .unwrap_or(mod_src.len());
    let region = &mod_src[start..end];
    assert!(
        region.contains("Zeroizing::new(response.body)"),
        "must move body into Zeroizing"
    );
    assert!(
        region.contains("ws_token::parse_ws_token_body"),
        "must use typed native parser"
    );
    assert!(
        !region.contains("serde_json::Value") && !region.contains("token.to_string"),
        "no Value / token.to_string in fetch_ws_token"
    );
}

#[tokio::test]
async fn success_returns_secret_free_cloud_response() {
    let auth = authed_store();
    let backend = MockHttpBackend::new(r#"{"servers":[{"id":"s1"}],"accessToken":"nope"}"#);
    let hooks = RecordingHooks::default();
    let proxy = CloudProxy::new(backend, auth, hooks);
    let out: CloudResponse = proxy.call(req("GET", "/api/servers")).await.unwrap();
    assert_eq!(out.status, 200);
    let body = out.body.unwrap();
    assert_eq!(body["servers"][0]["id"], "s1");
    assert!(body.get("accessToken").is_none());
}

#[test]
fn cloud_request_deny_unknown_fields() {
    let ok: Result<CloudRequest, _> =
        serde_json::from_str(r#"{"method":"GET","path":"/api/servers","body":null,"locale":"en"}"#);
    assert!(ok.is_ok());
    let bad: Result<CloudRequest, _> = serde_json::from_str(
        r#"{"method":"GET","path":"/api/servers","authorization":"Bearer x"}"#,
    );
    assert!(bad.is_err());
}
