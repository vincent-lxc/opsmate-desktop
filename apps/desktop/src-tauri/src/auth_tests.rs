//! Unit tests for `auth` (Task D2 security repair).
//! Loaded via `#[path = "auth_tests.rs"]` from `auth.rs`.

use super::*;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

// ─── Test doubles ────────────────────────────────────────────────────────────

#[derive(Clone)]
struct DetRng {
    bytes: Vec<u8>,
    pos: Arc<StdMutex<usize>>,
}

impl DetRng {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes,
            pos: Arc::new(StdMutex::new(0)),
        }
    }
}

impl RandomSource for DetRng {
    fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), AuthError> {
        let mut pos = self.pos.lock().unwrap();
        for b in dest.iter_mut() {
            if self.bytes.is_empty() {
                return Err(AuthError::Random);
            }
            *b = self.bytes[*pos % self.bytes.len()];
            *pos += 1;
        }
        Ok(())
    }
}

#[derive(Default)]
struct MockOpener {
    opened: StdMutex<Vec<String>>,
}

impl BrowserOpener for MockOpener {
    fn open_url(&self, url: &str) -> Result<(), AuthError> {
        self.opened.lock().unwrap().push(url.to_string());
        Ok(())
    }
}

struct MockHttp {
    get: StdMutex<HashMap<String, String>>,
    posts: StdMutex<Vec<(String, Value)>>,
    post_body: StdMutex<Option<String>>,
}

impl MockHttp {
    fn with_config(json: &str) -> Self {
        let m = Self {
            get: StdMutex::new(HashMap::new()),
            posts: StdMutex::new(Vec::new()),
            post_body: StdMutex::new(None),
        };
        m.get
            .lock()
            .unwrap()
            .insert(LOGTO_CONFIG_URL.to_string(), json.to_string());
        m
    }
    fn set_post_ok(&self, body: &str) {
        *self.post_body.lock().unwrap() = Some(body.to_string());
    }
    fn set_config(&self, json: &str) {
        self.get
            .lock()
            .unwrap()
            .insert(LOGTO_CONFIG_URL.to_string(), json.to_string());
    }
}

impl AuthHttp for MockHttp {
    fn get_text(&self, url: &str) -> Result<String, AuthError> {
        self.get
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .ok_or_else(|| AuthError::Http(format!("no mock GET {url}")))
    }
    fn post_json(&self, url: &str, body: &Value) -> Result<String, AuthError> {
        self.posts
            .lock()
            .unwrap()
            .push((url.to_string(), body.clone()));
        self.post_body
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| AuthError::Http("no mock POST body".into()))
    }
}

fn sample_config_json() -> String {
    json!({
        "enabled": true,
        "endpoint": "https://logto.example.com",
        "appId": "app-desktop",
        "redirectUri": "https://app.itops.sh/login/callback",
        "desktopRedirectUri": DESKTOP_REDIRECT_URI,
        "scopes": ["openid", "profile", "email"]
    })
    .to_string()
}

fn extract_query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=')?;
        if k == key {
            return Some(percent_decode_simple(v));
        }
    }
    None
}

