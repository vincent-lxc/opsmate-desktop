//! D4A — local SSH request / metadata / host-key policy tests (no real SSH).

use super::*;
use crate::auth::AuthStore;
use serde_json::json;
use std::sync::Mutex;

// ─── DTO unknown-field rejection ─────────────────────────────────────────────

#[test]
fn local_ssh_open_request_accepts_only_server_and_credential_id() {
    let ok = r#"{"serverId":"srv-1","credentialId":"cred-1"}"#;
    let r: LocalSshOpenRequest = serde_json::from_str(ok).unwrap();
    assert_eq!(r.server_id, "srv-1");
    assert_eq!(r.credential_id, "cred-1");
}

#[test]
fn local_ssh_open_request_rejects_host_port_username_tenant_pem() {
    for bad in [
        r#"{"serverId":"s","credentialId":"c","host":"1.2.3.4"}"#,
        r#"{"serverId":"s","credentialId":"c","port":22}"#,
        r#"{"serverId":"s","credentialId":"c","username":"root"}"#,
        r#"{"serverId":"s","credentialId":"c","tenantId":"tnt"}"#,
        r#"{"serverId":"s","credentialId":"c","pem":"-----BEGIN"}"#,
        r#"{"serverId":"s","credentialId":"c","passphrase":"x"}"#,
        r#"{"serverId":"s","credentialId":"c","token":"jwt"}"#,
        r#"{"serverId":"s","credentialId":"c","extra":1}"#,
    ] {
        assert!(
            serde_json::from_str::<LocalSshOpenRequest>(bad).is_err(),
            "should reject {bad}"
        );
    }
}

