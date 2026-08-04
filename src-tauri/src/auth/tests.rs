//! Unit tests for Rust-only Logto auth (Task 5 + security rework).

use super::*;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

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

/// Mock HTTP that never retains codeVerifier after post_exchange returns.
struct MockHttp {
    get: StdMutex<HashMap<String, String>>,
    /// Records only non-secret post metadata.
    posts: StdMutex<
        Vec<(
            String,
            usize,  /* code len */
            usize,  /* verifier len */
            String, /* redirect */
        )>,
    >,
    post_body: StdMutex<Option<String>>,
    fail_exchange: StdMutex<bool>,
}

impl MockHttp {
    fn with_config(json: &str) -> Self {
        let m = Self {
            get: StdMutex::new(HashMap::new()),
            posts: StdMutex::new(Vec::new()),
            post_body: StdMutex::new(None),
            fail_exchange: StdMutex::new(false),
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
}

impl AuthHttp for MockHttp {
    fn get_text(&self, url: &str) -> Result<String, AuthError> {
        self.get
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .ok_or(AuthError::Http)
    }
    fn post_exchange(&self, url: &str, req: &ExchangeRequest) -> Result<String, AuthError> {
        // Record lengths + redirect only — never store verifier/code strings.
        self.posts.lock().unwrap().push((
            url.to_string(),
            req.code.len(),
            req.code_verifier.len(),
            req.redirect_uri.to_string(),
        ));
        if *self.fail_exchange.lock().unwrap() {
            return Err(AuthError::Exchange);
        }
        self.post_body
            .lock()
            .unwrap()
            .clone()
            .ok_or(AuthError::Http)
    }
}

fn sample_config_json() -> String {
    json!({
        "enabled": true,
        "endpoint": "https://auth.itops.sh",
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

fn exchange_body(
    token: &str,
    username: &str,
    role: &str,
    subject: &str,
    tenant_id: &str,
) -> String {
    json!({
        "token": token,
        "username": username,
        "role": role,
        "must_change_password": false,
        "tenant_id": tenant_id,
        "workspace_id": "ws-1",
        "subject": subject
    })
    .to_string()
}

fn seed_session(store: &AuthStore, http: &MockHttp, opener: &MockOpener, seed: u8) {
    let rng = DetRng::new(vec![seed; 64]);
    perform_begin_logto(store, &rng, http, opener).unwrap();
    let state =
        extract_query_param(&opener.opened.lock().unwrap().last().unwrap(), "state").unwrap();
    http.set_post_ok(&exchange_body(
        "jwt-tok",
        "u@example.com",
        "admin",
        "sub-seed",
        "tenant-seed",
    ));
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
    assert_eq!(LOGTO_PUBLIC_ENDPOINT, "https://auth.itops.sh");
}

// ─── Exact IdP origin ────────────────────────────────────────────────────────

#[test]
fn auth_logto_endpoint_accepts_exact_origin_and_trailing_slash() {
    assert!(validate_logto_endpoint("https://auth.itops.sh").is_ok());
    assert!(validate_logto_endpoint("https://auth.itops.sh/").is_ok());
    assert!(validate_logto_endpoint("  https://auth.itops.sh/  ").is_ok());
}

#[test]
fn auth_logto_endpoint_rejects_other_hosts_userinfo_port_query_path_fragment() {
    for bad in [
        "http://auth.itops.sh",
        "https://evil.itops.sh",
        "https://auth.itops.sh.evil.com",
        "https://user:pass@auth.itops.sh",
        "https://auth.itops.sh:8443",
        // Explicit default port must be rejected (Url::port() would hide it).
        "https://auth.itops.sh:443",
        "https://auth.itops.sh:443/",
        "https://auth.itops.sh?x=1",
        "https://auth.itops.sh#frag",
        "https://auth.itops.sh/oidc",
        "https://auth.itops.sh/oidc/auth",
        "https://logto.example.com",
    ] {
        assert!(
            matches!(validate_logto_endpoint(bad), Err(AuthError::InvalidConfig)),
            "should reject {bad}"
        );
    }
}

/// Coordinator rejection: `trim_end_matches('/')` wrongly accepted multi-slash paths.
/// Allow only exact origin and single trailing slash after surrounding whitespace trim.
#[test]
fn auth_logto_endpoint_rejects_multiple_trailing_slashes() {
    for bad in [
        "https://auth.itops.sh//",
        "https://auth.itops.sh///",
        "  https://auth.itops.sh//  ",
        "  https://auth.itops.sh///  ",
        "https://auth.itops.sh////",
    ] {
        assert!(
            matches!(validate_logto_endpoint(bad), Err(AuthError::InvalidConfig)),
            "should reject multi-slash endpoint {bad}"
        );
    }
}

#[test]
fn auth_begin_always_authorizes_on_auth_itops_sh() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![5u8; 64]);
    // Config claims exact origin (only allowed).
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    perform_begin_logto(&store, &rng, &http, &opener).unwrap();
    let url = opener.opened.lock().unwrap()[0].clone();
    assert!(url.starts_with("https://auth.itops.sh/oidc/auth?"));
    assert_eq!(
        extract_query_param(&url, "redirect_uri").as_deref(),
        Some(DESKTOP_REDIRECT_URI)
    );
}

#[test]
fn auth_begin_rejects_non_exact_logto_endpoint_in_config() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![1u8; 64]);
    let http = MockHttp::with_config(
        &json!({
            "enabled": true,
            "endpoint": "https://logto.example.com",
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

// ─── Session status serialization secrecy ────────────────────────────────────

#[test]
fn session_status_never_serializes_tokens() {
    let st = SessionStatus {
        authenticated: true,
        username: Some("u@example.com".into()),
        role: Some("admin".into()),
        reauth_required: false,
    };
    let json = serde_json::to_string(&st).unwrap();
    assert!(!json.contains("token"));
    assert!(!json.contains("verifier"));
    assert!(!json.contains("subject"));
    assert!(!json.contains("tenant"));
    assert!(!json.contains("workspace"));
    let v = serde_json::to_value(&st).unwrap();
    let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    for forbidden in [
        "token",
        "state",
        "code_verifier",
        "codeVerifier",
        "subject",
        "tenant_id",
        "tenantId",
        "workspace_id",
        "workspaceId",
    ] {
        assert!(!keys.iter().any(|k| k == forbidden));
    }
}

#[test]
fn session_status_from_store_excludes_secret_and_namespace_fields() {
    let store = AuthStore::new();
    store.install_session_for_tests("ten-1", "alice", "admin", "sub-alice");
    let st = perform_session_status(&store).unwrap();
    let json = serde_json::to_string(&st).unwrap();
    assert!(!json.contains("token"));
    assert!(!json.contains("sub-alice"));
    assert!(!json.contains("ten-1"));
    assert_eq!(st.username.as_deref(), Some("alice"));
    assert!(st.authenticated);
}

#[test]
fn session_status_not_authenticated_when_principal_invalid() {
    let store = AuthStore::new();
    {
        let mut mem = store.inner.lock().unwrap();
        mem.session = Some(super::session::NativeSession {
            token: Zeroizing::new("tok".into()),
            username: "u".into(),
            role: "r".into(),
            must_change_password: false,
            subject: "".into(), // blank subject => invalid principal
            tenant_id: "t".into(),
            workspace_id: None,
        });
    }
    let st = perform_session_status(&store).unwrap();
    assert!(!st.authenticated);
    assert!(st.username.is_none());
}

// ─── IPC error sanitization ──────────────────────────────────────────────────

#[test]
fn map_auth_public_never_embeds_secret_bearing_strings() {
    // Construct errors that historically held secret-like Display text; now unit variants.
    let secret_like =
        "https://auth.itops.sh/x?code=SECRET&state=S&token=jwt-leak subject=sub tenant=tnt";
    for e in [
        AuthError::Http,
        AuthError::Exchange,
        AuthError::BrowserOpen,
        AuthError::Internal,
    ] {
        let public = map_auth_public(e);
        assert!(!public.contains("SECRET"));
        assert!(!public.contains("jwt-leak"));
        assert!(!public.contains("https://"));
        assert!(!public.contains(secret_like));
        assert!(public.starts_with("auth_"));
        // Display itself is also a fixed code
        assert_eq!(e.to_string(), public);
    }
}

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
    assert!(!obj.contains_key("state"));
    assert!(!obj.contains_key("codeVerifier"));
    assert!(!obj.contains_key("token"));
}

// ─── Deep link exact match ───────────────────────────────────────────────────

#[test]
fn auth_deep_link_accepts_exact_opsmate_auth_callback() {
    let p = parse_deep_link("opsmate://auth/callback?code=abc&state=xyz").unwrap();
    assert_eq!(p.code.as_deref(), Some("abc"));
    assert_eq!(p.state.as_deref(), Some("xyz"));
}

#[test]
fn auth_deep_link_rejects_callbackevil_and_wrong_scheme_host() {
    assert!(matches!(
        parse_deep_link("opsmate://auth/callbackevil?code=a&state=b"),
        Err(AuthError::InvalidDeepLink)
    ));
    assert!(parse_deep_link("https://auth/callback?code=a&state=b").is_err());
    assert!(parse_deep_link("opsmate://evil/callback?code=a&state=b").is_err());
}

// ─── State mismatch / replay / cleanup ───────────────────────────────────────

#[test]
fn auth_deep_link_bad_state_preserves_pending_no_exchange() {
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
    assert!(store.inner.lock().unwrap().pending.is_some());
}

#[test]
fn auth_deep_link_replay_state_rejected_without_second_exchange() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![2u8; 64]);
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    perform_begin_logto(&store, &rng, &http, &opener).unwrap();
    let state = extract_query_param(&opener.opened.lock().unwrap()[0], "state").unwrap();
    http.set_post_ok(&exchange_body(
        "jwt-1",
        "u@example.com",
        "workspace_owner",
        "sub-1",
        "tnt_test",
    ));
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
fn auth_begin_clears_pending_on_new_login_and_on_config_failure() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![1u8; 64]);
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    perform_begin_logto(&store, &rng, &http, &opener).unwrap();
    let first_gen = store
        .inner
        .lock()
        .unwrap()
        .pending
        .as_ref()
        .unwrap()
        .generation;

    let rng2 = DetRng::new(vec![9u8; 64]);
    perform_begin_logto(&store, &rng2, &http, &opener).unwrap();
    let second_gen = store
        .inner
        .lock()
        .unwrap()
        .pending
        .as_ref()
        .unwrap()
        .generation;
    assert_ne!(first_gen, second_gen);

    let empty_http = MockHttp {
        get: StdMutex::new(HashMap::new()),
        posts: StdMutex::new(Vec::new()),
        post_body: StdMutex::new(None),
        fail_exchange: StdMutex::new(false),
    };
    let rng3 = DetRng::new(vec![3u8; 64]);
    assert!(perform_begin_logto(&store, &rng3, &empty_http, &opener).is_err());
    assert!(store.inner.lock().unwrap().pending.is_none());
}

#[test]
fn auth_successful_exchange_installs_native_only_no_spa() {
    let store = AuthStore::new();
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    seed_session(&store, &http, &opener, 3);
    let status = perform_session_status(&store).unwrap();
    assert!(status.authenticated);
    let status_json = serde_json::to_string(&status).unwrap();
    assert!(!status_json.contains("jwt-tok"));
    assert!(!status_json.contains("sub-seed"));
    let bearer = store.auth_native_bearer().unwrap();
    assert_eq!(bearer.as_str(), "jwt-tok");
    let p = store.native_principal().expect("principal");
    assert_eq!(p.tenant_id, "tenant-seed");
    assert_eq!(p.subject, "sub-seed");
    let posts = http.posts.lock().unwrap();
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].0, LOGTO_EXCHANGE_URL);
    assert_eq!(posts[0].3, DESKTOP_REDIRECT_URI);
    // Mock never retained verifier string — only length
    assert!(posts[0].2 > 0);
}

