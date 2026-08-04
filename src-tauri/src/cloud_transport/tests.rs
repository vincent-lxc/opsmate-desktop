//! Task 6A reject-before-transport + Task 6B1 async/401 lifecycle tests.
//!
//! Every reject case asserts zero outbound start/completion.
//! Cancellation and hang paths assert aborted completion.

use super::client::{
    build_request, percent_encode_component, require_available, require_ipc_invocation,
    validate_path_param_value, CloudTransport, MockHttpBackend,
};
use super::error::{map_transport_public, TransportError};
use super::http::{
    accumulate_chunks_limited, check_content_length, validate_fixed_origin_url, MAX_RESPONSE_BYTES,
};
use super::lifecycle::{NoopLifecycleHooks, SpyLifecycleHooks};
use super::operations::{spec, Availability, Invocation, Operation, BASE_ORIGIN};
use super::sanitize::sanitize_value;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;

fn empty_obj() -> Value {
    json!({})
}

fn transport(backend: MockHttpBackend) -> CloudTransport<MockHttpBackend, NoopLifecycleHooks> {
    CloudTransport::with_backend(backend)
}

fn assert_no_outbound(backend: &MockHttpBackend) {
    assert_eq!(backend.request_count(), 0, "reject must not start backend");
    assert_eq!(
        backend.completed_count(),
        0,
        "reject must not complete backend"
    );
}

// ─── Unknown / native_only / availability / invocation ───────────────────────

#[tokio::test]
async fn reject_unknown_operation_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let t = transport(backend.clone());
    let err = t
        .invoke_ipc("not.a.real.op", &empty_obj(), Some("t"))
        .await
        .unwrap_err();
    assert_eq!(err, TransportError::UnknownOperation);
    assert_eq!(map_transport_public(err), "unknown_operation");
    assert_no_outbound(&backend);
}

#[tokio::test]
async fn reject_native_only_auth_config_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let t = transport(backend.clone());
    let err = t
        .invoke_ipc("auth.config", &empty_obj(), None)
        .await
        .unwrap_err();
    assert_eq!(err, TransportError::NativeOnly);
    assert_no_outbound(&backend);
}

#[tokio::test]
async fn reject_native_only_auth_exchange_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let t = transport(backend.clone());
    let err = t
        .invoke_ipc(
            "auth.exchange",
            &json!({"code": "x", "codeVerifier": "y"}),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err, TransportError::NativeOnly);
    assert_no_outbound(&backend);
}

#[test]
fn reject_blocked_availability_gate() {
    assert_eq!(
        require_available(Availability::BlockedPendingTenantIsolation),
        Err(TransportError::NotAvailable)
    );
    assert_eq!(require_available(Availability::Available), Ok(()));
}

#[test]
fn reject_native_only_invocation_gate() {
    assert_eq!(
        require_ipc_invocation(Invocation::NativeOnly),
        Err(TransportError::NativeOnly)
    );
    assert_eq!(require_ipc_invocation(Invocation::IpcViaRust), Ok(()));
}

// ─── Forbidden transport-control fields from caller ──────────────────────────

#[tokio::test]
async fn reject_extra_method_url_origin_header_authorization_bearer() {
    let backend = MockHttpBackend::new("{}");
    let t = transport(backend.clone());
    for (key, val) in [
        ("method", json!("DELETE")),
        ("url", json!("https://evil.example/")),
        ("uri", json!("https://evil.example/")),
        ("origin", json!("https://evil.example")),
        ("host", json!("evil.example")),
        ("headers", json!({"X-Evil": "1"})),
        ("header", json!("X-Evil: 1")),
        ("Authorization", json!("Bearer stolen")),
        ("authorization", json!("Bearer stolen")),
        ("Bearer", json!("stolen")),
        ("token", json!("stolen")),
        ("access_token", json!("stolen")),
        ("Content-Type", json!("text/plain")),
        ("content_type", json!("text/plain")),
    ] {
        let err = t
            .invoke_ipc("auth.me", &json!({ key: val }), Some("native-bearer"))
            .await
            .unwrap_err();
        assert_eq!(
            err,
            TransportError::InvalidInput,
            "must reject control key {key}"
        );
        assert_no_outbound(&backend);
    }
}

// ─── Missing / extra path-query-body fields ──────────────────────────────────

#[tokio::test]
async fn reject_missing_path_param_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let t = transport(backend.clone());
    let err = t
        .invoke_ipc("servers.get", &empty_obj(), Some("t"))
        .await
        .unwrap_err();
    assert_eq!(err, TransportError::InvalidInput);
    assert_no_outbound(&backend);
}

#[tokio::test]
async fn reject_extra_path_or_query_field_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let t = transport(backend.clone());
    let err = t
        .invoke_ipc(
            "servers.get",
            &json!({"id": "srv-1", "extra": "nope"}),
            Some("t"),
        )
        .await
        .unwrap_err();
    assert_eq!(err, TransportError::InvalidInput);
    assert_no_outbound(&backend);

    let err = t
        .invoke_ipc("servers.list", &json!({"not_a_query": "x"}), Some("t"))
        .await
        .unwrap_err();
    assert_eq!(err, TransportError::InvalidInput);
    assert_no_outbound(&backend);
}

