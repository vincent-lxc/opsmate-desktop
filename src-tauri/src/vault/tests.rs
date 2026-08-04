//! Task 8A1 vault core tests.
//! Default `cargo test` stays fast; production-Argon2 reopen is `#[ignore]`.

use super::*;
use crate::auth::{AuthBinding, AuthStore};
use crate::secure_prompt::{PromptError, SecurePrompt};
use sha2::{Digest, Sha256};
use std::sync::Mutex as StdMutex;
use std::time::Instant;
use zeroize::Zeroizing;

// Encrypted OpenSSH Ed25519 fixture (russh-keys tests); passphrase = "blabla".
const ED25519_ENCRYPTED_PEM: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jYmMAAAAGYmNyeXB0AAAAGAAAABDLGyfA39
J2FcJygtYqi5ISAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIN+Wjn4+4Fcvl2Jl
KpggT+wCRxpSvtqqpVrQrKN1/A22AAAAkOHDLnYZvYS6H9Q3S3Nk4ri3R2jAZlQlBbUos5
FkHpYgNw65KCWCTXtP7ye2czMC3zjn2r98pJLobsLYQgRiHIv/CUdAdsqbvMPECB+wl/UQ
e+JpiSq66Z6GIt0801skPh20jxOO3F52SoX1IeO5D5PXfZrfSZlw6S8c7bwyp2FHxDewRx
7/wNsnDM0T7nLv/Q==
-----END OPENSSH PRIVATE KEY-----";

/// Optional mid-prompt hook: runs between PEM selection and passphrase (or at passphrase).
struct MockPrompt {
    passphrase: StdMutex<Option<String>>,
    pem: StdMutex<String>,
    cancel_choose: StdMutex<bool>,
    cancel_passphrase: StdMutex<bool>,
    /// Invoked once from `choose_pem_import` after PEM is chosen (simulates auth switch during prompt).
    on_after_pem: StdMutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl MockPrompt {
    fn with_pem(pem: &str) -> Self {
        Self {
            passphrase: StdMutex::new(None),
            pem: StdMutex::new(pem.into()),
            cancel_choose: StdMutex::new(false),
            cancel_passphrase: StdMutex::new(false),
            on_after_pem: StdMutex::new(None),
        }
    }

    fn with_auth_switch_after_pem(pem: &str, switch: impl FnOnce() + Send + 'static) -> Self {
        let p = Self::with_pem(pem);
        *p.on_after_pem.lock().unwrap() = Some(Box::new(switch));
        p
    }
}

impl SecurePrompt for MockPrompt {
    fn prompt_password(
        &self,
        _title: &str,
        _message: &str,
    ) -> Result<Zeroizing<String>, PromptError> {
        Ok(Zeroizing::new("unused".into()))
    }
    fn prompt_passphrase(
        &self,
        _title: &str,
        _message: &str,
    ) -> Result<Option<Zeroizing<String>>, PromptError> {
        if *self.cancel_passphrase.lock().unwrap() {
            return Err(PromptError::Cancelled);
        }
        Ok(self
            .passphrase
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| Zeroizing::new(s.clone())))
    }
    fn pick_pem_file(&self) -> Result<Option<std::path::PathBuf>, PromptError> {
        Ok(None)
    }
    fn prompt_pem_paste(&self, _title: &str) -> Result<Zeroizing<String>, PromptError> {
        Ok(Zeroizing::new(self.pem.lock().unwrap().clone()))
    }
    fn choose_pem_import(&self) -> Result<Zeroizing<String>, PromptError> {
        if *self.cancel_choose.lock().unwrap() {
            return Err(PromptError::Cancelled);
        }
        let pem = self.prompt_pem_paste("paste")?;
        if let Some(hook) = self.on_after_pem.lock().unwrap().take() {
            hook();
        }
        Ok(pem)
    }
}

fn temp_snapshot() -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "opsmate-vault-8a1-{}-{}.hold",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    p
}

fn cleanup(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(salt_path(path));
}

fn authed(tenant: &str, username: &str, subject: &str) -> AuthStore {
    let a = AuthStore::new();
    a.install_session_for_tests(tenant, username, "admin", subject);
    a
}

