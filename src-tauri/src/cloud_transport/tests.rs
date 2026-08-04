//! Task 6A — reject-before-transport + sanitizer tests.
//!
//! Every reject case asserts `request_count == 0` (no outbound HTTP).

use super::client::{
    build_request, invoke_ipc, percent_encode_component, require_available, require_ipc_invocation,
    validate_path_param_value, MockHttpBackend,
};
// MockHttpBackend is cfg(test)-only in client.rs; available here because this module is cfg(test).
use super::error::{map_transport_public, TransportError};
use super::operations::{spec, Availability, Invocation, Operation, BASE_ORIGIN};
use super::sanitize::sanitize_value;
use serde_json::{json, Value};

fn empty_obj() -> Value {
    json!({})
}

fn assert_no_transport(backend: &MockHttpBackend) {
    assert_eq!(
        backend.request_count(),
        0,
        "reject path must not call backend"
    );
}

// ─── Unknown / native_only / availability / invocation ───────────────────────

#[test]
fn reject_unknown_operation_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let err = invoke_ipc(&backend, "not.a.real.op", &empty_obj(), Some("t")).unwrap_err();
    assert_eq!(err, TransportError::UnknownOperation);
    assert_eq!(map_transport_public(err), "unknown_operation");
    assert_no_transport(&backend);
}

#[test]
fn reject_native_only_auth_config_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let err = invoke_ipc(&backend, "auth.config", &empty_obj(), None).unwrap_err();
    assert_eq!(err, TransportError::NativeOnly);
    assert_no_transport(&backend);
}

#[test]
fn reject_native_only_auth_exchange_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let err = invoke_ipc(
        &backend,
        "auth.exchange",
        &json!({"code": "x", "codeVerifier": "y"}),
        None,
    )
    .unwrap_err();
    assert_eq!(err, TransportError::NativeOnly);
    assert_no_transport(&backend);
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
    assert_eq!(
        require_ipc_invocation(Invocation::IpcViaRust),
        Ok(())
    );
}

// ─── Forbidden transport-control fields from caller ──────────────────────────

#[test]
fn reject_extra_method_url_origin_header_authorization_bearer() {
    let backend = MockHttpBackend::new("{}");
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
        let err = invoke_ipc(
            &backend,
            "auth.me",
            &json!({ key: val }),
            Some("native-bearer"),
        )
        .unwrap_err();
        assert_eq!(
            err,
            TransportError::InvalidInput,
            "must reject control key {key}"
        );
        assert_no_transport(&backend);
    }
}

// ─── Missing / extra path-query-body fields ──────────────────────────────────

#[test]
fn reject_missing_path_param_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let err = invoke_ipc(&backend, "servers.get", &empty_obj(), Some("t")).unwrap_err();
    assert_eq!(err, TransportError::InvalidInput);
    assert_no_transport(&backend);
}

#[test]
fn reject_extra_path_or_query_field_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let err = invoke_ipc(
        &backend,
        "servers.get",
        &json!({"id": "srv-1", "extra": "nope"}),
        Some("t"),
    )
    .unwrap_err();
    assert_eq!(err, TransportError::InvalidInput);
    assert_no_transport(&backend);

    let err = invoke_ipc(
        &backend,
        "servers.list",
        &json!({"not_a_query": "x"}),
        Some("t"),
    )
    .unwrap_err();
    assert_eq!(err, TransportError::InvalidInput);
    assert_no_transport(&backend);
}

#[test]
fn reject_fixed_body_field_override_no_transport() {
    // auth.exchange is native_only — IPC fails closed before body merge.
    // Unit-test build_request with exchange spec so fixed redirectUri cannot be overridden.
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

    // Even case-variant of fixed key is rejected.
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

    // Valid body: fixed field injected by Rust only.
    let built = build_request(
        &s,
        &json!({"code": "abc", "codeVerifier": "ver"}),
        None,
    )
    .unwrap();
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

#[test]
fn reject_raw_and_encoded_path_traversal_no_transport() {
    let backend = MockHttpBackend::new("{}");
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
        let err = invoke_ipc(
            &backend,
            "servers.get",
            &json!({"id": v}),
            Some("t"),
        )
        .unwrap_err();
        assert!(
            matches!(
                err,
                TransportError::PathSmuggling | TransportError::InvalidInput
            ),
            "must reject path value {v:?}, got {err:?}"
        );
        assert_no_transport(&backend);
    }
}

#[test]
fn path_param_validator_rejects_smuggling_directly() {
    for v in ["..", "a/b", "a\\b", "%2e%2e", "%2f", "%5c", "x?y", "x#y", ".\0"] {
        assert!(
            validate_path_param_value(v).is_err(),
            "validator must reject {v:?}"
        );
    }
    assert!(validate_path_param_value("srv-123").is_ok());
    assert!(validate_path_param_value("abcDEF012").is_ok());
}