#[test]
fn reject_fixed_body_field_override_no_transport() {
    let s = spec(Operation::AuthExchange);
    let err = build_request(
        &s,
        &json!({
            "code": "abc",
            "codeVerifier": "ver",
            "redirectUri": "https://evil.example/callback"
        }),
        None,
    )
    .unwrap_err();
    assert_eq!(err, TransportError::InvalidInput);

    let err = build_request(
        &s,
        &json!({
            "code": "abc",
            "codeVerifier": "ver",
            "RedirectUri": "https://evil.example/callback"
        }),
        None,
    )
    .unwrap_err();
    assert_eq!(err, TransportError::InvalidInput);

    let built = build_request(&s, &json!({"code": "abc", "codeVerifier": "ver"}), None).unwrap();
    let body: Value = serde_json::from_str(built.body.as_deref().unwrap()).unwrap();
    assert_eq!(
        body["redirectUri"],
        "https://app.itops.sh/login/desktop/callback"
    );
    assert_eq!(body["code"], "abc");
    assert!(!built.url.contains("evil"));
    assert!(built.url.starts_with(BASE_ORIGIN));
}

// ─── Traversal / path smuggling ──────────────────────────────────────────────

#[tokio::test]
async fn reject_raw_and_encoded_path_traversal_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let t = transport(backend.clone());
    let evil_values = [
        "..",
        ".",
        "../etc/passwd",
        "foo/bar",
        "foo\\bar",
        "a?x=1",
        "a#frag",
        "x%2e%2e",
        "x%2E%2E",
        "%2e%2e",
        "%2e%2e%2f",
        "%2fetc",
        "%2Fetc",
        "%5cwindows",
        "%5Cwindows",
        "%252e%252e",
        "id%00null",
        "has\0nul",
        "has\nnewline",
    ];
    for v in evil_values {
        let err = t
            .invoke_ipc("servers.get", &json!({"id": v}), Some("t"))
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                TransportError::PathSmuggling | TransportError::InvalidInput
            ),
            "must reject path value {v:?}, got {err:?}"
        );
        assert_no_outbound(&backend);
    }
}

#[test]
fn path_param_validator_rejects_smuggling_directly() {
    for v in [
        "..", "a/b", "a\\b", "%2e%2e", "%2f", "%5c", "x?y", "x#y", ".\0",
    ] {
        assert!(
            validate_path_param_value(v).is_err(),
            "validator must reject {v:?}"
        );
    }
    assert!(validate_path_param_value("srv-123").is_ok());
    assert!(validate_path_param_value("abcDEF012").is_ok());
}

#[tokio::test]
async fn reject_query_traversal_smuggling_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let t = transport(backend.clone());
    let err = t
        .invoke_ipc("servers.list", &json!({"q": "..%2f..%2f"}), Some("t"))
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        TransportError::PathSmuggling | TransportError::InvalidInput
    ));
    assert_no_outbound(&backend);

    let err = t
        .invoke_ipc(
            "servers.list",
            &json!({"name": "ok", "not_allowed": "x"}),
            Some("t"),
        )
        .await
        .unwrap_err();
    assert_eq!(err, TransportError::InvalidInput);
    assert_no_outbound(&backend);
}

// ─── Happy path: URL under BASE_ORIGIN, method fixed, sanitizer ──────────────

#[tokio::test]
async fn success_servers_get_builds_origin_url_and_sanitizes() {
    let backend = MockHttpBackend::new(
        r#"{"id":"srv-1","name":"db","token":"LEAK","nested":{"access_token":"x","role":"admin"}}"#,
    );
    let t = transport(backend.clone());
    let out = t
        .invoke_ipc(
            "servers.get",
            &json!({"id": "srv-1"}),
            Some("native-bearer-token"),
        )
        .await
        .unwrap();
    assert_eq!(backend.request_count(), 1);
    assert_eq!(backend.completed_count(), 1);
    let req = backend.last_request().unwrap();
    assert_eq!(req.method.as_str(), "GET");
    assert_eq!(req.url, format!("{BASE_ORIGIN}/api/servers/srv-1"));
    assert!(req
        .headers
        .iter()
        .any(|(k, v)| k == "Authorization" && v == "Bearer native-bearer-token"));
    assert_eq!(out["id"], "srv-1");
    assert_eq!(out["name"], "db");
    assert!(out.get("token").is_none());
    assert_eq!(out["nested"]["role"], "admin");
    assert!(out["nested"].get("access_token").is_none());
}

