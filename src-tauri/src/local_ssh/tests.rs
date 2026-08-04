//! Task 8B1 local SSH preparation tests (deterministic seams; no sleeps).

use super::*;
use crate::auth::{AuthBinding, AuthStore};
use crate::cloud_bridge::{CloudBridge, SpyEmitter};
use crate::cloud_transport::client::MockHttpBackend;
use crate::security_cutoff::SecurityCutoff;
use crate::vault::{make_key, VaultService};
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;
use tauri_plugin_stronghold::stronghold::Stronghold;

const CLIENT_PATH: &[u8] = b"opsmate-vault-client";
const INDEX_KEY: &[u8] = b"__opsmate_credential_index__";

/// Canonical OpenSSH SHA-256 fingerprint (unpadded only; russh Display form).
const VALID_HOST_KEY_FP: &str = "SHA256:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
/// Padded form must be rejected (not canonical OpenSSH).
const PADDED_HOST_KEY_FP: &str = "SHA256:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

fn temp_hold(tag: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "opsmate-8b1-{}-{}-{}.hold",
        tag,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    p
}

fn cleanup(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let mut salt = path.as_os_str().to_os_string();
    salt.push(".salt");
    let _ = std::fs::remove_file(std::path::PathBuf::from(salt));
}

fn spy() -> Arc<SpyEmitter> {
    Arc::new(SpyEmitter::new())
}

fn valid_server_json(server_id: &str, tenant: &str, cred: &str) -> String {
    json!({
        "id": server_id,
        "tenant_id": tenant,
        "ip": "10.0.1.10",
        "ssh_port": 22,
        "ssh_user": "admin",
        "ssh_credential_id": cred,
        "name": "prod-web",
        "host_key_type": null,
        "host_key_fingerprint": null
    })
    .to_string()
}

fn inject_vault_with_cred(
    auth: &AuthStore,
    credential_id: &str,
) -> (Arc<VaultService>, std::path::PathBuf) {
    let path = temp_hold("vault");
    let sh = Stronghold::new(&path, vec![0x8Bu8; 32]).expect("stronghold");
    sh.create_client(CLIENT_PATH).expect("client");
    let principal = auth.native_principal().expect("principal");
    let binding = auth.auth_binding().expect("binding");
    let store_key = make_key(&principal.tenant_id, &principal.subject, credential_id).unwrap();
    let rec = json!({
        "tenant_id": principal.tenant_id,
        "subject": principal.subject,
        "credential_id": credential_id,
        "fingerprint": "SHA256:leasefp8b1",
        "pem": "-----BEGIN SECRET 8B1 PEM-----\n",
        "passphrase": "secret-pass-8b1"
    });
    let client = sh.get_client(CLIENT_PATH).unwrap();
    client
        .store()
        .insert(
            store_key.as_bytes().to_vec(),
            serde_json::to_vec(&rec).unwrap(),
            None,
        )
        .unwrap();
    client
        .store()
        .insert(
            INDEX_KEY.to_vec(),
            serde_json::to_vec(&json!({ "entries": [store_key] })).unwrap(),
            None,
        )
        .unwrap();
    let vault = Arc::new(VaultService::new(path.clone()));
    vault.test_inject_unlocked(sh, binding, path.clone(), Instant::now());
    (vault, path)
}

fn unlocked_cutoff() -> Arc<SecurityCutoff> {
    let c = Arc::new(SecurityCutoff::new());
    c.unlock_vault_for_tests();
    c
}

fn bridge_with(
    auth: Arc<AuthStore>,
    vault: Arc<VaultService>,
    body: &str,
    cutoff: Arc<SecurityCutoff>,
) -> CloudBridge<MockHttpBackend> {
    CloudBridge::with_backend_cutoff(auth, vault, MockHttpBackend::new(body), cutoff, spy())
}

// ─── DTO ─────────────────────────────────────────────────────────────────────

#[test]
fn local_ssh_open_request_accepts_only_server_and_credential_ids() {
    let ok: LocalSshOpenRequest = serde_json::from_value(json!({
        "serverId": "srv-1",
        "credentialId": "cred-1"
    }))
    .unwrap();
    assert_eq!(ok.server_id, "srv-1");
    assert_eq!(ok.credential_id, "cred-1");
}