#[test]
fn reject_query_traversal_smuggling_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let err = invoke_ipc(
        &backend,
        "servers.list",
        &json!({"q": "..%2f..%2f"}),
        Some("t"),
    )
    .unwrap_err();
    assert!(matches!(
        err,
        TransportError::PathSmuggling | TransportError::InvalidInput
    ));
    assert_no_transport(&backend);

    let err = invoke_ipc(
        &backend,
        "servers.list",
        &json!({"name": "ok", "not_allowed": "x"}),
        Some("t"),
    )
    .unwrap_err();
    assert_eq!(err, TransportError::InvalidInput);
    assert_no_transport(&backend);
}

// ─── Happy path: URL under BASE_ORIGIN, method fixed, sanitizer ──────────────

#[test]
fn success_servers_get_builds_origin_url_and_sanitizes() {
    let backend = MockHttpBackend::new(
        r#"{"id":"srv-1","name":"db","token":"LEAK","nested":{"access_token":"x","role":"admin"}}"#,
    );
    let out = invoke_ipc(
        &backend,
        "servers.get",
        &json!({"id": "srv-1"}),
        Some("native-bearer-token"),
    )
    .unwrap();
    assert_eq!(backend.request_count(), 1);
    let req = backend.last_request().unwrap();
    assert_eq!(req.method.as_str(), "GET");
    assert_eq!(req.url, format!("{BASE_ORIGIN}/api/servers/srv-1"));
    assert!(req
        .headers
        .iter()
        .any(|(k, v)| k == "Authorization" && v == "Bearer native-bearer-token"));
    // Caller never controlled Authorization value via input.
    assert!(!req.url.contains("token"));
    assert_eq!(out["id"], "srv-1");
    assert_eq!(out["name"], "db");
    assert!(out.get("token").is_none());
    assert_eq!(out["nested"]["role"], "admin");
    assert!(out["nested"].get("access_token").is_none());
}