#[tokio::test]
async fn success_query_deterministic_encoding_and_allowlist() {
    let backend = MockHttpBackend::new(r#"{"items":[]}"#);
    let t = transport(backend.clone());
    let _ = t
        .invoke_ipc(
            "servers.list",
            &json!({"page_size": "10", "page": "2", "name": "a b"}),
            Some("t"),
        )
        .await
        .unwrap();
    let req = backend.last_request().unwrap();
    assert!(req.url.starts_with(&format!("{BASE_ORIGIN}/api/servers?")));
    assert!(req.url.contains("name=a%20b"));
    assert!(req.url.contains("page=2"));
    assert!(req.url.contains("page_size=10"));
    assert_eq!(req.method.as_str(), "GET");
}

#[tokio::test]
async fn success_path_param_percent_encoded_after_validation() {
    let backend = MockHttpBackend::new(r#"{"id":"x"}"#);
    let t = transport(backend.clone());
    let _ = t
        .invoke_ipc("servers.get", &json!({"id": "a b"}), Some("t"))
        .await
        .unwrap();
    let req = backend.last_request().unwrap();
    assert_eq!(req.url, format!("{BASE_ORIGIN}/api/servers/a%20b"));
    assert_eq!(percent_encode_component("a b"), "a%20b");
}

#[tokio::test]
async fn unauthenticated_authenticated_op_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let t = transport(backend.clone());
    let err = t
        .invoke_ipc("auth.me", &empty_obj(), None)
        .await
        .unwrap_err();
    assert_eq!(err, TransportError::Unauthenticated);
    assert_no_outbound(&backend);
}

#[test]
fn public_errors_are_fixed_codes_without_raw_echo() {
    for err in [
        TransportError::UnknownOperation,
        TransportError::NativeOnly,
        TransportError::NotAvailable,
        TransportError::InvalidInvocation,
        TransportError::InvalidInput,
        TransportError::PathSmuggling,
        TransportError::Unauthenticated,
        TransportError::Transport,
        TransportError::InvalidResponse,
        TransportError::HttpStatus,
        TransportError::ResponseTooLarge,
        TransportError::Cancelled,
        TransportError::SessionInvalidated,
    ] {
        let code = map_transport_public(err);
        assert!(!code.is_empty());
        assert!(!code.contains("http://"));
        assert!(!code.contains("https://"));
        assert!(!code.contains("://"));
        assert_eq!(err.to_string(), code);
    }
}

#[test]
fn sanitizer_recursion_and_case_variants_preserve_safe_data() {
    let mut v = json!({
        "ok": true,
        "PASSWORD": "x",
        "ssh_private_key": "k",
        "private_key": "k2",
        "passphrase": "p",
        "client_secret": "c",
        "code_verifier": "v",
        "codeVerifier": "v2",
        "data": {
            "Refresh_Token": "r",
            "items": [{"Authorization": "Bearer z", "id": 1}]
        }
    });
    sanitize_value(&mut v);
    assert_eq!(v["ok"], true);
    assert!(v.get("PASSWORD").is_none());
    assert!(v.get("ssh_private_key").is_none());
    assert!(v.get("private_key").is_none());
    assert!(v.get("passphrase").is_none());
    assert!(v.get("client_secret").is_none());
    assert!(v.get("code_verifier").is_none());
    assert!(v.get("codeVerifier").is_none());
    assert!(v["data"].get("Refresh_Token").is_none());
    assert_eq!(v["data"]["items"][0]["id"], 1);
    assert!(v["data"]["items"][0].get("Authorization").is_none());
}

#[test]
fn no_generic_open_proxy_primitive_in_client_source() {
    let src = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/cloud_transport/client.rs"),
    )
    .unwrap();
    for banned in [
        "fn fetch_url",
        "fn open_url",
        "fn request_arbitrary",
        "fn proxy(",
        "arbitrary_url",
    ] {
        assert!(
            !src.contains(banned),
            "client must not expose open-proxy primitive {banned}"
        );
    }
    assert!(src.contains("BASE_ORIGIN"));
    assert!(src.contains("invoke_ipc"));
}

// ─── Coordinator security rework (6A) ────────────────────────────────────────

const SENTINEL_BEARER: &str = "SENTINEL_BEARER_SECRET_9f3a";
const SENTINEL_PASSWORD: &str = "SENTINEL_BODY_PASSWORD_7c2e";

#[test]
fn built_request_debug_redacts_authorization_and_body() {
    use super::client::BuiltRequest;
    use super::operations::Method;

    let req = BuiltRequest {
        method: Method::Post,
        url: format!("{BASE_ORIGIN}/api/auth/me/telegram"),
        headers: vec![
            ("Content-Type".into(), "application/json".into()),
            ("Authorization".into(), format!("Bearer {SENTINEL_BEARER}")),
        ],
        body: Some(format!(r#"{{"current_password":"{SENTINEL_PASSWORD}"}}"#)),
    };
    let dbg = format!("{req:?}");
    assert!(
        !dbg.contains(SENTINEL_BEARER),
        "Debug must not contain bearer: {dbg}"
    );
    assert!(
        !dbg.contains(SENTINEL_PASSWORD),
        "Debug must not contain body password: {dbg}"
    );
    assert!(
        !dbg.contains("Bearer "),
        "Debug must not contain Bearer prefix: {dbg}"
    );
}

#[test]
fn invoke_operation_not_public_bypass_surface() {
    let client_src = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/cloud_transport/client.rs"),
    )
    .unwrap();
    let mod_src = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/cloud_transport/mod.rs"),
    )
    .unwrap();
    assert!(!client_src.contains("pub fn invoke_operation"));
    assert!(!mod_src.contains("invoke_operation"));
    assert!(!client_src.contains("ipc_path: bool"));
    assert!(client_src.contains("invoke_ipc"));
}

#[test]
fn mock_http_backend_is_test_only_not_production_export() {
    let client_src = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/cloud_transport/client.rs"),
    )
    .unwrap();
    let mod_src = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/cloud_transport/mod.rs"),
    )
    .unwrap();
    assert!(client_src.contains("#[cfg(test)]") && client_src.contains("struct MockHttpBackend"));
    for line in mod_src.lines() {
        let t = line.trim();
        if t.starts_with("//") {
            continue;
        }
        if t.starts_with("pub use") && t.contains("MockHttpBackend") {
            panic!("production pub use must not re-export MockHttpBackend: {t}");
        }
    }
}