fn binding_of(auth: &AuthStore) -> AuthBinding {
    auth.auth_binding().expect("auth binding")
}

fn seed_client_with_index(sh: &Stronghold) {
    sh.create_client(CLIENT_PATH).expect("create client");
    let client = sh.get_client(CLIENT_PATH).expect("get client");
    client
        .store()
        .insert(
            INDEX_KEY.to_vec(),
            serde_json::to_vec(&CredentialIndex::default()).unwrap(),
            None,
        )
        .expect("seed index");
}

// ─── Pure unit tests ─────────────────────────────────────────────────────────

#[test]
fn vault_starts_locked_not_initialized() {
    let path = temp_snapshot();
    let v = VaultService::new(path.clone());
    let st = v.status().unwrap();
    assert!(!st.unlocked);
    assert_eq!(st.locked_reason.as_deref(), Some("not_initialized"));
    cleanup(&path);
}

#[test]
fn vault_argon2_different_salts_yield_different_keys() {
    let salt_a = [1u8; SALT_LEN];
    let salt_b = [2u8; SALT_LEN];
    let cfg = test_only_argon2_config();
    let k_a = derive_vault_key_with_config("same-password", &salt_a, &cfg).unwrap();
    let k_b = derive_vault_key_with_config("same-password", &salt_b, &cfg).unwrap();
    assert_ne!(k_a, k_b);
    assert_eq!(k_a.len(), 32);
}

#[test]
fn vault_production_argon2_is_not_weakened() {
    let c = production_argon2_config();
    assert_eq!(c.mem_cost, 19 * 1024);
    assert_eq!(c.time_cost, 2);
    assert_eq!(c.variant, argon2::Variant::Argon2id);
    assert_eq!(c.hash_length, 32);
}

#[test]
fn vault_strict_validate_id_rejects_smuggling() {
    assert!(validate_id("ok-id_1.x").is_ok());
    assert!(validate_id("").is_err());
    assert!(validate_id("a/b").is_err());
    assert!(validate_id("..").is_err());
    assert!(validate_id(".hidden").is_err());
    assert!(validate_id("has space").is_err());
    assert!(validate_id(&"x".repeat(129)).is_err());
}

#[test]
fn vault_namespace_uses_subject_not_username() {
    // Same username, different subjects → isolated keys.
    let k1 = make_key("ten-1", "sub-alice", "cred").unwrap();
    let k2 = make_key("ten-1", "sub-bob", "cred").unwrap();
    assert_ne!(k1, k2);
    // Same subject, different tenants → isolated.
    let k3 = make_key("ten-a", "sub-same", "cred").unwrap();
    let k4 = make_key("ten-b", "sub-same", "cred").unwrap();
    assert_ne!(k3, k4);
    // Encoding avoids separator collision.
    let c1 = make_key("a/b", "c", "cred").unwrap();
    let c2 = make_key("a", "b/c", "cred").unwrap();
    assert_ne!(c1, c2);
    // Raw subject not embedded when it would collide path-wise.
    let k = make_key("ten-1", "user@example.com", "cred-1").unwrap();
    assert!(!k.contains("user@example.com"));
    assert!(k.ends_with("/cred-1"));
}

