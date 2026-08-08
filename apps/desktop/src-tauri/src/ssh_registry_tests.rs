//! D4B1 — session registry / DTO / lifecycle unit tests (no real network).

use super::*;
use crate::auth::{AuthStore, RandomSource};
use crate::ssh_session::PreparedSshTarget;
use crate::vault::{SessionLifecycleSink, VaultService};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ─── Mocks ───────────────────────────────────────────────────────────────────

struct SeqRng {
    /// Each call returns the next preloaded 32-byte block (cycled if exhausted).
    blocks: Mutex<Vec<[u8; 32]>>,
    idx: Mutex<usize>,
    fail: Mutex<bool>,
}

impl SeqRng {
    fn from_blocks(blocks: Vec<[u8; 32]>) -> Self {
        Self {
            blocks: Mutex::new(blocks),
            idx: Mutex::new(0),
            fail: Mutex::new(false),
        }
    }
    fn single(b: [u8; 32]) -> Self {
        Self::from_blocks(vec![b])
    }
}

impl RandomSource for SeqRng {
    fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), crate::auth::AuthError> {
        if *self.fail.lock().unwrap() {
            return Err(crate::auth::AuthError::Random);
        }
        let blocks = self.blocks.lock().unwrap();
        let mut idx = self.idx.lock().unwrap();
        let b = blocks
            .get(*idx % blocks.len())
            .copied()
            .unwrap_or([0u8; 32]);
        *idx += 1;
        let n = dest.len().min(32);
        dest[..n].copy_from_slice(&b[..n]);
        if dest.len() > 32 {
            dest[32..].fill(0);
        }
        Ok(())
    }
}

struct MockTransport {
    closes: Arc<AtomicUsize>,
    writes: Mutex<Vec<Vec<u8>>>,
    resizes: Mutex<Vec<(u32, u32)>>,
    closed: AtomicBool,
}

impl MockTransport {
    fn new(closes: Arc<AtomicUsize>) -> Arc<Self> {
        Arc::new(Self {
            closes,
            writes: Mutex::new(Vec::new()),
            resizes: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
        })
    }
}