#[test]
fn sanitizer_strips_compound_camel_secrets_preserves_safe_fields() {
    let mut v = json!({
        "logtoAdminEndpoint": "https://evil/admin",
        "LOGTO_ADMIN_ENDPOINT": "https://evil/admin2",
        "sshKeyPassphrase": "ssh-pass",
        "privateKeyPem": "-----BEGIN PRIVATE KEY-----",
        "accessToken": "at",
        "refreshToken": "rt",
        "idToken": "idt",
        "clientSecret": "cs",
        "codeVerifier": "cv",
        "currentPassword": "cp",
        "newPassword": "np",
        "passwordHash": "ph",
        "token_usage": 42,
        "password_policy": {"min_length": 12},
        "private_key_status": "present",
        "endpoint": "https://app.itops.sh/api/servers",
        "username": "alice"
    });
    sanitize_value(&mut v);
    for secret in [
        "logtoAdminEndpoint",
        "LOGTO_ADMIN_ENDPOINT",
        "sshKeyPassphrase",
        "privateKeyPem",
        "accessToken",
        "refreshToken",
        "idToken",
        "clientSecret",
        "codeVerifier",
        "currentPassword",
        "newPassword",
        "passwordHash",
    ] {
        assert!(v.get(secret).is_none(), "must strip {secret}");
    }
    assert_eq!(v["token_usage"], 42);
    assert_eq!(v["password_policy"]["min_length"], 12);
    assert_eq!(v["private_key_status"], "present");
    assert_eq!(v["endpoint"], "https://app.itops.sh/api/servers");
    assert_eq!(v["username"], "alice");
}

#[tokio::test]
async fn reject_blank_whitespace_control_bearer_zero_outbound() {
    let backend = MockHttpBackend::new("{}");
    let t = transport(backend.clone());
    for bad in ["", "   ", "\t", "\n", " \t ", "tok\0en", "tok\nen"] {
        let err = t
            .invoke_ipc("auth.me", &empty_obj(), Some(bad))
            .await
            .unwrap_err();
        assert_eq!(
            err,
            TransportError::Unauthenticated,
            "bad bearer {bad:?} must fail closed"
        );
        assert_no_outbound(&backend);
    }
}

#[test]
fn unauthenticated_spec_never_receives_authorization_header() {
    let s = spec(Operation::AuthConfig);
    assert!(!s.authenticated);
    let built = build_request(&s, &empty_obj(), Some(SENTINEL_BEARER)).unwrap();
    assert!(
        built
            .headers
            .iter()
            .all(|(k, _)| !k.eq_ignore_ascii_case("Authorization")),
        "unauthenticated op must not attach Authorization: {:?}",
        built.headers
    );
    let dbg = format!("{built:?}");
    assert!(!dbg.contains(SENTINEL_BEARER), "Debug leak: {dbg}");
}

// ─── Task 6B1 contract (were RED against 6A-only) ────────────────────────────

fn cloud_transport_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/cloud_transport")
}

#[test]
fn six_b1_error_codes_session_http_size_cancel_present() {
    let src = std::fs::read_to_string(cloud_transport_dir().join("error.rs")).unwrap();
    for needle in [
        "SessionInvalidated",
        "session_invalidated",
        "HttpStatus",
        "http_status",
        "ResponseTooLarge",
        "response_too_large",
        "Cancelled",
        "cancelled",
    ] {
        assert!(
            src.contains(needle),
            "6B1 requires error code surface {needle}"
        );
    }
}

#[test]
fn six_b1_http_backend_is_async_owned_request() {
    let src = std::fs::read_to_string(cloud_transport_dir().join("client.rs")).unwrap();
    assert!(
        !src.contains("fn execute(&self, request: &BuiltRequest)"),
        "execute must not take &BuiltRequest"
    );
    assert!(src.contains("request: BuiltRequest"));
    assert!(src.contains("async fn invoke_ipc") || src.contains("pub async fn invoke_ipc"));
    assert!(!src.contains("std::thread::spawn"));
    assert!(!src.contains("block_on"));
    assert!(!src.contains("Runtime::new"));
}

#[test]
fn six_b1_http_and_lifecycle_modules_exist() {
    let dir = cloud_transport_dir();
    assert!(dir.join("http.rs").is_file());
    assert!(dir.join("lifecycle.rs").is_file());
    let http = std::fs::read_to_string(dir.join("http.rs")).unwrap();
    assert!(
        http.contains("Policy::none") || http.contains("redirect::Policy::none"),
        "redirects must be disabled"
    );
    assert!(http.contains("BASE_ORIGIN") || http.contains("app.itops.sh"));
    assert!(
        http.contains("ResponseTooLarge")
            || http.contains("response_too_large")
            || http.contains("MAX_RESPONSE")
    );
    let life = std::fs::read_to_string(dir.join("lifecycle.rs")).unwrap();
    assert!(life.contains("SessionLifecycle") || life.contains("mark_reauth"));
    assert!(life.contains("close_all_ssh") && life.contains("lock_vault"));
}

// ─── Task 6B1 behavioral ─────────────────────────────────────────────────────