#[test]
fn local_ssh_open_request_rejects_extras_and_secret_fields() {
    let cases = [
        json!({"serverId": "s", "credentialId": "c", "tenantId": "t"}),
        json!({"serverId": "s", "credentialId": "c", "tenant": "t"}),
        json!({"serverId": "s", "credentialId": "c", "subject": "sub"}),
        json!({"serverId": "s", "credentialId": "c", "user": "u"}),
        json!({"serverId": "s", "credentialId": "c", "host": "1.2.3.4"}),
        json!({"serverId": "s", "credentialId": "c", "ip": "1.2.3.4"}),
        json!({"serverId": "s", "credentialId": "c", "port": 22}),
        json!({"serverId": "s", "credentialId": "c", "username": "root"}),
        json!({"serverId": "s", "credentialId": "c", "token": "t"}),
        json!({"serverId": "s", "credentialId": "c", "key": "k"}),
        json!({"serverId": "s", "credentialId": "c", "pem": "p"}),
        json!({"serverId": "s", "credentialId": "c", "passphrase": "x"}),
        json!({"serverId": "s", "credentialId": "c", "extra": 1}),
        json!({"serverId": "s"}),     // missing credentialId
        json!({"credentialId": "c"}), // missing serverId
    ];
    for v in cases {
        assert!(
            serde_json::from_value::<LocalSshOpenRequest>(v.clone()).is_err(),
            "must reject {v}"
        );
    }
}

#[test]
fn local_ssh_open_request_rejects_unbounded_or_smuggling_ids() {
    let long = "x".repeat(200);
    let bad_ids = [
        "",
        "../evil",
        "a/b",
        "a\\b",
        "has space",
        long.as_str(),
        "null\0byte",
    ];
    // Deserialization may succeed; prepare must reject via validate_id.
    for id in bad_ids {
        let req = LocalSshOpenRequest {
            server_id: id.to_string(),
            credential_id: "cred-ok".into(),
        };
        // Synchronous validate path via invalid server id on prepare needs runtime —
        // exercise map through a minimal blocked call using empty auth.
        // Direct: invalid ids fail before any cloud/auth with InvalidInput.
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("ten", "user", "admin", "sub");
        let (vault, path) = inject_vault_with_cred(&auth, "cred-ok");
        let cutoff = unlocked_cutoff();
        let bridge = bridge_with(
            auth,
            vault,
            &valid_server_json("srv-1", "ten", "cred-ok"),
            cutoff,
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(prepare_local_ssh_open(&bridge, &req));
        assert!(
            matches!(err, Err(LocalSshError::InvalidInput)),
            "id {id:?} => {err:?}"
        );
        let _ = bridge.vault.lock();
        cleanup(&path);
    }
}

// ─── Happy path + metadata ───────────────────────────────────────────────────

#[tokio::test]
async fn prepare_valid_metadata_and_lease_succeeds() {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    let cutoff = unlocked_cutoff();
    let gen0 = cutoff.ssh_generation();
    let body = valid_server_json("srv-1", "tenant-a", "cred-1");
    let bridge = bridge_with(auth.clone(), vault, &body, cutoff.clone());
    let req = LocalSshOpenRequest {
        server_id: "srv-1".into(),
        credential_id: "cred-1".into(),
    };
    let prep = prepare_local_ssh_open(&bridge, &req).await.unwrap();
    assert_eq!(prep.server_id, "srv-1");
    assert_eq!(prep.credential_id, "cred-1");
    assert_eq!(prep.target_host, "10.0.1.10");
    assert_eq!(prep.ssh_port, 22);
    assert_eq!(prep.ssh_user, "admin");
    assert!(prep.host_key.is_none());
    assert_eq!(prep.ssh_generation, gen0);
    assert_eq!(prep.principal.tenant_id, "tenant-a");
    assert_eq!(prep.epoch, auth.auth_binding().unwrap().epoch);
    assert!(prep.lease.pem.contains("SECRET 8B1"));
    let _ = bridge.vault.lock();
    cleanup(&path);
}

#[tokio::test]
async fn prepare_accepts_both_host_key_fields_present() {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    let mut body: serde_json::Value =
        serde_json::from_str(&valid_server_json("srv-1", "tenant-a", "cred-1")).unwrap();
    body["host_key_type"] = json!("ssh-ed25519");
    body["host_key_fingerprint"] = json!(VALID_HOST_KEY_FP);
    let bridge = bridge_with(auth, vault, &body.to_string(), unlocked_cutoff());
    let prep = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap();
    let hk = prep.host_key.unwrap();
    assert_eq!(hk.key_type, "ssh-ed25519");
    assert_eq!(hk.fingerprint, VALID_HOST_KEY_FP);
    let _ = bridge.vault.lock();
    cleanup(&path);
}

// ─── Isolation / mismatch ────────────────────────────────────────────────────

#[tokio::test]
async fn prepare_rejects_server_id_mismatch() {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    // Cloud returns different id than requested.
    let body = valid_server_json("srv-OTHER", "tenant-a", "cred-1");
    let bridge = bridge_with(auth, vault, &body, unlocked_cutoff());
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::MetadataMismatch);
    let _ = bridge.vault.lock();
    cleanup(&path);
}