#[test]
fn auth_logout_clears_native_session_and_pending() {
    let store = AuthStore::new();
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    seed_session(&store, &http, &opener, 4);
    perform_logout(&store).unwrap();
    assert!(!perform_session_status(&store).unwrap().authenticated);
    assert!(store.auth_native_bearer().is_none());
    assert!(store.inner.lock().unwrap().pending.is_none());
}

#[test]
fn auth_oauth_error_matching_state_clears_pending_fixed_code() {
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
            "opsmate://auth/callback?error=access_denied&error_description=attacker&state={}",
            percent_encode(&state)
        ),
    )
    .unwrap_err();
    assert_eq!(err, AuthError::Exchange);
    assert_eq!(map_auth_public(err), "auth_exchange_failed");
    assert!(store.inner.lock().unwrap().pending.is_none());
}

#[test]
fn auth_exchange_error_clears_pending_no_session() {
    let store = AuthStore::new();
    let rng = DetRng::new(vec![11u8; 64]);
    let http = MockHttp::with_config(&sample_config_json());
    let opener = MockOpener::default();
    perform_begin_logto(&store, &rng, &http, &opener).unwrap();
    let state = extract_query_param(&opener.opened.lock().unwrap()[0], "state").unwrap();
    *http.fail_exchange.lock().unwrap() = true;
    let err = perform_handle_deep_link(
        &store,
        &http,
        &format!(
            "opsmate://auth/callback?code=c&state={}",
            percent_encode(&state)
        ),
    )
    .unwrap_err();
    assert_eq!(err, AuthError::Exchange);
    assert!(store.inner.lock().unwrap().pending.is_none());
    assert!(store.auth_native_bearer().is_none());
}