#[tokio::test]
async fn six_b1_fake_async_backend_success_and_sanitization() {
    let backend = MockHttpBackend::new(r#"{"ok":true,"accessToken":"LEAK","n":1}"#);
    let t = transport(backend.clone());
    let out = t
        .invoke_ipc("auth.me", &empty_obj(), Some("good-token"))
        .await
        .unwrap();
    assert_eq!(out["ok"], true);
    assert_eq!(out["n"], 1);
    assert!(out.get("accessToken").is_none());
    assert_eq!(backend.completed_count(), 1);
}

#[tokio::test]
async fn six_b1_cancellation_wins_pending_backend_future() {
    let backend = MockHttpBackend::new("{}");
    backend.set_hang(true);
    let t = Arc::new(transport(backend.clone()));
    let t2 = Arc::clone(&t);
    let handle =
        tokio::spawn(async move { t2.invoke_ipc("auth.me", &empty_obj(), Some("tok")).await });
    // Allow the hang future to start.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(backend.request_count(), 1);
    assert_eq!(backend.completed_count(), 0);
    t.cancel_inflight();
    let err = handle.await.unwrap().unwrap_err();
    assert_eq!(err, TransportError::Cancelled);
    assert_eq!(map_transport_public(err), "cancelled");
    // Hang never completed outbound.
    assert_eq!(backend.completed_count(), 0);
}

#[tokio::test]
async fn six_b1_401_lifecycle_ordered_once() {
    let backend = MockHttpBackend::new("{}");
    backend.set_status(401);
    let hooks = Arc::new(SpyLifecycleHooks::new());
    // SessionLifecycleHooks for Arc
    let t = CloudTransport::new(backend.clone(), ArcSpy(hooks.clone()));
    let err = t
        .invoke_ipc("auth.me", &empty_obj(), Some("tok"))
        .await
        .unwrap_err();
    assert_eq!(err, TransportError::SessionInvalidated);
    assert_eq!(map_transport_public(err), "session_invalidated");
    assert_eq!(
        hooks.events(),
        vec![
            "mark_reauth_required_and_clear_auth",
            "close_all_ssh",
            "lock_vault",
            "emit_session_invalidated",
        ]
    );
    assert!(hooks.reauth_marked.load(Ordering::SeqCst));
    assert_eq!(backend.completed_count(), 1);
}

#[tokio::test]
async fn six_b1_concurrent_repeated_401_dedup() {
    let backend = MockHttpBackend::new("{}");
    backend.set_status(401);
    let hooks = Arc::new(SpyLifecycleHooks::new());
    let t = Arc::new(CloudTransport::new(backend.clone(), ArcSpy(hooks.clone())));
    let mut joins = Vec::new();
    for _ in 0..8 {
        let t = Arc::clone(&t);
        joins.push(tokio::spawn(async move {
            t.invoke_ipc("auth.me", &empty_obj(), Some("tok")).await
        }));
    }
    for j in joins {
        let err = j.await.unwrap().unwrap_err();
        assert_eq!(err, TransportError::SessionInvalidated);
    }
    // Exactly one lifecycle emission set.
    assert_eq!(
        hooks.events(),
        vec![
            "mark_reauth_required_and_clear_auth",
            "close_all_ssh",
            "lock_vault",
            "emit_session_invalidated",
        ]
    );
    // New session epoch allows another lifecycle.
    t.begin_session_epoch();
    let err = t
        .invoke_ipc("auth.me", &empty_obj(), Some("tok"))
        .await
        .unwrap_err();
    assert_eq!(err, TransportError::SessionInvalidated);
    assert_eq!(hooks.events().len(), 8); // 4 + 4
}

#[tokio::test]
async fn six_b1_hook_failure_still_attempts_later_hooks() {
    let backend = MockHttpBackend::new("{}");
    backend.set_status(401);
    let hooks = Arc::new(SpyLifecycleHooks::new());
    hooks.fail_ssh.store(true, Ordering::SeqCst);
    hooks.fail_vault.store(true, Ordering::SeqCst);
    let t = CloudTransport::new(backend, ArcSpy(hooks.clone()));
    let err = t
        .invoke_ipc("auth.me", &empty_obj(), Some("tok"))
        .await
        .unwrap_err();
    assert_eq!(err, TransportError::SessionInvalidated);
    assert_eq!(
        hooks.events(),
        vec![
            "mark_reauth_required_and_clear_auth",
            "close_all_ssh",
            "lock_vault",
            "emit_session_invalidated",
        ]
    );
}

#[tokio::test]
async fn six_b1_non_401_status_fixed_error_no_raw_echo() {
    let backend = MockHttpBackend::new(r#"{"detail":"SECRET_STACK_TRACE_xyz"}"#);
    backend.set_status(500);
    let t = transport(backend.clone());
    let err = t
        .invoke_ipc("auth.me", &empty_obj(), Some("tok"))
        .await
        .unwrap_err();
    assert_eq!(err, TransportError::HttpStatus);
    let code = map_transport_public(err);
    assert_eq!(code, "http_status");
    assert!(!code.contains("500"));
    assert!(!code.contains("SECRET"));
    assert!(!format!("{err:?}").contains("SECRET"));
    assert_eq!(backend.completed_count(), 1);
}

#[test]
fn six_b1_redirect_policy_and_origin_guard_source_and_unit() {
    let http = std::fs::read_to_string(cloud_transport_dir().join("http.rs")).unwrap();
    assert!(http.contains("Policy::none") || http.contains("redirect::Policy::none"));
    assert!(http.contains("validate_fixed_origin_url"));
    assert!(validate_fixed_origin_url(&format!("{BASE_ORIGIN}/api/servers")).is_ok());
    assert!(validate_fixed_origin_url(&format!("{BASE_ORIGIN}/api/servers?x=1")).is_ok());
    for bad in [
        "http://app.itops.sh/api/servers",
        "https://evil.example/api/servers",
        "https://app.itops.sh:443/api/servers",
        "https://user:pass@app.itops.sh/api/servers",
        "https://app.itops.sh/not-api",
        "https://app.itops.sh.evil/api/servers",
    ] {
        assert!(validate_fixed_origin_url(bad).is_err(), "must reject {bad}");
    }
}

#[test]
fn six_b1_content_length_and_chunked_oversize_rejection() {
    assert_eq!(
        check_content_length(Some((MAX_RESPONSE_BYTES as u64) + 1), MAX_RESPONSE_BYTES),
        Err(TransportError::ResponseTooLarge)
    );
    assert_eq!(check_content_length(Some(100), MAX_RESPONSE_BYTES), Ok(()));
    assert_eq!(check_content_length(None, MAX_RESPONSE_BYTES), Ok(()));

    // Chunked / unknown-length: accumulate past cap.
    let chunks = vec![vec![b'a'; 1024], vec![b'b'; MAX_RESPONSE_BYTES]];
    let err = accumulate_chunks_limited(chunks, MAX_RESPONSE_BYTES).unwrap_err();
    assert_eq!(err, TransportError::ResponseTooLarge);
    assert_eq!(map_transport_public(err), "response_too_large");

    let ok = accumulate_chunks_limited(vec![vec![1, 2, 3], vec![4]], 10).unwrap();
    assert_eq!(ok, vec![1, 2, 3, 4]);
}

#[test]
fn six_b1_debug_error_leak_sentinels_absent() {
    use super::client::BuiltRequest;
    use super::operations::Method;
    let req = BuiltRequest {
        method: Method::Post,
        url: format!("{BASE_ORIGIN}/api/x"),
        headers: vec![("Authorization".into(), format!("Bearer {SENTINEL_BEARER}"))],
        body: Some(format!(r#"{{"current_password":"{SENTINEL_PASSWORD}"}}"#)),
    };
    let dbg = format!("{req:?}");
    assert!(!dbg.contains(SENTINEL_BEARER));
    assert!(!dbg.contains(SENTINEL_PASSWORD));
    for err in [
        TransportError::HttpStatus,
        TransportError::SessionInvalidated,
        TransportError::ResponseTooLarge,
        TransportError::Cancelled,
    ] {
        let s = format!("{err:?}{err}{}", map_transport_public(err));
        assert!(!s.contains(SENTINEL_BEARER));
        assert!(!s.contains("500"));
        assert!(!s.contains("http://"));
    }
}

/// Arc wrapper so hooks can be shared with spies in tests.
struct ArcSpy(Arc<SpyLifecycleHooks>);

impl super::lifecycle::SessionLifecycleHooks for ArcSpy {
    fn mark_reauth_required_and_clear_auth(&self) {
        self.0.mark_reauth_required_and_clear_auth();
    }
    fn close_all_ssh(&self) -> Result<(), ()> {
        self.0.close_all_ssh()
    }
    fn lock_vault(&self) -> Result<(), ()> {
        self.0.lock_vault()
    }
    fn emit_session_invalidated(&self) {
        self.0.emit_session_invalidated();
    }
}

// ─── Coordinator review rework (focused defects; RED first) ──────────────────

use super::lifecycle::InvalidationControl;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

/// Review #1: cancel before waiter polls must still complete (durable generation).
#[tokio::test]
async fn review_cancel_before_waiter_polling_is_observed() {
    let control = InvalidationControl::new();
    let gen = control.cancel_generation();
    control.cancel_inflight();
    tokio::time::timeout(Duration::from_millis(200), control.cancelled(gen))
        .await
        .expect("cancel before wait must not hang (lost-wakeup / durable gen)");
}

/// Review #1: concurrent wait/cancel cycles stay bounded (no permanent hang).
#[tokio::test]
async fn review_concurrent_wait_cancel_cycles_bounded() {
    let control = Arc::new(InvalidationControl::new());
    for _ in 0..40 {
        let gen = control.cancel_generation();
        let c = Arc::clone(&control);
        let waiter = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_millis(500), c.cancelled(gen))
                .await
                .expect("waiter must observe cancel within timeout")
        });
        // Interleave: sometimes cancel immediately, sometimes after tiny yield.
        if gen % 2 == 0 {
            control.cancel_inflight();
        } else {
            tokio::task::yield_now().await;
            control.cancel_inflight();
        }
        waiter.await.unwrap();
    }
}

/// Review #1 source: durable watch channel, not Notify check/notified race.
#[test]
fn review_cancellation_uses_durable_watch_not_notify_race() {
    let src = std::fs::read_to_string(cloud_transport_dir().join("lifecycle.rs")).unwrap();
    assert!(
        src.contains("watch::") || src.contains("sync::watch"),
        "must use tokio watch (or durable observed generation), not Notify race"
    );
    // Disallow Notify type usage (comments may mention it as anti-pattern).
    for line in src.lines() {
        let t = line.trim();
        if t.starts_with("//") || t.starts_with("///") || t.starts_with("//!") {
            continue;
        }
        assert!(
            !t.contains("Notify") && !t.contains("notify_waiters") && !t.contains(".notified()"),
            "must not use tokio::sync::Notify for cancellation: {t}"
        );
    }
    let cargo = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
    )
    .unwrap();
    // Direct sync feature when using watch.
    assert!(
        cargo.contains("\"sync\"") || cargo.contains("sync"),
        "Cargo.toml must enable tokio sync feature for watch"
    );
}