#[test]
fn vault_dto_unknown_fields_rejected() {
    assert!(serde_json::from_str::<VaultImportRequest>(r#"{"credentialId":"c"}"#).is_ok());
    for bad in [
        r#"{"credentialId":"c","tenantId":"evil"}"#,
        r#"{"credentialId":"c","subject":"evil"}"#,
        r#"{"credentialId":"c","userId":"evil"}"#,
        r#"{"credentialId":"c","fromFile":true}"#,
        r#"{"credentialId":"c","pem":"x"}"#,
        r#"{"credentialId":"c","passphrase":"x"}"#,
        r#"{"credentialId":"c","snapshotPath":"/tmp/x"}"#,
    ] {
        assert!(
            serde_json::from_str::<VaultImportRequest>(bad).is_err(),
            "must reject: {bad}"
        );
    }
    assert!(serde_json::from_str::<VaultDeleteLocalRequest>(
        r#"{"credentialId":"c","tenantId":"x"}"#
    )
    .is_err());
}

#[test]
fn vault_status_exposes_only_unlocked_and_locked_reason() {
    let locked = VaultStatus {
        unlocked: false,
        locked_reason: Some("not_initialized".into()),
    };
    let o = serde_json::to_value(&locked).unwrap();
    let keys: Vec<_> = o.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys.len(), 2);
    assert!(keys.contains(&"unlocked".to_string()));
    assert!(keys.contains(&"lockedReason".to_string()));
}

#[test]
fn vault_russh_fingerprint_encrypted_ed25519_fixture() {
    assert!(matches!(
        fingerprint_from_pem(ED25519_ENCRYPTED_PEM, None),
        Err(VaultError::InvalidPrivateKey)
    ));
    let fp = fingerprint_from_pem(ED25519_ENCRYPTED_PEM, Some("blabla")).unwrap();
    assert!(fp.starts_with("SHA256:"));
    assert!(!fp.contains("BEGIN"));
    let text_digest = hex::encode(Sha256::digest(ED25519_ENCRYPTED_PEM.as_bytes()));
    assert!(!fp.contains(&text_digest));
}

#[test]
fn vault_macos_secure_prompt_cfg_compiles() {
    let _ = crate::secure_prompt::macos_secure_types_linked();
    #[cfg(target_os = "macos")]
    assert!(crate::secure_prompt::macos_secure_types_linked());
}

#[test]
fn vault_lease_and_stored_not_serialize_clone_in_source() {
    let src = include_str!("mod.rs");
    let lease_region = src
        .split("pub struct VaultCredentialLease")
        .nth(1)
        .unwrap()
        .split("impl std::fmt::Debug for VaultCredentialLease")
        .next()
        .unwrap();
    assert!(!lease_region.contains("Serialize"));
    assert!(!lease_region.contains("Clone"));
    // StoredCredential must not derive Clone.
    let stored = src
        .split("struct StoredCredential")
        .nth(1)
        .unwrap()
        .split("impl Drop for StoredCredential")
        .next()
        .unwrap();
    assert!(!stored.contains("Clone"));
}

#[test]
fn vault_named_ipc_only_no_stronghold_plugin() {
    let lib = include_str!("../lib.rs");
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
        assert!(prod.contains(name), "8A2A registers named command {name}");
    }
    assert!(prod.contains("pub mod vault"));
    assert!(prod.contains("pub mod secure_prompt"));
    // No Stronghold plugin registration in production run/setup (library use only).
    let setup = prod
        .split("pub fn run()")
        .nth(1)
        .unwrap_or(prod)
        .split("invoke_handler")
        .next()
        .unwrap_or("");
    assert!(
        !setup.contains("stronghold::init"),
        "must not register Stronghold plugin"
    );
}

#[test]
fn vault_capability_has_no_stronghold() {
    let cap = include_str!("../../capabilities/default.json");
    assert!(!cap.contains("stronghold:"));
    assert!(cap.contains("core:default"));
}

// ─── Auth / principal / locked ───────────────────────────────────────────────

#[test]
fn vault_unauthenticated_rejected_without_stronghold() {
    let path = temp_snapshot();
    let v = VaultService::new(path.clone());
    let unauth = AuthStore::new();
    assert!(matches!(
        v.unlock_with_password(&unauth, Zeroizing::new("pw".into())),
        Err(VaultError::Unauthenticated)
    ));
    assert!(matches!(
        v.list_meta(&unauth),
        Err(VaultError::Unauthenticated)
    ));
    cleanup(&path);
}

#[test]
fn vault_prompt_cancel_zero_write() {
    let path = temp_snapshot();
    let auth = authed("ten-1", "alice", "sub-alice");
    let v = VaultService::new(path.clone());
    // Inject unlocked empty vault (no disk Argon2).
    let key = vec![0x50u8; 32];
    let sh = Stronghold::new(&path, key).expect("sh");
    seed_client_with_index(&sh);
    v.test_inject_unlocked(sh, binding_of(&auth), path.clone(), Instant::now());

    let prompt = MockPrompt::with_pem(ED25519_ENCRYPTED_PEM);
    *prompt.cancel_choose.lock().unwrap() = true;
    let req = VaultImportRequest {
        credential_id: "cred-1".into(),
    };
    assert!(matches!(
        v.import_begin_native(&auth, &prompt, &req),
        Err(VaultError::PromptCancelled)
    ));
    // Zero write: index still empty.
    assert!(v.list_meta(&auth).unwrap().is_empty());
    let _ = v.lock();
    cleanup(&path);
}