// ─── Wall-clock pending timeout ──────────────────────────────────────────────

#[test]
fn auth_pending_expires_by_wall_clock_helper() {
    // Direct expire_due_pending unit (not the production timer path).
    let store = AuthStore::new();
    let past = Instant::now() - Duration::from_secs(1);
    let gen = store.install_pending_for_tests("state-a", "verifier-a", past);
    assert!(store.expire_due_pending(Instant::now()));
    assert!(store.inner.lock().unwrap().pending.is_none());
    assert!(!store.clear_pending_if_generation(gen));
}

#[test]
fn auth_pending_not_expired_before_deadline() {
    let store = AuthStore::new();
    let future = Instant::now() + Duration::from_secs(600);
    store.install_pending_for_tests("state-b", "verifier-b", future);
    assert!(!store.expire_due_pending(Instant::now()));
    assert!(store.inner.lock().unwrap().pending.is_some());
}

/// Production timer path: short async sleep, no direct clear/expire helpers after arm.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auth_real_async_timer_clears_pending() {
    let store = Arc::new(AuthStore::new());
    // Far-future expires_at so only the armed timer clears pending.
    let gen = store.install_pending_for_tests(
        "state-timer",
        "verifier-timer",
        Instant::now() + Duration::from_secs(600),
    );
    AuthStore::arm_pending_timeout(store.clone(), gen, Duration::from_millis(40));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        store.inner.lock().unwrap().pending.is_none(),
        "production async timer must clear pending"
    );
}