/// Review #2: begin_session_epoch blocked while old 401 lifecycle holds hooks.
#[test]
fn review_begin_session_epoch_serialized_with_lifecycle() {
    use super::lifecycle::SessionLifecycleHooks;
    use std::sync::Condvar;

    struct BlockingHooks {
        entered: Arc<(std::sync::Mutex<bool>, Condvar)>,
        release: Arc<(std::sync::Mutex<bool>, Condvar)>,
        events: StdMutex<Vec<&'static str>>,
    }

    impl SessionLifecycleHooks for BlockingHooks {
        fn mark_reauth_required_and_clear_auth(&self) {
            {
                let (lock, cv) = &*self.entered;
                let mut g = lock.lock().unwrap();
                *g = true;
                cv.notify_all();
            }
            // Block until release.
            let (lock, cv) = &*self.release;
            let mut g = lock.lock().unwrap();
            while !*g {
                g = cv.wait(g).unwrap();
            }
            self.events
                .lock()
                .unwrap()
                .push("mark_reauth_required_and_clear_auth");
        }
        fn close_all_ssh(&self) -> Result<(), ()> {
            self.events.lock().unwrap().push("close_all_ssh");
            Ok(())
        }
        fn lock_vault(&self) -> Result<(), ()> {
            self.events.lock().unwrap().push("lock_vault");
            Ok(())
        }
        fn emit_session_invalidated(&self) {
            self.events.lock().unwrap().push("emit_session_invalidated");
        }
    }

    let control = Arc::new(InvalidationControl::new());
    let entered = Arc::new((std::sync::Mutex::new(false), Condvar::new()));
    let release = Arc::new((std::sync::Mutex::new(false), Condvar::new()));
    let hooks = BlockingHooks {
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
        events: StdMutex::new(Vec::new()),
    };

    let control_l = Arc::clone(&control);
    let life = std::thread::spawn(move || {
        assert!(control_l.run_401_lifecycle_once(&hooks));
    });

    // Wait until lifecycle is inside mark_reauth.
    {
        let (lock, cv) = &*entered;
        let mut g = lock.lock().unwrap();
        while !*g {
            g = cv.wait(g).unwrap();
        }
    }

    let control_e = Arc::clone(&control);
    let epoch_done = Arc::new(AtomicBool::new(false));
    let epoch_done2 = Arc::clone(&epoch_done);
    let epoch_thread = std::thread::spawn(move || {
        control_e.begin_session_epoch();
        epoch_done2.store(true, Ordering::SeqCst);
    });

    // Give begin_session_epoch a chance to race incorrectly.
    std::thread::sleep(Duration::from_millis(50));
    assert!(
        !epoch_done.load(Ordering::SeqCst),
        "begin_session_epoch must not complete while old 401 lifecycle holds the lock"
    );

    // Release lifecycle hooks.
    {
        let (lock, cv) = &*release;
        let mut g = lock.lock().unwrap();
        *g = true;
        cv.notify_all();
    }
    life.join().unwrap();
    epoch_thread.join().unwrap();
    assert!(epoch_done.load(Ordering::SeqCst));

    // New epoch can invalidate once.
    let hooks2 = SpyLifecycleHooks::new();
    assert!(control.run_401_lifecycle_once(&hooks2));
    assert_eq!(hooks2.events().len(), 4);
}