#[test]
fn local_ssh_open_response_serializes_session_id_only() {
    let resp = LocalSshOpenResponse {
        session_id: "lssh-1".into(),
    };
    let v = serde_json::to_value(&resp).unwrap();
    let obj = v.as_object().unwrap();
    assert_eq!(obj.len(), 1);
    assert_eq!(
        obj.get("sessionId").and_then(|x| x.as_str()),
        Some("lssh-1")
    );
    let s = serde_json::to_string(&resp).unwrap();
    assert_eq!(s, r#"{"sessionId":"lssh-1"}"#);
    for forbidden in [
        "host",
        "username",
        "credential",
        "serverId",
        "hostKey",
        "fingerprint",
        "pem",
        "token",
        "passphrase",
    ] {
        assert!(
            !s.to_lowercase().contains(&forbidden.to_lowercase()),
            "IPC must not contain {forbidden}: {s}"
        );
    }
    let _internal = PreparedSshTarget {
        server_id: "s".into(),
        name: "n".into(),
        host: "1.2.3.4".into(),
        port: 22,
        username: "u".into(),
        credential_id: "c".into(),
        host_key_status: HostKeyStatus::Unpinned,
        host_key_type: None,
        host_key_fingerprint: None,
        principal: crate::auth::NativePrincipal {
            tenant_id: "tenant-secret".into(),
            user_id: "user-secret".into(),
            subject: "sub:user-secret".into(),
        },
        session_epoch: 42,
    };
    let dbg = format!("{:?}", _internal);
    assert!(!dbg.contains("session_id"));
    assert!(!dbg.contains("tenant-secret"));
    assert!(!dbg.contains("user-secret"));
    assert!(!dbg.contains("42"));
    assert!(dbg.contains("<redacted>"));
}

// ─── Mocks ───────────────────────────────────────────────────────────────────

struct MockMeta {
    body: Mutex<Option<String>>,
    err: Mutex<Option<SshSessionError>>,
    last_url: Mutex<Option<String>>,
    /// Whether Authorization bearer was nonempty — never stores the token.
    saw_nonempty_auth: Mutex<bool>,
    /// Optional hook run during metadata fetch (identity-race injection).
    on_fetch: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl Default for MockMeta {
    fn default() -> Self {
        Self {
            body: Mutex::new(None),
            err: Mutex::new(None),
            last_url: Mutex::new(None),
            saw_nonempty_auth: Mutex::new(false),
            on_fetch: Mutex::new(None),
        }
    }
}

impl ServerMetadataClient for MockMeta {
    fn fetch_server_json(&self, url: &str, bearer: &str) -> Result<String, SshSessionError> {
        *self.last_url.lock().unwrap() = Some(url.to_string());
        *self.saw_nonempty_auth.lock().unwrap() = !bearer.is_empty();
        if let Some(hook) = self.on_fetch.lock().unwrap().as_ref() {
            hook();
        }
        if let Some(e) = self.err.lock().unwrap().clone() {
            return Err(e);
        }
        self.body
            .lock()
            .unwrap()
            .clone()
            .ok_or(SshSessionError::OnlineMetadataRequired)
    }
}

#[derive(Default)]
struct MockConfirm {
    allow: Mutex<bool>,
    last: Mutex<Option<TofuPrompt>>,
}

impl HostKeyConfirmer for MockConfirm {
    fn confirm_tofu(&self, prompt: &TofuPrompt) -> Result<bool, SshSessionError> {
        *self.last.lock().unwrap() = Some(prompt.clone());
        Ok(*self.allow.lock().unwrap())
    }
}

struct MockCloud {
    fail: Mutex<bool>,
    calls: Mutex<Vec<CloudHostKeyParams>>,
    saw_nonempty_auth: Mutex<bool>,
    /// Optional hook after recording a cloud call (identity-race injection).
    on_write: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl Default for MockCloud {
    fn default() -> Self {
        Self {
            fail: Mutex::new(false),
            calls: Mutex::new(Vec::new()),
            saw_nonempty_auth: Mutex::new(false),
            on_write: Mutex::new(None),
        }
    }
}

impl CloudHostKeyWriter for MockCloud {
    fn write_host_key(
        &self,
        params: &CloudHostKeyParams,
        bearer: &str,
    ) -> Result<(), SshSessionError> {
        *self.saw_nonempty_auth.lock().unwrap() = !bearer.is_empty();
        self.calls.lock().unwrap().push(params.clone());
        if let Some(hook) = self.on_write.lock().unwrap().as_ref() {
            hook();
        }
        if *self.fail.lock().unwrap() {
            return Err(SshSessionError::CloudHostKeyWriteFailed);
        }
        Ok(())
    }
}

#[derive(Default)]
struct MockLocalKh {
    /// (opaque namespace, key_type, fingerprint) — implementer cannot key by raw server_id alone.
    writes: Mutex<Vec<(String, String, String)>>,
}

impl LocalKnownHosts for MockLocalKh {
    fn record_host_key(
        &self,
        namespace: &str,
        key_type: &str,
        fingerprint: &str,
    ) -> Result<(), SshSessionError> {
        self.writes.lock().unwrap().push((
            namespace.to_string(),
            key_type.to_string(),
            fingerprint.to_string(),
        ));
        Ok(())
    }
}

fn sample_server_json(
    id: &str,
    tenant: &str,
    cred: &str,
    status: &str,
    key_type: Option<&str>,
    fp: Option<&str>,
) -> String {
    json!({
        "id": id,
        "tenant_id": tenant,
        "name": "web-1",
        "ip": "10.0.0.5",
        "ssh_user": "ubuntu",
        "ssh_port": 22,
        "ssh_credential_id": cred,
        "host_key_type": key_type,
        "host_key_fingerprint": fp,
        "host_key_status": status,
    })
    .to_string()
}

fn authed(tenant: &str, user: &str) -> AuthStore {
    let s = AuthStore::new();
    s.install_session_for_tests(tenant, user, "admin");
    s
}

// ─── ID validation / injection ───────────────────────────────────────────────

#[test]
fn local_ssh_id_rejects_path_injection_before_network() {
    let long = "x".repeat(129);
    let bad_ids = [
        "../etc",
        "a/b",
        "a?x",
        "a#b",
        "a%2f",
        ".",
        "..",
        "a..b",
        ".hidden",
        "trail.",
        "",
        "has space",
        long.as_str(),
    ];
    for bad in bad_ids {
        assert!(validate_ssh_id(bad).is_err(), "should reject id {bad:?}");
        assert!(server_metadata_url(bad).is_err());
        assert!(cloud_host_key_url(bad).is_err());
    }
    // Injection never reaches mock network.
    let auth = authed("tnt", "u");
    let meta = MockMeta::default();
    let req = LocalSshOpenRequest {
        server_id: "../evil".into(),
        credential_id: "cred".into(),
    };
    assert!(prepare_local_ssh_open(&auth, &req, &meta).is_err());
    assert!(meta.last_url.lock().unwrap().is_none());
}

#[test]
fn local_ssh_metadata_url_is_https_app_servers() {
    assert_eq!(
        server_metadata_url("srv-9").unwrap(),
        "https://app.itops.sh/api/servers/srv-9"
    );
}

// ─── Metadata parse / authorize ──────────────────────────────────────────────

#[test]
fn local_ssh_offline_metadata_message_requires_online_zh() {
    let msg = SshSessionError::OnlineMetadataRequired.user_message();
    assert!(msg.contains("需要在线"));
}

#[test]
fn local_ssh_parse_rejects_missing_required_fields() {
    let bad = json!({"id":"s","tenant_id":"t","name":"n","ip":"","ssh_user":"u","ssh_port":22,"ssh_credential_id":"c","host_key_status":"unpinned"});
    assert!(parse_server_metadata(&bad.to_string(), "s").is_err());
}

#[test]
fn local_ssh_parse_rejects_id_mismatch() {
    let raw = sample_server_json("srv-a", "tnt", "cred", "unpinned", None, None);
    assert!(matches!(
        parse_server_metadata(&raw, "srv-b"),
        Err(SshSessionError::AuthorizationFailed)
    ));
}

#[test]
fn local_ssh_parse_rejects_unpinned_with_partial_host_key() {
    let raw = sample_server_json("s1", "t", "c", "unpinned", Some("ssh-ed25519"), None);
    assert!(matches!(
        parse_server_metadata(&raw, "s1"),
        Err(SshSessionError::InvalidMetadata)
    ));
    let raw2 = sample_server_json("s1", "t", "c", "unpinned", None, Some("SHA256:x"));
    assert!(matches!(
        parse_server_metadata(&raw2, "s1"),
        Err(SshSessionError::InvalidMetadata)
    ));
}

#[test]
fn local_ssh_parse_pinned_requires_type_and_fingerprint() {
    let raw = sample_server_json("s1", "t", "c", "pinned", Some("ssh-ed25519"), None);
    assert!(matches!(
        parse_server_metadata(&raw, "s1"),
        Err(SshSessionError::InvalidMetadata)
    ));
}

#[test]
fn local_ssh_authorize_cross_tenant_indistinguishable() {
    let auth = authed("tnt-a", "user");
    let meta = parse_server_metadata(
        &sample_server_json("s1", "tnt-b", "cred", "unpinned", None, None),
        "s1",
    )
    .unwrap();
    let err = authorize_server_for_open(&auth, &meta, "cred").unwrap_err();
    assert!(matches!(err, SshSessionError::AuthorizationFailed));
    let um = err.user_message();
    assert!(!um.contains("tnt-b"));
    assert!(!um.contains("tnt-a"));
}

#[test]
fn local_ssh_authorize_cross_credential_indistinguishable() {
    let auth = authed("tnt-a", "user");
    let meta = parse_server_metadata(
        &sample_server_json("s1", "tnt-a", "cred-bound", "unpinned", None, None),
        "s1",
    )
    .unwrap();
    let e1 = authorize_server_for_open(&auth, &meta, "cred-other").unwrap_err();
    let e2 = authorize_server_for_open(
        &auth,
        &parse_server_metadata(
            &sample_server_json("s1", "tnt-other", "cred-bound", "unpinned", None, None),
            "s1",
        )
        .unwrap(),
        "cred-bound",
    )
    .unwrap_err();
    assert_eq!(e1.user_message(), e2.user_message());
}

// ─── Host-key policy ─────────────────────────────────────────────────────────

#[test]
fn local_ssh_host_key_pinned_exact_accepts() {
    let meta = parse_server_metadata(
        &sample_server_json(
            "s1",
            "t",
            "c",
            "pinned",
            Some("ssh-ed25519"),
            Some("SHA256:abc"),
        ),
        "s1",
    )
    .unwrap();
    let presented = PresentedHostKey {
        key_type: "ssh-ed25519".into(),
        fingerprint: "SHA256:abc".into(),
    };
    let conf = MockConfirm::default();
    assert!(matches!(
        evaluate_host_key(&meta, &presented, &conf).unwrap(),
        HostKeyDecision::AcceptPinned
    ));
    assert!(conf.last.lock().unwrap().is_none());
}

#[test]
fn local_ssh_host_key_pinned_mismatch_hard_rejects() {
    let meta = parse_server_metadata(
        &sample_server_json(
            "s1",
            "t",
            "c",
            "pinned",
            Some("ssh-ed25519"),
            Some("SHA256:abc"),
        ),
        "s1",
    )
    .unwrap();
    let presented = PresentedHostKey {
        key_type: "ssh-ed25519".into(),
        fingerprint: "SHA256:evil".into(),
    };
    assert!(matches!(
        evaluate_host_key(&meta, &presented, &MockConfirm::default()),
        Err(SshSessionError::HostKeyMismatch)
    ));
}

#[test]
fn local_ssh_host_key_unpinned_requires_tofu_never_silent() {
    let meta = parse_server_metadata(
        &sample_server_json("s1", "t", "c", "unpinned", None, None),
        "s1",
    )
    .unwrap();
    let presented = PresentedHostKey {
        key_type: "ssh-ed25519".into(),
        fingerprint: "SHA256:new".into(),
    };
    let conf = MockConfirm::default();
    *conf.allow.lock().unwrap() = false;
    assert!(matches!(
        evaluate_host_key(&meta, &presented, &conf),
        Err(SshSessionError::HostKeyRejectedByUser)
    ));
    let p = conf.last.lock().unwrap().clone().unwrap();
    assert_eq!(p.fingerprint, "SHA256:new");
    let ps = serde_json::to_string(&p).unwrap();
    assert!(!ps.contains("token"));
    assert!(!ps.contains("pem"));
}

// ─── TOFU cloud-before-local ─────────────────────────────────────────────────

#[test]
fn local_ssh_tofu_confirm_reject_no_cloud_or_local_write() {
    let auth = authed("tnt", "u");
    let meta = MockMeta::default();
    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1", "tnt", "cred", "unpinned", None, None,
    ));
    let conf = MockConfirm::default();
    *conf.allow.lock().unwrap() = false;
    let cloud = MockCloud::default();
    let local = MockLocalKh::default();
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred".into(),
    };
    let presented = PresentedHostKey {
        key_type: "ssh-ed25519".into(),
        fingerprint: "SHA256:new".into(),
    };
    let target = prepare_local_ssh_open(&auth, &req, &meta).unwrap();
    let err =
        verify_server_host_key(&auth, &target, &presented, &conf, &cloud, &local).unwrap_err();
    assert!(matches!(err, SshSessionError::HostKeyRejectedByUser));
    assert!(cloud.calls.lock().unwrap().is_empty());
    assert!(local.writes.lock().unwrap().is_empty());
}