#[test]
fn vault_invalid_pem_zero_write() {
    let path = temp_snapshot();
    let auth = authed("ten-1", "alice", "sub-alice");
    let v = VaultService::new(path.clone());
    let key = vec![0x51u8; 32];
    let sh = Stronghold::new(&path, key).expect("sh");
    seed_client_with_index(&sh);
    v.test_inject_unlocked(sh, binding_of(&auth), path.clone(), Instant::now());

    let err = v
        .import_pem(&auth, "cred-bad", Zeroizing::new("NOT-A-PEM".into()), None)
        .unwrap_err();
    assert!(matches!(err, VaultError::InvalidPrivateKey));
    assert!(v.list_meta(&auth).unwrap().is_empty());
    let _ = v.lock();
    cleanup(&path);
}

#[test]
fn vault_import_list_delete_isolation_by_subject_and_tenant() {
    let path = temp_snapshot();
    let key = vec![0x52u8; 32];
    let sh = Stronghold::new(&path, key).expect("sh");
    seed_client_with_index(&sh);

    // Same username, different subjects.
    let auth_a = authed("ten-1", "alice", "sub-a");
    let auth_b = authed("ten-1", "alice", "sub-b");
    let v = VaultService::new(path.clone());
    v.test_inject_unlocked(sh, binding_of(&auth_a), path.clone(), Instant::now());

    let resp = v
        .import_pem(
            &auth_a,
            "cred-1",
            Zeroizing::new(ED25519_ENCRYPTED_PEM.into()),
            Some(Zeroizing::new("blabla".into())),
        )
        .unwrap();
    assert!(resp.fingerprint.starts_with("SHA256:"));
    assert_eq!(v.list_meta(&auth_a).unwrap().len(), 1);

    // Subject B (same username) sees sealed principal_changed then locked.
    let err = v.list_meta(&auth_b).unwrap_err();
    assert!(matches!(
        err,
        VaultError::Locked | VaultError::Unauthenticated
    ));
    assert_eq!(
        v.status().unwrap().locked_reason.as_deref(),
        Some("principal_changed")
    );

    // Re-inject for tenant isolation (same subject string, different tenant).
    let path2 = temp_snapshot();
    let sh2 = Stronghold::new(&path2, vec![0x53u8; 32]).expect("sh2");
    seed_client_with_index(&sh2);
    let auth_t1 = authed("ten-x", "bob", "sub-same");
    let auth_t2 = authed("ten-y", "bob", "sub-same");
    let v2 = VaultService::new(path2.clone());
    v2.test_inject_unlocked(sh2, binding_of(&auth_t1), path2.clone(), Instant::now());
    v2.import_pem(
        &auth_t1,
        "cred-t",
        Zeroizing::new(ED25519_ENCRYPTED_PEM.into()),
        Some(Zeroizing::new("blabla".into())),
    )
    .unwrap();
    assert_eq!(v2.list_meta(&auth_t1).unwrap().len(), 1);
    let err = v2.list_meta(&auth_t2).unwrap_err();
    assert!(matches!(
        err,
        VaultError::Locked | VaultError::Unauthenticated
    ));

    // Keys for same username different subjects differ.
    assert_ne!(
        make_key("ten-1", "sub-a", "cred-1").unwrap(),
        make_key("ten-1", "sub-b", "cred-1").unwrap()
    );

    let _ = v.lock();
    let _ = v2.lock();
    cleanup(&path);
    cleanup(&path2);
}

#[test]
fn vault_principal_change_and_auth_missing_fail_closed() {
    let path = temp_snapshot();
    let sh = Stronghold::new(&path, vec![0x54u8; 32]).expect("sh");
    seed_client_with_index(&sh);
    let auth = authed("ten", "u", "sub-1");
    let v = VaultService::new(path.clone());
    v.test_inject_unlocked(sh, binding_of(&auth), path.clone(), Instant::now());
    assert!(v.status().unwrap().unlocked);

    // Clear auth → observe seals with logout.
    let _ = auth.clear_native();
    v.observe_binding(&auth).unwrap();
    assert!(!v.status().unwrap().unlocked);
    assert_eq!(v.status().unwrap().locked_reason.as_deref(), Some("logout"));
    cleanup(&path);
}