/// Old generation timer must not clear a replacement login's pending.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auth_real_async_timer_old_generation_does_not_clear_replacement() {
    let store = Arc::new(AuthStore::new());
    let far = Instant::now() + Duration::from_secs(600);
    let old_gen = store.install_pending_for_tests("old", "v1", far);
    AuthStore::arm_pending_timeout(store.clone(), old_gen, Duration::from_millis(40));
    let new_gen = store.install_pending_for_tests("new", "v2", far);
    assert_ne!(old_gen, new_gen);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mem = store.inner.lock().unwrap();
    let pending = mem
        .pending
        .as_ref()
        .expect("replacement pending must remain");
    assert_eq!(pending.generation, new_gen);
    assert_eq!(pending.state.as_str(), "new");
}

#[test]
fn auth_handle_deep_link_rejects_expired_pending() {
    let store = AuthStore::new();
    let past = Instant::now() - Duration::from_millis(5);
    store.install_pending_for_tests("st", "ver", past);
    let http = MockHttp::with_config(&sample_config_json());
    let err = perform_handle_deep_link_at(
        &store,
        &http,
        "opsmate://auth/callback?code=c&state=st",
        Instant::now(),
    )
    .unwrap_err();
    // expire_due_pending may clear first → StateMismatch, or PendingExpired
    assert!(matches!(
        err,
        AuthError::PendingExpired | AuthError::StateMismatch
    ));
    assert!(http.posts.lock().unwrap().is_empty());
}

// ─── Principal validation ────────────────────────────────────────────────────