#[test]
fn local_ssh_tofu_cloud_failure_no_local_write() {
    let auth = authed("tnt", "u");
    let meta = MockMeta::default();
    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1", "tnt", "cred", "unpinned", None, None,
    ));
    let conf = MockConfirm::default();
    *conf.allow.lock().unwrap() = true;
    let cloud = MockCloud::default();
    *cloud.fail.lock().unwrap() = true;
    let local = MockLocalKh::default();
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred".into(),
    };
    let presented = PresentedHostKey {
        key_type: "ssh-ed25519".into(),
        fingerprint: "SHA256:new".into(),
    };
    let target = prepare_local_ssh_open(&auth, &req, &meta).unwrap();
    let err =
        verify_server_host_key(&auth, &target, &presented, &conf, &cloud, &local).unwrap_err();
    assert!(matches!(err, SshSessionError::CloudHostKeyWriteFailed));
    assert_eq!(cloud.calls.lock().unwrap().len(), 1);
    assert!(cloud.calls.lock().unwrap()[0]
        .expected_fingerprint
        .is_none());
    assert!(*cloud.saw_nonempty_auth.lock().unwrap());
    assert!(local.writes.lock().unwrap().is_empty());
}

#[test]
fn local_ssh_tofu_cloud_success_then_local_write() {
    let auth = authed("tnt", "u");
    let meta = MockMeta::default();
    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1", "tnt", "cred", "unpinned", None, None,
    ));
    let conf = MockConfirm::default();
    *conf.allow.lock().unwrap() = true;
    let cloud = MockCloud::default();
    let local = MockLocalKh::default();
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred".into(),
    };
    let presented = PresentedHostKey {
        key_type: "ssh-ed25519".into(),
        fingerprint: "SHA256:new".into(),
    };
    let target = prepare_local_ssh_open(&auth, &req, &meta).unwrap();
    verify_server_host_key(&auth, &target, &presented, &conf, &cloud, &local).unwrap();
    assert_eq!(target.host, "10.0.0.5");
    assert_eq!(target.username, "ubuntu");
    assert_eq!(cloud.calls.lock().unwrap().len(), 1);
    assert!(cloud.calls.lock().unwrap()[0]
        .expected_fingerprint
        .is_none());
    let body = cloud_host_key_body(&cloud.calls.lock().unwrap()[0]);
    assert_eq!(body["expected_fingerprint"], serde_json::Value::Null);
    assert_eq!(body["host_key_type"], "ssh-ed25519");
    assert_eq!(body["fingerprint"], "SHA256:new");
    let expected_ns = local_known_hosts_namespace(
        &crate::auth::NativePrincipal {
            tenant_id: "tnt".into(),
            user_id: "u".into(),
            subject: "sub:u".into(),
        },
        "s1",
    )
    .unwrap();
    let writes = local.writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].0, expected_ns);
    assert!(writes[0].0.starts_with("kh/v1/"));
    assert_eq!(writes[0].1, "ssh-ed25519");
    assert_eq!(writes[0].2, "SHA256:new");
    drop(writes);
    assert_eq!(
        meta.last_url.lock().unwrap().as_deref(),
        Some("https://app.itops.sh/api/servers/s1")
    );
    assert!(*meta.saw_nonempty_auth.lock().unwrap());
    assert!(*cloud.saw_nonempty_auth.lock().unwrap());
    // Prepared target is bound to snapshot principal + epoch (internal, not IPC).
    assert_eq!(target.principal.tenant_id, "tnt");
    assert_eq!(target.principal.user_id, "u");
    assert!(target.session_epoch > 0);
    assert!(auth.session_binding_current(&target.principal, target.session_epoch));
    // D4A does not invent sessionId — only D4B DTO in tests.
    let ipc = LocalSshOpenResponse {
        session_id: "placeholder-from-test-only".into(),
    };
    assert_eq!(
        serde_json::to_string(&ipc).unwrap(),
        r#"{"sessionId":"placeholder-from-test-only"}"#
    );
}