#[test]
fn vault_auth_poison_fails_closed_on_binding() {
    let auth = authed("t", "u", "s");
    let p = auth.native_principal().unwrap();
    let epoch = auth.native_auth_snapshot().unwrap().epoch;
    assert!(auth.session_binding_current(&p, epoch));
    auth.poison_lock_for_tests();
    assert!(!auth.session_binding_current(&p, epoch));
}

// ─── Stronghold smoke (no production Argon2) ─────────────────────────────────

#[test]
fn vault_stronghold_client_store_roundtrip_minimal() {
    let path = temp_snapshot();
    let key = vec![0x42u8; 32];
    let sh = Stronghold::new(&path, key).expect("stronghold new");
    sh.create_client(CLIENT_PATH).expect("create client");
    let client = sh.get_client(CLIENT_PATH).expect("get client");
    let payload = b"meta-only-blob".to_vec();
    client
        .store()
        .insert(b"k1".to_vec(), payload.clone(), None)
        .expect("insert");
    let got = client.store().get(b"k1").expect("get").expect("some");
    assert_eq!(got.as_slice(), payload.as_slice());
    cleanup(&path);
}

#[test]
fn vault_lease_for_ssh_happy_path_redacted_and_drop() {
    let path = temp_snapshot();
    let sh = Stronghold::new(&path, vec![0x61u8; 32]).expect("stronghold");
    sh.create_client(CLIENT_PATH).expect("client");
    let auth = authed("ten-lease", "user-lease", "sub-lease");
    let principal = auth.native_principal().unwrap();
    let snap = auth.native_auth_snapshot().unwrap();
    let store_key = make_key(&principal.tenant_id, &principal.subject, "cred-lease").unwrap();
    let mut rec = StoredCredential {
        tenant_id: principal.tenant_id.clone(),
        subject: principal.subject.clone(),
        credential_id: "cred-lease".into(),
        fingerprint: "SHA256:leasefp".into(),
        pem: "-----BEGIN SECRET LEASE PEM-----\n".into(),
        passphrase: Some("secret-pass".into()),
    };
    let bytes = serde_json::to_vec(&rec).unwrap();
    rec.pem.zeroize();
    if let Some(ref mut p) = rec.passphrase {
        p.zeroize();
    }
    let client = sh.get_client(CLIENT_PATH).unwrap();
    client
        .store()
        .insert(store_key.as_bytes().to_vec(), bytes, None)
        .unwrap();
    client
        .store()
        .insert(
            INDEX_KEY.to_vec(),
            serde_json::to_vec(&CredentialIndex {
                entries: vec![store_key],
            })
            .unwrap(),
            None,
        )
        .unwrap();

    let v = VaultService::new(path.clone());
    v.test_inject_unlocked(sh, binding_of(&auth), path.clone(), Instant::now());

    let lease = v
        .lease_for_ssh(&auth, &principal, snap.epoch, "cred-lease")
        .unwrap();
    assert_eq!(lease.fingerprint, "SHA256:leasefp");
    assert!(lease.pem.contains("SECRET LEASE PEM"));
    let dbg = format!("{lease:?}");
    assert!(!dbg.contains("SECRET LEASE"));
    assert!(!dbg.contains("secret-pass"));
    assert!(!dbg.contains("cred-lease"));
    assert!(dbg.contains("<redacted>"));

    // Epoch mismatch after reinstall
    let _ = auth.clear_native();
    auth.install_session_for_tests("ten-lease", "user-lease", "admin", "sub-lease");
    assert!(matches!(
        v.lease_for_ssh(&auth, &principal, snap.epoch, "cred-lease"),
        Err(VaultError::Unauthenticated)
    ));

    let _ = v.lock();
    cleanup(&path);
}