#[tokio::test]
async fn prepare_rejects_tenant_ab_isolation() {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-A", "alice", "admin", "sub-a");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    // Online metadata claims tenant-B.
    let body = valid_server_json("srv-1", "tenant-B", "cred-1");
    let bridge = bridge_with(auth, vault, &body, unlocked_cutoff());
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::MetadataMismatch);
    let _ = bridge.vault.lock();
    cleanup(&path);
}

#[tokio::test]
async fn prepare_rejects_credential_id_mismatch() {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    let body = valid_server_json("srv-1", "tenant-a", "cred-OTHER");
    let bridge = bridge_with(auth, vault, &body, unlocked_cutoff());
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::MetadataMismatch);
    let _ = bridge.vault.lock();
    cleanup(&path);
}

// ─── Invalid host / port / user / host-key ───────────────────────────────────

async fn assert_invalid_metadata(mutate: impl FnOnce(&mut serde_json::Value)) {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    let mut body: serde_json::Value =
        serde_json::from_str(&valid_server_json("srv-1", "tenant-a", "cred-1")).unwrap();
    mutate(&mut body);
    let bridge = bridge_with(auth, vault, &body.to_string(), unlocked_cutoff());
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::InvalidMetadata);
    let _ = bridge.vault.lock();
    cleanup(&path);
}

#[tokio::test]
async fn prepare_rejects_blank_or_url_host() {
    assert_invalid_metadata(|b| {
        b["ip"] = json!("");
    })
    .await;
    assert_invalid_metadata(|b| {
        b["ip"] = json!("http://evil");
    })
    .await;
    assert_invalid_metadata(|b| {
        b["ip"] = json!("10.0.0.1/24");
    })
    .await;
    assert_invalid_metadata(|b| {
        b["ip"] = json!("host with space");
    })
    .await;
    assert_invalid_metadata(|b| {
        b["ip"] = json!("user@host");
    })
    .await;
}

#[tokio::test]
async fn prepare_rejects_invalid_port_and_string_coercion() {
    assert_invalid_metadata(|b| {
        b["ssh_port"] = json!(0);
    })
    .await;
    assert_invalid_metadata(|b| {
        b["ssh_port"] = json!(65536);
    })
    .await;
    assert_invalid_metadata(|b| {
        b["ssh_port"] = json!("22");
    })
    .await;
    assert_invalid_metadata(|b| {
        b["ssh_port"] = json!(22.5);
    })
    .await;
    assert_invalid_metadata(|b| {
        b["ssh_port"] = json!(-1);
    })
    .await;
}

#[tokio::test]
async fn prepare_rejects_invalid_ssh_user() {
    assert_invalid_metadata(|b| {
        b["ssh_user"] = json!("");
    })
    .await;
    assert_invalid_metadata(|b| {
        b["ssh_user"] = json!("has space");
    })
    .await;
    assert_invalid_metadata(|b| {
        b["ssh_user"] = json!("user\nname");
    })
    .await;
}