#[test]
fn local_ssh_unauthenticated_fails_closed() {
    let auth = AuthStore::new();
    let meta = MockMeta::default();
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred".into(),
    };
    assert!(matches!(
        prepare_local_ssh_open(&auth, &req, &meta),
        Err(SshSessionError::Unauthenticated)
    ));
    assert!(meta.last_url.lock().unwrap().is_none());
}

#[test]
fn local_ssh_offline_metadata_uses_stable_message() {
    let auth = authed("tnt", "u");
    let meta = MockMeta::default();
    *meta.err.lock().unwrap() = Some(SshSessionError::OnlineMetadataRequired);
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred".into(),
    };
    let err = prepare_local_ssh_open(&auth, &req, &meta).unwrap_err();
    assert!(err.user_message().contains("需要在线"));
}

#[test]
fn local_ssh_cloud_params_debug_has_no_bearer_field() {
    let p = CloudHostKeyParams {
        server_id: "s".into(),
        host_key_type: "ssh-ed25519".into(),
        fingerprint: "SHA256:x".into(),
        expected_fingerprint: None,
    };
    let d = format!("{p:?}");
    assert!(!d.to_lowercase().contains("bearer"));
    assert!(!d.to_lowercase().contains("token"));
    // production adapters exist
    let _ = ReqwestServerMetadataClient::new();
    let _ = ReqwestCloudHostKeyWriter::new();
}

#[test]
fn local_ssh_source_has_no_bearer_on_cloud_params_struct() {
    let src = include_str!("ssh_session.rs");
    assert!(src.contains("struct CloudHostKeyParams"));
    assert!(
        !src.contains("pub bearer"),
        "must not store bearer on any public field"
    );
    assert!(src.contains("bearer: &str"));
    assert!(src.contains("set_sensitive(true)"));
    assert!(src.contains("accumulate_chunks_bounded"));
    assert!(src.contains("chunk().await") || src.contains(".chunk()"));
    assert!(!src.contains("new_session_id"));
    assert!(!src.contains("fn new_session_id"));
}

#[test]
fn local_ssh_accumulate_chunks_exact_limit_ok() {
    let max = 8;
    let a = vec![1u8; 5];
    let b = vec![2u8; 3];
    let out = accumulate_chunks_bounded([a, b], max).unwrap();
    assert_eq!(out.len(), 8);
}

#[test]
fn local_ssh_accumulate_chunks_limit_plus_one_fails() {
    let max = 8;
    let a = vec![1u8; 5];
    let b = vec![2u8; 4]; // 5+4=9 > 8
    assert!(matches!(
        accumulate_chunks_bounded([a, b], max),
        Err(SshSessionError::OnlineMetadataRequired)
    ));
}

#[test]
fn local_ssh_map_get_status_auth_vs_online() {
    use reqwest::StatusCode;
    assert!(map_get_status(StatusCode::OK).is_ok());
    assert!(matches!(
        map_get_status(StatusCode::UNAUTHORIZED),
        Err(SshSessionError::AuthorizationFailed)
    ));
    assert!(matches!(
        map_get_status(StatusCode::FORBIDDEN),
        Err(SshSessionError::AuthorizationFailed)
    ));
    assert!(matches!(
        map_get_status(StatusCode::NOT_FOUND),
        Err(SshSessionError::AuthorizationFailed)
    ));
    assert!(matches!(
        map_get_status(StatusCode::INTERNAL_SERVER_ERROR),
        Err(SshSessionError::OnlineMetadataRequired)
    ));
    assert!(matches!(
        map_get_status(StatusCode::BAD_GATEWAY),
        Err(SshSessionError::OnlineMetadataRequired)
    ));
}

// ─── Principal-namespaced known-hosts ────────────────────────────────────────

#[test]
fn local_ssh_known_hosts_namespace_slash_collision_pair_is_distinct() {
    // Raw path join would make ("a/b","c") collide with ("a","b/c"); encoding must not.
    let p1 = crate::auth::NativePrincipal {
        tenant_id: "a/b".into(),
        user_id: "c".into(),
        subject: "sub:c".into(),
    };
    let p2 = crate::auth::NativePrincipal {
        tenant_id: "a".into(),
        user_id: "b/c".into(),
        subject: "sub:b/c".into(),
    };
    let ns1 = local_known_hosts_namespace(&p1, "srv-1").unwrap();
    let ns2 = local_known_hosts_namespace(&p2, "srv-1").unwrap();
    assert_ne!(ns1, ns2);
    assert!(ns1.starts_with("kh/v1/"));
    assert!(ns2.starts_with("kh/v1/"));
    // Encoded segments must not leave raw slash-bearing principal text in the key.
    assert!(!ns1.contains("a/b"));
    assert!(!ns2.contains("b/c"));
}

#[test]
fn local_ssh_known_hosts_namespace_unicode_encoded_not_raw() {
    let p = crate::auth::NativePrincipal {
        tenant_id: "租户".into(),
        user_id: "用户".into(),
        subject: "sub:用户".into(),
    };
    let ns = local_known_hosts_namespace(&p, "srv-1").unwrap();
    assert!(ns.starts_with("kh/v1/"));
    assert!(!ns.contains("租户"));
    assert!(!ns.contains("用户"));
    assert!(ns.ends_with("/srv-1"));
    // Deterministic: same inputs → same namespace.
    assert_eq!(ns, local_known_hosts_namespace(&p, "srv-1").unwrap());
}