#[test]
fn vault_lease_rejects_locked_and_wrong_id() {
    let path = temp_snapshot();
    let sh = Stronghold::new(&path, vec![0x62u8; 32]).expect("stronghold");
    seed_client_with_index(&sh);
    let auth = authed("t", "u", "s");
    let principal = auth.native_principal().unwrap();
    let snap = auth.native_auth_snapshot().unwrap();
    let v = VaultService::new(path.clone());
    v.test_inject_unlocked(sh, binding_of(&auth), path.clone(), Instant::now());
    assert!(matches!(
        v.lease_for_ssh(&auth, &principal, snap.epoch, "missing-cred"),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.lease_for_ssh(&auth, &principal, snap.epoch, "../evil"),
        Err(VaultError::InvalidIdentity)
    ));
    let _ = v.lock();
    assert!(matches!(
        v.lease_for_ssh(&auth, &principal, snap.epoch, "missing-cred"),
        Err(VaultError::Locked)
    ));
    cleanup(&path);
}

#[test]
fn vault_delete_local_isolation() {
    let path = temp_snapshot();
    let sh = Stronghold::new(&path, vec![0x63u8; 32]).expect("sh");
    seed_client_with_index(&sh);
    let auth = authed("ten", "alice", "sub-del");
    let v = VaultService::new(path.clone());
    v.test_inject_unlocked(sh, binding_of(&auth), path.clone(), Instant::now());
    v.import_pem(
        &auth,
        "cred-a",
        Zeroizing::new(ED25519_ENCRYPTED_PEM.into()),
        Some(Zeroizing::new("blabla".into())),
    )
    .unwrap();
    v.import_pem(
        &auth,
        "cred-b",
        Zeroizing::new(ED25519_ENCRYPTED_PEM.into()),
        Some(Zeroizing::new("blabla".into())),
    )
    .unwrap();
    assert_eq!(v.list_meta(&auth).unwrap().len(), 2);
    v.delete_local(&auth, "cred-a").unwrap();
    let meta = v.list_meta(&auth).unwrap();
    assert_eq!(meta.len(), 1);
    assert_eq!(meta[0].credential_id, "cred-b");
    assert!(matches!(
        v.delete_local(&auth, "cred-a"),
        Err(VaultError::NotFound)
    ));
    let _ = v.lock();
    cleanup(&path);
}

#[test]
fn vault_list_meta_mismatched_record_fails_closed() {
    let path = temp_snapshot();
    let sh = Stronghold::new(&path, vec![0x47u8; 32]).expect("stronghold");
    sh.create_client(CLIENT_PATH).expect("create");
    let auth = authed("ten-a", "user-a", "sub-a");
    let principal = auth.native_principal().unwrap();
    let store_key = make_key(&principal.tenant_id, &principal.subject, "cred-1").unwrap();
    let mut bad = StoredCredential {
        tenant_id: "other-tenant".into(),
        subject: principal.subject.clone(),
        credential_id: "cred-1".into(),
        fingerprint: "SHA256:dead".into(),
        pem: "SECRET".into(),
        passphrase: None,
    };
    let bytes = serde_json::to_vec(&bad).unwrap();
    bad.pem.zeroize();
    let client = sh.get_client(CLIENT_PATH).unwrap();
    client
        .store()
        .insert(store_key.as_bytes().to_vec(), bytes, None)
        .unwrap();
    client
        .store()
        .insert(
            INDEX_KEY.to_vec(),
            serde_json::to_vec(&CredentialIndex {
                entries: vec![store_key],
            })
            .unwrap(),
            None,
        )
        .unwrap();

    let v = VaultService::new(path.clone());
    v.test_inject_unlocked(sh, binding_of(&auth), path.clone(), Instant::now());
    assert!(matches!(v.list_meta(&auth), Err(VaultError::Storage)));
    let _ = v.lock();
    cleanup(&path);
}

#[test]
fn vault_require_existing_client_and_index_fail_closed() {
    let path = temp_snapshot();
    let sh = Stronghold::new(&path, vec![0x44u8; 32]).expect("sh");
    assert!(matches!(
        require_existing_client(&sh),
        Err(VaultError::Storage)
    ));
    sh.create_client(CLIENT_PATH).unwrap();
    assert!(matches!(load_index(&sh), Err(VaultError::Storage)));
    cleanup(&path);
}