#[tokio::test]
async fn prepare_rejects_partial_or_invalid_host_key() {
    assert_invalid_metadata(|b| {
        b["host_key_type"] = json!("ssh-ed25519");
        b["host_key_fingerprint"] = json!(null);
    })
    .await;
    assert_invalid_metadata(|b| {
        b["host_key_type"] = json!(null);
        b["host_key_fingerprint"] = json!(VALID_HOST_KEY_FP);
    })
    .await;
    assert_invalid_metadata(|b| {
        b["host_key_type"] = json!("ssh-unknown-algo");
        b["host_key_fingerprint"] = json!(VALID_HOST_KEY_FP);
    })
    .await;
    assert_invalid_metadata(|b| {
        b["host_key_type"] = json!("ssh-ed25519");
        b["host_key_fingerprint"] = json!("MD5:aa:bb");
    })
    .await;
    // Too short / not 32-byte digest.
    assert_invalid_metadata(|b| {
        b["host_key_type"] = json!("ssh-ed25519");
        b["host_key_fingerprint"] = json!("SHA256:x");
    })
    .await;
    assert_invalid_metadata(|b| {
        b["host_key_type"] = json!("ssh-ed25519");
        b["host_key_fingerprint"] = json!("SHA256:abc");
    })
    .await;
    // URL-safe alphabet rejected.
    assert_invalid_metadata(|b| {
        b["host_key_type"] = json!("ssh-ed25519");
        b["host_key_fingerprint"] = json!("SHA256:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8_");
    })
    .await;
    // Padded form rejected (canonical OpenSSH is unpadded).
    assert_invalid_metadata(|b| {
        b["host_key_type"] = json!("ssh-ed25519");
        b["host_key_fingerprint"] = json!(PADDED_HOST_KEY_FP);
    })
    .await;
    // Excess padding / double pad.
    assert_invalid_metadata(|b| {
        b["host_key_type"] = json!("ssh-ed25519");
        b["host_key_fingerprint"] = json!("SHA256:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8==");
    })
    .await;
    // Misplaced padding.
    assert_invalid_metadata(|b| {
        b["host_key_type"] = json!("ssh-ed25519");
        b["host_key_fingerprint"] = json!("SHA256:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwd=Hh8");
    })
    .await;
    // Wrong length (too long unpadded).
    assert_invalid_metadata(|b| {
        b["host_key_type"] = json!("ssh-ed25519");
        b["host_key_fingerprint"] = json!("SHA256:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8AAAA");
    })
    .await;
    // SHA-512 is parseable but not accepted (must be SHA-256).
    assert_invalid_metadata(|b| {
        b["host_key_type"] = json!("ssh-ed25519");
        // 64-byte all-zero SHA512 unpadded base64 (86 chars) — if parse works, is_sha256 fails.
        b["host_key_fingerprint"] = json!(
            "SHA512:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        );
    })
    .await;
}

#[tokio::test]
async fn prepare_rejects_array_response_and_aliases() {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    let bridge = bridge_with(
        auth.clone(),
        vault.clone(),
        &json!([{"id":"srv-1"}]).to_string(),
        unlocked_cutoff(),
    );
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::InvalidMetadata);
    let _ = bridge.vault.lock();
    cleanup(&path);

    // Ambiguous alias `host` present.
    let (vault2, path2) = inject_vault_with_cred(&auth, "cred-1");
    let mut body: serde_json::Value =
        serde_json::from_str(&valid_server_json("srv-1", "tenant-a", "cred-1")).unwrap();
    body["host"] = json!("10.0.0.1");
    let bridge2 = bridge_with(auth.clone(), vault2, &body.to_string(), unlocked_cutoff());
    let err2 = prepare_local_ssh_open(
        &bridge2,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err2, LocalSshError::InvalidMetadata);
    let _ = bridge2.vault.lock();
    cleanup(&path2);
}