#[test]
fn local_ssh_known_hosts_namespace_rejects_empty_control_whitespace() {
    let ok_server = "srv-1";
    assert!(matches!(
        local_known_hosts_namespace(
            &crate::auth::NativePrincipal {
                tenant_id: "".into(),
                user_id: "u".into(),
                subject: "sub:u".into(),
            },
            ok_server
        ),
        Err(SshSessionError::InvalidIdentity)
    ));
    assert!(matches!(
        local_known_hosts_namespace(
            &crate::auth::NativePrincipal {
                tenant_id: "t".into(),
                user_id: "".into(),
                subject: format!("sub:{}", ""),
            },
            ok_server
        ),
        Err(SshSessionError::InvalidIdentity)
    ));
    assert!(matches!(
        local_known_hosts_namespace(
            &crate::auth::NativePrincipal {
                tenant_id: " t ".into(),
                user_id: "u".into(),
                subject: "sub:u".into(),
            },
            ok_server
        ),
        Err(SshSessionError::InvalidIdentity)
    ));
    assert!(matches!(
        local_known_hosts_namespace(
            &crate::auth::NativePrincipal {
                tenant_id: "t".into(),
                user_id: "u\n".into(),
                subject: "sub:u\n".into(),
            },
            ok_server
        ),
        Err(SshSessionError::InvalidIdentity)
    ));
    assert!(matches!(
        local_known_hosts_namespace(
            &crate::auth::NativePrincipal {
                tenant_id: "t\0x".into(),
                user_id: "u".into(),
                subject: "sub:u".into(),
            },
            ok_server
        ),
        Err(SshSessionError::InvalidIdentity)
    ));
}

#[test]
fn local_ssh_known_hosts_namespace_rejects_invalid_server_id() {
    let p = crate::auth::NativePrincipal {
        tenant_id: "tnt".into(),
        user_id: "user".into(),
        subject: "sub:user".into(),
    };
    for bad in ["../evil", "a/b", "", "has space", "..", ".hidden"] {
        assert!(
            matches!(
                local_known_hosts_namespace(&p, bad),
                Err(SshSessionError::InvalidIdentity)
            ),
            "should reject server_id {bad:?}"
        );
    }
}

#[test]
fn local_ssh_known_hosts_namespace_differs_by_principal_same_server() {
    let p_a = crate::auth::NativePrincipal {
        tenant_id: "tnt-a".into(),
        user_id: "alice".into(),
        subject: "sub:alice".into(),
    };
    let p_b = crate::auth::NativePrincipal {
        tenant_id: "tnt-b".into(),
        user_id: "bob".into(),
        subject: "sub:bob".into(),
    };
    let ns_a = local_known_hosts_namespace(&p_a, "srv-1").unwrap();
    let ns_b = local_known_hosts_namespace(&p_b, "srv-1").unwrap();
    assert_ne!(ns_a, ns_b);
    assert!(ns_a.starts_with("kh/v1/"));
    assert!(ns_b.starts_with("kh/v1/"));
    assert!(!ns_a.eq("srv-1"), "must not be global server_id alone");
    // Raw tenant strings must not appear (base64url segments only).
    assert!(!ns_a.contains("tnt-a"));
    assert!(!ns_b.contains("tnt-b"));

    let local = MockLocalKh::default();
    local
        .record_host_key(&ns_a, "ssh-ed25519", "SHA256:aa")
        .unwrap();
    local
        .record_host_key(&ns_b, "ssh-ed25519", "SHA256:bb")
        .unwrap();
    let writes = local.writes.lock().unwrap();
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0].0, ns_a);
    assert_eq!(writes[1].0, ns_b);
    assert_ne!(writes[0].0, writes[1].0);
}

// ─── Identity race / session epoch ───────────────────────────────────────────

#[test]
fn local_ssh_identity_race_principal_change_during_metadata_no_writes_or_target() {
    use std::sync::Arc;
    let auth = Arc::new(authed("tnt-old", "user-old"));
    let meta = MockMeta::default();
    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1", "tnt-old", "cred", "unpinned", None, None,
    ));
    let auth_hook = Arc::clone(&auth);
    *meta.on_fetch.lock().unwrap() = Some(Box::new(move || {
        auth_hook.install_session_for_tests("tnt-new", "user-new", "admin");
    }));
    let cloud = MockCloud::default();
    let local = MockLocalKh::default();
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred".into(),
    };
    let err = prepare_local_ssh_open(auth.as_ref(), &req, &meta).unwrap_err();
    assert!(matches!(err, SshSessionError::AuthorizationFailed));
    assert!(cloud.calls.lock().unwrap().is_empty());
    assert!(local.writes.lock().unwrap().is_empty());
}

#[test]
fn local_ssh_identity_race_logout_relogin_same_principal_epoch_mismatch() {
    use std::sync::Arc;
    let auth = Arc::new(authed("tnt", "user"));
    let snap_epoch = auth.native_auth_snapshot().unwrap().epoch;
    let meta = MockMeta::default();
    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1", "tnt", "cred", "unpinned", None, None,
    ));
    let auth_hook = Arc::clone(&auth);
    *meta.on_fetch.lock().unwrap() = Some(Box::new(move || {
        // Logout + relogin same tenant/user advances epoch.
        let _ = auth_hook.clear_native();
        auth_hook.install_session_for_tests("tnt", "user", "admin");
    }));
    let cloud = MockCloud::default();
    let local = MockLocalKh::default();
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred".into(),
    };
    let err = prepare_local_ssh_open(auth.as_ref(), &req, &meta).unwrap_err();
    assert!(matches!(err, SshSessionError::AuthorizationFailed));
    assert!(cloud.calls.lock().unwrap().is_empty());
    assert!(local.writes.lock().unwrap().is_empty());
    // New session is live but different epoch than the in-flight snapshot.
    let now = auth.native_auth_snapshot().unwrap();
    assert!(now.epoch > snap_epoch);
    assert!(!auth.session_binding_current(
        &crate::auth::NativePrincipal {
            tenant_id: "tnt".into(),
            user_id: "user".into(),
            subject: "sub:user".into(),
        },
        snap_epoch
    ));
}