/// Full Stronghold init/save/reopen with production Argon2 — slow; not default suite.
#[test]
#[ignore = "slow Stronghold+production-Argon2 cycle; run: cargo test --lib vault_init_save_reopen_wrong_password_and_ops -- --ignored --test-threads=1"]
fn vault_init_save_reopen_wrong_password_and_ops() {
    let path = temp_snapshot();
    let auth = authed("tenant-a", "user@example.com", "sub-user");
    let v = VaultService::new(path.clone());

    let st = v
        .init_with_password(Some(path.clone()), Zeroizing::new("correct-horse".into()))
        .unwrap();
    assert!(!st.unlocked);
    assert!(salt_path(&path).exists());

    let err = v
        .unlock_with_password(&auth, Zeroizing::new("wrong".into()))
        .unwrap_err();
    assert!(matches!(err, VaultError::InvalidPassword));

    let st = v
        .unlock_with_password(&auth, Zeroizing::new("correct-horse".into()))
        .unwrap();
    assert!(st.unlocked);

    let expected_fp = fingerprint_from_pem(ED25519_ENCRYPTED_PEM, Some("blabla")).unwrap();
    let resp = v
        .import_pem(
            &auth,
            "cred-1",
            Zeroizing::new(ED25519_ENCRYPTED_PEM.into()),
            Some(Zeroizing::new("blabla".into())),
        )
        .unwrap();
    assert_eq!(resp.fingerprint, expected_fp);
    assert_eq!(v.list_meta(&auth).unwrap().len(), 1);

    v.delete_local(&auth, "cred-1").unwrap();
    let _ = v.on_logout();
    assert_eq!(v.status().unwrap().locked_reason.as_deref(), Some("logout"));
    cleanup(&path);
}

// ─── Epoch / prompt-race binding (8A1 review rework) ─────────────────────────

#[test]
fn vault_same_principal_newer_epoch_seals_old_unlock() {
    let path = temp_snapshot();
    let sh = Stronghold::new(&path, vec![0x70u8; 32]).expect("sh");
    seed_client_with_index(&sh);
    let auth = authed("ten", "alice", "sub-same");
    let old = binding_of(&auth);
    let v = VaultService::new(path.clone());
    v.test_inject_unlocked(sh, old.clone(), path.clone(), Instant::now());
    assert!(v.status().unwrap().unlocked);

    // Logout + re-login same tenant/username/subject → new epoch.
    let _ = auth.clear_native();
    auth.install_session_for_tests("ten", "alice", "admin", "sub-same");
    let new_b = binding_of(&auth);
    assert_ne!(old.epoch, new_b.epoch);
    assert_eq!(old.principal, new_b.principal);

    // Observe / list must seal fail-closed; no data from stale unlock.
    assert!(matches!(
        v.list_meta(&auth),
        Err(VaultError::Locked | VaultError::Unauthenticated)
    ));
    assert!(!v.status().unwrap().unlocked);
    assert_eq!(
        v.status().unwrap().locked_reason.as_deref(),
        Some("principal_changed")
    );
    cleanup(&path);
}

#[test]
fn vault_prompt_auth_switch_zero_write_no_success() {
    let path = temp_snapshot();
    let sh = Stronghold::new(&path, vec![0x71u8; 32]).expect("sh");
    seed_client_with_index(&sh);
    let auth = std::sync::Arc::new(authed("ten", "alice", "sub-old"));
    let v = VaultService::new(path.clone());
    v.test_inject_unlocked(sh, binding_of(&auth), path.clone(), Instant::now());
    assert_eq!(
        v.test_credential_store_write_count(),
        0,
        "baseline: no credential mutations yet"
    );

    let auth_hook = auth.clone();
    let prompt = MockPrompt::with_auth_switch_after_pem(ED25519_ENCRYPTED_PEM, move || {
        let _ = auth_hook.clear_native();
        auth_hook.install_session_for_tests("ten", "alice", "admin", "sub-new");
    });
    *prompt.passphrase.lock().unwrap() = Some("blabla".into());
    let req = VaultImportRequest {
        credential_id: "cred-race".into(),
    };
    let err = v
        .import_begin_native(&auth, &prompt, &req)
        .expect_err("must not succeed after auth switch");
    assert!(
        matches!(err, VaultError::Unauthenticated | VaultError::Locked),
        "got {err:?}"
    );
    // Original service/write path: credential secret store mutation boundary never fired.
    assert_eq!(
        v.test_credential_store_write_count(),
        0,
        "auth switch during prompt must not mutate original vault credential store"
    );
    let _ = v.lock();
    cleanup(&path);
}