fn percent_decode_simple(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn seed_session(store: &AuthStore, http: &MockHttp, opener: &MockOpener, seed: u8) {
    let rng = DetRng::new(vec![seed; 64]);
    perform_begin_logto(store, &rng, http, opener).unwrap();
    let state =
        extract_query_param(opener.opened.lock().unwrap().last().unwrap(), "state").unwrap();
    http.set_post_ok(
        &json!({
            "token": "jwt-tok",
            "username": "u@example.com",
            "role": "admin",
            "must_change_password": false,
            "tenant_id": "tenant-seed",
            "subject": "sub-seed",
            "workspace_id": null
        })
        .to_string(),
    );
    perform_handle_deep_link(
        store,
        http,
        &format!(
            "opsmate://auth/callback?code=c&state={}",
            percent_encode(&state)
        ),
    )
    .unwrap();
}

// ─── PKCE / constants ────────────────────────────────────────────────────────

#[test]
fn auth_pkce_s256_known_rfc7636_appendix_b_vector() {
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert_eq!(
        pkce_s256_challenge(verifier),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn auth_pkce_verifier_shape_is_base64url_unpadded() {
    let rng = DetRng::new((0u8..64).collect());
    let v = generate_code_verifier(&rng).unwrap();
    assert!(v.len() >= 43);
    assert!(!v.contains('='));
}

#[test]
fn auth_exact_redirect_and_api_urls_constants() {
    assert_eq!(
        DESKTOP_REDIRECT_URI,
        "https://app.itops.sh/login/desktop/callback"
    );
    assert_eq!(
        LOGTO_CONFIG_URL,
        "https://app.itops.sh/api/auth/logto/config"
    );
    assert_eq!(
        LOGTO_EXCHANGE_URL,
        "https://app.itops.sh/api/auth/logto/exchange"
    );
    assert_eq!(API_BASE_URL, "https://app.itops.sh");
}

// ─── IPC response secrecy ────────────────────────────────────────────────────

#[test]
fn auth_begin_ipc_result_serializes_without_state_or_code_verifier() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![7u8; 64]);
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    let resp = perform_begin_logto(&store, &rng, &http, &opener).unwrap();
    assert_eq!(resp, AuthBeginResponse { started: true });
    let v = serde_json::to_value(&resp).unwrap();
    let obj = v.as_object().unwrap();
    assert_eq!(obj.get("started"), Some(&json!(true)));
    assert!(!obj.contains_key("state"));
    assert!(!obj.contains_key("code_verifier"));
    assert!(!obj.contains_key("codeVerifier"));
    assert!(!obj.contains_key("token"));
    let s = serde_json::to_string(&resp).unwrap();
    assert!(!s.contains("code_verifier") && !s.contains("codeVerifier"));
}

#[test]
fn auth_session_status_struct_has_no_secret_fields() {
    let st = AuthSessionStatus {
        authenticated: true,
        username: Some("u".into()),
        role: Some("admin".into()),
        must_change_password: false,
        expires_at_unix: Some(1),
        reauth_required: false,
    };
    let v = serde_json::to_value(&st).unwrap();
    let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    for forbidden in ["token", "state", "code_verifier", "codeVerifier", "jwt"] {
        assert!(
            !keys.iter().any(|k| k == forbidden),
            "unexpected key {forbidden}"
        );
    }
}

// ─── Deep link strict parsing ────────────────────────────────────────────────

#[test]
fn auth_deep_link_accepts_exact_opsmate_auth_callback() {
    let p = parse_deep_link("opsmate://auth/callback?code=abc&state=xyz").unwrap();
    assert_eq!(p.code.as_deref(), Some("abc"));
    assert_eq!(p.state.as_deref(), Some("xyz"));
    assert!(p.error.is_none());
}

#[test]
fn auth_deep_link_rejects_callbackevil_path() {
    assert!(matches!(
        parse_deep_link("opsmate://auth/callbackevil?code=a&state=b"),
        Err(AuthError::InvalidDeepLink)
    ));
}

#[test]
fn auth_deep_link_rejects_wrong_scheme_or_host() {
    assert!(parse_deep_link("https://auth/callback?code=a&state=b").is_err());
    assert!(parse_deep_link("opsmate://evil/callback?code=a&state=b").is_err());
}

#[test]
fn auth_deep_link_rejects_duplicate_and_ambiguous_params() {
    assert!(parse_deep_link("opsmate://auth/callback?code=a&code=b&state=s").is_err());
    assert!(parse_deep_link("opsmate://auth/callback?state=s&state=t&code=a").is_err());
    assert!(parse_deep_link("opsmate://auth/callback?code=a&error=e&state=s").is_err());
    assert!(parse_deep_link("opsmate://auth/callback?error=e&error=f").is_err());
}

#[test]
fn auth_deep_link_rejects_malformed_percent_and_empty_values() {
    assert!(parse_deep_link("opsmate://auth/callback?code=%zz&state=s").is_err());
    assert!(parse_deep_link("opsmate://auth/callback?code=a&state=").is_err());
    assert!(parse_deep_link("opsmate://auth/callback?code=&state=s").is_err());
}

#[test]
fn auth_deep_link_rejects_unknown_query_keys() {
    assert!(parse_deep_link("opsmate://auth/callback?code=a&state=s&token=leak").is_err());
    assert!(parse_deep_link("opsmate://auth/callback?code=a&state=s&foo=bar").is_err());
}

#[test]
fn auth_deep_link_allows_error_description_but_never_surfaces_it() {
    // error_description is allowlisted for parse, never returned in DeepLinkParams.
    let p = parse_deep_link(
        "opsmate://auth/callback?error=access_denied&error_description=attacker_payload&state=xyz",
    )
    .unwrap();
    assert_eq!(p.error.as_deref(), Some("access_denied"));
    assert_eq!(p.state.as_deref(), Some("xyz"));
    // No field for error_description on DeepLinkParams — ensure JSON/log path wouldn't leak
    let debug = format!("{:?}", p);
    assert!(!debug.contains("attacker_payload"));
}

// ─── Flows ───────────────────────────────────────────────────────────────────

#[test]
fn auth_deep_link_bad_state_does_not_call_exchange() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![1u8; 64]);
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    perform_begin_logto(&store, &rng, &http, &opener).unwrap();
    let err = perform_handle_deep_link(
        &store,
        &http,
        "opsmate://auth/callback?code=abc&state=wrong-state",
    )
    .unwrap_err();
    assert!(matches!(err, AuthError::StateMismatch));
    assert!(http.posts.lock().unwrap().is_empty());
}

