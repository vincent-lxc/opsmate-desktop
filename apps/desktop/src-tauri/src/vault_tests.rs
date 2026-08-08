//! Task D3 / D3B vault unit tests.
//! Default `cargo test vault_` stays fast; full Stronghold reopen cycle is #[ignore].

use super::*;
use crate::auth::AuthStore;
use crate::secure_prompt::{PromptError, SecurePrompt};
use sha2::{Digest, Sha256};
use std::sync::Mutex as StdMutex;
use zeroize::Zeroizing;

// Encrypted OpenSSH Ed25519 fixture from russh-keys tests; passphrase = "blabla".
const ED25519_ENCRYPTED_PEM: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jYmMAAAAGYmNyeXB0AAAAGAAAABDLGyfA39
J2FcJygtYqi5ISAAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIN+Wjn4+4Fcvl2Jl
KpggT+wCRxpSvtqqpVrQrKN1/A22AAAAkOHDLnYZvYS6H9Q3S3Nk4ri3R2jAZlQlBbUos5
FkHpYgNw65KCWCTXtP7ye2czMC3zjn2r98pJLobsLYQgRiHIv/CUdAdsqbvMPECB+wl/UQ
e+JpiSq66Z6GIt0801skPh20jxOO3F52SoX1IeO5D5PXfZrfSZlw6S8c7bwyp2FHxDewRx
7/wNsnDM0T7nLv/Q==
-----END OPENSSH PRIVATE KEY-----";

struct MockPrompt {
    passphrase: StdMutex<Option<String>>,
    pem: StdMutex<String>,
    file: StdMutex<Option<std::path::PathBuf>>,
    cancel_passphrase: StdMutex<bool>,
    use_file: StdMutex<bool>,
}

impl MockPrompt {
    fn with_pem(pem: &str) -> Self {
        Self {
            passphrase: StdMutex::new(None),
            pem: StdMutex::new(pem.into()),
            file: StdMutex::new(None),
            cancel_passphrase: StdMutex::new(false),
            use_file: StdMutex::new(false),
        }
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
        Ok(self.file.lock().unwrap().clone())
    }
    fn prompt_pem_paste(&self, _title: &str) -> Result<Zeroizing<String>, PromptError> {
        Ok(Zeroizing::new(self.pem.lock().unwrap().clone()))
    }
    fn choose_pem_import(&self) -> Result<Zeroizing<String>, PromptError> {
        if *self.use_file.lock().unwrap() {
            let path = self.pick_pem_file()?.ok_or(PromptError::Cancelled)?;
            let s =
                std::fs::read_to_string(path).map_err(|e| PromptError::Native(e.to_string()))?;
            Ok(Zeroizing::new(s))
        } else {
            self.prompt_pem_paste("paste")
        }
    }
}

fn temp_snapshot() -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "opsmate-vault-test-{}-{}.hold",
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

fn authed(tenant: &str, user: &str) -> AuthStore {
    let a = AuthStore::new();
    a.install_session_for_tests(tenant, user, "admin");
    a
}

// ─── Fast pure unit tests ────────────────────────────────────────────────────

#[test]
fn vault_argon2_different_salts_yield_different_keys() {
    // Test-only weak config — production path uses production_argon2_config().
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
    // rust-argon2 Config::default: m=19*1024, t=2, Argon2id
    assert_eq!(c.mem_cost, 19 * 1024);
    assert_eq!(c.time_cost, 2);
    assert_eq!(c.variant, argon2::Variant::Argon2id);
    assert_eq!(c.hash_length, 32);
    // Explicitly stronger / not the weakened original() profile used only historically.
    assert!(c.mem_cost >= 19 * 1024);
}

#[test]
fn vault_argon2_wrong_salt_length_fails_closed() {
    assert!(matches!(
        derive_vault_key("pw", &[0u8; 8]),
        Err(VaultError::Storage)
    ));
    assert!(matches!(
        derive_vault_key("pw", &[0u8; 32]),
        Err(VaultError::Storage)
    ));
}

#[test]
fn vault_strict_validate_id_rejects_dot_segments_and_ambiguous() {
    assert!(validate_id("ok-id_1.x").is_ok());
    assert!(validate_id("").is_err());
    assert!(validate_id("a/b").is_err());
    assert!(validate_id("a\\b").is_err());
    assert!(validate_id("..").is_err());
    assert!(validate_id(".hidden").is_err());
    assert!(validate_id("trail.").is_err());
    assert!(validate_id("a..b").is_err());
    assert!(validate_id("has space").is_err());
    assert!(validate_id("has\t tab").is_err());
    assert!(validate_id("nul\0byte").is_err());
    assert!(validate_id(&"x".repeat(129)).is_err());
}

#[test]
fn vault_namespace_encoding_prevents_separator_collision() {
    // Naive "tenant/user/cred" collides for ("a/b","c") vs ("a","b/c").
    let k1 = make_key("a/b", "c", "cred").unwrap();
    let k2 = make_key("a", "b/c", "cred").unwrap();
    assert_ne!(k1, k2);
    // Username with @ and . (email) still encodes cleanly.
    let k3 = make_key("ten-1", "user@example.com", "cred-1").unwrap();
    assert!(k3.contains('/'));
    assert!(!k3.contains("user@example.com")); // raw user not embedded
    assert!(k3.ends_with("/cred-1"));
    // Control / empty rejected
    assert!(encode_ns_component("").is_err());
    assert!(encode_ns_component("bad\0").is_err());
    assert!(make_key("ok", "bad/../x\0", "c").is_err());
}