impl LocalSshTransport for MockTransport {
    fn write(&self, data: &[u8]) -> Result<(), SshSessionError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(SshSessionError::AuthorizationFailed);
        }
        self.writes.lock().unwrap().push(data.to_vec());
        Ok(())
    }
    fn resize(&self, cols: u32, rows: u32) -> Result<(), SshSessionError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(SshSessionError::AuthorizationFailed);
        }
        self.resizes.lock().unwrap().push((cols, rows));
        Ok(())
    }
    fn close(&self) -> Result<(), SshSessionError> {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.closes.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

struct MockConnector {
    fail: Mutex<bool>,
    closes: Arc<AtomicUsize>,
    connects: AtomicUsize,
}

impl MockConnector {
    fn ok(closes: Arc<AtomicUsize>) -> Self {
        Self {
            fail: Mutex::new(false),
            closes,
            connects: AtomicUsize::new(0),
        }
    }
}

impl LocalSshConnector for MockConnector {
    fn connect(
        &self,
        _target: &PreparedSshTarget,
    ) -> Result<Arc<dyn LocalSshTransport>, SshSessionError> {
        self.connects.fetch_add(1, Ordering::SeqCst);
        if *self.fail.lock().unwrap() {
            return Err(SshSessionError::Internal);
        }
        Ok(MockTransport::new(Arc::clone(&self.closes)))
    }
}

fn authed(tenant: &str, user: &str) -> AuthStore {
    let a = AuthStore::new();
    a.install_session_for_tests(tenant, user, "admin");
    a
}

fn bound_target(auth: &AuthStore, server: &str, cred: &str) -> PreparedSshTarget {
    let snap = auth.native_auth_snapshot().unwrap();
    PreparedSshTarget {
        server_id: server.into(),
        name: "n".into(),
        host: "10.0.0.1".into(),
        port: 22,
        username: "ubuntu".into(),
        credential_id: cred.into(),
        host_key_status: crate::ssh_session::HostKeyStatus::Pinned,
        host_key_type: Some("ssh-ed25519".into()),
        host_key_fingerprint: Some("SHA256:x".into()),
        principal: snap.principal,
        session_epoch: snap.epoch,
    }
}

// ─── Session ID ──────────────────────────────────────────────────────────────

#[test]
fn local_ssh_session_id_is_32_byte_base64url_no_timestamp() {
    let mut block = [0u8; 32];
    for (i, b) in block.iter_mut().enumerate() {
        *b = i as u8;
    }
    let rng = SeqRng::single(block);
    let id = generate_session_id(&rng, &|_| false).unwrap();
    assert_eq!(id, crate::auth::base64url_nopad(&block));
    // base64url alphabet only
    assert!(id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    assert!(!id.contains('+') && !id.contains('/') && !id.contains('='));
    // no obvious unix-ish timestamp prefix
    assert!(!id.starts_with("17") && !id.contains("202"));
}

#[test]
fn local_ssh_session_id_retries_on_collision() {
    let b1 = [1u8; 32];
    let b2 = [2u8; 32];
    let rng = SeqRng::from_blocks(vec![b1, b2]);
    let first = crate::auth::base64url_nopad(&b1);
    let id = generate_session_id(&rng, &|s| s == first).unwrap();
    assert_eq!(id, crate::auth::base64url_nopad(&b2));
    assert_ne!(id, first);
}

// ─── DTO strictness / bounds ─────────────────────────────────────────────────

#[test]
fn local_ssh_write_request_rejects_unknown_fields_and_oversize() {
    let ok = r#"{"sessionId":"abc","data":"hi"}"#;
    let r: LocalSshWriteRequest = serde_json::from_str(ok).unwrap();
    assert_eq!(r.session_id, "abc");
    assert!(validate_write_request(&r).is_ok());

    assert!(serde_json::from_str::<LocalSshWriteRequest>(
        r#"{"sessionId":"a","data":"x","extra":1}"#
    )
    .is_err());
    assert!(serde_json::from_str::<LocalSshWriteRequest>(
        r#"{"sessionId":"a","data":"x","token":"t"}"#
    )
    .is_err());

    let big = LocalSshWriteRequest {
        session_id: "s".into(),
        data: "x".repeat(MAX_SSH_WRITE_BYTES + 1),
    };
    assert!(matches!(
        validate_write_request(&big),
        Err(SshSessionError::InvalidMetadata)
    ));
    let exact = LocalSshWriteRequest {
        session_id: "s".into(),
        data: "x".repeat(MAX_SSH_WRITE_BYTES),
    };
    assert!(validate_write_request(&exact).is_ok());
}

#[test]
fn local_ssh_resize_request_bounds_and_unknown_fields() {
    let ok: LocalSshResizeRequest =
        serde_json::from_str(r#"{"sessionId":"s","cols":80,"rows":24}"#).unwrap();
    assert!(validate_resize_request(&ok).is_ok());
    assert!(serde_json::from_str::<LocalSshResizeRequest>(
        r#"{"sessionId":"s","cols":80,"rows":24,"extra":true}"#
    )
    .is_err());
    for (cols, rows) in [(0, 24), (80, 0), (1001, 24), (80, 1001)] {
        let r = LocalSshResizeRequest {
            session_id: "s".into(),
            cols,
            rows,
        };
        assert!(
            matches!(
                validate_resize_request(&r),
                Err(SshSessionError::InvalidMetadata)
            ),
            "cols={cols} rows={rows}"
        );
    }
    assert!(validate_resize_request(&LocalSshResizeRequest {
        session_id: "s".into(),
        cols: 1,
        rows: 1000,
    })
    .is_ok());
}

#[test]
fn local_ssh_close_request_session_id_only() {
    let ok: LocalSshCloseRequest = serde_json::from_str(r#"{"sessionId":"s1"}"#).unwrap();
    assert_eq!(ok.session_id, "s1");
    assert!(
        serde_json::from_str::<LocalSshCloseRequest>(r#"{"sessionId":"s1","force":true}"#).is_err()
    );
}

// ─── Registry open / write / authz ───────────────────────────────────────────

#[test]
fn local_ssh_open_registers_only_after_connector_success() {
    let auth = authed("tnt", "user");
    let target = bound_target(&auth, "srv-1", "cred-1");
    let closes = Arc::new(AtomicUsize::new(0));
    let conn = MockConnector::ok(Arc::clone(&closes));
    *conn.fail.lock().unwrap() = true;
    let mgr = LocalSshSessionManager::new();
    let rng = SeqRng::single([9u8; 32]);
    assert!(mgr.open_session(&auth, &target, &conn, &rng).is_err());
    assert_eq!(mgr.session_count(), 0);
    assert_eq!(conn.connects.load(Ordering::SeqCst), 1);

    *conn.fail.lock().unwrap() = false;
    let resp = mgr.open_session(&auth, &target, &conn, &rng).unwrap();
    assert!(!resp.session_id.is_empty());
    assert_eq!(mgr.session_count(), 1);
    let v = serde_json::to_value(&resp).unwrap();
    assert_eq!(v.as_object().unwrap().len(), 1);
    assert!(v.get("sessionId").is_some());
}

#[test]
fn local_ssh_write_revalidates_and_closes_on_epoch_mismatch() {
    let auth = authed("tnt", "user");
    let target = bound_target(&auth, "srv-1", "cred-1");
    let closes = Arc::new(AtomicUsize::new(0));
    let conn = MockConnector::ok(Arc::clone(&closes));
    let mgr = LocalSshSessionManager::new();
    let rng = SeqRng::single([3u8; 32]);
    let resp = mgr.open_session(&auth, &target, &conn, &rng).unwrap();

    // Logout+relogin same principal advances epoch → write fails and session removed.
    let _ = auth.clear_native();
    auth.install_session_for_tests("tnt", "user", "admin");
    let err = mgr
        .write(
            &auth,
            &LocalSshWriteRequest {
                session_id: resp.session_id.clone(),
                data: "x".into(),
            },
        )
        .unwrap_err();
    assert!(matches!(err, SshSessionError::AuthorizationFailed));
    assert_eq!(mgr.session_count(), 0);
    assert_eq!(closes.load(Ordering::SeqCst), 1);
}

#[test]
fn local_ssh_cross_principal_write_fails() {
    let auth_a = authed("tnt-a", "alice");
    let target = bound_target(&auth_a, "srv", "cred");
    let closes = Arc::new(AtomicUsize::new(0));
    let conn = MockConnector::ok(Arc::clone(&closes));
    let mgr = LocalSshSessionManager::new();
    let rng = SeqRng::single([4u8; 32]);
    let resp = mgr.open_session(&auth_a, &target, &conn, &rng).unwrap();

    let auth_b = authed("tnt-b", "bob");
    let err = mgr
        .write(
            &auth_b,
            &LocalSshWriteRequest {
                session_id: resp.session_id,
                data: "x".into(),
            },
        )
        .unwrap_err();
    assert!(matches!(err, SshSessionError::AuthorizationFailed));
    assert_eq!(mgr.session_count(), 0);
}

#[test]
fn local_ssh_close_idempotent_non_enumerating() {
    let auth = authed("tnt", "user");
    let target = bound_target(&auth, "srv", "cred");
    let closes = Arc::new(AtomicUsize::new(0));
    let conn = MockConnector::ok(Arc::clone(&closes));
    let mgr = LocalSshSessionManager::new();
    let rng = SeqRng::single([5u8; 32]);
    let resp = mgr.open_session(&auth, &target, &conn, &rng).unwrap();
    let req = LocalSshCloseRequest {
        session_id: resp.session_id.clone(),
    };
    mgr.close(&auth, &req).unwrap();
    assert_eq!(closes.load(Ordering::SeqCst), 1);
    // Second close and unknown id: success, no extra close, no existence leak.
    mgr.close(&auth, &req).unwrap();
    mgr.close(
        &auth,
        &LocalSshCloseRequest {
            session_id: "does-not-exist".into(),
        },
    )
    .unwrap();
    assert_eq!(closes.load(Ordering::SeqCst), 1);
    assert_eq!(mgr.session_count(), 0);
}

/// Cross-tenant isolation: leaked session_id must not let B close A's session.
/// Also: only current principal+epoch can close; own close works; repeated close is idempotent.
#[test]
fn local_ssh_close_requires_current_principal_epoch_binding() {
    let auth_a = authed("tnt-a", "alice");
    let target = bound_target(&auth_a, "srv", "cred");
    let closes = Arc::new(AtomicUsize::new(0));
    let conn = MockConnector::ok(Arc::clone(&closes));
    let mgr = LocalSshSessionManager::new();
    let rng = SeqRng::single([0xABu8; 32]);
    let resp = mgr.open_session(&auth_a, &target, &conn, &rng).unwrap();
    let req = LocalSshCloseRequest {
        session_id: resp.session_id.clone(),
    };

    // B holds a leaked session_id: Ok (non-enumeration) but must not close A.
    let auth_b = authed("tnt-b", "bob");
    mgr.close(&auth_b, &req).unwrap();
    assert_eq!(mgr.session_count(), 1, "B must not remove A's slot");
    assert_eq!(
        closes.load(Ordering::SeqCst),
        0,
        "B must not transport.close A"
    );

    // Stale epoch (logout+relogin same principal): still no close — binding not current.
    let _ = auth_a.clear_native();
    auth_a.install_session_for_tests("tnt-a", "alice", "admin");
    mgr.close(&auth_a, &req).unwrap();
    assert_eq!(mgr.session_count(), 1, "stale epoch must not remove slot");
    assert_eq!(closes.load(Ordering::SeqCst), 0);

    // Fresh open under current epoch; own close succeeds.
    let target_fresh = bound_target(&auth_a, "srv", "cred");
    let rng2 = SeqRng::single([0xCDu8; 32]);
    let resp_own = mgr
        .open_session(&auth_a, &target_fresh, &conn, &rng2)
        .unwrap();
    assert_eq!(mgr.session_count(), 2);
    let req_own = LocalSshCloseRequest {
        session_id: resp_own.session_id.clone(),
    };
    mgr.close(&auth_a, &req_own).unwrap();
    assert_eq!(mgr.session_count(), 1);
    assert_eq!(closes.load(Ordering::SeqCst), 1);

    // Repeated own close + unknown id: success, no extra transport.close (non-enumerating).
    mgr.close(&auth_a, &req_own).unwrap();
    mgr.close(
        &auth_a,
        &LocalSshCloseRequest {
            session_id: "does-not-exist".into(),
        },
    )
    .unwrap();
    assert_eq!(closes.load(Ordering::SeqCst), 1);

    // Lifecycle still can drain the stale orphan (auth-bound close correctly refused it).
    mgr.close_all();
    assert_eq!(mgr.session_count(), 0);
    assert_eq!(closes.load(Ordering::SeqCst), 2);
}

#[test]
fn local_ssh_transport_close_once_on_close_all() {
    let auth = authed("tnt", "user");
    let closes = Arc::new(AtomicUsize::new(0));
    let conn = MockConnector::ok(Arc::clone(&closes));
    let mgr = LocalSshSessionManager::new();
    let rng = SeqRng::from_blocks(vec![[6u8; 32], [7u8; 32]]);
    let t1 = bound_target(&auth, "s1", "c1");
    let t2 = bound_target(&auth, "s2", "c2");
    mgr.open_session(&auth, &t1, &conn, &rng).unwrap();
    mgr.open_session(&auth, &t2, &conn, &rng).unwrap();
    assert_eq!(mgr.session_count(), 2);
    mgr.close_all();
    assert_eq!(mgr.session_count(), 0);
    assert_eq!(closes.load(Ordering::SeqCst), 2);
    mgr.close_all();
    assert_eq!(closes.load(Ordering::SeqCst), 2);
}

#[test]
fn local_ssh_close_for_credential_only_matching() {
    let auth = authed("tnt", "user");
    let closes = Arc::new(AtomicUsize::new(0));
    let conn = MockConnector::ok(Arc::clone(&closes));
    let mgr = LocalSshSessionManager::new();
    let rng = SeqRng::from_blocks(vec![[10u8; 32], [11u8; 32]]);
    mgr.open_session(&auth, &bound_target(&auth, "s1", "cred-keep"), &conn, &rng)
        .unwrap();
    mgr.open_session(&auth, &bound_target(&auth, "s2", "cred-del"), &conn, &rng)
        .unwrap();
    let p = auth.native_principal().unwrap();
    mgr.close_for_principal_credential(&p, "cred-del");
    assert_eq!(mgr.session_count(), 1);
    assert_eq!(closes.load(Ordering::SeqCst), 1);
}

#[test]
fn local_ssh_close_for_credential_is_tenant_isolated() {
    let auth_a = authed("tenant-a", "alice");
    let auth_b = authed("tenant-b", "bob");
    let closes = Arc::new(AtomicUsize::new(0));
    let conn = MockConnector::ok(Arc::clone(&closes));
    let mgr = LocalSshSessionManager::new();
    let rng = SeqRng::from_blocks(vec![[30u8; 32], [31u8; 32]]);
    // Same credential_id "prod" under two tenants.
    mgr.open_session(&auth_a, &bound_target(&auth_a, "s1", "prod"), &conn, &rng)
        .unwrap();
    mgr.open_session(&auth_b, &bound_target(&auth_b, "s2", "prod"), &conn, &rng)
        .unwrap();
    assert_eq!(mgr.session_count(), 2);
    let p_a = auth_a.native_principal().unwrap();
    mgr.close_for_principal_credential(&p_a, "prod");
    assert_eq!(mgr.session_count(), 1);
    assert_eq!(closes.load(Ordering::SeqCst), 1);
    // Tenant B still writable.
    // Find remaining session by attempting write with B's auth — need id.
    // Re-open is not needed: only B remains; use close_all count check.
}

// ─── Lifecycle via vault sink ────────────────────────────────────────────────

#[test]
fn local_ssh_vault_lock_closes_sessions_before_seal() {
    let auth = authed("tnt", "user");
    let path = std::env::temp_dir().join(format!(
        "opsmate-d4b1-lock-{}-{}.hold",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let vault = VaultService::new(path.clone());
    let mgr = Arc::new(LocalSshSessionManager::new());
    vault.set_session_lifecycle_sink(mgr.clone());

    let closes = Arc::new(AtomicUsize::new(0));
    let conn = MockConnector::ok(Arc::clone(&closes));
    let rng = SeqRng::single([12u8; 32]);
    mgr.open_session(&auth, &bound_target(&auth, "s", "c"), &conn, &rng)
        .unwrap();
    assert_eq!(mgr.session_count(), 1);

    {
        use tauri_plugin_stronghold::stronghold::Stronghold;
        let key = vec![0x51u8; 32];
        let sh = Stronghold::new(&path, key).unwrap();
        sh.create_client(b"opsmate-vault-client").unwrap();
        vault.test_inject_unlocked(
            sh,
            auth.native_principal().unwrap(),
            path.clone(),
            Instant::now(),
        );
    }

    let _ = vault.lock().unwrap();
    assert_eq!(mgr.session_count(), 0);
    assert_eq!(closes.load(Ordering::SeqCst), 1);
    assert!(!vault.status().unwrap().unlocked);

    let _ = vault.lock();
    let _ = std::fs::remove_file(&path);
    let mut salt = path.clone();
    {
        let mut s = salt.as_os_str().to_os_string();
        s.push(".salt");
        salt = std::path::PathBuf::from(s);
    }
    let _ = std::fs::remove_file(salt);
}

#[test]
fn local_ssh_idle_timeout_closes_sessions() {
    let auth = authed("tnt", "user");
    let path = std::env::temp_dir().join(format!(
        "opsmate-d4b1-idle-{}-{}.hold",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let vault = VaultService::new(path.clone());
    let mgr = Arc::new(LocalSshSessionManager::new());
    vault.set_session_lifecycle_sink(mgr.clone());
    let closes = Arc::new(AtomicUsize::new(0));
    let conn = MockConnector::ok(Arc::clone(&closes));
    let rng = SeqRng::single([13u8; 32]);
    mgr.open_session(&auth, &bound_target(&auth, "s", "c"), &conn, &rng)
        .unwrap();

    {
        use tauri_plugin_stronghold::stronghold::Stronghold;
        let key = vec![0x52u8; 32];
        let sh = Stronghold::new(&path, key).unwrap();
        sh.create_client(b"opsmate-vault-client").unwrap();
        vault.test_inject_unlocked(
            sh,
            auth.native_principal().unwrap(),
            path.clone(),
            Instant::now() - crate::vault::VAULT_IDLE_TIMEOUT - Duration::from_secs(1),
        );
    }

    // status triggers idle seal → sessions closed
    let st = vault.status().unwrap();
    assert!(!st.unlocked);
    assert_eq!(st.locked_reason.as_deref(), Some("idle_timeout"));
    assert_eq!(mgr.session_count(), 0);
    assert_eq!(closes.load(Ordering::SeqCst), 1);

    let _ = std::fs::remove_file(&path);
}

#[test]
fn local_ssh_delete_local_closes_dependent_sessions() {
    let auth = authed("tnt", "user");
    let path = std::env::temp_dir().join(format!(
        "opsmate-d4b1-del-{}-{}.hold",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let vault = VaultService::new(path.clone());
    let mgr = Arc::new(LocalSshSessionManager::new());
    vault.set_session_lifecycle_sink(mgr.clone());
    let closes = Arc::new(AtomicUsize::new(0));
    let conn = MockConnector::ok(Arc::clone(&closes));
    let rng = SeqRng::from_blocks(vec![[20u8; 32], [21u8; 32]]);
    mgr.open_session(&auth, &bound_target(&auth, "s1", "cred-x"), &conn, &rng)
        .unwrap();
    mgr.open_session(&auth, &bound_target(&auth, "s2", "cred-y"), &conn, &rng)
        .unwrap();

    let p = auth.native_principal().unwrap();
    SessionLifecycleSink::close_sessions_for_credential(mgr.as_ref(), &p, "cred-x");
    assert_eq!(mgr.session_count(), 1);
    assert_eq!(closes.load(Ordering::SeqCst), 1);

    let _ = std::fs::remove_file(&path);
}

// ─── P1 concurrent close (blocking connector/transport) ─────────────────────

/// Blocks in connect until `release`; signals `entered` when blocked.
struct BlockingConnector {
    entered: Arc<std::sync::Barrier>,
    release: Arc<std::sync::Barrier>,
    closes: Arc<AtomicUsize>,
}

impl LocalSshConnector for BlockingConnector {
    fn connect(
        &self,
        _target: &PreparedSshTarget,
    ) -> Result<Arc<dyn LocalSshTransport>, SshSessionError> {
        self.entered.wait();
        self.release.wait();
        Ok(MockTransport::new(Arc::clone(&self.closes)))
    }
}

/// Blocks in write/resize; close is concurrent (`&self`) and counts immediately.
struct BlockingIoTransport {
    closes: Arc<AtomicUsize>,
    closed: AtomicBool,
    entered: Arc<std::sync::Barrier>,
    release: Arc<std::sync::Barrier>,
    close_seen: Arc<AtomicBool>,
    mode: &'static str,
}

impl LocalSshTransport for BlockingIoTransport {
    fn write(&self, _data: &[u8]) -> Result<(), SshSessionError> {
        if self.mode != "write" {
            return Ok(());
        }
        if self.closed.load(Ordering::SeqCst) {
            return Err(SshSessionError::AuthorizationFailed);
        }
        self.entered.wait();
        self.release.wait();
        if self.closed.load(Ordering::SeqCst) {
            return Err(SshSessionError::AuthorizationFailed);
        }
        Ok(())
    }
    fn resize(&self, _cols: u32, _rows: u32) -> Result<(), SshSessionError> {
        if self.mode != "resize" {
            return Ok(());
        }
        if self.closed.load(Ordering::SeqCst) {
            return Err(SshSessionError::AuthorizationFailed);
        }
        self.entered.wait();
        self.release.wait();
        if self.closed.load(Ordering::SeqCst) {
            return Err(SshSessionError::AuthorizationFailed);
        }
        Ok(())
    }
    fn close(&self) -> Result<(), SshSessionError> {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.closes.fetch_add(1, Ordering::SeqCst);
            self.close_seen.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
}

struct BlockingIoConnector {
    closes: Arc<AtomicUsize>,
    entered: Arc<std::sync::Barrier>,
    release: Arc<std::sync::Barrier>,
    close_seen: Arc<AtomicBool>,
    mode: &'static str,
}

impl LocalSshConnector for BlockingIoConnector {
    fn connect(
        &self,
        _target: &PreparedSshTarget,
    ) -> Result<Arc<dyn LocalSshTransport>, SshSessionError> {
        Ok(Arc::new(BlockingIoTransport {
            closes: Arc::clone(&self.closes),
            closed: AtomicBool::new(false),
            entered: Arc::clone(&self.entered),
            release: Arc::clone(&self.release),
            close_seen: Arc::clone(&self.close_seen),
            mode: self.mode,
        }))
    }
}

#[test]
fn local_ssh_close_all_during_connect_never_registers() {
    let auth = Arc::new(authed("tnt", "user"));
    let target = bound_target(&auth, "srv", "cred");
    let closes = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let conn = BlockingConnector {
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
        closes: Arc::clone(&closes),
    };
    let mgr = Arc::new(LocalSshSessionManager::new());
    let rng = SeqRng::single([40u8; 32]);

    let mgr_t = Arc::clone(&mgr);
    let auth_t = Arc::clone(&auth);
    let handle = std::thread::spawn(move || mgr_t.open_session(&auth_t, &target, &conn, &rng));

    entered.wait();
    mgr.close_all();
    assert_eq!(mgr.session_count(), 0);
    release.wait();
    let result = handle.join().unwrap();
    assert!(matches!(result, Err(SshSessionError::AuthorizationFailed)));
    assert_eq!(mgr.session_count(), 0);
    assert_eq!(closes.load(Ordering::SeqCst), 1);
}

#[test]
fn local_ssh_close_all_during_write_invokes_close_before_return() {
    let auth = Arc::new(authed("tnt", "user"));
    let target = bound_target(&auth, "srv", "cred");
    let closes = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let close_seen = Arc::new(AtomicBool::new(false));
    let conn = BlockingIoConnector {
        closes: Arc::clone(&closes),
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
        close_seen: Arc::clone(&close_seen),
        mode: "write",
    };
    let mgr = Arc::new(LocalSshSessionManager::new());
    let rng = SeqRng::single([41u8; 32]);
    let resp = mgr.open_session(&auth, &target, &conn, &rng).unwrap();

    let mgr_t = Arc::clone(&mgr);
    let auth_t = Arc::clone(&auth);
    let sid = resp.session_id.clone();
    let handle = std::thread::spawn(move || {
        mgr_t.write(
            &auth_t,
            &LocalSshWriteRequest {
                session_id: sid,
                data: "x".into(),
            },
        )
    });

    entered.wait(); // write blocked mid-I/O
                    // close_all must invoke transport.close while write is still blocked.
    mgr.close_all();
    assert!(close_seen.load(Ordering::SeqCst));
    assert_eq!(closes.load(Ordering::SeqCst), 1);
    assert_eq!(mgr.session_count(), 0);

    release.wait();
    let result = handle.join().unwrap();
    assert!(matches!(result, Err(SshSessionError::AuthorizationFailed)));
    assert_eq!(mgr.session_count(), 0);
    assert_eq!(closes.load(Ordering::SeqCst), 1);
}

#[test]
fn local_ssh_close_all_during_resize_then_vault_lock_no_extra_close() {
    let auth = Arc::new(authed("tnt", "user"));
    let target = bound_target(&auth, "srv", "cred");
    let closes = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let close_seen = Arc::new(AtomicBool::new(false));
    let conn = BlockingIoConnector {
        closes: Arc::clone(&closes),
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
        close_seen: Arc::clone(&close_seen),
        mode: "resize",
    };
    let mgr = Arc::new(LocalSshSessionManager::new());
    let rng = SeqRng::single([42u8; 32]);
    let resp = mgr.open_session(&auth, &target, &conn, &rng).unwrap();

    let mgr_t = Arc::clone(&mgr);
    let auth_t = Arc::clone(&auth);
    let sid = resp.session_id.clone();
    let handle = std::thread::spawn(move || {
        mgr_t.resize(
            &auth_t,
            &LocalSshResizeRequest {
                session_id: sid,
                cols: 80,
                rows: 24,
            },
        )
    });

    entered.wait();
    mgr.close_all();
    assert!(close_seen.load(Ordering::SeqCst));
    assert_eq!(closes.load(Ordering::SeqCst), 1);

    let path = std::env::temp_dir().join(format!(
        "opsmate-close-seal-{}-{}.hold",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let vault = VaultService::new(path.clone());
    vault.set_session_lifecycle_sink(mgr.clone());
    {
        use tauri_plugin_stronghold::stronghold::Stronghold;
        let sh = Stronghold::new(&path, vec![0x61u8; 32]).unwrap();
        sh.create_client(b"opsmate-vault-client").unwrap();
        vault.test_inject_unlocked(
            sh,
            auth.native_principal().unwrap(),
            path.clone(),
            Instant::now(),
        );
    }
    // close already done; vault.lock must not double-close.
    let _ = vault.lock().unwrap();
    assert_eq!(closes.load(Ordering::SeqCst), 1);

    release.wait();
    let result = handle.join().unwrap();
    assert!(matches!(result, Err(SshSessionError::AuthorizationFailed)));
    assert_eq!(closes.load(Ordering::SeqCst), 1);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn local_ssh_credential_close_blocks_inflight_open_same_pair_only() {
    let auth_a = Arc::new(authed("tenant-a", "alice"));
    let auth_b = Arc::new(authed("tenant-b", "bob"));
    let closes = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let conn_block = BlockingConnector {
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
        closes: Arc::clone(&closes),
    };
    let conn_ok = MockConnector::ok(Arc::clone(&closes));
    let mgr = Arc::new(LocalSshSessionManager::new());
    let rng_b = SeqRng::single([50u8; 32]);
    let resp_b = mgr
        .open_session(
            &auth_b,
            &bound_target(&auth_b, "sb", "prod"),
            &conn_ok,
            &rng_b,
        )
        .unwrap();
    assert_eq!(mgr.session_count(), 1);

    let mgr_t = Arc::clone(&mgr);
    let auth_a_t = Arc::clone(&auth_a);
    let target_a = bound_target(&auth_a, "sa", "prod");
    let rng_a = SeqRng::single([51u8; 32]);
    let handle =
        std::thread::spawn(move || mgr_t.open_session(&auth_a_t, &target_a, &conn_block, &rng_a));

    entered.wait();
    let p_a = auth_a.native_principal().unwrap();
    mgr.close_for_principal_credential(&p_a, "prod");
    assert_eq!(mgr.session_count(), 1);
    release.wait();
    let result = handle.join().unwrap();
    assert!(matches!(result, Err(SshSessionError::AuthorizationFailed)));
    assert_eq!(mgr.session_count(), 1);
    mgr.close(
        &auth_b,
        &LocalSshCloseRequest {
            session_id: resp_b.session_id,
        },
    )
    .unwrap();
    assert_eq!(mgr.session_count(), 0);
    assert_eq!(closes.load(Ordering::SeqCst), 2);
}