#[test]
fn local_ssh_identity_race_principal_change_during_cloud_tofu_no_local_or_target() {
    use std::sync::Arc;
    let auth = Arc::new(authed("tnt-old", "user-old"));
    let meta = MockMeta::default();
    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1", "tnt-old", "cred", "unpinned", None, None,
    ));
    let conf = MockConfirm::default();
    *conf.allow.lock().unwrap() = true;
    let cloud = MockCloud::default();
    let auth_hook = Arc::clone(&auth);
    *cloud.on_write.lock().unwrap() = Some(Box::new(move || {
        auth_hook.install_session_for_tests("tnt-switched", "user-switched", "admin");
    }));
    let local = MockLocalKh::default();
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred".into(),
    };
    let presented = PresentedHostKey {
        key_type: "ssh-ed25519".into(),
        fingerprint: "SHA256:new".into(),
    };
    let target = prepare_local_ssh_open(auth.as_ref(), &req, &meta).unwrap();
    let err = verify_server_host_key(auth.as_ref(), &target, &presented, &conf, &cloud, &local)
        .unwrap_err();
    assert!(matches!(err, SshSessionError::AuthorizationFailed));
    // Cloud may have completed; local write must not.
    assert_eq!(cloud.calls.lock().unwrap().len(), 1);
    assert!(local.writes.lock().unwrap().is_empty());
}

#[test]
fn local_ssh_stable_snapshot_binds_principal_and_epoch_on_target() {
    let auth = authed("tnt-stable", "alice");
    let snap = auth.native_auth_snapshot().unwrap();
    let meta = MockMeta::default();
    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1",
        "tnt-stable",
        "cred-unique-xyz",
        "pinned",
        Some("ssh-ed25519"),
        Some("SHA256:pin"),
    ));
    let conf = MockConfirm::default();
    let cloud = MockCloud::default();
    let local = MockLocalKh::default();
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred-unique-xyz".into(),
    };
    let presented = PresentedHostKey {
        key_type: "ssh-ed25519".into(),
        fingerprint: "SHA256:pin".into(),
    };
    let target = prepare_local_ssh_open(&auth, &req, &meta).unwrap();
    // Phase 1: no TOFU side effects yet.
    assert!(cloud.calls.lock().unwrap().is_empty());
    assert!(local.writes.lock().unwrap().is_empty());
    verify_server_host_key(&auth, &target, &presented, &conf, &cloud, &local).unwrap();
    assert_eq!(target.principal, snap.principal);
    assert_eq!(target.session_epoch, snap.epoch);
    assert!(auth.session_binding_current(&target.principal, target.session_epoch));
    // Pinned match: no cloud write; reconcile into local known-hosts.
    assert!(cloud.calls.lock().unwrap().is_empty());
    assert_eq!(local.writes.lock().unwrap().len(), 1);
    assert_eq!(local.writes.lock().unwrap()[0].1, "ssh-ed25519");
    assert_eq!(local.writes.lock().unwrap()[0].2, "SHA256:pin");
    // Debug must redact identity binding fields (tenant/user/epoch/credential value).
    let dbg = format!("{target:?}");
    assert!(!dbg.contains("tnt-stable"));
    assert!(!dbg.contains("alice"));
    assert!(!dbg.contains("cred-unique-xyz"));
    assert!(
        dbg.contains("session_epoch: \"<redacted>\"") || dbg.contains("session_epoch: <redacted>")
    );
    assert!(dbg.contains("principal: \"<redacted>\"") || dbg.contains("principal: <redacted>"));
    assert!(
        dbg.contains("credential_id: \"<redacted>\"") || dbg.contains("credential_id: <redacted>")
    );
}

#[test]
fn local_ssh_d4b_revalidation_accepts_current_rejects_after_relogin() {
    let auth = authed("tnt", "user");
    let meta = MockMeta::default();
    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1", "tnt", "cred", "unpinned", None, None,
    ));
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred".into(),
    };
    let target = prepare_local_ssh_open(&auth, &req, &meta).unwrap();
    // D4B revalidation uses principal+epoch without bearer snapshot.
    assert!(auth.session_binding_current(&target.principal, target.session_epoch));
    // Logout + relogin same tenant/user: epoch advances → stale prepared target rejected.
    let _ = auth.clear_native();
    auth.install_session_for_tests("tnt", "user", "admin");
    assert!(!auth.session_binding_current(&target.principal, target.session_epoch));
    // Fresh session binds under a new epoch.
    let fresh = auth.native_auth_snapshot().unwrap();
    assert_ne!(fresh.epoch, target.session_epoch);
    assert!(auth.session_binding_current(&fresh.principal, fresh.epoch));
}

#[test]
fn local_ssh_map_post_status_always_cloud_failure() {
    use reqwest::StatusCode;
    assert!(map_post_status(StatusCode::OK).is_ok());
    assert!(matches!(
        map_post_status(StatusCode::UNAUTHORIZED),
        Err(SshSessionError::CloudHostKeyWriteFailed)
    ));
    assert!(matches!(
        map_post_status(StatusCode::INTERNAL_SERVER_ERROR),
        Err(SshSessionError::CloudHostKeyWriteFailed)
    ));
    assert!(matches!(
        map_post_status(StatusCode::NOT_FOUND),
        Err(SshSessionError::CloudHostKeyWriteFailed)
    ));
}

// ─── D4B2a focused requirements (two-phase + opaque hashed namespace) ─────────

/// Known-hosts namespace must be opaque/hashed — not reversible base64 of tenant/user.
#[test]
fn local_ssh_known_hosts_namespace_is_opaque_hash_not_reversible_b64() {
    use crate::auth::base64url_nopad;
    let p = crate::auth::NativePrincipal {
        tenant_id: "tenant-secret-xyz".into(),
        user_id: "user-secret-abc".into(),
        subject: "sub:user-secret-abc".into(),
    };
    let ns = local_known_hosts_namespace(&p, "srv-1").unwrap();
    assert!(ns.starts_with("kh/v1/"), "ns={ns}");
    // No raw principal in path.
    assert!(!ns.contains("tenant-secret-xyz"));
    assert!(!ns.contains("user-secret-abc"));
    // No reversible base64url of principal components.
    let b64_t = base64url_nopad(b"tenant-secret-xyz");
    let b64_u = base64url_nopad(b"user-secret-abc");
    assert!(
        !ns.contains(&b64_t),
        "namespace must not embed reversible b64(tenant): {ns}"
    );
    assert!(
        !ns.contains(&b64_u),
        "namespace must not embed reversible b64(user): {ns}"
    );
    // Opaque segment: lowercase sha256 hex (64 chars) under kh/v1/.
    let rest = ns.strip_prefix("kh/v1/").expect("prefix");
    let principal_seg = rest
        .strip_suffix("/srv-1")
        .expect("server_id suffix on hashed namespace");
    assert_eq!(
        principal_seg.len(),
        64,
        "expect sha256 hex principal segment, got {principal_seg:?} in {ns}"
    );
    assert!(
        principal_seg.chars().all(|c| c.is_ascii_hexdigit()),
        "principal segment must be hex, got {principal_seg}"
    );
    assert_eq!(
        principal_seg,
        principal_seg.to_ascii_lowercase(),
        "hex digest must be lowercase"
    );
}