/// Non-canonical spellings of trusted keys (separator-insensitive) are rejected.
#[tokio::test]
async fn prepare_rejects_normalized_colliding_response_keys() {
    for bad_key in [
        "ID",
        "TENANT_ID",
        "tenantId",
        "ssh-port",
        "SSH_USER",
        "HostKeyFingerprint",
        "host_key_Type",
        "sshCredentialId", // collides with ssh_credential_id via normalization? sshcredentialid == sshcredentialid yes
    ] {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
        let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
        let mut body: serde_json::Value =
            serde_json::from_str(&valid_server_json("srv-1", "tenant-a", "cred-1")).unwrap();
        // Extra colliding key alongside exact trusted fields.
        body[bad_key] = json!("evil");
        let bridge = bridge_with(auth, vault, &body.to_string(), unlocked_cutoff());
        let err = prepare_local_ssh_open(
            &bridge,
            &LocalSshOpenRequest {
                server_id: "srv-1".into(),
                credential_id: "cred-1".into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            err,
            LocalSshError::InvalidMetadata,
            "must reject colliding key {bad_key}"
        );
        let _ = bridge.vault.lock();
        cleanup(&path);
    }
}

// ─── Cloud errors ────────────────────────────────────────────────────────────

#[tokio::test]
async fn prepare_maps_cloud_http_error_to_online_metadata_required() {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    let backend = MockHttpBackend::new(r#"{"error":"LEAK_BODY status=500 token=sekrit"}"#);
    backend.set_status(500);
    let bridge = CloudBridge::with_backend_cutoff(auth, vault, backend, unlocked_cutoff(), spy());
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::OnlineMetadataRequired);
    let code = map_local_ssh_public(err);
    assert_eq!(code, "local_ssh_online_metadata_required");
    assert!(!code.contains("500"));
    assert!(!code.contains("LEAK"));
    assert!(!code.contains("sekrit"));
    let _ = bridge.vault.lock();
    cleanup(&path);
}

#[tokio::test]
async fn prepare_maps_invalid_json_body_to_online_metadata_required() {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    let bridge = bridge_with(auth, vault, "not-json{{{", unlocked_cutoff());
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::OnlineMetadataRequired);
    let _ = bridge.vault.lock();
    cleanup(&path);
}

// ─── Auth / cutoff races ─────────────────────────────────────────────────────

#[tokio::test]
async fn prepare_fails_when_unauthenticated() {
    let auth = Arc::new(AuthStore::new());
    let vault = Arc::new(VaultService::new(temp_hold("empty")));
    let bridge = bridge_with(
        auth,
        vault,
        &valid_server_json("srv-1", "t", "c"),
        unlocked_cutoff(),
    );
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::Unauthenticated);
}

/// Deterministic epoch race: backend advances auth epoch during cloud round-trip so
/// post-metadata revalidation fails with BindingMismatch (no sleep/timing).
#[tokio::test]
async fn prepare_fails_when_auth_epoch_changes_during_metadata() {
    use crate::cloud_transport::{BackendResponse, BuiltRequest, HttpBackend, TransportError};

    struct EpochSwitchBackend {
        body: String,
        auth: Arc<AuthStore>,
    }

    impl HttpBackend for EpochSwitchBackend {
        fn execute(
            &self,
            _request: BuiltRequest,
        ) -> impl std::future::Future<Output = Result<BackendResponse, TransportError>> + Send
        {
            let body = self.body.clone();
            let auth = self.auth.clone();
            async move {
                // Mid-flight: reinstall session → new epoch, same principal.
                let _ = auth.clear_native();
                auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
                Ok(BackendResponse {
                    status: 200,
                    body: body.into_bytes(),
                })
            }
        }
    }

    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let captured = auth.auth_binding().unwrap();
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    let backend = EpochSwitchBackend {
        body: valid_server_json("srv-1", "tenant-a", "cred-1"),
        auth: auth.clone(),
    };
    let bridge =
        CloudBridge::with_backend_cutoff(auth.clone(), vault, backend, unlocked_cutoff(), spy());
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::BindingMismatch);
    assert!(!auth.binding_still_current(&captured));
    assert_eq!(map_local_ssh_public(err), "local_ssh_binding_mismatch");
    let _ = bridge.vault.lock();
    cleanup(&path);
}

