//! D5 — cloud custody upload/delete unit tests (no external network).

use super::*;
use crate::auth::AuthStore;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use zeroize::Zeroizing;

// Encrypted OpenSSH Ed25519 fixture; passphrase = "blabla".
const ED25519_ENCRYPTED_PEM: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jYmMAAAAGYmNyeXB0AAAAGAAAABDLGyfA39
J2FcJygtYqi5ISAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIN+Wjn4+4Fcvl2Jl
KpggT+wCRxpSvtqqpVrQrKN1/A22AAAAkOHDLnYZvYS6H9Q3S3Nk4ri3R2jAZlQlBbUos5
FkHpYgNw65KCWCTXtP7ye2czMC3zjn2r98pJLobsLYQgRiHIv/CUdAdsqbvMPECB+wl/UQ
e+JpiSq66Z6GIt0801skPh20jxOO3F52SoX1IeO5D5PXfZrfSZlw6S8c7bwyp2FHxDewRx
7/wNsnDM0T7nLv/Q==
-----END OPENSSH PRIVATE KEY-----";

// ─── Mocks ───────────────────────────────────────────────────────────────────

#[derive(Default)]
struct MockConfirmer {
    calls: Mutex<usize>,
    force: Mutex<Option<Result<(), CloudCustodyError>>>,
    last_prompt: Mutex<Option<CloudConfirmPrompt>>,
    typed: Mutex<String>,
    checked: Mutex<bool>,
    use_evaluate: bool,
}

impl MockConfirmer {
    fn accept_exact(token: &str, checked: bool) -> Self {
        Self {
            typed: Mutex::new(token.into()),
            checked: Mutex::new(checked),
            use_evaluate: true,
            ..Default::default()
        }
    }
    fn cancel() -> Self {
        Self {
            force: Mutex::new(Some(Err(CloudCustodyError::ConfirmationCancelled))),
            ..Default::default()
        }
    }
}

impl CloudCustodyConfirmer for MockConfirmer {
    fn confirm(&self, prompt: &CloudConfirmPrompt) -> Result<(), CloudCustodyError> {
        *self.calls.lock().unwrap() += 1;
        *self.last_prompt.lock().unwrap() = Some(prompt.clone());
        if let Some(r) = self.force.lock().unwrap().clone() {
            return r;
        }
        if self.use_evaluate {
            return evaluate_confirmation(
                &prompt.required_token,
                self.typed.lock().unwrap().as_str(),
                prompt.require_ack_checkbox,
                *self.checked.lock().unwrap(),
            );
        }
        Ok(())
    }
}

#[derive(Default)]
struct MockHttp {
    steps: Mutex<Vec<&'static str>>,
    bearers: Mutex<Vec<String>>,
    bodies: Mutex<Vec<String>>,
    meta: Mutex<Option<CredentialPublicMeta>>,
    intent_id: Mutex<String>,
    fail_at: Mutex<Option<&'static str>>,
    http_calls: AtomicUsize,
    /// If set, invoked at start of create_intent (session race).
    on_intent: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl MockHttp {
    fn with_meta(meta: CredentialPublicMeta) -> Self {
        Self {
            meta: Mutex::new(Some(meta)),
            intent_id: Mutex::new("intent-1".into()),
            ..Default::default()
        }
    }
    fn call_count(&self) -> usize {
        self.http_calls.load(Ordering::SeqCst)
    }
}

impl CloudCustodyHttp for MockHttp {
    fn fetch_credential_meta(
        &self,
        credential_id: &str,
        bearer: &str,
    ) -> Result<CredentialPublicMeta, CloudCustodyError> {
        self.http_calls.fetch_add(1, Ordering::SeqCst);
        self.steps.lock().unwrap().push("meta");
        self.bearers.lock().unwrap().push(bearer.to_string());
        if self.fail_at.lock().unwrap().as_deref() == Some("meta") {
            return Err(CloudCustodyError::MetadataFailed);
        }
        let mut m = self
            .meta
            .lock()
            .unwrap()
            .clone()
            .ok_or(CloudCustodyError::MetadataFailed)?;
        m.credential_id = credential_id.to_string();
        Ok(m)
    }