#[test]
fn vault_import_request_accepts_only_credential_id() {
    assert!(serde_json::from_str::<VaultImportRequest>(r#"{"credentialId":"c"}"#).is_ok());
    assert!(
        serde_json::from_str::<VaultImportRequest>(r#"{"credentialId":"c","fromFile":true}"#)
            .is_err()
    );
    assert!(serde_json::from_str::<VaultImportRequest>(
        r#"{"credentialId":"c","tenantId":"evil"}"#
    )
    .is_err());
    assert!(
        serde_json::from_str::<VaultImportRequest>(r#"{"credentialId":"c","userId":"evil"}"#)
            .is_err()
    );
    assert!(serde_json::from_str::<VaultImportRequest>(
        r#"{"credentialId":"c","snapshotPath":"/tmp/x"}"#
    )
    .is_err());
}

#[test]
fn vault_status_exposes_only_unlocked_and_locked_reason() {
    let locked = VaultStatus {
        unlocked: false,
        locked_reason: Some("not_initialized".into()),
    };
    let open = VaultStatus {
        unlocked: true,
        locked_reason: None,
    };
    let o = serde_json::to_value(&locked).unwrap();
    let keys: Vec<_> = o.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys.len(),
        2,
        "status must expose only unlocked + lockedReason: {keys:?}"
    );
    assert!(keys.contains(&"unlocked".to_string()));
    assert!(keys.contains(&"lockedReason".to_string()));
    let open_v = serde_json::to_value(&open).unwrap();
    assert_eq!(open_v.get("unlocked"), Some(&serde_json::json!(true)));
    assert!(open_v.get("lockedReason").unwrap().is_null());
}

#[test]
fn vault_russh_fingerprint_encrypted_ed25519_fixture() {
    assert!(matches!(
        fingerprint_from_pem(ED25519_ENCRYPTED_PEM, None),
        Err(VaultError::InvalidPrivateKey)
    ));
    assert!(matches!(
        fingerprint_from_pem(ED25519_ENCRYPTED_PEM, Some("wrong")),
        Err(VaultError::InvalidPrivateKey)
    ));
    let fp = fingerprint_from_pem(ED25519_ENCRYPTED_PEM, Some("blabla")).unwrap();
    assert!(fp.starts_with("SHA256:"), "got {fp}");
    assert!(!fp.contains("BEGIN"));
    let text_digest = hex::encode(Sha256::digest(ED25519_ENCRYPTED_PEM.as_bytes()));
    assert!(!fp.contains(&text_digest));
}

#[test]
fn vault_make_key_uses_encoded_components() {
    let k = make_key("t", "u", "c").unwrap();
    assert_eq!(
        k,
        format!(
            "{}/{}/c",
            encode_ns_component("t").unwrap(),
            encode_ns_component("u").unwrap()
        )
    );
}

#[test]
fn vault_macos_secure_prompt_cfg_compiles() {
    let _ = crate::secure_prompt::macos_secure_types_linked();
    #[cfg(target_os = "macos")]
    assert!(crate::secure_prompt::macos_secure_types_linked());
}

#[test]
fn vault_lifecycle_sleep_wake_supported_on_macos() {
    #[cfg(target_os = "macos")]
    assert!(crate::vault_lifecycle::sleep_wake_registration_supported());
    #[cfg(not(target_os = "macos"))]
    assert!(!crate::vault_lifecycle::sleep_wake_registration_supported());
}

#[test]
fn vault_prompt_cancel_vs_optional_empty_semantics() {
    let cancel = MockPrompt::with_pem("x");
    *cancel.cancel_passphrase.lock().unwrap() = true;
    assert!(matches!(
        cancel.prompt_passphrase("t", "m"),
        Err(PromptError::Cancelled)
    ));
    let empty = MockPrompt::with_pem("x");
    assert!(matches!(empty.prompt_passphrase("t", "m"), Ok(None)));
}

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
    let st = v.status().unwrap();
    assert!(!st.unlocked);
    assert_eq!(st.locked_reason.as_deref(), Some("not_initialized"));
    cleanup(&path);
}

#[test]
fn vault_missing_or_corrupt_salt_fails_before_stronghold() {
    let path = temp_snapshot();
    let auth = authed("t", "u");
    let v = VaultService::new(path.clone());
    std::fs::write(&path, b"not-a-real-snapshot").unwrap();
    let err = v
        .unlock_with_password(&auth, Zeroizing::new("pw".into()))
        .unwrap_err();
    assert!(matches!(err, VaultError::Storage));
    std::fs::write(salt_path(&path), [0u8; 3]).unwrap();
    let err = v
        .unlock_with_password(&auth, Zeroizing::new("pw".into()))
        .unwrap_err();
    assert!(matches!(err, VaultError::Storage));
    cleanup(&path);
}

#[test]
fn vault_public_commands_boundary_no_identity_or_from_file() {
    let lib = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
    let vault = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/vault.rs");
    let lib_raw = std::fs::read_to_string(lib).unwrap();
    let vault_raw = std::fs::read_to_string(vault).unwrap();
    for name in [
        "vault_status",
        "vault_init",
        "vault_unlock",
        "vault_lock",
        "vault_import",
        "vault_list_meta",
        "vault_delete_local",
    ] {
        assert!(lib_raw.contains(name), "missing command {name}");
    }
    assert!(
        !lib_raw.contains("fn vault_on_tenant_switch")
            && !lib_raw.contains("vault_on_tenant_switch,"),
        "vault_on_tenant_switch must not be a registered command"
    );
    assert!(!lib_raw.contains("VaultUnlockRequest"));
    assert!(!vault_raw.contains("from_file"));
    assert!(!vault_raw.contains("fromFile"));
    assert!(!vault_raw.contains("active_tenant_id"));
    assert!(!vault_raw.contains("active_user_id"));
}

/// Structural + type-level proof: serialized secrets use Zeroizing RAII (not bare Vec).
#[test]
fn vault_secret_json_bytes_uses_zeroizing_raii() {
    #[derive(Serialize)]
    struct Sample {
        pem: String,
        passphrase: Option<String>,
    }
    let sample = Sample {
        pem: "-----BEGIN SECRET-----".into(),
        passphrase: Some("blabla".into()),
    };
    let buf = secret_json_bytes(&sample).expect("serialize");
    // Type is Zeroizing — compile-time RAII; Drop wipes even if we early-return after this.
    fn assert_is_zeroizing(_: &Zeroizing<Vec<u8>>) {}
    assert_is_zeroizing(&buf);
    assert!(buf.windows(6).any(|w| w == b"SECRET"));
    // Source contract: import path must not use bare `let mut bytes = serde_json::to_vec(&record)`.
    let src = include_str!("vault.rs");
    assert!(
        src.contains("fn secret_json_bytes"),
        "must keep secret_json_bytes helper"
    );
    assert!(
        src.contains("secret_json_bytes(&record)"),
        "import_pem must serialize via secret_json_bytes"
    );
    assert!(
        !src.contains("let mut bytes = serde_json::to_vec(&record)"),
        "must not use bare Vec for secret serialization"
    );
}

/// Fast proof: real Stronghold Client store insert/get on a fresh snapshot (no reopen).
#[test]
fn vault_stronghold_client_store_roundtrip_minimal() {
    let path = temp_snapshot();
    // Fixed 32-byte key — KeyProvider does not Argon2; this proves Client store only.
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

/// Unlock must not create a missing client — already-open Stronghold without CLIENT_PATH.
#[test]
fn vault_require_existing_client_missing_fails_closed() {
    let path = temp_snapshot();
    let key = vec![0x44u8; 32];
    let sh = Stronghold::new(&path, key).expect("stronghold new");
    // Deliberately no create_client — unlock path must Storage, not invent a blank vault.
    assert!(matches!(
        require_existing_client(&sh),
        Err(VaultError::Storage)
    ));
    cleanup(&path);
}

/// Missing index entry cannot become an empty successful vault.
#[test]
fn vault_load_index_missing_fails_closed() {
    let path = temp_snapshot();
    let key = vec![0x45u8; 32];
    let sh = Stronghold::new(&path, key).expect("stronghold new");
    sh.create_client(CLIENT_PATH).expect("create client");
    // Client exists but index never seeded (only init seeds it).
    assert!(matches!(load_index(&sh), Err(VaultError::Storage)));
    cleanup(&path);
}

/// Malformed index JSON cannot become an empty successful vault.
#[test]
fn vault_load_index_malformed_fails_closed() {
    let path = temp_snapshot();
    let key = vec![0x46u8; 32];
    let sh = Stronghold::new(&path, key).expect("stronghold new");
    sh.create_client(CLIENT_PATH).expect("create client");
    let client = sh.get_client(CLIENT_PATH).expect("get client");
    client
        .store()
        .insert(INDEX_KEY.to_vec(), b"not-valid-json{{{".to_vec(), None)
        .expect("insert bad index");
    assert!(matches!(load_index(&sh), Err(VaultError::Storage)));
    // Valid empty index still loads.
    let good = serde_json::to_vec(&CredentialIndex::default()).unwrap();
    client
        .store()
        .insert(INDEX_KEY.to_vec(), good, None)
        .expect("insert good index");
    let idx = load_index(&sh).expect("valid index");
    assert!(idx.entries.is_empty());
    cleanup(&path);
}

/// list_meta fail-closed: store entry present but identity mismatch rejects.
#[test]
fn vault_list_meta_mismatched_record_fails_closed() {
    let path = temp_snapshot();
    let key = vec![0x47u8; 32];
    let sh = Stronghold::new(&path, key).expect("stronghold new");
    sh.create_client(CLIENT_PATH).expect("create client");
    let auth = authed("ten-a", "user-a");
    let principal = auth.native_principal().unwrap();
    let store_key = make_key(&principal.tenant_id, &principal.subject, "cred-1").unwrap();
    // Record claims a different tenant than the index key / principal.
    let mut bad = StoredCredential {
        tenant_id: "other-tenant".into(),
        subject: principal.subject.clone(),
        credential_id: "cred-1".into(),
        fingerprint: "SHA256:dead".into(),
        pem: "SECRET".into(),
        passphrase: None,
    };
    let mut bytes = serde_json::to_vec(&bad).unwrap();
    bad.pem.zeroize();
    let client = sh.get_client(CLIENT_PATH).unwrap();
    client
        .store()
        .insert(store_key.as_bytes().to_vec(), bytes.clone(), None)
        .unwrap();
    bytes.zeroize();
    let index = CredentialIndex {
        entries: vec![store_key],
    };
    let mut index_bytes = serde_json::to_vec(&index).unwrap();
    client
        .store()
        .insert(INDEX_KEY.to_vec(), index_bytes.clone(), None)
        .unwrap();
    index_bytes.zeroize();

    // Inject unlocked state with this Stronghold (no disk Argon2 cycle).
    let v = VaultService::new(path.clone());
    {
        let mut g = v.inner.lock().unwrap();
        *g = VaultInner::Unlocked(UnlockedState {
            stronghold: sh,
            last_activity: Instant::now(),
            principal: principal.clone(),
            snapshot_path: path.clone(),
            skip_persist: true,
        });
    }
    let err = v.list_meta(&auth).unwrap_err();
    assert!(
        matches!(err, VaultError::Storage),
        "mismatched StoredCredential must fail closed, got {err:?}"
    );
    let _ = v.lock();
    cleanup(&path);
}

// ─── D4B1 lease_for_ssh ──────────────────────────────────────────────────────

#[test]
fn vault_lease_for_ssh_happy_path_and_debug_redacted() {
    let path = temp_snapshot();
    let key = vec![0x61u8; 32];
    let sh = Stronghold::new(&path, key).expect("stronghold");
    sh.create_client(CLIENT_PATH).expect("client");
    let auth = authed("ten-lease", "user-lease");
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
    let index = CredentialIndex {
        entries: vec![store_key],
    };
    client
        .store()
        .insert(
            INDEX_KEY.to_vec(),
            serde_json::to_vec(&index).unwrap(),
            None,
        )
        .unwrap();

    let v = VaultService::new(path.clone());
    v.test_inject_unlocked(sh, principal.clone(), path.clone(), Instant::now());

    let lease = v
        .lease_for_ssh(&auth, &principal, snap.epoch, "cred-lease")
        .unwrap();
    assert_eq!(lease.fingerprint, "SHA256:leasefp");
    assert!(lease.pem.contains("SECRET LEASE PEM"));
    assert_eq!(
        lease.passphrase.as_ref().map(|p| p.as_str()),
        Some("secret-pass")
    );
    let dbg = format!("{lease:?}");
    assert!(!dbg.contains("SECRET LEASE"));
    assert!(!dbg.contains("secret-pass"));
    assert!(!dbg.contains("cred-lease"));
    assert!(dbg.contains("<redacted>"));

    // Epoch mismatch after logout+relogin
    let _ = auth.clear_native();
    auth.install_session_for_tests("ten-lease", "user-lease", "admin");
    assert!(matches!(
        v.lease_for_ssh(&auth, &principal, snap.epoch, "cred-lease"),
        Err(VaultError::Unauthenticated)
    ));

    let _ = v.lock();
    cleanup(&path);
}

#[test]
fn vault_lease_for_ssh_rejects_wrong_credential_and_locked() {
    let path = temp_snapshot();
    let key = vec![0x62u8; 32];
    let sh = Stronghold::new(&path, key).expect("stronghold");
    sh.create_client(CLIENT_PATH).expect("client");
    let client = sh.get_client(CLIENT_PATH).unwrap();
    client
        .store()
        .insert(
            INDEX_KEY.to_vec(),
            serde_json::to_vec(&CredentialIndex::default()).unwrap(),
            None,
        )
        .unwrap();
    let auth = authed("t", "u");
    let principal = auth.native_principal().unwrap();
    let snap = auth.native_auth_snapshot().unwrap();
    let v = VaultService::new(path.clone());
    v.test_inject_unlocked(sh, principal.clone(), path.clone(), Instant::now());
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
fn vault_lease_is_not_clone_or_serialize_in_source() {
    let src = include_str!("vault.rs");
    assert!(src.contains("struct VaultCredentialLease"));
    assert!(src.contains("pub fn lease_for_ssh"));
    // No Serialize/Clone on the lease type itself.
    let lease_region = src
        .split("pub struct VaultCredentialLease")
        .nth(1)
        .unwrap()
        .split("impl std::fmt::Debug for VaultCredentialLease")
        .next()
        .unwrap();
    assert!(!lease_region.contains("Serialize"));
    assert!(!lease_region.contains("Clone"));
}

// ─── Slow full cycle (ignored in default suite) ──────────────────────────────
// Run explicitly:
//   cargo test --lib vault_init_save_reopen_wrong_password_and_ops -- --ignored --test-threads=1

/// Full Stronghold init/save/reopen/wrong-password + ops. Slow (~minutes) due to
/// production Argon2id (19 MiB) on each open — not run in default `cargo test vault_`.
#[test]
#[ignore = "slow Stronghold+production-Argon2 cycle; run: cargo test --lib vault_init_save_reopen_wrong_password_and_ops -- --ignored --test-threads=1"]
fn vault_init_save_reopen_wrong_password_and_ops() {
    let path = temp_snapshot();
    let auth = authed("tenant-a", "user@example.com");
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
    assert!(st.locked_reason.is_none());

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

    let prompt = MockPrompt::with_pem(ED25519_ENCRYPTED_PEM);
    *prompt.passphrase.lock().unwrap() = Some("blabla".into());
    let req = VaultImportRequest {
        credential_id: "c-native".into(),
    };
    assert_eq!(
        v.import_begin_native(&auth, &prompt, &req)
            .unwrap()
            .credential_id,
        "c-native"
    );
    v.delete_local(&auth, "cred-1").unwrap();

    {
        let mut g = v.inner.lock().unwrap();
        if let VaultInner::Unlocked(u) = &mut *g {
            u.last_activity = Instant::now() - VAULT_IDLE_TIMEOUT - Duration::from_secs(1);
        }
    }
    assert!(matches!(v.list_meta(&auth), Err(VaultError::Locked)));
    assert_eq!(
        v.status().unwrap().locked_reason.as_deref(),
        Some("idle_timeout")
    );

    // reopen
    let st = v
        .unlock_with_password(&auth, Zeroizing::new("correct-horse".into()))
        .unwrap();
    assert!(st.unlocked);

    let auth_b = authed("tenant-b", "user@example.com");
    let err = v.list_meta(&auth_b).unwrap_err();
    assert!(matches!(
        err,
        VaultError::Locked | VaultError::Unauthenticated
    ));
    assert_eq!(
        v.status().unwrap().locked_reason.as_deref(),
        Some("principal_changed")
    );

    let _ = v.on_logout();
    assert_eq!(v.status().unwrap().locked_reason.as_deref(), Some("logout"));
    cleanup(&path);
}

// ─── P2 idle seal vs activity gate ───────────────────────────────────────────

#[test]
fn vault_idle_watchdog_loses_to_activity_before_seal() {
    use crate::ssh_registry::{LocalSshConnector, LocalSshSessionManager, LocalSshTransport};
    use crate::ssh_session::{PreparedSshTarget, SshSessionError};

    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    struct T {
        closes: Arc<AtomicUsize>,
        closed: AtomicBool,
    }
    impl LocalSshTransport for T {
        fn write(&self, _: &[u8]) -> Result<(), SshSessionError> {
            Ok(())
        }
        fn resize(&self, _: u32, _: u32) -> Result<(), SshSessionError> {
            Ok(())
        }
        fn close(&self) -> Result<(), SshSessionError> {
            if !self.closed.swap(true, Ordering::SeqCst) {
                self.closes.fetch_add(1, Ordering::SeqCst);
            }
            Ok(())
        }
    }
    struct C {
        closes: Arc<AtomicUsize>,
    }
    impl LocalSshConnector for C {
        fn connect(
            &self,
            _: &PreparedSshTarget,
        ) -> Result<Arc<dyn LocalSshTransport>, SshSessionError> {
            Ok(Arc::new(T {
                closes: Arc::clone(&self.closes),
                closed: AtomicBool::new(false),
            }))
        }
    }

    let path = temp_snapshot();
    let auth = authed("tnt", "user");
    let vault = Arc::new(VaultService::new(path.clone()));
    let mgr = Arc::new(LocalSshSessionManager::new());
    vault.set_session_lifecycle_sink(mgr.clone());
    let closes = Arc::new(AtomicUsize::new(0));
    let conn = C {
        closes: Arc::clone(&closes),
    };
    let snap = auth.native_auth_snapshot().unwrap();
    let target = PreparedSshTarget {
        server_id: "s".into(),
        name: "n".into(),
        host: "1.1.1.1".into(),
        port: 22,
        username: "u".into(),
        credential_id: "c".into(),
        host_key_status: crate::ssh_session::HostKeyStatus::Unpinned,
        host_key_type: None,
        host_key_fingerprint: None,
        principal: snap.principal.clone(),
        session_epoch: snap.epoch,
    };
    mgr.open_session(&auth, &target, &conn, &crate::auth::SecRandomSource)
        .unwrap();

    let key = vec![0x71u8; 32];
    let sh = Stronghold::new(&path, key).unwrap();
    sh.create_client(CLIENT_PATH).unwrap();
    // Seed empty index for list_meta.
    let client = sh.get_client(CLIENT_PATH).unwrap();
    client
        .store()
        .insert(
            INDEX_KEY.to_vec(),
            serde_json::to_vec(&CredentialIndex::default()).unwrap(),
            None,
        )
        .unwrap();
    vault.test_inject_unlocked(
        sh,
        snap.principal.clone(),
        path.clone(),
        Instant::now() - VAULT_IDLE_TIMEOUT - Duration::from_secs(1),
    );

    // Single-threaded gate proof (no channel join hang on assert failure):
    // while Operating, watchdog must skip even though last_activity is stale;
    // after activity refreshes timestamps, watchdog still must not seal.
    vault
        .test_with_operating_gate(|| {
            vault.check_idle_and_seal().unwrap();
            assert!(vault.status().unwrap().unlocked);
            assert_eq!(mgr.session_count(), 1);
            assert_eq!(closes.load(Ordering::SeqCst), 0);
            vault.test_touch_activity();
        })
        .unwrap();
    vault.check_idle_and_seal().unwrap();
    assert!(vault.status().unwrap().unlocked);
    assert_eq!(mgr.session_count(), 1);
    assert_eq!(closes.load(Ordering::SeqCst), 0);

    let _ = vault.lock();
    cleanup(&path);
}

#[test]
fn vault_idle_seal_wins_gate_ops_see_locked_after_close() {
    use crate::ssh_registry::{LocalSshConnector, LocalSshSessionManager, LocalSshTransport};
    use crate::ssh_session::{PreparedSshTarget, SshSessionError};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    struct T {
        closes: Arc<AtomicUsize>,
        closed: AtomicBool,
        closed_before_return: Arc<AtomicBool>,
    }
    impl LocalSshTransport for T {
        fn write(&self, _: &[u8]) -> Result<(), SshSessionError> {
            Ok(())
        }
        fn resize(&self, _: u32, _: u32) -> Result<(), SshSessionError> {
            Ok(())
        }
        fn close(&self) -> Result<(), SshSessionError> {
            if !self.closed.swap(true, Ordering::SeqCst) {
                self.closes.fetch_add(1, Ordering::SeqCst);
                self.closed_before_return.store(true, Ordering::SeqCst);
            }
            Ok(())
        }
    }
    struct C {
        closes: Arc<AtomicUsize>,
        closed_before_return: Arc<AtomicBool>,
    }
    impl LocalSshConnector for C {
        fn connect(
            &self,
            _: &PreparedSshTarget,
        ) -> Result<Arc<dyn LocalSshTransport>, SshSessionError> {
            Ok(Arc::new(T {
                closes: Arc::clone(&self.closes),
                closed: AtomicBool::new(false),
                closed_before_return: Arc::clone(&self.closed_before_return),
            }))
        }
    }

    let path = temp_snapshot();
    let auth = authed("tnt", "user");
    let vault = Arc::new(VaultService::new(path.clone()));
    let mgr = Arc::new(LocalSshSessionManager::new());
    vault.set_session_lifecycle_sink(mgr.clone());
    let closes = Arc::new(AtomicUsize::new(0));
    let closed_flag = Arc::new(AtomicBool::new(false));
    let conn = C {
        closes: Arc::clone(&closes),
        closed_before_return: Arc::clone(&closed_flag),
    };
    let snap = auth.native_auth_snapshot().unwrap();
    let target = PreparedSshTarget {
        server_id: "s".into(),
        name: "n".into(),
        host: "1.1.1.1".into(),
        port: 22,
        username: "u".into(),
        credential_id: "c".into(),
        host_key_status: crate::ssh_session::HostKeyStatus::Unpinned,
        host_key_type: None,
        host_key_fingerprint: None,
        principal: snap.principal.clone(),
        session_epoch: snap.epoch,
    };
    mgr.open_session(&auth, &target, &conn, &crate::auth::SecRandomSource)
        .unwrap();

    let key = vec![0x72u8; 32];
    let sh = Stronghold::new(&path, key).unwrap();
    sh.create_client(CLIENT_PATH).unwrap();
    client_seed_index(&sh);
    vault.test_inject_unlocked(
        sh,
        snap.principal.clone(),
        path.clone(),
        Instant::now() - VAULT_IDLE_TIMEOUT - Duration::from_secs(1),
    );

    vault.check_idle_and_seal().unwrap();
    // Transport closed before seal completed.
    assert!(closed_flag.load(Ordering::SeqCst));
    assert_eq!(closes.load(Ordering::SeqCst), 1);
    assert_eq!(mgr.session_count(), 0);
    assert!(!vault.status().unwrap().unlocked);
    assert_eq!(
        vault.status().unwrap().locked_reason.as_deref(),
        Some("idle_timeout")
    );
    // Later op fails closed.
    assert!(matches!(vault.list_meta(&auth), Err(VaultError::Locked)));

    cleanup(&path);
}

fn client_seed_index(sh: &Stronghold) {
    let client = sh.get_client(CLIENT_PATH).unwrap();
    client
        .store()
        .insert(
            INDEX_KEY.to_vec(),
            serde_json::to_vec(&CredentialIndex::default()).unwrap(),
            None,
        )
        .unwrap();
}

// ─── Lifecycle gate race protocol (Condvar + seal_waiters) ───────────────────

fn inject_fresh_unlocked(vault: &VaultService, auth: &AuthStore, path: &std::path::Path) {
    let sh = Stronghold::new(path, vec![0x90u8; 32]).unwrap();
    sh.create_client(CLIENT_PATH).unwrap();
    client_seed_index(&sh);
    vault.test_inject_unlocked(
        sh,
        auth.native_principal().unwrap(),
        path.to_path_buf(),
        Instant::now(),
    );
}

/// Separate-thread lock waits on Condvar while OPERATING; never busy-spins.
#[test]
fn vault_explicit_lock_waits_for_operating_then_seals() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    let path = temp_snapshot();
    let auth = authed("tnt", "user");
    let vault = Arc::new(VaultService::new(path.clone()));
    inject_fresh_unlocked(&vault, &auth, &path);

    let op_ready = Arc::new(std::sync::Barrier::new(2));
    let op_release = Arc::new(std::sync::Barrier::new(2));
    let lock_finished = Arc::new(AtomicBool::new(false));

    let v_op = Arc::clone(&vault);
    let op_ready_t = Arc::clone(&op_ready);
    let op_release_t = Arc::clone(&op_release);
    let op_thread = std::thread::spawn(move || {
        v_op.test_with_operating_gate(|| {
            op_ready_t.wait();
            op_release_t.wait();
        })
        .unwrap();
    });

    op_ready.wait();
    let v_lock = Arc::clone(&vault);
    let lock_finished_t = Arc::clone(&lock_finished);
    let lock_thread = std::thread::spawn(move || {
        let st = v_lock.lock().unwrap();
        lock_finished_t.store(true, Ordering::SeqCst);
        st
    });

    std::thread::sleep(Duration::from_millis(80));
    assert!(!lock_finished.load(Ordering::SeqCst));
    assert!(
        vault.test_seal_pending(),
        "lock must publish seal_waiters while waiting"
    );
    assert!(vault.status().unwrap().unlocked);

    op_release.wait();
    op_thread.join().unwrap();
    let st = lock_thread.join().unwrap();
    assert!(!st.unlocked);
    assert!(vault.test_gate_is_idle());
    cleanup(&path);
}

/// After lock/logout publishes seal intent, no new OPERATING claim can enter.
#[test]
fn vault_seal_pending_rejects_new_op_while_lock_waits() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    let path = temp_snapshot();
    let auth = authed("tnt", "user");
    let vault = Arc::new(VaultService::new(path.clone()));
    inject_fresh_unlocked(&vault, &auth, &path);

    let op_ready = Arc::new(std::sync::Barrier::new(2));
    let op_release = Arc::new(std::sync::Barrier::new(2));

    let v_op = Arc::clone(&vault);
    let op_ready_t = Arc::clone(&op_ready);
    let op_release_t = Arc::clone(&op_release);
    let op_thread = std::thread::spawn(move || {
        v_op.test_with_operating_gate(|| {
            op_ready_t.wait();
            op_release_t.wait();
        })
        .unwrap();
    });

    op_ready.wait();
    let lock_done = Arc::new(AtomicBool::new(false));
    let v_lock = Arc::clone(&vault);
    let lock_done_t = Arc::clone(&lock_done);
    let lock_thread = std::thread::spawn(move || {
        let st = v_lock.lock().unwrap();
        lock_done_t.store(true, Ordering::SeqCst);
        st
    });

    // Wait until sealer has published seal_waiters (blocked on OPERATING).
    for _ in 0..50 {
        if vault.test_seal_pending() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(vault.test_seal_pending());
    // Continuous ops cannot starve logout: new OPERATING rejected while pending.
    assert!(matches!(
        vault.test_claim_operating(),
        Err(VaultError::Locked)
    ));
    assert!(!lock_done.load(Ordering::SeqCst));

    op_release.wait();
    op_thread.join().unwrap();
    let st = lock_thread.join().unwrap();
    assert!(!st.unlocked);
    assert!(vault.test_gate_is_idle());
    cleanup(&path);
}

/// Same-thread nested lock while holding OPERATING must fail (not infinite Condvar wait).
#[test]
fn vault_same_thread_nested_lock_while_operating_fails() {
    let path = temp_snapshot();
    let auth = authed("tnt", "user");
    let vault = VaultService::new(path.clone());
    inject_fresh_unlocked(&vault, &auth, &path);
    let err = vault
        .test_with_operating_gate(|| vault.lock().unwrap_err())
        .unwrap();
    assert!(matches!(err, VaultError::Internal));
    assert!(vault.status().unwrap().unlocked);
    assert!(vault.test_gate_is_idle());
    cleanup(&path);
}

/// Unlock under OPERATING serializes with lock: lock waits, then seals after unlock claim ends.
#[test]
fn vault_unlock_operating_claim_serializes_with_lock() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    let path = temp_snapshot();
    let auth = authed("tnt", "user");
    let vault = Arc::new(VaultService::new(path.clone()));
    let sh_locked = Stronghold::new(&path, vec![0x83u8; 32]).unwrap();
    sh_locked.create_client(CLIENT_PATH).unwrap();
    client_seed_index(&sh_locked);
    drop(sh_locked);
    let sh_unlock = Stronghold::new(&path, vec![0x83u8; 32]).unwrap();
    let _ = sh_unlock
        .get_client(CLIENT_PATH)
        .or_else(|_| sh_unlock.load_client(CLIENT_PATH));

    {
        let mut g = vault.inner.lock().unwrap();
        *g = VaultInner::Locked {
            snapshot_path: path.clone(),
            reason: "locked",
        };
    }

    let ready = Arc::new(std::sync::Barrier::new(2));
    let hold = Arc::new(std::sync::Barrier::new(2));
    let lock_done = Arc::new(AtomicBool::new(false));

    let v_u = Arc::clone(&vault);
    let ready_u = Arc::clone(&ready);
    let hold_u = Arc::clone(&hold);
    let principal = auth.native_principal().unwrap();
    let path_u = path.clone();
    let unlock_thread = std::thread::spawn(move || {
        v_u.test_simulate_unlock_under_operating(principal, sh_unlock, path_u, &ready_u, &hold_u)
    });

    ready.wait();
    let v_l = Arc::clone(&vault);
    let lock_done_t = Arc::clone(&lock_done);
    let lock_thread = std::thread::spawn(move || {
        let st = v_l.lock().unwrap();
        lock_done_t.store(true, Ordering::SeqCst);
        st
    });

    for _ in 0..50 {
        if vault.test_seal_pending() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(vault.test_seal_pending());
    assert!(matches!(
        vault.test_claim_operating(),
        Err(VaultError::Locked)
    ));
    assert!(!lock_done.load(Ordering::SeqCst));

    hold.wait();
    let unlock_r = unlock_thread.join().unwrap();
    assert!(unlock_r.is_ok());
    let st = lock_thread.join().unwrap();
    assert!(!st.unlocked);
    assert!(!vault.status().unwrap().unlocked);
    assert!(vault.test_gate_is_idle());
    cleanup(&path);
}

/// Idle seal leaves gate fully idle (no stuck SEALING / seal_waiters).
#[test]
fn vault_idle_seal_leaves_gate_idle_not_stuck_sealing() {
    let path = temp_snapshot();
    let auth = authed("tnt", "user");
    let vault = VaultService::new(path.clone());
    let sh = Stronghold::new(&path, vec![0x82u8; 32]).unwrap();
    sh.create_client(CLIENT_PATH).unwrap();
    client_seed_index(&sh);
    vault.test_inject_unlocked(
        sh,
        auth.native_principal().unwrap(),
        path.clone(),
        Instant::now() - VAULT_IDLE_TIMEOUT - Duration::from_secs(1),
    );
    vault.check_idle_and_seal().unwrap();
    assert!(!vault.status().unwrap().unlocked);
    assert!(vault.test_gate_is_idle());
    cleanup(&path);
}

/// delete_local must not close sessions when op claim fails (vault locked).
#[test]
fn vault_delete_local_no_session_close_when_op_claim_fails() {
    use crate::ssh_registry::{LocalSshConnector, LocalSshSessionManager, LocalSshTransport};
    use crate::ssh_session::{PreparedSshTarget, SshSessionError};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    struct T {
        closes: Arc<AtomicUsize>,
        closed: AtomicBool,
    }
    impl LocalSshTransport for T {
        fn write(&self, _: &[u8]) -> Result<(), SshSessionError> {
            Ok(())
        }
        fn resize(&self, _: u32, _: u32) -> Result<(), SshSessionError> {
            Ok(())
        }
        fn close(&self) -> Result<(), SshSessionError> {
            if !self.closed.swap(true, Ordering::SeqCst) {
                self.closes.fetch_add(1, Ordering::SeqCst);
            }
            Ok(())
        }
    }
    struct C {
        closes: Arc<AtomicUsize>,
    }
    impl LocalSshConnector for C {
        fn connect(
            &self,
            _: &PreparedSshTarget,
        ) -> Result<Arc<dyn LocalSshTransport>, SshSessionError> {
            Ok(Arc::new(T {
                closes: Arc::clone(&self.closes),
                closed: AtomicBool::new(false),
            }))
        }
    }

    let path = temp_snapshot();
    let auth = authed("tnt", "user");
    let vault = VaultService::new(path.clone());
    let mgr = Arc::new(LocalSshSessionManager::new());
    vault.set_session_lifecycle_sink(mgr.clone());
    let closes = Arc::new(AtomicUsize::new(0));
    let conn = C {
        closes: Arc::clone(&closes),
    };
    let snap = auth.native_auth_snapshot().unwrap();
    let target = PreparedSshTarget {
        server_id: "s".into(),
        name: "n".into(),
        host: "1.1.1.1".into(),
        port: 22,
        username: "u".into(),
        credential_id: "cred-x".into(),
        host_key_status: crate::ssh_session::HostKeyStatus::Unpinned,
        host_key_type: None,
        host_key_fingerprint: None,
        principal: snap.principal.clone(),
        session_epoch: snap.epoch,
    };
    mgr.open_session(&auth, &target, &conn, &crate::auth::SecRandomSource)
        .unwrap();
    assert_eq!(mgr.session_count(), 1);

    let err = vault.delete_local(&auth, "cred-x").unwrap_err();
    assert!(matches!(err, VaultError::Locked));
    assert_eq!(mgr.session_count(), 1);
    assert_eq!(closes.load(Ordering::SeqCst), 0);
    cleanup(&path);
}

// ─── Task 6: subject namespace + lifecycle order + no temp snapshot ───────────

#[test]
fn vault_namespace_uses_subject_not_username() {
    // Same username string is irrelevant — subjects isolate keys.
    let k_a = make_key("tenant-1", "sub-alice", "cred-1").unwrap();
    let k_b = make_key("tenant-1", "sub-bob", "cred-1").unwrap();
    assert_ne!(k_a, k_b);
    // Same subject, different tenants isolate.
    let k_t = make_key("tenant-2", "sub-alice", "cred-1").unwrap();
    assert_ne!(k_a, k_t);
    // Raw subject separator cannot collide via encoding.
    let k1 = make_key("a/b", "c", "cred").unwrap();
    let k2 = make_key("a", "b/c", "cred").unwrap();
    assert_ne!(k1, k2);
}

#[test]
fn vault_rejects_username_as_namespace_field_in_source() {
    let vault_src = include_str!("vault.rs");
    // Production make_key must bind subject, never principal.user_id.
    assert!(
        !vault_src.contains("make_key(&principal.tenant_id, &principal.user_id"),
        "vault must not namespace on username user_id"
    );
    assert!(
        !vault_src.contains(
            "make_key(&expected_principal.tenant_id,\n            &expected_principal.user_id"
        ),
        "lease path must use subject"
    );
    assert!(
        vault_src.contains("make_key(&principal.tenant_id, &principal.subject"),
        "vault must namespace on Logto subject"
    );
    assert!(
        vault_src.contains("/// Never uses username / user_id"),
        "make_key docs must forbid username namespace"
    );
    // StoredCredential field is subject, not user_id.
    assert!(vault_src.contains("subject: String,"));
    assert!(
        !vault_src.contains("user_id: principal.user_id"),
        "must not write username into stored vault records"
    );
}

#[test]
fn vault_lib_forbids_temp_dir_snapshot_fallback() {
    let lib = include_str!("lib.rs");
    assert!(
        !lib.contains("temp_dir().join(\"opsmate-desktop\")"),
        "app_data_dir must never fall back to temp_dir for vault/SSH data"
    );
    assert!(
        lib.contains("app_data_dir().map_err") || lib.contains("app_data_dir()\n"),
        "setup must require app_data_dir"
    );
}

#[test]
fn vault_lock_and_logout_close_ssh_before_seal() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    struct OrderSink {
        events: StdMutex<Vec<&'static str>>,
        closes: AtomicUsize,
    }
    impl SessionLifecycleSink for OrderSink {
        fn close_all_sessions(&self) {
            self.closes.fetch_add(1, Ordering::SeqCst);
            self.events.lock().unwrap().push("close_all_ssh");
        }
        fn close_sessions_for_credential(&self, _: &crate::auth::NativePrincipal, _: &str) {
            self.events.lock().unwrap().push("close_cred_ssh");
        }
    }

    let path = temp_snapshot();
    let auth = authed("tnt-order", "user-order");
    let vault = VaultService::new(path.clone());
    let sink = Arc::new(OrderSink {
        events: StdMutex::new(Vec::new()),
        closes: AtomicUsize::new(0),
    });
    vault.set_session_lifecycle_sink(sink.clone());
    vault
        .init_with_password(None, Zeroizing::new("pw-order".into()))
        .unwrap();
    // Unlock with same password for ops.
    vault
        .unlock_with_password(&auth, Zeroizing::new("pw-order".into()))
        .unwrap();
    assert!(vault.status().unwrap().unlocked);

    sink.events.lock().unwrap().clear();
    vault.lock().unwrap();
    assert!(!vault.status().unwrap().unlocked);
    assert_eq!(sink.closes.load(Ordering::SeqCst), 1);
    assert_eq!(
        sink.events.lock().unwrap().as_slice(),
        &["close_all_ssh"][..]
    );

    // Re-unlock then logout path.
    vault
        .unlock_with_password(&auth, Zeroizing::new("pw-order".into()))
        .unwrap();
    sink.events.lock().unwrap().clear();
    vault.on_logout().unwrap();
    assert_eq!(
        vault.status().unwrap().locked_reason.as_deref(),
        Some("logout")
    );
    assert_eq!(
        sink.events.lock().unwrap().as_slice(),
        &["close_all_ssh"][..]
    );
    cleanup(&path);
}

#[test]
fn vault_delete_local_closes_cred_ssh_before_store_mutation() {
    use std::sync::Arc;

    struct OrderSink {
        events: StdMutex<Vec<&'static str>>,
    }
    impl SessionLifecycleSink for OrderSink {
        fn close_all_sessions(&self) {
            self.events.lock().unwrap().push("close_all_ssh");
        }
        fn close_sessions_for_credential(&self, _: &crate::auth::NativePrincipal, cid: &str) {
            assert_eq!(cid, "cred-del");
            self.events.lock().unwrap().push("close_cred_ssh");
        }
    }

    let path = temp_snapshot();
    let auth = authed("tnt-del", "user-del");
    let vault = VaultService::new(path.clone());
    let sink = Arc::new(OrderSink {
        events: StdMutex::new(Vec::new()),
    });
    vault.set_session_lifecycle_sink(sink.clone());
    vault
        .init_with_password(None, Zeroizing::new("pw-del".into()))
        .unwrap();
    vault
        .unlock_with_password(&auth, Zeroizing::new("pw-del".into()))
        .unwrap();

    // Missing credential: still closes scoped SSH before store NotFound.
    sink.events.lock().unwrap().clear();
    let err = vault.delete_local(&auth, "cred-del").unwrap_err();
    assert!(
        matches!(err, VaultError::NotFound),
        "expected NotFound after close, got {err:?}"
    );
    assert_eq!(
        sink.events.lock().unwrap().as_slice(),
        &["close_cred_ssh"][..],
        "delete_local must close credential SSH before store mutation"
    );
    cleanup(&path);
}