/// Review #3: only 2xx bodies are read/buffered (exported policy + source branch).
#[test]
fn review_status_body_read_policy_2xx_only() {
    let http = std::fs::read_to_string(cloud_transport_dir().join("http.rs")).unwrap();
    assert!(
        http.contains("fn should_read_response_body"),
        "must define should_read_response_body for status/body policy"
    );
    // Crate-internal policy (not public re-export) — still reachable from tests.
    assert!(super::http::should_read_response_body(200));
    assert!(super::http::should_read_response_body(204));
    assert!(super::http::should_read_response_body(201));
    assert!(!super::http::should_read_response_body(401));
    assert!(!super::http::should_read_response_body(301));
    assert!(!super::http::should_read_response_body(302));
    assert!(!super::http::should_read_response_body(400));
    assert!(!super::http::should_read_response_body(403));
    assert!(!super::http::should_read_response_body(404));
    assert!(!super::http::should_read_response_body(500));
    assert!(!super::http::should_read_response_body(503));
}

/// Review #3: oversize 401 body must not become response_too_large (policy).
#[test]
fn review_non_2xx_skips_body_so_oversize_401_cannot_bypass() {
    let http = std::fs::read_to_string(cloud_transport_dir().join("http.rs")).unwrap();
    assert!(
        http.contains("should_read_response_body"),
        "ReqwestBackend must use should_read_response_body"
    );
    let execute_region = http
        .split("impl HttpBackend for ReqwestBackend")
        .nth(1)
        .unwrap_or("");
    assert!(
        execute_region.contains("vec![]") || execute_region.contains("Vec::new()"),
        "execute path must return empty body for non-2xx without buffering"
    );
    let status_pos = execute_region.find("status()").expect("status()");
    let after_status = &execute_region[status_pos..];
    assert!(
        after_status.contains("should_read_response_body"),
        "must branch on should_read_response_body after status"
    );
}