#[test]
fn auth_deep_link_replay_state_rejected_without_second_exchange() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![2u8; 64]);
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    perform_begin_logto(&store, &rng, &http, &opener).unwrap();
    let state = extract_query_param(&opener.opened.lock().unwrap()[0], "state").unwrap();
    http.set_post_ok(
        &json!({
            "token": "jwt-1",
            "username": "u@example.com",
            "role": "workspace_owner",
            "must_change_password": false,
            "tenant_id": "tnt_test",
            "subject": "sub-1"
        })
        .to_string(),
    );
    perform_handle_deep_link(
        &store,
        &http,
        &format!(
            "opsmate://auth/callback?code=c1&state={}",
            percent_encode(&state)
        ),
    )
    .unwrap();
    assert_eq!(http.posts.lock().unwrap().len(), 1);
    let err = perform_handle_deep_link(
        &store,
        &http,
        &format!(
            "opsmate://auth/callback?code=c2&state={}",
            percent_encode(&state)
        ),
    )
    .unwrap_err();
    assert!(matches!(
        err,
        AuthError::StateReplay | AuthError::StateMismatch
    ));
    assert_eq!(http.posts.lock().unwrap().len(), 1);
}

#[test]
fn auth_successful_exchange_installs_native_only_secret_free_status() {
    let store = AuthStore::new();
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    seed_session(&store, &http, &opener, 3);
    let status = perform_session_status(&store).unwrap();
    assert!(status.authenticated);
    let status_json = serde_json::to_string(&status).unwrap();
    assert!(!status_json.contains("jwt-tok"));
    assert!(!status_json.contains("sub-seed"));
    assert!(!status_json.contains("tenant-seed"));
    let bearer = auth_native_bearer(&store).unwrap();
    assert_eq!(bearer.as_str(), "jwt-tok");
    let p = store.native_principal().unwrap();
    assert_eq!(p.subject, "sub-seed");
    assert_eq!(p.tenant_id, "tenant-seed");
}

#[test]
fn auth_logout_clears_native_session() {
    let store = AuthStore::new();
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    seed_session(&store, &http, &opener, 4);
    perform_logout(&store).unwrap();
    assert!(!perform_session_status(&store).unwrap().authenticated);
    assert!(auth_native_bearer(&store).is_none());
}