#[test]
fn vault_stale_expected_binding_cannot_install_unlocked() {
    let path = temp_snapshot();
    let auth = authed("ten", "u", "sub");
    let stale = binding_of(&auth);
    // Advance epoch while keeping principal.
    let _ = auth.clear_native();
    auth.install_session_for_tests("ten", "u", "admin", "sub");
    assert!(!auth.binding_still_current(&stale));

    let sh = Stronghold::new(&path, vec![0x73u8; 32]).expect("sh");
    seed_client_with_index(&sh);
    let v = VaultService::new(path.clone());
    let err = v
        .test_try_install_unlocked_for_binding(&auth, &stale, sh, path.clone())
        .unwrap_err();
    assert!(matches!(err, VaultError::Unauthenticated));
    assert!(!v.status().unwrap().unlocked);
    cleanup(&path);
}

#[test]
fn vault_list_and_lease_stale_epoch_return_no_data() {
    let path = temp_snapshot();
    let sh = Stronghold::new(&path, vec![0x74u8; 32]).expect("sh");
    sh.create_client(CLIENT_PATH).unwrap();
    let auth = authed("ten", "u", "sub");
    let principal = auth.native_principal().unwrap();
    let old = binding_of(&auth);
    let store_key = make_key(&principal.tenant_id, &principal.subject, "cred-1").unwrap();
    let mut rec = StoredCredential {
        tenant_id: principal.tenant_id.clone(),
        subject: principal.subject.clone(),
        credential_id: "cred-1".into(),
        fingerprint: "SHA256:x".into(),
        pem: "-----BEGIN SECRET-----\n".into(),
        passphrase: None,
    };
    let bytes = serde_json::to_vec(&rec).unwrap();
    rec.pem.zeroize();
    let client = sh.get_client(CLIENT_PATH).unwrap();
    client
        .store()
        .insert(store_key.as_bytes().to_vec(), bytes, None)
        .unwrap();
    client
        .store()
        .insert(
            INDEX_KEY.to_vec(),
            serde_json::to_vec(&CredentialIndex {
                entries: vec![store_key],
            })
            .unwrap(),
            None,
        )
        .unwrap();

    let v = VaultService::new(path.clone());
    v.test_inject_unlocked(sh, old.clone(), path.clone(), Instant::now());

    // Capture epoch for lease, then reinstall session (new epoch).
    let stale_epoch = old.epoch;
    let _ = auth.clear_native();
    auth.install_session_for_tests("ten", "u", "admin", "sub");

    assert!(matches!(
        v.list_meta(&auth),
        Err(VaultError::Locked | VaultError::Unauthenticated)
    ));
    // Lease with stale epoch must not return PEM.
    assert!(matches!(
        v.lease_for_ssh(&auth, &principal, stale_epoch, "cred-1"),
        Err(VaultError::Unauthenticated | VaultError::Locked)
    ));
    let _ = v.lock();
    cleanup(&path);
}

#[test]
fn vault_auth_binding_has_no_bearer_or_serialize() {
    let auth = authed("t", "u", "s");
    let b = binding_of(&auth);
    let dbg = format!("{b:?}");
    assert!(!dbg.contains("test-token"));
    assert!(dbg.contains("<redacted>"));
    // Type-level: AuthBinding is not Serialize (compile-time by absence of derive in source).
    let session_src = include_str!("../auth/session.rs");
    let region = session_src
        .split("pub struct AuthBinding")
        .nth(1)
        .unwrap()
        .split("impl std::fmt::Debug for AuthBinding")
        .next()
        .unwrap();
    assert!(!region.contains("Serialize"));
    assert!(!region.contains("bearer"));
    assert!(!region.contains("token"));
}