#[tokio::test]
async fn prepare_fails_when_cutoff_or_stronghold_locked() {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    let cutoff = unlocked_cutoff();
    cutoff.lock_vault();
    assert!(cutoff.is_vault_locked());
    let bridge = bridge_with(
        auth,
        vault,
        &valid_server_json("srv-1", "tenant-a", "cred-1"),
        cutoff.clone(),
    );
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::VaultLocked);

    let auth3 = Arc::new(AuthStore::new());
    auth3.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let (vault3, path3) = inject_vault_with_cred(&auth3, "cred-1");
    let _ = vault3.lock();
    let bridge3 = bridge_with(
        auth3,
        vault3,
        &valid_server_json("srv-1", "tenant-a", "cred-1"),
        unlocked_cutoff(),
    );
    let err3 = prepare_local_ssh_open(
        &bridge3,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err3, LocalSshError::VaultLocked);
    cleanup(&path);
    cleanup(&path3);
}

/// Deterministic SSH generation race via GenBumpBackend during cloud round-trip.
#[tokio::test]
async fn prepare_fails_closed_when_ssh_generation_invalidated_before_lease() {
    use crate::cloud_transport::{BackendResponse, BuiltRequest, HttpBackend, TransportError};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct GenBumpBackend {
        body: String,
        cutoff: Arc<SecurityCutoff>,
        hits: AtomicUsize,
    }

    impl HttpBackend for GenBumpBackend {
        fn execute(
            &self,
            _request: BuiltRequest,
        ) -> impl std::future::Future<Output = Result<BackendResponse, TransportError>> + Send
        {
            let body = self.body.clone();
            let cutoff = self.cutoff.clone();
            let n = self.hits.fetch_add(1, Ordering::SeqCst);
            async move {
                // After the request is "in flight", advance SSH generation so
                // post-cloud revalidation sees a stale capture.
                if n == 0 {
                    let _ = cutoff.close_all_ssh();
                }
                Ok(BackendResponse {
                    status: 200,
                    body: body.into_bytes(),
                })
            }
        }
    }

    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    let cutoff = unlocked_cutoff();
    let gen0 = cutoff.ssh_generation();
    let backend = GenBumpBackend {
        body: valid_server_json("srv-1", "tenant-a", "cred-1"),
        cutoff: cutoff.clone(),
        hits: AtomicUsize::new(0),
    };
    let bridge = CloudBridge::with_backend_cutoff(auth, vault, backend, cutoff.clone(), spy());
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::SshCutoff);
    assert!(!cutoff.ssh_session_still_valid(gen0));
    assert_eq!(map_local_ssh_public(err), "local_ssh_ssh_cutoff");
    let _ = bridge.vault.lock();
    cleanup(&path);
}

// ─── Missing credential / Debug ──────────────────────────────────────────────

#[tokio::test]
async fn prepare_missing_local_credential_not_found() {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    // Vault unlocked but no credential stored for cred-1.
    let path = temp_hold("empty-cred");
    let sh = Stronghold::new(&path, vec![0x11u8; 32]).expect("sh");
    sh.create_client(CLIENT_PATH).unwrap();
    let client = sh.get_client(CLIENT_PATH).unwrap();
    client
        .store()
        .insert(
            INDEX_KEY.to_vec(),
            serde_json::to_vec(&json!({ "entries": [] })).unwrap(),
            None,
        )
        .unwrap();
    let vault = Arc::new(VaultService::new(path.clone()));
    vault.test_inject_unlocked(
        sh,
        auth.auth_binding().unwrap(),
        path.clone(),
        Instant::now(),
    );
    let bridge = bridge_with(
        auth,
        vault,
        &valid_server_json("srv-1", "tenant-a", "cred-1"),
        unlocked_cutoff(),
    );
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::CredentialNotFound);
    assert_eq!(map_local_ssh_public(err), "local_ssh_credential_not_found");
    let _ = bridge.vault.lock();
    cleanup(&path);
}