#[test]
fn auth_on_unauthorized_clears_starts_relogin_and_is_secret_free() {
    let store = AuthStore::new();
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    seed_session(&store, &http, &opener, 6);
    opener.opened.lock().unwrap().clear();

    let rng = DetRng::new(vec![9u8; 64]);
    let resp = perform_on_unauthorized(&store, &rng, &http, &opener).unwrap();
    assert_eq!(resp, AuthBeginResponse { started: true });
    let v = serde_json::to_value(&resp).unwrap();
    assert!(!v.to_string().contains("token"));
    assert!(!v.to_string().contains("state"));
    assert!(!v.to_string().contains("codeVerifier"));
    assert_eq!(opener.opened.lock().unwrap().len(), 1);
    assert!(opener.opened.lock().unwrap()[0].contains("/oidc/auth?"));
    assert!(auth_native_bearer(&store).is_none());
}

#[test]
fn auth_begin_clears_pending_if_config_fails() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![1u8; 64]);
    let http = MockHttp {
        get: StdMutex::new(HashMap::new()),
        posts: StdMutex::new(Vec::new()),
        post_body: StdMutex::new(None),
    };
    let opener = MockOpener::default();
    assert!(perform_begin_logto(&store, &rng, &http, &opener).is_err());
    let mem = store.inner.lock().unwrap();
    assert!(mem.pending.is_none());
}

#[test]
fn auth_begin_rejects_non_https_logto_endpoint() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![1u8; 64]);
    let http = MockHttp::with_config(
        &json!({
            "enabled": true,
            "endpoint": "http://logto.example.com",
            "appId": "app",
            "scopes": ["openid"]
        })
        .to_string(),
    );
    let opener = MockOpener::default();
    assert!(matches!(
        perform_begin_logto(&store, &rng, &http, &opener),
        Err(AuthError::InvalidConfig)
    ));
    assert!(opener.opened.lock().unwrap().is_empty());
    assert!(store.inner.lock().unwrap().pending.is_none());
}

#[test]
fn auth_oauth_error_without_matching_state_cannot_cancel_pending_login() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![1u8; 64]);
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    perform_begin_logto(&store, &rng, &http, &opener).unwrap();
    assert!(store.inner.lock().unwrap().pending.is_some());

    // Unauthenticated external error without state
    let err =
        perform_handle_deep_link(&store, &http, "opsmate://auth/callback?error=access_denied")
            .unwrap_err();
    assert!(matches!(
        err,
        AuthError::StateMismatch | AuthError::InvalidDeepLink
    ));
    assert!(
        store.inner.lock().unwrap().pending.is_some(),
        "pending must be preserved without matching state"
    );

    // Error with wrong state
    let err = perform_handle_deep_link(
        &store,
        &http,
        "opsmate://auth/callback?error=access_denied&state=not-the-pending-state",
    )
    .unwrap_err();
    assert!(matches!(err, AuthError::StateMismatch));
    assert!(store.inner.lock().unwrap().pending.is_some());
}

#[test]
fn auth_oauth_error_with_matching_state_consumes_pending_sanitized() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![1u8; 64]);
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    perform_begin_logto(&store, &rng, &http, &opener).unwrap();
    let state = extract_query_param(&opener.opened.lock().unwrap()[0], "state").unwrap();
    let err = perform_handle_deep_link(
        &store,
        &http,
        &format!(
            "opsmate://auth/callback?error=access_denied&error_description=attacker_msg&state={}",
            percent_encode(&state)
        ),
    )
    .unwrap_err();
    match err {
        AuthError::Exchange(msg) => {
            assert_eq!(msg, "access_denied");
            assert!(!msg.contains("attacker"));
        }
        other => panic!("expected Exchange, got {other:?}"),
    }
    assert!(store.inner.lock().unwrap().pending.is_none());
    // Replay of same error state rejected
    let err2 = perform_handle_deep_link(
        &store,
        &http,
        &format!(
            "opsmate://auth/callback?error=access_denied&state={}",
            percent_encode(&state)
        ),
    )
    .unwrap_err();
    assert!(matches!(
        err2,
        AuthError::StateReplay | AuthError::StateMismatch
    ));
}