    fn create_intent(
        &self,
        _credential_id: &str,
        action: CloudCustodyAction,
        fingerprint: &str,
        bearer: &str,
    ) -> Result<String, CloudCustodyError> {
        if let Some(f) = self.on_intent.lock().unwrap().as_ref() {
            f();
        }
        self.http_calls.fetch_add(1, Ordering::SeqCst);
        self.steps.lock().unwrap().push("intent");
        self.bearers.lock().unwrap().push(bearer.to_string());
        self.bodies.lock().unwrap().push(format!(
            "action={} fp={}",
            action.as_api_str(),
            fingerprint
        ));
        if self.fail_at.lock().unwrap().as_deref() == Some("intent") {
            return Err(CloudCustodyError::IntentFailed);
        }
        Ok(self.intent_id.lock().unwrap().clone())
    }

    fn consume_upload(
        &self,
        _credential_id: &str,
        intent_id: &str,
        ssh_private_key: &str,
        fingerprint: &str,
        bearer: &str,
    ) -> Result<(), CloudCustodyError> {
        self.http_calls.fetch_add(1, Ordering::SeqCst);
        self.steps.lock().unwrap().push("consume_upload");
        self.bearers.lock().unwrap().push(bearer.to_string());
        self.bodies.lock().unwrap().push(format!(
            "intent={intent_id} fp={fingerprint} pem_len={} has_begin={}",
            ssh_private_key.len(),
            ssh_private_key.contains("BEGIN OPENSSH PRIVATE KEY")
        ));
        assert!(!ssh_private_key.to_ascii_lowercase().contains("blabla"));
        assert!(ssh_private_key.contains("BEGIN OPENSSH PRIVATE KEY"));
        if self.fail_at.lock().unwrap().as_deref() == Some("consume") {
            return Err(CloudCustodyError::ConsumeFailed);
        }
        Ok(())
    }