#[tokio::test]
async fn prepared_debug_redacts_lease_and_identity_secrets() {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-secret", "alice", "admin", "sub-secret-xyz");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-secret");
    let bridge = bridge_with(
        auth,
        vault,
        &valid_server_json("srv-secret", "tenant-secret", "cred-secret"),
        unlocked_cutoff(),
    );
    let prep = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-secret".into(),
            credential_id: "cred-secret".into(),
        },
    )
    .await
    .unwrap();
    let dbg = format!("{prep:?}");
    assert!(dbg.contains("PreparedLocalSshOpen"));
    assert!(dbg.contains("<redacted>"));
    assert!(!dbg.contains("SECRET 8B1"));
    assert!(!dbg.contains("secret-pass-8b1"));
    assert!(!dbg.contains("tenant-secret"));
    assert!(!dbg.contains("sub-secret-xyz"));
    assert!(!dbg.contains("cred-secret"));
    assert!(!dbg.contains("srv-secret"));
    assert!(!dbg.contains("10.0.1.10"));
    // Type-level: no Serialize / Clone on PreparedLocalSshOpen.
    let src = include_str!("prepare.rs");
    let block = src
        .split("pub struct PreparedLocalSshOpen")
        .nth(1)
        .unwrap()
        .split("impl std::fmt::Debug for PreparedLocalSshOpen")
        .next()
        .unwrap();
    assert!(!block.contains("Serialize"));
    assert!(!block.contains("Clone"));
    // Crate-internal only; no IPC registration.
    let lib = include_str!("../lib.rs");
    assert!(!lib.contains("local_ssh_open"));
    assert!(lib.contains("pub(crate) mod local_ssh"));
    assert!(!lib.contains("pub mod local_ssh;"));
    let _ = bridge.vault.lock();
    cleanup(&path);
}

/// Duplicate identity keys in raw cloud JSON must fail before any vault lease.
#[tokio::test]
async fn prepare_duplicate_json_keys_online_metadata_no_lease() {
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("tenant-a", "alice", "admin", "sub-a");
    let (vault, path) = inject_vault_with_cred(&auth, "cred-1");
    // Last-wins would yield id=srv-1 matching request; must reject instead.
    let raw = r#"{
        "id":"srv-A",
        "id":"srv-1",
        "tenant_id":"tenant-a",
        "ip":"10.0.1.10",
        "ssh_port":22,
        "ssh_user":"admin",
        "ssh_credential_id":"cred-1"
    }"#;
    let bridge = bridge_with(auth, vault, raw, unlocked_cutoff());
    let err = prepare_local_ssh_open(
        &bridge,
        &LocalSshOpenRequest {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err, LocalSshError::OnlineMetadataRequired);
    assert_eq!(
        map_local_ssh_public(err),
        "local_ssh_online_metadata_required"
    );
    // Vault still unlocked — lease never ran (credential material not touched).
    assert!(bridge.vault.is_unlocked());
    let _ = bridge.vault.lock();
    cleanup(&path);
}

#[test]
fn public_error_codes_are_fixed_and_secret_free() {
    for e in [
        LocalSshError::InvalidInput,
        LocalSshError::Unauthenticated,
        LocalSshError::BindingMismatch,
        LocalSshError::VaultLocked,
        LocalSshError::SshCutoff,
        LocalSshError::OnlineMetadataRequired,
        LocalSshError::MetadataMismatch,
        LocalSshError::InvalidMetadata,
        LocalSshError::CredentialNotFound,
        LocalSshError::HostKeyMismatch,
        LocalSshError::HostKeyRejectedByUser,
        LocalSshError::CloudHostKeyWriteFailed,
        LocalSshError::LocalKnownHostsFailed,
        LocalSshError::AuthenticationFailed,
        LocalSshError::ConnectFailed,
        LocalSshError::Internal,
    ] {
        let s = map_local_ssh_public(e);
        assert!(s.starts_with("local_ssh_"), "{s}");
        assert!(!s.contains("http"));
        assert!(!s.contains("Bearer"));
        assert!(!s.contains("token"));
        assert_eq!(s, e.to_string());
    }
}

// silence unused AuthBinding import if not used
#[allow(dead_code)]
fn _binding_ty(_: AuthBinding) {}