#[test]
fn auth_exchange_missing_tenant_does_not_install_native_session() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![11u8; 64]);
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    perform_begin_logto(&store, &rng, &http, &opener).unwrap();
    let state = extract_query_param(&opener.opened.lock().unwrap()[0], "state").unwrap();
    http.set_post_ok(
        &json!({
            "token": "jwt-should-not-stick",
            "username": "u@example.com",
            "role": "admin",
            "must_change_password": false,
            "subject": "sub-x"
        })
        .to_string(),
    );
    let err = perform_handle_deep_link(
        &store,
        &http,
        &format!(
            "opsmate://auth/callback?code=c&state={}",
            percent_encode(&state)
        ),
    )
    .unwrap_err();
    assert!(matches!(err, AuthError::InvalidSession));
    assert!(store.inner.lock().unwrap().pending.is_none());
    assert!(auth_native_bearer(&store).is_none());
    assert!(!perform_session_status(&store).unwrap().authenticated);
}

#[test]
fn auth_cargo_toml_has_no_direct_open_dependency() {
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let raw = std::fs::read_to_string(manifest).unwrap();
    for line in raw.lines() {
        let t = line.trim();
        if t.starts_with('#') {
            continue;
        }
        assert!(
            !t.starts_with("open ") && !t.starts_with("open=") && !t.starts_with("open ="),
            "must not add direct open crate; found {t}"
        );
    }
}

#[test]
fn auth_public_command_names_in_lib_source() {
    let lib = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
    let raw = std::fs::read_to_string(lib).unwrap();
    for name in [
        "auth_begin_logto",
        "auth_logout",
        "auth_session_status",
        "auth_on_unauthorized",
    ] {
        assert!(
            raw.contains(name),
            "lib.rs must expose exact command name {name}"
        );
        assert!(
            !raw.contains(&format!("{name}_cmd")),
            "lib.rs must not use {name}_cmd public contract"
        );
    }
    // generate_handler lists exact names
    assert!(raw.contains("generate_handler!["));
    assert!(raw.contains("auth_begin_logto,") || raw.contains("auth_begin_logto\n"));
    // Public tenant-switch vault command must remain unregistered (observe_principal only).
    assert!(
        !raw.contains("fn vault_on_tenant_switch") && !raw.contains("vault_on_tenant_switch,"),
        "vault_on_tenant_switch must not be a public WebView command"
    );
}

#[test]
fn auth_native_principal_is_tenant_plus_username_never_token() {
    let store = AuthStore::new();
    assert!(store.native_principal().is_none());
    store.install_session_for_tests("ten-1", "alice", "admin");
    let p = store.native_principal().expect("principal");
    assert_eq!(p.tenant_id, "ten-1");
    assert_eq!(p.user_id, "alice");
    assert_eq!(p.subject, "sub:alice");
    // Session status must not leak token; principal accessor has no token field.
    let st = perform_session_status(&store).unwrap();
    let s = serde_json::to_string(&st).unwrap();
    assert!(!s.contains("token"));
    assert!(!s.contains("jwt"));
    assert!(!s.contains("test-token"));
    assert!(!s.contains("sub:alice"));
}

#[test]
fn auth_exchange_retains_tenant_id_for_principal() {
    let store = AuthStore::new();
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    seed_session(&store, &http, &opener, 3);
    let p = store.native_principal().expect("principal after exchange");
    assert_eq!(p.tenant_id, "tenant-seed");
    assert_eq!(p.user_id, "u@example.com");
    assert_eq!(p.subject, "sub-seed");
}

/// Real backend AuthSessionResponse is snake_case (`tenant_id`, `must_change_password`, `subject`).
#[test]
fn auth_exchange_session_response_uses_backend_snake_case() {
    let raw = r#"{
        "token":"jwt",
        "username":"owner@ex.com",
        "role":"workspace_owner",
        "tenant_id":"tnt_abc",
        "workspace_id":"ws_1",
        "subject":"logto|abc",
        "must_change_password":false
    }"#;
    let s: ExchangeSessionResponse = serde_json::from_str(raw).unwrap();
    assert_eq!(s.tenant_id.as_deref(), Some("tnt_abc"));
    assert_eq!(s.workspace_id.as_deref(), Some("ws_1"));
    assert_eq!(s.subject.as_deref(), Some("logto|abc"));
    assert!(!s.must_change_password);

    // camelCase must NOT silently bind as the real contract (would leave tenant unset).
    let camel = r#"{
        "token":"jwt",
        "username":"owner@ex.com",
        "role":"workspace_owner",
        "tenantId":"tnt_wrong",
        "mustChangePassword":true
    }"#;
    let c: ExchangeSessionResponse = serde_json::from_str(camel).unwrap();
    assert!(
        c.tenant_id.is_none(),
        "camelCase tenantId must not deserialize into tenant_id"
    );
    assert!(
        !c.must_change_password,
        "camelCase mustChangePassword must not bind; default false"
    );
}