#[test]
fn auth_exchange_rejects_blank_subject_tenant_token_username_role() {
    for body in [
        exchange_body("", "u", "r", "sub", "ten"),
        exchange_body("tok", "", "r", "sub", "ten"),
        exchange_body("tok", "u", "", "sub", "ten"),
        exchange_body("tok", "u", "r", "", "ten"),
        exchange_body("tok", "u", "r", "sub", ""),
        // missing tenant_id key entirely
        json!({"token":"t","username":"u","role":"r","subject":"s"}).to_string(),
    ] {
        // Fresh pending for each attempt
        let store = AuthStore::new();
        let rng = DetRng::new(vec![12u8; 64]);
        let http = MockHttp::with_config(&sample_config_json());
        let opener = MockOpener::default();
        perform_begin_logto(&store, &rng, &http, &opener).unwrap();
        let state = extract_query_param(&opener.opened.lock().unwrap()[0], "state").unwrap();
        http.set_post_ok(&body);
        let err = perform_handle_deep_link(
            &store,
            &http,
            &format!(
                "opsmate://auth/callback?code=c&state={}",
                percent_encode(&state)
            ),
        )
        .unwrap_err();
        assert!(
            matches!(err, AuthError::InvalidSession | AuthError::Exchange),
            "body={body} err={err:?}"
        );
        assert!(store.auth_native_bearer().is_none());
    }
}

#[test]
fn auth_exchange_session_response_requires_tenant_id_and_subject() {
    let raw = r#"{
        "token":"jwt",
        "username":"owner@ex.com",
        "role":"workspace_owner",
        "tenant_id":"tnt_abc",
        "workspace_id":"ws_1",
        "must_change_password":false,
        "subject":"sub_logto_1"
    }"#;
    let s: ExchangeSessionResponse = serde_json::from_str(raw).unwrap();
    assert_eq!(s.tenant_id, "tnt_abc");
    assert_eq!(s.subject, "sub_logto_1");
    validate_exchange_session(&s).unwrap();

    let missing_tenant = r#"{
        "token":"jwt","username":"u","role":"r","subject":"s"
    }"#;
    assert!(serde_json::from_str::<ExchangeSessionResponse>(missing_tenant).is_err());
}

// ─── Exchange request zeroizing boundary ─────────────────────────────────────

#[test]
fn exchange_request_json_contains_fields_and_debug_redacts() {
    let req = ExchangeRequest {
        code: Zeroizing::new("authcode".into()),
        code_verifier: Zeroizing::new("verifier-secret".into()),
        redirect_uri: DESKTOP_REDIRECT_URI,
    };
    let bytes = req.to_json_bytes().unwrap();
    let s = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(s.contains("\"code\":\"authcode\""));
    assert!(s.contains("\"codeVerifier\":\"verifier-secret\""));
    assert!(s.contains(DESKTOP_REDIRECT_URI));
    let dbg = format!("{:?}", req);
    assert!(!dbg.contains("verifier-secret"));
    assert!(!dbg.contains("authcode"));
    assert!(dbg.contains("<redacted>"));
}

// ─── Source-level forbids & command allowlist ────────────────────────────────

#[test]
fn auth_source_forbids_spa_token_sync_eval_and_storage() {
    let auth_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/auth");
    let lib = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
    let mut corpus = String::new();
    for name in ["mod.rs", "pkce.rs", "session.rs", "http.rs"] {
        corpus.push_str(&std::fs::read_to_string(auth_dir.join(name)).unwrap());
        corpus.push('\n');
    }
    corpus.push_str(&std::fs::read_to_string(&lib).unwrap());

    for forbidden in [
        "SpaSessionSync",
        "spa_write_session_script",
        "spa_clear_session_script",
        "opsmate_token",
        "window.eval",
        "localStorage",
        "sessionStorage",
    ] {
        assert!(
            !corpus.contains(forbidden),
            "forbidden string present: {forbidden}"
        );
    }
    // map_auth must route through map_auth_public (fixed codes only)
    let lib_src = std::fs::read_to_string(&lib).unwrap();
    assert!(lib_src.contains("map_auth_public"));
    assert!(lib_src.contains("fn map_auth"));
    // No raw format of AuthError variants that embed free-form strings
    assert!(!lib_src.contains("format!(\"{e}\""));
    assert!(!lib_src.contains("format!(\"{}\", e)"));
}