#[test]
fn success_query_deterministic_encoding_and_allowlist() {
    let backend = MockHttpBackend::new(r#"{"items":[]}"#);
    let _ = invoke_ipc(
        &backend,
        "servers.list",
        &json!({"page_size": "10", "page": "2", "name": "a b"}),
        Some("t"),
    )
    .unwrap();
    let req = backend.last_request().unwrap();
    assert!(req.url.starts_with(&format!("{BASE_ORIGIN}/api/servers?")));
    // Sorted keys: name, page, page_size
    assert!(req.url.contains("name=a%20b"));
    assert!(req.url.contains("page=2"));
    assert!(req.url.contains("page_size=10"));
    // Method not caller-controlled
    assert_eq!(req.method.as_str(), "GET");
}

#[test]
fn success_path_param_percent_encoded_after_validation() {
    let backend = MockHttpBackend::new(r#"{"id":"x"}"#);
    // Space is not smuggling; must be encoded in path.
    let _ = invoke_ipc(
        &backend,
        "servers.get",
        &json!({"id": "a b"}),
        Some("t"),
    )
    .unwrap();
    let req = backend.last_request().unwrap();
    assert_eq!(req.url, format!("{BASE_ORIGIN}/api/servers/a%20b"));
    assert_eq!(percent_encode_component("a b"), "a%20b");
}

#[test]
fn unauthenticated_authenticated_op_no_transport() {
    let backend = MockHttpBackend::new("{}");
    let err = invoke_ipc(&backend, "auth.me", &empty_obj(), None).unwrap_err();
    assert_eq!(err, TransportError::Unauthenticated);
    assert_no_transport(&backend);
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
    ] {
        let code = map_transport_public(err);
        assert!(!code.is_empty());
        assert!(!code.contains("http"));
        assert!(!code.contains('/'));
        assert!(!code.contains("://"));
        // Display must equal fixed code (no payload).
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
    // Must not expose arbitrary URL fetch APIs.
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

// ─── Coordinator security rework (product RED first) ─────────────────────────

const SENTINEL_BEARER: &str = "SENTINEL_BEARER_SECRET_9f3a";
const SENTINEL_PASSWORD: &str = "SENTINEL_BODY_PASSWORD_7c2e";

/// Finding 1: Debug must never leak Authorization bearer or body password material.
#[test]
fn built_request_debug_redacts_authorization_and_body() {
    use super::client::BuiltRequest;
    use super::operations::Method;

    let req = BuiltRequest {
        method: Method::Post,
        url: format!("{BASE_ORIGIN}/api/auth/me/telegram"),
        headers: vec![
            ("Content-Type".into(), "application/json".into()),
            (
                "Authorization".into(),
                format!("Bearer {SENTINEL_BEARER}"),
            ),
        ],
        body: Some(format!(
            r#"{{"current_password":"{SENTINEL_PASSWORD}"}}"#
        )),
    };
    let dbg = format!("{req:?}");
    assert!(
        !dbg.contains(SENTINEL_BEARER),
        "Debug must not contain bearer sentinel: {dbg}"
    );
    assert!(
        !dbg.contains(SENTINEL_PASSWORD),
        "Debug must not contain body password sentinel: {dbg}"
    );
    assert!(
        !dbg.contains("Bearer "),
        "Debug must not contain raw Bearer prefix: {dbg}"
    );
    // Redacted markers should be present for reviewability.
    assert!(
        dbg.contains("Authorization") || dbg.contains("headers"),
        "Debug should still mention headers structure: {dbg}"
    );
}

/// Finding 2: no public ipc_path bypass / invoke_operation surface.
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
    assert!(
        !client_src.contains("pub fn invoke_operation"),
        "invoke_operation must not be public (NativeOnly bypass risk)"
    );
    assert!(
        !mod_src.contains("invoke_operation"),
        "mod.rs must not re-export invoke_operation"
    );
    // No generic bool ipc_path parameter for callers.
    assert!(
        !client_src.contains("ipc_path: bool"),
        "must not expose caller-selected ipc_path bool"
    );
    assert!(
        client_src.contains("pub fn invoke_ipc"),
        "invoke_ipc remains the sole business entry"
    );
}

/// Finding 3: MockHttpBackend is test-only; not a production re-export.
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
    // Mock must be behind cfg(test).
    assert!(
        client_src.contains("#[cfg(test)]")
            && client_src.contains("struct MockHttpBackend"),
        "MockHttpBackend must be cfg(test)"
    );
    // Production re-export list must not include MockHttpBackend.
    // Allow mention only inside cfg(test) blocks if any; simple check: pub use line.
    for line in mod_src.lines() {
        let t = line.trim();
        if t.starts_with("//") {
            continue;
        }
        if t.contains("MockHttpBackend") {
            assert!(
                t.contains("cfg(test)") || mod_src.contains("#[cfg(test)]\npub use") /* weak */,
                "MockHttpBackend must not appear in production re-exports: {t}"
            );
            // Stronger: no uncfg'd pub use of MockHttpBackend
            if t.starts_with("pub use") && t.contains("MockHttpBackend") {
                panic!("production pub use must not re-export MockHttpBackend: {t}");
            }
        }
    }
}

/// Finding 4: compound/camel secret keys must strip; safe business fields preserved.
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
        // Safe business / status fields — must survive.
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
        assert!(
            v.get(secret).is_none(),
            "sanitizer must strip secret key {secret}"
        );
    }
    assert_eq!(v["token_usage"], 42);
    assert_eq!(v["password_policy"]["min_length"], 12);
    assert_eq!(v["private_key_status"], "present");
    assert_eq!(v["endpoint"], "https://app.itops.sh/api/servers");
    assert_eq!(v["username"], "alice");
}

/// Finding 5: blank/whitespace/control bearer fail closed with zero outbound;
/// unauthenticated ops must never get Authorization.
#[test]
fn reject_blank_whitespace_control_bearer_zero_outbound() {
    let backend = MockHttpBackend::new("{}");
    for bad in ["", "   ", "\t", "\n", " \t ", "tok\0en", "tok\nen"] {
        let err = invoke_ipc(&backend, "auth.me", &empty_obj(), Some(bad)).unwrap_err();
        assert_eq!(
            err,
            TransportError::Unauthenticated,
            "bad bearer {bad:?} must fail closed"
        );
        assert_no_transport(&backend);
    }
}

#[test]
fn unauthenticated_spec_never_receives_authorization_header() {
    // auth.config is NativeOnly — use build_request on the public GET config spec shape
    // via a non-authenticated IPC op with empty body: monitoring has authenticated ops.
    // Use Operation::AuthConfig spec directly (authenticated: false).
    let s = spec(Operation::AuthConfig);
    assert!(!s.authenticated);
    let built = build_request(&s, &empty_obj(), Some(SENTINEL_BEARER)).unwrap();
    assert!(
        built
            .headers
            .iter()
            .all(|(k, _)| !k.eq_ignore_ascii_case("Authorization")),
        "unauthenticated op must not attach Authorization even if bearer provided: {:?}",
        built.headers
    );
    // And Debug of that built request must not leak the sentinel if somehow present.
    let dbg = format!("{built:?}");
    assert!(!dbg.contains(SENTINEL_BEARER), "Debug leak: {dbg}");
}