/// Exact backend JSON shape → native principal + must_change; no WebView token write.
#[test]
fn auth_exchange_snake_case_sets_principal_and_must_change() {
    let store = AuthStore::new();
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    let rng = DetRng::new(vec![19u8; 64]);
    perform_begin_logto(&store, &rng, &http, &opener).unwrap();
    let state =
        extract_query_param(opener.opened.lock().unwrap().last().unwrap(), "state").unwrap();
    // Exact real backend field set (snake_case only).
    http.set_post_ok(
        &json!({
            "token": "jwt-snake",
            "username": "owner@logto.test",
            "role": "workspace_owner",
            "must_change_password": true,
            "tenant_id": "tnt_snake_01",
            "subject": "logto|snake"
        })
        .to_string(),
    );
    perform_handle_deep_link(
        &store,
        &http,
        &format!(
            "opsmate://auth/callback?code=c&state={}",
            percent_encode(&state)
        ),
    )
    .unwrap();

    let p = store.native_principal().expect("native principal");
    assert_eq!(p.tenant_id, "tnt_snake_01");
    assert_eq!(p.user_id, "owner@logto.test");
    assert_eq!(p.subject, "logto|snake");
    let st = perform_session_status(&store).unwrap();
    assert!(st.authenticated);
    assert!(st.must_change_password);
    assert_eq!(st.username.as_deref(), Some("owner@logto.test"));
    let wire = serde_json::to_string(&st).unwrap();
    assert!(!wire.contains("token"));
    assert!(!wire.contains("jwt-snake"));
    assert!(!wire.contains("subject"));
    assert!(!wire.contains("tenant"));
    assert!(!wire.contains("logto|snake"));
}

// ─── Task 4: JWT must stay native (source bans + secret-free status) ─────────

#[test]
fn auth_source_forbids_spa_token_sync_and_opsmate_token() {
    let src_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut corpus = String::new();
    for name in ["auth.rs", "lib.rs"] {
        corpus.push_str(&std::fs::read_to_string(src_dir.join(name)).unwrap());
        corpus.push('\n');
    }
    for forbidden in [
        "spa_write_session_script",
        "spa_clear_session_script",
        "SpaSessionSync",
        "TauriSpaBridge",
        "opsmate_token",
        "SPA_TOKEN_KEY",
        "localStorage.setItem",
        "window.eval",
    ] {
        assert!(
            !corpus.contains(forbidden),
            "production source must not contain {forbidden}"
        );
    }
}

#[test]
fn auth_source_forbids_token_bearing_production_events() {
    let lib = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
    let raw = std::fs::read_to_string(lib).unwrap();
    // Session event may exist, but must never emit raw token/bearer payloads.
    assert!(
        !raw.contains("emit(\"opsmate:auth-session\", token")
            && !raw.contains("emit(\"opsmate:auth-session\", &token")
            && !raw.contains("emit(\"opsmate:auth-session\", session.token"),
        "must not emit token-bearing auth-session events"
    );
    if raw.contains("opsmate:auth-session") {
        // When present, emit AuthSessionStatus (secret-free), not free-form maps with token keys.
        assert!(
            raw.contains("AUTH_SESSION_EVENT") || raw.contains("\"opsmate:auth-session\""),
            "auth-session event name must be the fixed public constant"
        );
        assert!(
            raw.contains("AuthSessionStatus") || raw.contains("perform_session_status"),
            "auth-session payload must come from secret-free session status"
        );
    }
}