/// Review #4: URL fragments rejected.
#[test]
fn review_validate_fixed_origin_rejects_fragments() {
    let bad = format!("{BASE_ORIGIN}/api/servers#frag");
    assert!(
        matches!(
            validate_fixed_origin_url(&bad),
            Err(TransportError::PathSmuggling)
        ),
        "fragment must be rejected"
    );
    let bad2 = format!("{BASE_ORIGIN}/api/servers?x=1#y");
    assert!(validate_fixed_origin_url(&bad2).is_err());
}

/// Review #5: production must not default to no-op 401 hooks.
#[test]
fn review_noop_lifecycle_is_test_only_not_production_default() {
    let client = std::fs::read_to_string(cloud_transport_dir().join("client.rs")).unwrap();
    let life = std::fs::read_to_string(cloud_transport_dir().join("lifecycle.rs")).unwrap();
    let mod_src = std::fs::read_to_string(cloud_transport_dir().join("mod.rs")).unwrap();

    // Noop struct only under cfg(test).
    assert!(
        life.contains("#[cfg(test)]") && life.contains("struct NoopLifecycleHooks"),
        "NoopLifecycleHooks must be cfg(test)"
    );
    // CloudTransport must not default H = NoopLifecycleHooks in production.
    assert!(
        !client.contains("H = NoopLifecycleHooks"),
        "CloudTransport must not default to NoopLifecycleHooks"
    );
    // with_backend convenience only under cfg(test).
    if client.contains("fn with_backend") {
        // Must appear near cfg(test).
        let idx = client.find("fn with_backend").unwrap();
        let window = &client[idx.saturating_sub(200)..idx];
        assert!(
            window.contains("cfg(test)"),
            "with_backend must be cfg(test)"
        );
    }
    // Production re-export must not expose Noop without cfg.
    for line in mod_src.lines() {
        let t = line.trim();
        if t.starts_with("pub use") && t.contains("NoopLifecycleHooks") {
            panic!("mod.rs must not production-export NoopLifecycleHooks: {t}");
        }
    }
}

// ─── Final coordinator rework (task_0fb88502fad9) — RED first ────────────────

/// Content-Length compare must not cast attacker u64 → usize before comparison.
#[test]
fn final_check_content_length_no_u64_truncation() {
    let max = MAX_RESPONSE_BYTES;
    // Exact max accepts.
    assert_eq!(check_content_length(Some(max as u64), max), Ok(()));
    // One over max rejects.
    assert_eq!(
        check_content_length(Some((max as u64) + 1), max),
        Err(TransportError::ResponseTooLarge)
    );
    // Extreme attacker length must reject without truncating into a small usize.
    assert_eq!(
        check_content_length(Some(u64::MAX), max),
        Err(TransportError::ResponseTooLarge)
    );
    // Source: never cast content-length u64 to usize for the comparison.
    let http = std::fs::read_to_string(cloud_transport_dir().join("http.rs")).unwrap();
    let fn_src = http
        .split("fn check_content_length")
        .nth(1)
        .and_then(|s| s.split("pub async fn read_body_limited").next())
        .unwrap_or("");
    assert!(
        !fn_src.contains("as usize"),
        "check_content_length must not cast Content-Length u64 to usize before compare"
    );
}

/// ReqwestBackend must not provide panicking Default.
#[test]
fn final_reqwest_backend_no_panicking_default() {
    let http = std::fs::read_to_string(cloud_transport_dir().join("http.rs")).unwrap();
    assert!(
        !http.contains("impl Default for ReqwestBackend"),
        "ReqwestBackend must not implement Default"
    );
    assert!(
        http.contains("pub fn new() -> Result<Self, TransportError>"),
        "construction remains fallible via new() -> Result"
    );
    // No expect-panic construction path on the backend.
    for line in http.lines() {
        let t = line.trim();
        if t.starts_with("//") || t.starts_with("///") {
            continue;
        }
        if t.contains("ReqwestBackend") || t.contains("Self::new()") {
            assert!(
                !t.contains(".expect("),
                "must not panic-construct ReqwestBackend: {t}"
            );
        }
    }
}

/// should_read_response_body is crate-internal policy, not a public re-export.
#[test]
fn final_should_read_response_body_not_public_reexport() {
    let mod_src = std::fs::read_to_string(cloud_transport_dir().join("mod.rs")).unwrap();
    for line in mod_src.lines() {
        let t = line.trim();
        if t.starts_with("//") {
            continue;
        }
        if t.contains("should_read_response_body") {
            panic!("mod.rs must not re-export should_read_response_body: {t}");
        }
    }
    let http = std::fs::read_to_string(cloud_transport_dir().join("http.rs")).unwrap();
    // Visible to sibling module tests via pub(super) or pub(crate), not unrestricted pub API.
    assert!(
        http.contains("pub(super) fn should_read_response_body")
            || http.contains("pub(crate) fn should_read_response_body"),
        "should_read_response_body must be pub(super)/pub(crate), not public crate API"
    );
    // Behavioral matrix still holds via crate-private path.
    assert!(super::http::should_read_response_body(200));
    assert!(!super::http::should_read_response_body(401));
}