#[test]
fn auth_public_command_allowlist_only_named_commands() {
    let lib = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
    let raw = std::fs::read_to_string(lib).unwrap();
    for name in [
        "auth_begin_logto",
        "auth_session_status",
        "auth_logout",
        "cloud_call",
    ] {
        assert!(raw.contains(name));
    }
    let start = raw.find("generate_handler![").expect("generate_handler!");
    let rest = &raw[start..];
    let end = rest.find(']').expect("]");
    let handler = &rest[..=end];
    assert!(handler.contains("auth_begin_logto"));
    assert!(handler.contains("auth_session_status"));
    assert!(handler.contains("auth_logout"));
    assert!(handler.contains("cloud_call"));
    for banned in [
        "auth_on_unauthorized",
        "fetch_url",
        "generic_http",
        "http_request",
    ] {
        assert!(!handler.contains(banned));
    }
}

#[test]
fn mark_reauth_required_if_epoch_current_vs_stale() {
    let store = AuthStore::new();
    store.install_session_for_tests("t1", "alice", "admin", "sub-1");
    let epoch = store.native_auth_snapshot().unwrap().epoch;
    assert_eq!(store.mark_reauth_required_if_epoch(epoch), Ok(true));
    assert!(store.native_auth_snapshot().is_none());
    // Stale epoch after clear: Ok(false).
    assert_eq!(store.mark_reauth_required_if_epoch(epoch), Ok(false));

    store.install_session_for_tests("t1", "bob", "admin", "sub-2");
    let new_epoch = store.native_auth_snapshot().unwrap().epoch;
    assert_eq!(store.mark_reauth_required_if_epoch(epoch), Ok(false)); // old
    assert!(store.native_auth_snapshot().is_some());
    assert_eq!(store.mark_reauth_required_if_epoch(new_epoch), Ok(true));
    assert!(store.native_auth_snapshot().is_none());
}

#[test]
fn mark_reauth_required_if_epoch_poison_is_err_not_stale() {
    let store = AuthStore::new();
    store.install_session_for_tests("t1", "alice", "admin", "sub-1");
    let epoch = store.native_auth_snapshot().unwrap().epoch;
    store.poison_lock_for_tests();
    assert!(matches!(
        store.mark_reauth_required_if_epoch(epoch),
        Err(AuthError::Internal)
    ));
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
        assert!(!t.starts_with("open ") && !t.starts_with("open=") && !t.starts_with("open ="));
    }
}

#[test]
fn auth_native_only_ops_remain_not_ipc_callable() {
    use crate::cloud_transport::{is_ipc_callable, Operation};
    assert!(!is_ipc_callable(Operation::AuthConfig));
    assert!(!is_ipc_callable(Operation::AuthExchange));
}

#[test]
fn auth_capability_denies_opener_deep_link_shell_to_webview() {
    let cap = include_str!("../../capabilities/default.json");
    assert!(cap.contains("core:default"));
    assert!(!cap.contains("shell:"));
    assert!(!cap.contains("opener:"));
    assert!(!cap.contains("deep-link:"));
    assert!(!cap.contains("stronghold:"));
}

#[test]
fn auth_token_and_verifier_use_zeroizing() {
    let session_src = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/auth/session.rs"),
    )
    .unwrap();
    assert!(session_src.contains("token: Zeroizing<String>"));
    assert!(session_src.contains("code_verifier: Zeroizing<String>"));
}

/// Coordinator rejection: deep-link path cloned verifier via `as_str().to_string()`.
/// Require a true move of the `Zeroizing` wrapper (mem::take / mem::replace).
#[test]
fn auth_deep_link_moves_code_verifier_without_secret_clone() {
    let mod_src = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/auth/mod.rs"),
    )
    .unwrap();
    let start = mod_src
        .find("pub fn perform_handle_deep_link_at")
        .expect("perform_handle_deep_link_at");
    let body = &mod_src[start..];
    // Hard-fail the prior clone of secret verifier text.
    assert!(
        !body.contains("pending.code_verifier.as_str().to_string()"),
        "must not clone code_verifier secret via as_str().to_string()"
    );
    assert!(
        !body.contains("code_verifier.as_str().to_string()"),
        "must not clone code_verifier secret via as_str().to_string()"
    );
    // Accept either fully-qualified or imported mem::take/replace of the field.
    let takes = body.contains("mem::take(&mut pending.code_verifier)")
        || body.contains("std::mem::take(&mut pending.code_verifier)")
        || body.contains("mem::replace(&mut pending.code_verifier")
        || body.contains("std::mem::replace(&mut pending.code_verifier");
    assert!(
        takes,
        "must move Zeroizing code_verifier out with mem::take or mem::replace"
    );
}