#[test]
fn auth_deep_link_source_handles_startup_urls_and_recovers_ui_on_error() {
    let lib = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
    let raw = std::fs::read_to_string(lib).unwrap();
    assert!(
        raw.contains("deep_link().get_current()"),
        "desktop auth must consume the callback URL that launched the app"
    );
    assert!(
        raw.contains("fn handle_auth_deep_link")
            && raw.contains("emit_auth_session_status(app, store)"),
        "deep-link success and failure must notify the WebView session state"
    );
}

#[test]
fn auth_session_status_wire_is_secret_free_camel_case() {
    let st = AuthSessionStatus {
        authenticated: true,
        username: Some("u@ex.com".into()),
        role: Some("admin".into()),
        must_change_password: true,
        expires_at_unix: Some(99),
        reauth_required: false,
    };
    let v = serde_json::to_value(&st).unwrap();
    let obj = v.as_object().unwrap();
    assert!(obj.contains_key("mustChangePassword"));
    assert!(obj.contains_key("expiresAtUnix"));
    assert!(obj.contains_key("reauthRequired"));
    assert!(!obj.contains_key("token"));
    assert!(!obj.contains_key("subject"));
    assert!(!obj.contains_key("tenant_id"));
    assert!(!obj.contains_key("tenantId"));
    assert!(!obj.contains_key("workspace_id"));
    assert!(!obj.contains_key("workspaceId"));
    let s = serde_json::to_string(&st).unwrap();
    assert!(!s.contains("Bearer"));
    assert!(!s.contains("jwt"));
}

#[test]
fn auth_exchange_requires_nonempty_subject_and_tenant() {
    let store = AuthStore::new();
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    let rng = DetRng::new(vec![21u8; 64]);
    perform_begin_logto(&store, &rng, &http, &opener).unwrap();
    let state =
        extract_query_param(opener.opened.lock().unwrap().last().unwrap(), "state").unwrap();
    http.set_post_ok(
        &json!({
            "token": "jwt",
            "username": "u",
            "role": "admin",
            "must_change_password": false,
            "tenant_id": "t1",
            "subject": ""
        })
        .to_string(),
    );
    let err = perform_handle_deep_link(
        &store,
        &http,
        &format!(
            "opsmate://auth/callback?code=c&state={}",
            percent_encode(&state)
        ),
    )
    .unwrap_err();
    assert!(matches!(
        err,
        AuthError::InvalidSession | AuthError::Exchange(_)
    ));
    assert!(auth_native_bearer(&store).is_none());
}

#[test]
fn auth_exchange_and_public_errors_never_include_upstream_body_or_token() {
    // Production HTTP adapter must not embed response bodies or bearer material.
    let http_src = include_str!("auth.rs");
    assert!(
        !http_src.contains("POST {url} -> {status}: {text}"),
        "TokioAuthHttp must not format upstream body into Exchange errors"
    );
    assert!(
        http_src.contains("map_auth_public") || http_src.contains("fn map_auth_public"),
        "auth.rs must expose map_auth_public for secret-free IPC/log mapping"
    );

    // Simulated free-form / body-bearing exchange error must map to fixed public code only.
    let leaky = AuthError::Exchange(
        "POST https://app.itops.sh/api/auth/logto/exchange -> 500: {\"token\":\"jwt-secret\",\"access_token\":\"x\"}"
            .into(),
    );
    let public = map_auth_public(leaky);
    assert_eq!(public, "exchange");
    assert!(!public.contains("token"));
    assert!(!public.contains("jwt"));
    assert!(!public.contains("app.itops.sh"));
    assert!(!public.contains("500"));

    let http_err = AuthError::Http("connection failed with Authorization: Bearer abc".into());
    let pub_http = map_auth_public(http_err);
    assert_eq!(pub_http, "transport");
    assert!(!pub_http.contains("Bearer"));
    assert!(!pub_http.contains("abc"));

    let display_leak = format!("{}", AuthError::Exchange("body-with-token-jwt".into()));
    // Display may still be used only in tests; production must use map_auth_public.
    let _ = display_leak;
    assert_eq!(
        map_auth_public(AuthError::InvalidSession),
        "invalid_session"
    );
    assert_eq!(map_auth_public(AuthError::Unauthorized), "unauthorized");
}