/// Debug of prepared target must never print raw principal fields.
#[test]
fn local_ssh_d4b2a_prepared_debug_has_no_raw_principal() {
    let target = PreparedSshTarget {
        server_id: "s1".into(),
        name: "n".into(),
        host: "10.0.0.5".into(),
        port: 22,
        username: "ubuntu".into(),
        credential_id: "cred".into(),
        host_key_status: HostKeyStatus::Unpinned,
        host_key_type: None,
        host_key_fingerprint: None,
        principal: crate::auth::NativePrincipal {
            tenant_id: "tenant-secret-xyz".into(),
            user_id: "user-secret-abc".into(),
            subject: "sub:user-secret-abc".into(),
        },
        session_epoch: 99,
    };
    let dbg = format!("{target:?}");
    assert!(!dbg.contains("tenant-secret-xyz"));
    assert!(!dbg.contains("user-secret-abc"));
    assert!(!dbg.contains("99"));
    assert!(dbg.contains("<redacted>"));
}

/// Cloud pin must be recorded before local known-hosts write (shared event log).
/// When cloud fails, local stays untouched.
#[test]
fn local_ssh_d4b2a_tofu_cloud_before_local_event_order() {
    use std::sync::{Arc, Mutex};
    let events: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));

    struct OrderCloud {
        events: Arc<Mutex<Vec<&'static str>>>,
        inner: MockCloud,
    }
    impl CloudHostKeyWriter for OrderCloud {
        fn write_host_key(
            &self,
            params: &CloudHostKeyParams,
            bearer: &str,
        ) -> Result<(), SshSessionError> {
            self.events.lock().unwrap().push("cloud");
            self.inner.write_host_key(params, bearer)
        }
    }
    struct OrderLocal {
        events: Arc<Mutex<Vec<&'static str>>>,
        inner: MockLocalKh,
    }
    impl LocalKnownHosts for OrderLocal {
        fn record_host_key(
            &self,
            namespace: &str,
            key_type: &str,
            fingerprint: &str,
        ) -> Result<(), SshSessionError> {
            self.events.lock().unwrap().push("local");
            self.inner.record_host_key(namespace, key_type, fingerprint)
        }
    }

    let auth = authed("tnt-order", "user-order");
    let meta = MockMeta::default();
    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1",
        "tnt-order",
        "cred",
        "unpinned",
        None,
        None,
    ));
    let conf = MockConfirm::default();
    *conf.allow.lock().unwrap() = true;
    let cloud = OrderCloud {
        events: Arc::clone(&events),
        inner: MockCloud::default(),
    };
    let local = OrderLocal {
        events: Arc::clone(&events),
        inner: MockLocalKh::default(),
    };
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred".into(),
    };
    let target = prepare_local_ssh_open(&auth, &req, &meta).unwrap();
    assert!(events.lock().unwrap().is_empty());
    let presented = PresentedHostKey {
        key_type: "ssh-ed25519".into(),
        fingerprint: "SHA256:order-fp".into(),
    };
    verify_server_host_key(&auth, &target, &presented, &conf, &cloud, &local).unwrap();
    assert_eq!(*events.lock().unwrap(), vec!["cloud", "local"]);

    // Cloud failure leaves local untouched beyond prior success (ordering + fail-closed).
    let local_before = local.inner.writes.lock().unwrap().len();
    events.lock().unwrap().clear();
    *cloud.inner.fail.lock().unwrap() = true;
    let err =
        verify_server_host_key(&auth, &target, &presented, &conf, &cloud, &local).unwrap_err();
    assert!(matches!(err, SshSessionError::CloudHostKeyWriteFailed));
    assert_eq!(*events.lock().unwrap(), vec!["cloud"]);
    assert_eq!(local.inner.writes.lock().unwrap().len(), local_before);
}

/// Pinned match reconciles into local KH without cloud write; local failure fails closed.
#[test]
fn local_ssh_d4b2a_pinned_reconciles_local_no_cloud_and_local_fail_closed() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    struct FailLocal {
        fail: Arc<AtomicBool>,
        inner: MockLocalKh,
    }
    impl LocalKnownHosts for FailLocal {
        fn record_host_key(
            &self,
            namespace: &str,
            key_type: &str,
            fingerprint: &str,
        ) -> Result<(), SshSessionError> {
            if self.fail.load(Ordering::SeqCst) {
                return Err(SshSessionError::LocalKnownHostsFailed);
            }
            self.inner.record_host_key(namespace, key_type, fingerprint)
        }
    }

    let auth = authed("tnt-pin", "user-pin");
    let meta = MockMeta::default();
    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1",
        "tnt-pin",
        "cred",
        "pinned",
        Some("ssh-ed25519"),
        Some("SHA256:pin"),
    ));
    let conf = MockConfirm::default();
    let cloud = MockCloud::default();
    let fail = Arc::new(AtomicBool::new(true));
    let local = FailLocal {
        fail: Arc::clone(&fail),
        inner: MockLocalKh::default(),
    };
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred".into(),
    };
    let presented = PresentedHostKey {
        key_type: "ssh-ed25519".into(),
        fingerprint: "SHA256:pin".into(),
    };
    let target = prepare_local_ssh_open(&auth, &req, &meta).unwrap();
    let err =
        verify_server_host_key(&auth, &target, &presented, &conf, &cloud, &local).unwrap_err();
    assert!(matches!(err, SshSessionError::LocalKnownHostsFailed));
    assert!(cloud.calls.lock().unwrap().is_empty());
    // Retry after local recovers succeeds (retryable).
    fail.store(false, Ordering::SeqCst);
    verify_server_host_key(&auth, &target, &presented, &conf, &cloud, &local).unwrap();
    assert!(cloud.calls.lock().unwrap().is_empty());
    assert_eq!(local.inner.writes.lock().unwrap().len(), 1);
}