    fn consume_delete(
        &self,
        _credential_id: &str,
        intent_id: &str,
        fingerprint: &str,
        bearer: &str,
    ) -> Result<(), CloudCustodyError> {
        self.http_calls.fetch_add(1, Ordering::SeqCst);
        self.steps.lock().unwrap().push("consume_delete");
        self.bearers.lock().unwrap().push(bearer.to_string());
        self.bodies
            .lock()
            .unwrap()
            .push(format!("intent={intent_id} fp={fingerprint}"));
        if self.fail_at.lock().unwrap().as_deref() == Some("consume") {
            return Err(CloudCustodyError::ConsumeFailed);
        }
        Ok(())
    }
}

struct FixedLeaseSource {
    pem: String,
    fingerprint: String,
    passphrase: Option<String>,
    fail: bool,
}

impl CloudLeaseSource for FixedLeaseSource {
    fn lease_for_upload(
        &self,
        auth: &AuthStore,
        principal: &crate::auth::NativePrincipal,
        epoch: u64,
        credential_id: &str,
    ) -> Result<VaultCredentialLease, CloudCustodyError> {
        if self.fail {
            return Err(CloudCustodyError::VaultFailed);
        }
        if !auth.session_binding_current(principal, epoch) {
            return Err(CloudCustodyError::Unauthenticated);
        }
        Ok(VaultCredentialLease {
            credential_id: credential_id.into(),
            fingerprint: self.fingerprint.clone(),
            pem: Zeroizing::new(self.pem.clone()),
            passphrase: self.passphrase.as_ref().map(|p| Zeroizing::new(p.clone())),
        })
    }
}

fn sample_meta_no_cloud() -> CredentialPublicMeta {
    CredentialPublicMeta {
        credential_id: "cred-1".into(),
        fingerprint: "SHA256:abc".into(),
        environment: ENV_TEST.into(),
        storage_mode: "simple_managed".into(),
        cloud_present: false,
    }
}

fn sample_meta_with_cloud() -> CredentialPublicMeta {
    CredentialPublicMeta {
        credential_id: "cred-1".into(),
        fingerprint: "SHA256:abc".into(),
        environment: ENV_TEST.into(),
        storage_mode: "simple_managed".into(),
        cloud_present: true,
    }
}

fn authed() -> AuthStore {
    let a = AuthStore::new();
    a.install_session_for_tests("tenant-a", "user-a", "admin");
    a
}

// ─── Metadata parse ──────────────────────────────────────────────────────────

#[test]
fn cloud_upload_parse_production_list_json_environments_and_cloud_flag() {
    for (env, has_cloud) in [
        ("test", false),
        ("staging", false),
        ("production", true),
        ("unknown", false),
    ] {
        let body = format!(
            r#"{{"items":[{{"id":"cred-1","fingerprint":"SHA256:fp1","environment_classification":"{env}","has_cloud_secret":{has_cloud},"storage_mode":"simple_managed","name":"prod-named-but-ignored"}}],"total":1}}"#
        );
        let meta = parse_credentials_list_body(body.as_bytes(), "cred-1").unwrap();
        assert_eq!(meta.environment, env);
        assert_eq!(meta.cloud_present, has_cloud);
        assert_eq!(meta.fingerprint, "SHA256:fp1");
        // Must not infer from name "prod-named-but-ignored"
        if env == "test" {
            assert_ne!(meta.environment, "production");
        }
    }
    // deleted cloud secret
    let deleted = r#"{"items":[{"id":"cred-1","fingerprint":"SHA256:fp1","environment_classification":"production","has_cloud_secret":false,"storage_mode":"simple_managed"}],"total":1}"#;
    let meta = parse_credentials_list_body(deleted.as_bytes(), "cred-1").unwrap();
    assert!(!meta.cloud_present);
    // invalid enum
    let bad = r#"{"items":[{"id":"cred-1","fingerprint":"SHA256:fp1","environment_classification":"dev","has_cloud_secret":false}],"total":1}"#;
    assert!(parse_credentials_list_body(bad.as_bytes(), "cred-1").is_err());
    // missing has_cloud_secret
    let miss = r#"{"items":[{"id":"cred-1","fingerprint":"SHA256:fp1","environment_classification":"test"}],"total":1}"#;
    assert!(parse_credentials_list_body(miss.as_bytes(), "cred-1").is_err());
    // camelCase fallback
    let camel = r#"{"items":[{"credentialId":"cred-1","fingerprint":"SHA256:fp1","environmentClassification":"staging","hasCloudSecret":true}],"total":1}"#;
    let m = parse_credentials_list_body(camel.as_bytes(), "cred-1").unwrap();
    assert_eq!(m.environment, "staging");
    assert!(m.cloud_present);
    // local-only: fingerprint null is allowed
    let local_null = r#"{"items":[{"id":"cred-1","fingerprint":null,"environment_classification":"production","has_cloud_secret":false,"storage_mode":"simple_managed"}],"total":1}"#;
    let m = parse_credentials_list_body(local_null.as_bytes(), "cred-1").unwrap();
    assert!(!m.cloud_present);
    assert!(m.fingerprint.is_empty());
    assert_eq!(m.environment, ENV_PRODUCTION);
    // empty string fingerprint also allowed
    let local_empty = r#"{"items":[{"id":"cred-1","fingerprint":"","environment_classification":"test","has_cloud_secret":false}],"total":1}"#;
    assert!(
        parse_credentials_list_body(local_empty.as_bytes(), "cred-1")
            .unwrap()
            .fingerprint
            .is_empty()
    );
    // non-string non-null fingerprint fails
    let bad_fp = r#"{"items":[{"id":"cred-1","fingerprint":123,"environment_classification":"test","has_cloud_secret":false}],"total":1}"#;
    assert!(matches!(
        parse_credentials_list_body(bad_fp.as_bytes(), "cred-1"),
        Err(CloudCustodyError::MetadataFailed)
    ));
}

#[test]
fn cloud_upload_local_only_null_fingerprint_reaches_lease_and_sends_lease_fp() {
    let auth = authed();
    let meta = CredentialPublicMeta {
        credential_id: "cred-1".into(),
        fingerprint: String::new(), // public null
        environment: ENV_PRODUCTION.into(),
        storage_mode: "simple_managed".into(),
        cloud_present: false,
    };
    // Prove production-shaped JSON with null fingerprint parses first.
    let body = r#"{"items":[{"id":"cred-1","fingerprint":null,"environment_classification":"production","has_cloud_secret":false,"storage_mode":"simple_managed"}],"total":1}"#;
    let parsed = parse_credentials_list_body(body.as_bytes(), "cred-1").unwrap();
    assert!(parsed.fingerprint.is_empty());
    assert!(!parsed.cloud_present);

    let http = MockHttp::with_meta(meta);
    let conf = MockConfirmer::accept_exact(UPLOAD_TOKEN, true);
    let lease = FixedLeaseSource {
        pem: ED25519_ENCRYPTED_PEM.into(),
        fingerprint: "SHA256:from-lease".into(),
        passphrase: Some("blabla".into()),
        fail: false,
    };
    let mut steps = Vec::new();
    let resp = perform_cloud_upload(&auth, &lease, &http, &conf, "cred-1", &mut steps).unwrap();
    assert!(resp.ok);
    assert!(steps.contains(&CloudUploadStep::Confirm));
    assert!(steps.contains(&CloudUploadStep::Lease));
    assert!(steps.contains(&CloudUploadStep::Intent));
    assert!(steps.contains(&CloudUploadStep::Consume));
    let bodies = http.bodies.lock().unwrap().clone();
    assert!(
        bodies.iter().any(|b| b.contains("fp=SHA256:from-lease")),
        "upload must send lease fingerprint, got {bodies:?}"
    );
    // Intent body records action + lease fp only (not empty public meta fp).
    assert!(
        bodies
            .iter()
            .any(|b| b.starts_with("action=upload") && b.contains("from-lease")),
        "intent must use lease fingerprint, got {bodies:?}"
    );
}

#[test]
fn cloud_upload_delete_cloud_present_null_fingerprint_fails_before_confirm() {
    let auth = authed();
    let meta = CredentialPublicMeta {
        credential_id: "cred-1".into(),
        fingerprint: String::new(),
        environment: ENV_PRODUCTION.into(),
        storage_mode: "simple_managed".into(),
        cloud_present: true,
    };
    let body = r#"{"items":[{"id":"cred-1","fingerprint":null,"environment_classification":"production","has_cloud_secret":true}],"total":1}"#;
    let parsed = parse_credentials_list_body(body.as_bytes(), "cred-1").unwrap();
    assert!(parsed.cloud_present);
    assert!(parsed.fingerprint.is_empty());

    let http = MockHttp::with_meta(meta);
    let conf = MockConfirmer::accept_exact(DELETE_TOKEN, false);
    let mut steps = Vec::new();
    let err = perform_cloud_delete(&auth, &http, &conf, "cred-1", &mut steps);
    assert!(matches!(err, Err(CloudCustodyError::MetadataFailed)));
    assert_eq!(*http.steps.lock().unwrap(), vec!["meta"]);
    assert!(!steps.contains(&CloudDeleteStep::Confirm));
    assert!(!steps.contains(&CloudDeleteStep::Intent));
    assert_eq!(*conf.calls.lock().unwrap(), 0);
}

// ─── DTO / confirmation ──────────────────────────────────────────────────────

#[test]
fn cloud_upload_dto_strict_credential_id_only() {
    let ok: CloudUploadRequest = serde_json::from_str(r#"{"credentialId":"c1"}"#).unwrap();
    assert_eq!(ok.credential_id, "c1");
    assert!(
        serde_json::from_str::<CloudUploadRequest>(r#"{"credentialId":"c1","pem":"x"}"#).is_err()
    );
    assert!(
        serde_json::from_str::<CloudDeleteRequest>(r#"{"credentialId":"c1","tenantId":"t"}"#)
            .is_err()
    );
}

#[test]
fn cloud_upload_confirmation_exact_token_no_surrounding_whitespace() {
    assert!(evaluate_confirmation(UPLOAD_TOKEN, "UPLOAD", true, true).is_ok());
    for bad in [
        " UPLOAD", "UPLOAD ", "\nUPLOAD", "UPLOAD\n", " upload", "UPLOAD\t",
    ] {
        assert!(
            matches!(
                evaluate_confirmation(UPLOAD_TOKEN, bad, true, true),
                Err(CloudCustodyError::ConfirmationRejected)
            ),
            "must reject {bad:?}"
        );
    }
    assert!(matches!(
        evaluate_confirmation(UPLOAD_TOKEN, "UPLOAD", true, false),
        Err(CloudCustodyError::ConfirmationRejected)
    ));
    assert!(evaluate_confirmation(DELETE_TOKEN, "DELETE CLOUD", false, false).is_ok());
    for bad in [
        " DELETE CLOUD",
        "DELETE CLOUD ",
        "\nDELETE CLOUD",
        "DELETE CLOUD\n",
        "delete cloud",
        "DELETE",
    ] {
        assert!(
            matches!(
                evaluate_confirmation(DELETE_TOKEN, bad, false, false),
                Err(CloudCustodyError::ConfirmationRejected)
            ),
            "must reject {bad:?}"
        );
    }
}

#[test]
fn cloud_upload_warnings_and_checkbox_copy_design_fixed() {
    assert_eq!(
        UPLOAD_CHECKBOX_LABEL,
        "我理解私钥将离开本机，并授权云端在我的租户内用于自动化运维。"
    );
    let t = upload_warning_body(ENV_TEST);
    assert!(t.contains("非生产") || t.contains("测试"));
    let p = upload_warning_body(ENV_PRODUCTION);
    assert!(p.contains("仅本机") || p.contains("生产"));
    assert!(p.contains("自动化"));
    let u = upload_warning_body(ENV_UNKNOWN);
    assert!(u.contains("仅本机") || u.contains("未知"));
    let d = delete_warning_body(ENV_PRODUCTION);
    assert!(d.contains("DELETE CLOUD"));
    assert_eq!(UPLOAD_DIALOG_TITLE, "确认上传私钥到云端");
    assert_eq!(DELETE_DIALOG_TITLE, "确认删除云端托管密钥");
}

#[test]
fn cloud_upload_cancel_performs_zero_intent_network() {
    let auth = authed();
    let http = MockHttp::with_meta(sample_meta_no_cloud());
    let conf = MockConfirmer::cancel();
    let lease = FixedLeaseSource {
        pem: ED25519_ENCRYPTED_PEM.into(),
        fingerprint: "SHA256:x".into(),
        passphrase: Some("blabla".into()),
        fail: false,
    };
    let mut steps = Vec::new();
    let err = perform_cloud_upload(&auth, &lease, &http, &conf, "cred-1", &mut steps);
    assert!(matches!(err, Err(CloudCustodyError::ConfirmationCancelled)));
    assert_eq!(*http.steps.lock().unwrap(), vec!["meta"]);
    assert!(!steps.contains(&CloudUploadStep::Intent));
}

#[test]
fn cloud_upload_rejects_existing_cloud_secret() {
    let auth = authed();
    let http = MockHttp::with_meta(sample_meta_with_cloud());
    let conf = MockConfirmer::accept_exact(UPLOAD_TOKEN, true);
    let lease = FixedLeaseSource {
        pem: ED25519_ENCRYPTED_PEM.into(),
        fingerprint: "SHA256:x".into(),
        passphrase: Some("blabla".into()),
        fail: false,
    };
    let mut steps = Vec::new();
    let err = perform_cloud_upload(&auth, &lease, &http, &conf, "cred-1", &mut steps);
    assert!(matches!(
        err,
        Err(CloudCustodyError::CloudSecretAlreadyPresent)
    ));
    assert_eq!(*http.steps.lock().unwrap(), vec!["meta"]);
    assert!(!steps.contains(&CloudUploadStep::Confirm));
}

#[test]
fn cloud_upload_delete_rejects_absent_cloud_secret() {
    let auth = authed();
    let http = MockHttp::with_meta(sample_meta_no_cloud());
    let conf = MockConfirmer::accept_exact(DELETE_TOKEN, false);
    let mut steps = Vec::new();
    let err = perform_cloud_delete(&auth, &http, &conf, "cred-1", &mut steps);
    assert!(matches!(err, Err(CloudCustodyError::CloudSecretAbsent)));
    assert_eq!(*http.steps.lock().unwrap(), vec!["meta"]);
    assert!(!steps.contains(&CloudDeleteStep::Confirm));
}

// ─── PEM normalization ───────────────────────────────────────────────────────

#[test]
fn cloud_upload_encrypted_pem_normalized_without_passphrase() {
    let norm = normalize_pem_for_cloud_upload(ED25519_ENCRYPTED_PEM, Some("blabla")).unwrap();
    assert!(norm.contains("BEGIN OPENSSH PRIVATE KEY"));
    assert!(decode_secret_key(norm.as_str(), None).is_ok());
    assert!(decode_secret_key(ED25519_ENCRYPTED_PEM, None).is_err());
    assert!(!norm.as_str().to_ascii_lowercase().contains("blabla"));
}

#[test]
fn cloud_upload_consume_body_borrows_secret_no_passphrase_field() {
    let pem = Zeroizing::new(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nTEST\n-----END OPENSSH PRIVATE KEY-----\n"
            .to_string(),
    );
    let body = CloudUploadConsumeBody {
        intent_id: "intent-1",
        ssh_private_key: pem.as_str(),
        fingerprint: "SHA256:fp",
    };
    let s = serde_json::to_string(&body).unwrap();
    assert!(s.contains("\"ssh_private_key\""));
    assert!(s.contains("BEGIN OPENSSH PRIVATE KEY"));
    assert!(!s.contains("passphrase"));
    assert!(!s.contains("blabla"));
    // Structural: only three keys
    let v: serde_json::Value = serde_json::from_str(&s).unwrap();
    let obj = v.as_object().unwrap();
    assert_eq!(obj.len(), 3);
    assert!(obj.contains_key("intent_id"));
    assert!(obj.contains_key("ssh_private_key"));
    assert!(obj.contains_key("fingerprint"));
}

// ─── Upload success order ────────────────────────────────────────────────────

#[test]
fn cloud_upload_success_order_confirm_lease_intent_consume_same_bearer() {
    let auth = authed();
    let http = MockHttp::with_meta(sample_meta_no_cloud());
    let conf = MockConfirmer::accept_exact(UPLOAD_TOKEN, true);
    let lease = FixedLeaseSource {
        pem: ED25519_ENCRYPTED_PEM.into(),
        fingerprint: "SHA256:lease-fp".into(),
        passphrase: Some("blabla".into()),
        fail: false,
    };
    let mut steps = Vec::new();
    let resp = perform_cloud_upload(&auth, &lease, &http, &conf, "cred-1", &mut steps).unwrap();
    assert!(resp.ok);
    assert_eq!(resp.custody_state, "uploaded");
    assert_eq!(
        steps,
        vec![
            CloudUploadStep::PreflightMeta,
            CloudUploadStep::Confirm,
            CloudUploadStep::Lease,
            CloudUploadStep::NormalizePem,
            CloudUploadStep::Intent,
            CloudUploadStep::Consume,
        ]
    );
    assert_eq!(
        *http.steps.lock().unwrap(),
        vec!["meta", "intent", "consume_upload"]
    );
    let bearers = http.bearers.lock().unwrap().clone();
    assert_eq!(bearers[1], bearers[2]);
    let prompt = conf.last_prompt.lock().unwrap().clone().unwrap();
    assert_eq!(prompt.title, UPLOAD_DIALOG_TITLE);
    assert_eq!(prompt.checkbox_label, UPLOAD_CHECKBOX_LABEL);
}

// ─── Delete without local vault ──────────────────────────────────────────────

#[test]
fn cloud_upload_delete_success_without_local_vault() {
    let auth = authed();
    let http = MockHttp::with_meta(sample_meta_with_cloud());
    let conf = MockConfirmer::accept_exact(DELETE_TOKEN, false);
    let mut steps = Vec::new();
    let resp = perform_cloud_delete(&auth, &http, &conf, "cred-1", &mut steps).unwrap();
    assert!(resp.ok);
    assert_eq!(resp.custody_state, "deleted");
    assert_eq!(
        *http.steps.lock().unwrap(),
        vec!["meta", "intent", "consume_delete"]
    );
    let bearers = http.bearers.lock().unwrap().clone();
    assert_eq!(bearers[1], bearers[2]);
}

#[test]
fn cloud_upload_session_race_during_intent_skips_consume() {
    use std::sync::Arc;
    // Upload path
    {
        let auth = Arc::new(authed());
        let http = MockHttp::with_meta(sample_meta_no_cloud());
        let auth_c = Arc::clone(&auth);
        *http.on_intent.lock().unwrap() = Some(Box::new(move || {
            let _ = auth_c.clear_native();
        }));
        let conf = MockConfirmer::accept_exact(UPLOAD_TOKEN, true);
        let lease = FixedLeaseSource {
            pem: ED25519_ENCRYPTED_PEM.into(),
            fingerprint: "SHA256:lease-fp".into(),
            passphrase: Some("blabla".into()),
            fail: false,
        };
        let mut steps = Vec::new();
        let err = perform_cloud_upload(auth.as_ref(), &lease, &http, &conf, "cred-1", &mut steps);
        assert!(matches!(err, Err(CloudCustodyError::Unauthenticated)));
        assert!(http.steps.lock().unwrap().contains(&"intent"));
        assert!(!http.steps.lock().unwrap().contains(&"consume_upload"));
    }
    // Delete path
    {
        let auth = Arc::new(authed());
        let http = MockHttp::with_meta(sample_meta_with_cloud());
        let auth_c = Arc::clone(&auth);
        *http.on_intent.lock().unwrap() = Some(Box::new(move || {
            let _ = auth_c.clear_native();
        }));
        let conf = MockConfirmer::accept_exact(DELETE_TOKEN, false);
        let mut steps = Vec::new();
        let err = perform_cloud_delete(auth.as_ref(), &http, &conf, "cred-1", &mut steps);
        assert!(matches!(err, Err(CloudCustodyError::Unauthenticated)));
        assert!(http.steps.lock().unwrap().contains(&"intent"));
        assert!(!http.steps.lock().unwrap().contains(&"consume_delete"));
    }
}

#[test]
fn cloud_upload_epoch_mismatch_after_confirm_stops_before_intent() {
    let auth = authed();
    let http = MockHttp::with_meta(sample_meta_with_cloud());
    struct EpochBustConfirmer<'a> {
        auth: &'a AuthStore,
    }
    impl CloudCustodyConfirmer for EpochBustConfirmer<'_> {
        fn confirm(&self, _prompt: &CloudConfirmPrompt) -> Result<(), CloudCustodyError> {
            let _ = self.auth.clear_native();
            Ok(())
        }
    }
    let conf = EpochBustConfirmer { auth: &auth };
    let mut steps = Vec::new();
    let err = perform_cloud_delete(&auth, &http, &conf, "cred-1", &mut steps);
    assert!(matches!(err, Err(CloudCustodyError::Unauthenticated)));
    assert!(!http.steps.lock().unwrap().contains(&"intent"));
}

#[test]
fn cloud_upload_http_failure_on_intent() {
    let auth = authed();
    let http = MockHttp::with_meta(sample_meta_with_cloud());
    *http.fail_at.lock().unwrap() = Some("intent");
    let conf = MockConfirmer::accept_exact(DELETE_TOKEN, false);
    let mut steps = Vec::new();
    let err = perform_cloud_delete(&auth, &http, &conf, "cred-1", &mut steps);
    assert!(matches!(err, Err(CloudCustodyError::IntentFailed)));
    assert!(!http.steps.lock().unwrap().contains(&"consume_delete"));
}

#[test]
fn cloud_upload_user_messages_secret_free() {
    for e in [
        CloudCustodyError::Unauthenticated,
        CloudCustodyError::ConsumeFailed,
        CloudCustodyError::CloudSecretAlreadyPresent,
        CloudCustodyError::CloudSecretAbsent,
    ] {
        let m = e.user_message();
        assert!(!m.is_empty());
        assert!(!m.contains("pem"));
        assert!(!m.contains("Bearer"));
        assert_ne!(m, format!("{e:?}"));
    }
}

#[test]
fn cloud_upload_urls_https_and_paths() {
    let u = intents_url("cred-x").unwrap();
    assert!(u.starts_with("https://"));
    assert!(u.contains("/intents"));
    assert!(cloud_secret_url("cred-x")
        .unwrap()
        .contains("/cloud-secret"));
}

#[test]
fn cloud_upload_commands_registered_in_lib() {
    let raw = include_str!("lib.rs");
    assert!(raw.contains("request_cloud_upload"));
    assert!(raw.contains("request_cloud_delete"));
    assert!(raw.contains("mod upload"));
    assert!(raw.contains("spawn_blocking"));
}