/// russh Handler::check_server_key with real PublicKey; exact Err on mismatch/reject.
#[tokio::test]
async fn local_ssh_d4b2a_handler_check_server_key_delegates_to_phase2() {
    use std::sync::Arc;

    let auth = Arc::new(authed("tnt-handler", "user-handler"));
    let meta = MockMeta::default();
    let openssh =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ test@host";
    let pk = russh::keys::PublicKey::from_openssh(openssh).expect("fixture public key");
    let presented = presented_host_key_from_russh(&pk);
    assert_eq!(presented.key_type, "ssh-ed25519");
    assert!(presented.fingerprint.starts_with("SHA256:"));

    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1",
        "tnt-handler",
        "cred",
        "pinned",
        Some("ssh-ed25519"),
        Some(&presented.fingerprint),
    ));
    let conf = Arc::new(MockConfirm::default());
    let cloud = Arc::new(MockCloud::default());
    let local = Arc::new(MockLocalKh::default());
    let req = LocalSshOpenRequest {
        server_id: "s1".into(),
        credential_id: "cred".into(),
    };
    let target = prepare_local_ssh_open(auth.as_ref(), &req, &meta).unwrap();
    let mut handler = HostKeyPolicyHandler::new(
        Arc::clone(&auth),
        target,
        conf.clone() as Arc<dyn HostKeyConfirmer>,
        cloud.clone() as Arc<dyn CloudHostKeyWriter>,
        local.clone() as Arc<dyn LocalKnownHosts>,
    );
    let accepted = russh::client::Handler::check_server_key(&mut handler, &pk)
        .await
        .expect("handler ok");
    assert!(accepted);
    assert!(conf.last.lock().unwrap().is_none());
    assert!(cloud.calls.lock().unwrap().is_empty());
    // Pinned reconcile writes local once.
    assert_eq!(local.writes.lock().unwrap().len(), 1);

    // Mismatch: exact HostKeyMismatch Err (not Ok(false)).
    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1",
        "tnt-handler",
        "cred",
        "pinned",
        Some("ssh-ed25519"),
        Some("SHA256:not-the-key"),
    ));
    let target2 = prepare_local_ssh_open(auth.as_ref(), &req, &meta).unwrap();
    let mut handler2 = HostKeyPolicyHandler::new(
        Arc::clone(&auth),
        target2,
        conf.clone() as Arc<dyn HostKeyConfirmer>,
        cloud.clone() as Arc<dyn CloudHostKeyWriter>,
        local.clone() as Arc<dyn LocalKnownHosts>,
    );
    let err = russh::client::Handler::check_server_key(&mut handler2, &pk)
        .await
        .unwrap_err();
    assert!(
        matches!(err, SshSessionError::HostKeyMismatch),
        "expected HostKeyMismatch, got {err:?}"
    );

    // User reject (unpinned + confirmer false): exact HostKeyRejectedByUser.
    *meta.body.lock().unwrap() = Some(sample_server_json(
        "s1",
        "tnt-handler",
        "cred",
        "unpinned",
        None,
        None,
    ));
    *conf.allow.lock().unwrap() = false;
    let target3 = prepare_local_ssh_open(auth.as_ref(), &req, &meta).unwrap();
    let mut handler3 = HostKeyPolicyHandler::new(
        Arc::clone(&auth),
        target3,
        conf.clone() as Arc<dyn HostKeyConfirmer>,
        cloud.clone() as Arc<dyn CloudHostKeyWriter>,
        local.clone() as Arc<dyn LocalKnownHosts>,
    );
    let err3 = russh::client::Handler::check_server_key(&mut handler3, &pk)
        .await
        .unwrap_err();
    assert!(matches!(err3, SshSessionError::HostKeyRejectedByUser));
}

/// Native confirmer uses rfd MessageDialog OkCancel; accept only Ok.
#[test]
fn local_ssh_d4b2a_native_tofu_confirmer_uses_rfd_message_dialog() {
    let _ = NativeTofuConfirmer;
    let src = include_str!("ssh_session.rs");
    assert!(src.contains("MessageDialog::new()"));
    assert!(src.contains("set_buttons(MessageButtons::OkCancel)"));
    assert!(src.contains("MessageDialogResult::Ok"));
    // Must not accept Yes for OkCancel dialogs.
    assert!(
        !src.contains("MessageDialogResult::Ok | MessageDialogResult::Yes")
            && !src.contains("MessageDialogResult::Yes | MessageDialogResult::Ok")
    );
    assert!(src.contains("Fingerprint:"));
    assert!(src.contains("Key type:"));
}

/// FsLocalKnownHosts: opaque path, content, modes, traversal, no leftover temps.
#[test]
fn local_ssh_d4b2a_fs_known_hosts_hardened_write() {
    let root = std::env::temp_dir().join(format!(
        "opsmate-kh-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let kh = FsLocalKnownHosts::new(root.clone());
    let p = crate::auth::NativePrincipal {
        tenant_id: "tenant-secret-xyz".into(),
        user_id: "user-secret-abc".into(),
        subject: "sub:user-secret-abc".into(),
    };
    let ns = local_known_hosts_namespace(&p, "srv-1").unwrap();
    assert!(!ns.contains("tenant-secret-xyz"));
    assert!(!ns.contains("user-secret-abc"));
    kh.record_host_key(&ns, "ssh-ed25519", "SHA256:fp1")
        .unwrap();
    let path = root.join(&ns);
    assert!(path.is_file());
    let path_str = path.to_string_lossy();
    assert!(!path_str.contains("tenant-secret-xyz"));
    assert!(!path_str.contains("user-secret-abc"));
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "ssh-ed25519 SHA256:fp1\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(file_mode, 0o600);
        let dir_mode = std::fs::metadata(&root).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
    }
    // No leftover temp parts.
    let leftovers: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().to_string_lossy().contains(".tmp.")
                || e.file_name().to_string_lossy().ends_with(".part")
        })
        .collect();
    assert!(leftovers.is_empty(), "leftover temps: {leftovers:?}");
    // Traversal rejected.
    assert!(matches!(
        kh.record_host_key("../evil", "ssh-ed25519", "SHA256:x"),
        Err(SshSessionError::LocalKnownHostsFailed)
    ));
    assert!(matches!(
        kh.record_host_key("kh/v1/../evil/srv", "ssh-ed25519", "SHA256:x"),
        Err(SshSessionError::LocalKnownHostsFailed)
    ));
    let _ = std::fs::remove_dir_all(&root);
}
