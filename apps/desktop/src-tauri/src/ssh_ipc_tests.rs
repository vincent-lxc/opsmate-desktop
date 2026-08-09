//! D4B2c — IPC orchestration / pending sink / event contract unit tests (no network).

use super::*;
use crate::auth::{AuthError, AuthStore, NativePrincipal, RandomSource};
use crate::ssh_registry::{
    LocalSshCloseRequest, LocalSshConnector, LocalSshResizeRequest, LocalSshSessionManager,
    LocalSshTransport, LocalSshWriteRequest,
};
use crate::ssh_session::{LocalSshOpenRequest, PreparedSshTarget, SshSessionError};
use crate::ssh_transport::TerminalOutput;
use crate::vault::VaultCredentialLease;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

// ─── Mocks ───────────────────────────────────────────────────────────────────

struct DetRng([u8; 32]);
impl RandomSource for DetRng {
    fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), AuthError> {
        for (i, b) in dest.iter_mut().enumerate() {
            *b = self.0[i % 32];
        }
        Ok(())
    }
}

struct NopTransport;
impl LocalSshTransport for NopTransport {
    fn write(&self, _: &[u8]) -> Result<(), SshSessionError> {
        Ok(())
    }
    fn resize(&self, _: u32, _: u32) -> Result<(), SshSessionError> {
        Ok(())
    }
    fn close(&self) -> Result<(), SshSessionError> {
        Ok(())
    }
}

/// Connector that optionally emits on the shared sink during connect.
struct ScriptedConnector {
    steps: Arc<Mutex<Vec<&'static str>>>,
    sink: Arc<IpcTerminalSink>,
    /// Outputs to push during connect (before open_session returns).
    during_connect: Mutex<Vec<TerminalOutput>>,
    fail: AtomicBool,
}

impl ScriptedConnector {
    fn new(sink: Arc<IpcTerminalSink>, steps: Arc<Mutex<Vec<&'static str>>>) -> Self {
        Self {
            steps,
            sink,
            during_connect: Mutex::new(Vec::new()),
            fail: AtomicBool::new(false),
        }
    }
}

impl LocalSshConnector for ScriptedConnector {
    fn connect(
        &self,
        _target: &PreparedSshTarget,
    ) -> Result<Arc<dyn LocalSshTransport>, SshSessionError> {
        self.steps.lock().unwrap().push("connect");
        if self.fail.load(Ordering::SeqCst) {
            return Err(SshSessionError::ConnectFailed);
        }
        let pending = std::mem::take(&mut *self.during_connect.lock().unwrap());
        for chunk in pending {
            self.sink.on_output(chunk);
        }
        Ok(Arc::new(NopTransport))
    }
}

struct MockDriver {
    steps: Arc<Mutex<Vec<&'static str>>>,
    open_steps: Arc<Mutex<Vec<LocalSshOpenStep>>>,
    target: PreparedSshTarget,
    sink: Arc<IpcTerminalSink>,
    during_connect: Vec<TerminalOutput>,
    fail_at: Option<&'static str>,
    connector_steps: Arc<Mutex<Vec<&'static str>>>,
}

impl LocalSshOpenDriver for MockDriver {
    fn prepare(
        &mut self,
        auth: &AuthStore,
        _req: &LocalSshOpenRequest,
    ) -> Result<PreparedSshTarget, SshSessionError> {
        self.steps.lock().unwrap().push("prepare");
        if self.fail_at == Some("prepare") {
            return Err(SshSessionError::Unauthenticated);
        }
        if !auth.session_binding_current(&self.target.principal, self.target.session_epoch) {
            return Err(SshSessionError::AuthorizationFailed);
        }
        Ok(self.target.clone())
    }

    fn lease(
        &mut self,
        auth: &AuthStore,
        target: &PreparedSshTarget,
    ) -> Result<(), SshSessionError> {
        self.steps.lock().unwrap().push("lease");
        if self.fail_at == Some("lease") {
            return Err(SshSessionError::AuthorizationFailed);
        }
        if !auth.session_binding_current(&target.principal, target.session_epoch) {
            return Err(SshSessionError::AuthorizationFailed);
        }
        Ok(())
    }

    fn connector(
        &mut self,
        _sink: Arc<dyn TerminalSink>,
    ) -> Result<Box<dyn LocalSshConnector>, SshSessionError> {
        self.steps.lock().unwrap().push("connector");
        if self.fail_at == Some("connector") {
            return Err(SshSessionError::ConnectFailed);
        }
        let c = ScriptedConnector::new(Arc::clone(&self.sink), Arc::clone(&self.connector_steps));
        *c.during_connect.lock().unwrap() = self.during_connect.clone();
        if self.fail_at == Some("connect") {
            c.fail.store(true, Ordering::SeqCst);
        }
        Ok(Box::new(c))
    }
}

fn authed_target() -> (AuthStore, PreparedSshTarget) {
    let auth = AuthStore::new();
    auth.install_session_for_tests("t", "u", "admin");
    let snap = auth.native_auth_snapshot().unwrap();
    let target = PreparedSshTarget {
        server_id: "srv".into(),
        name: "n".into(),
        host: "10.0.0.1".into(),
        port: 22,
        username: "ubuntu".into(),
        credential_id: "cred".into(),
        host_key_status: crate::ssh_session::HostKeyStatus::Unpinned,
        host_key_type: None,
        host_key_fingerprint: None,
        principal: snap.principal,
        session_epoch: snap.epoch,
    };
    (auth, target)
}

fn wire_ended(sessions: Arc<LocalSshSessionManager>, sink: &IpcTerminalSink) {
    let w = Arc::downgrade(&sessions);
    sink.set_transport_ended_handler(Arc::new(move |sid: &str| {
        if let Some(m) = w.upgrade() {
            m.remove_on_transport_ended(sid);
        }
    }));
}

// ─── Base64 / event DTO ──────────────────────────────────────────────────────

#[test]
fn ssh_ipc_base64_and_event_mapping_secret_free() {
    assert_eq!(encode_std_base64(b""), "");
    assert_eq!(encode_std_base64(b"f"), "Zg==");
    assert_eq!(encode_std_base64(b"fo"), "Zm8=");
    assert_eq!(encode_std_base64(b"foo"), "Zm9v");
    assert_eq!(encode_std_base64(&[0x00, 0xff]), "AP8=");

    let ev = LocalSshOutputEvent::from_output("sid", &TerminalOutput::Data(b"hi".to_vec()));
    assert_eq!(ev.session_id, "sid");
    assert_eq!(ev.stream, LocalSshOutputStream::Stdout);
    assert_eq!(ev.data, encode_std_base64(b"hi"));
    let dbg = format!("{ev:?}");
    assert!(!dbg.to_lowercase().contains("pem"));
    assert!(!dbg.to_lowercase().contains("bearer"));

    let ev2 = LocalSshOutputEvent::from_output(
        "sid",
        &TerminalOutput::ExtendedData {
            data: vec![1, 2],
            ext: 1,
        },
    );
    assert_eq!(ev2.stream, LocalSshOutputStream::Stderr);

    let ev3 = LocalSshOutputEvent::from_output("sid", &TerminalOutput::Closed);
    assert_eq!(ev3.stream, LocalSshOutputStream::Closed);
    assert!(ev3.data.is_empty());

    let json = serde_json::to_string(&ev3).unwrap();
    assert!(json.contains("sessionId") || json.contains("session_id"));
    assert!(!json.contains("tenant"));
    assert!(!json.contains("credential"));
}

/// Terminal payload (passwords/tokens) must never appear in Debug; Serialize keeps base64.
#[test]
fn ssh_ipc_output_event_debug_redacts_secret_payload() {
    let secret_plain = b"SUPER_SECRET_PASSWORD_hunter2_token=xyz";
    let secret_b64 = encode_std_base64(secret_plain);
    assert!(secret_b64.contains('=') || !secret_b64.is_empty());
    assert_ne!(secret_b64, String::from_utf8_lossy(secret_plain));

    let ev = LocalSshOutputEvent::from_output(
        "opaque-session-id-abc",
        &TerminalOutput::Data(secret_plain.to_vec()),
    );
    // Delivery path still has base64 payload.
    assert_eq!(ev.data, secret_b64);
    let ser = serde_json::to_string(&ev).expect("serialize");
    assert!(
        ser.contains(&secret_b64),
        "Serialize must retain base64 for WebView delivery"
    );

    let dbg = format!("{ev:?}");
    assert!(
        !dbg.contains("SUPER_SECRET_PASSWORD"),
        "Debug must not contain plaintext secret: {dbg}"
    );
    assert!(
        !dbg.contains("hunter2"),
        "Debug must not contain plaintext secret fragment: {dbg}"
    );
    assert!(
        !dbg.contains(&secret_b64),
        "Debug must not contain base64 payload: {dbg}"
    );
    assert!(
        dbg.contains("data_b64_len") && dbg.contains(&format!("{}", secret_b64.len())),
        "Debug should expose only length: {dbg}"
    );
    assert!(dbg.contains("opaque-session-id-abc") || dbg.contains("session_id"));
    assert!(dbg.contains("Stdout") || dbg.contains("stream"));

    let closed = LocalSshOutputEvent::from_output("s", &TerminalOutput::Closed);
    let dclosed = format!("{closed:?}");
    assert!(!dclosed.contains("SUPER_SECRET"));
    assert!(closed.data.is_empty());

    // Sanitized user errors still secret-free.
    for e in [
        SshSessionError::AuthenticationFailed,
        SshSessionError::ConnectFailed,
        SshSessionError::Internal,
    ] {
        let um = map_ssh_user(e.clone());
        assert!(!um.contains("SUPER_SECRET"));
        assert_ne!(um, format!("{e:?}"));
    }
}

// ─── Pending sink ────────────────────────────────────────────────────────────

#[test]
fn ssh_ipc_pending_flush_in_order_after_bind() {
    let em = Arc::new(RecordingEmitter::new());
    let sink = IpcTerminalSink::new(em.clone() as Arc<dyn LocalSshOutputEmitter>);
    sink.on_output(TerminalOutput::Data(b"a".to_vec()));
    sink.on_output(TerminalOutput::Data(b"b".to_vec()));
    assert!(em.snapshot().is_empty(), "no emit before bind");
    assert_eq!(sink.bind("S1").unwrap(), BindOutcome::Ready);
    let snap = em.snapshot();
    assert_eq!(snap.len(), 2);
    assert_eq!(snap[0].data, encode_std_base64(b"a"));
    assert_eq!(snap[1].data, encode_std_base64(b"b"));
    assert!(snap.iter().all(|e| e.session_id == "S1"));
    // bind is exactly-once
    assert!(matches!(sink.bind("S1"), Err(SshSessionError::Internal)));
}

/// Deterministic concurrent race: pending "old" must emit before concurrent "new".
/// Uses a gated emitter (channels/barriers) — no sleeps as correctness.
#[test]
fn ssh_ipc_bind_flush_linearizable_with_concurrent_on_output() {
    struct GatedEmitter {
        events: Mutex<Vec<LocalSshOutputEvent>>,
        /// Signaled when the first emit enters the gate.
        entered_tx: Mutex<Option<mpsc::SyncSender<()>>>,
        /// First emit blocks until this receives.
        release_rx: Mutex<Option<mpsc::Receiver<()>>>,
        first: AtomicBool,
    }
    impl LocalSshOutputEmitter for GatedEmitter {
        fn emit_to_main(&self, event: &LocalSshOutputEvent) -> Result<(), SshSessionError> {
            if self.first.swap(false, Ordering::SeqCst) {
                if let Some(tx) = self.entered_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                if let Some(rx) = self.release_rx.lock().unwrap().take() {
                    let _ = rx.recv();
                }
            }
            self.events.lock().unwrap().push(event.clone());
            Ok(())
        }
    }

    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let em = Arc::new(GatedEmitter {
        events: Mutex::new(Vec::new()),
        entered_tx: Mutex::new(Some(entered_tx)),
        release_rx: Mutex::new(Some(release_rx)),
        first: AtomicBool::new(true),
    });
    let sink = IpcTerminalSink::new(em.clone() as Arc<dyn LocalSshOutputEmitter>);
    sink.on_output(TerminalOutput::Data(b"old".to_vec()));

    let sink_b = Arc::clone(&sink);
    let binder = thread::spawn(move || sink_b.bind("SID"));

    // Wait until bind is blocked inside first emit (old).
    entered_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("bind must reach first emit");

    // Concurrent live output while flush of "old" is in progress.
    sink.on_output(TerminalOutput::Data(b"new".to_vec()));

    // Unblock first emit; bind completes flush of deferred "new".
    release_tx.send(()).unwrap();
    assert_eq!(binder.join().unwrap().unwrap(), BindOutcome::Ready);

    let snap = em.events.lock().unwrap().clone();
    assert_eq!(snap.len(), 2, "expected old then new");
    assert_eq!(snap[0].data, encode_std_base64(b"old"));
    assert_eq!(snap[1].data, encode_std_base64(b"new"));
    assert!(snap.iter().all(|e| e.session_id == "SID"));
}

#[test]
fn ssh_ipc_early_closed_before_bind() {
    let em = Arc::new(RecordingEmitter::new());
    let sink = IpcTerminalSink::new(em.clone() as Arc<dyn LocalSshOutputEmitter>);
    let ended = Arc::new(AtomicUsize::new(0));
    let e2 = Arc::clone(&ended);
    sink.set_transport_ended_handler(Arc::new(move |_| {
        e2.fetch_add(1, Ordering::SeqCst);
    }));
    sink.on_output(TerminalOutput::Data(b"x".to_vec()));
    sink.on_output(TerminalOutput::Closed);
    assert_eq!(
        sink.bind("early").unwrap(),
        BindOutcome::ClosedDuringConnect
    );
    let snap = em.snapshot();
    assert_eq!(snap.len(), 2);
    assert_eq!(snap[1].stream, LocalSshOutputStream::Closed);
    assert_eq!(ended.load(Ordering::SeqCst), 1);
    // Exact-once Closed
    sink.on_output(TerminalOutput::Closed);
    assert_eq!(em.snapshot().len(), 2);
}

#[test]
fn ssh_ipc_closed_after_bind_exact_once_and_ended() {
    let em = Arc::new(RecordingEmitter::new());
    let sink = IpcTerminalSink::new(em.clone() as Arc<dyn LocalSshOutputEmitter>);
    let ended = Arc::new(AtomicUsize::new(0));
    let e2 = Arc::clone(&ended);
    sink.set_transport_ended_handler(Arc::new(move |sid| {
        assert_eq!(sid, "live");
        e2.fetch_add(1, Ordering::SeqCst);
    }));
    assert_eq!(sink.bind("live").unwrap(), BindOutcome::Ready);
    sink.on_output(TerminalOutput::Data(vec![0x00, 0xff]));
    sink.on_output(TerminalOutput::Closed);
    sink.on_output(TerminalOutput::Closed);
    let snap = em.snapshot();
    assert_eq!(snap.len(), 2);
    assert_eq!(snap[0].stream, LocalSshOutputStream::Stdout);
    assert_eq!(snap[0].data, encode_std_base64(&[0x00, 0xff]));
    assert_eq!(snap[1].stream, LocalSshOutputStream::Closed);
    assert_eq!(ended.load(Ordering::SeqCst), 1);
}

#[test]
fn ssh_ipc_pending_overflow_fail_closed() {
    let em = Arc::new(RecordingEmitter::new());
    let sink = IpcTerminalSink::new(em as Arc<dyn LocalSshOutputEmitter>);
    for i in 0..MAX_PENDING_SSH_OUTPUT {
        sink.on_output(TerminalOutput::Data(vec![i as u8]));
    }
    // One past bound → Failed
    sink.on_output(TerminalOutput::Data(vec![0xff]));
    assert!(sink.is_failed());
    assert!(matches!(sink.bind("x"), Err(SshSessionError::Internal)));
}

#[test]
fn ssh_ipc_emitter_failure_fail_closed() {
    let em = Arc::new(RecordingEmitter::new());
    em.always_fail.store(true, Ordering::SeqCst);
    let sink = IpcTerminalSink::new(em as Arc<dyn LocalSshOutputEmitter>);
    sink.on_output(TerminalOutput::Data(b"z".to_vec()));
    assert!(matches!(sink.bind("s"), Err(SshSessionError::Internal)));
}

#[test]
fn ssh_ipc_main_window_targeting_only() {
    let em = Arc::new(RecordingEmitter::new());
    *em.target_window.lock().unwrap() = "main".into();
    let sink = IpcTerminalSink::new(em.clone() as Arc<dyn LocalSshOutputEmitter>);
    sink.bind("s").unwrap();
    sink.on_output(TerminalOutput::Data(b"ok".to_vec()));
    assert_eq!(em.snapshot().len(), 1);

    let em2 = Arc::new(RecordingEmitter::new());
    *em2.target_window.lock().unwrap() = "other".into();
    let sink2 = IpcTerminalSink::new(em2 as Arc<dyn LocalSshOutputEmitter>);
    sink2.bind("s").unwrap();
    sink2.on_output(TerminalOutput::Data(b"x".to_vec()));
    assert!(sink2.is_failed());
}

// ─── Orchestration order / failures ──────────────────────────────────────────

#[test]
fn ssh_ipc_open_orchestration_order_prepare_lease_connect_bind() {
    let (auth, target) = authed_target();
    let sessions = Arc::new(LocalSshSessionManager::new());
    let em = Arc::new(RecordingEmitter::new());
    let sink = IpcTerminalSink::new(em as Arc<dyn LocalSshOutputEmitter>);
    wire_ended(Arc::clone(&sessions), &sink);

    let trace = Arc::new(Mutex::new(Vec::new()));
    let conn_trace = Arc::new(Mutex::new(Vec::new()));
    let mut driver = MockDriver {
        steps: Arc::clone(&trace),
        open_steps: Arc::new(Mutex::new(Vec::new())),
        target,
        sink: Arc::clone(&sink),
        during_connect: vec![TerminalOutput::Data(b"hello".to_vec())],
        fail_at: None,
        connector_steps: Arc::clone(&conn_trace),
    };
    let mut steps = Vec::new();
    let rng = DetRng([9u8; 32]);
    let req = LocalSshOpenRequest {
        server_id: "srv".into(),
        credential_id: "cred".into(),
    };
    let resp = perform_local_ssh_open_with_driver(
        &auth,
        sessions.as_ref(),
        &req,
        &mut driver,
        sink,
        &rng,
        &mut steps,
    )
    .unwrap();
    assert!(!resp.session_id.is_empty());
    assert_eq!(
        steps,
        vec![
            LocalSshOpenStep::Prepare,
            LocalSshOpenStep::Lease,
            LocalSshOpenStep::ConnectRegister,
            LocalSshOpenStep::BindSink,
        ]
    );
    assert_eq!(
        *trace.lock().unwrap(),
        vec!["prepare", "lease", "connector"]
    );
    assert_eq!(*conn_trace.lock().unwrap(), vec!["connect"]);
    assert_eq!(sessions.session_count(), 1);
}

#[test]
fn ssh_ipc_open_failure_leaves_zero_sessions() {
    let (auth, target) = authed_target();
    let sessions = Arc::new(LocalSshSessionManager::new());
    let em = Arc::new(RecordingEmitter::new());
    let sink = IpcTerminalSink::new(em as Arc<dyn LocalSshOutputEmitter>);
    wire_ended(Arc::clone(&sessions), &sink);

    for fail in ["prepare", "lease", "connect"] {
        let mut driver = MockDriver {
            steps: Arc::new(Mutex::new(Vec::new())),
            open_steps: Arc::new(Mutex::new(Vec::new())),
            target: target.clone(),
            sink: Arc::clone(&sink),
            during_connect: vec![],
            fail_at: Some(fail),
            connector_steps: Arc::new(Mutex::new(Vec::new())),
        };
        // Fresh sink per attempt
        let sink2 = IpcTerminalSink::new(Arc::new(RecordingEmitter::new()) as Arc<_>);
        wire_ended(Arc::clone(&sessions), &sink2);
        driver.sink = Arc::clone(&sink2);
        let mut steps = Vec::new();
        let err = perform_local_ssh_open_with_driver(
            &auth,
            sessions.as_ref(),
            &LocalSshOpenRequest {
                server_id: "srv".into(),
                credential_id: "cred".into(),
            },
            &mut driver,
            sink2,
            &DetRng([1u8; 32]),
            &mut steps,
        );
        assert!(err.is_err(), "fail_at={fail}");
        assert_eq!(sessions.session_count(), 0, "no session leak at {fail}");
    }
}

#[test]
fn ssh_ipc_early_closed_during_connect_no_session_leak() {
    let (auth, target) = authed_target();
    let sessions = Arc::new(LocalSshSessionManager::new());
    let em = Arc::new(RecordingEmitter::new());
    let sink = IpcTerminalSink::new(em.clone() as Arc<dyn LocalSshOutputEmitter>);
    wire_ended(Arc::clone(&sessions), &sink);

    let mut driver = MockDriver {
        steps: Arc::new(Mutex::new(Vec::new())),
        open_steps: Arc::new(Mutex::new(Vec::new())),
        target,
        sink: Arc::clone(&sink),
        during_connect: vec![TerminalOutput::Closed],
        fail_at: None,
        connector_steps: Arc::new(Mutex::new(Vec::new())),
    };
    let mut steps = Vec::new();
    let err = perform_local_ssh_open_with_driver(
        &auth,
        sessions.as_ref(),
        &LocalSshOpenRequest {
            server_id: "srv".into(),
            credential_id: "cred".into(),
        },
        &mut driver,
        sink,
        &DetRng([2u8; 32]),
        &mut steps,
    );
    assert!(matches!(err, Err(SshSessionError::TransportClosed)));
    // Allow detached drop thread
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert_eq!(sessions.session_count(), 0);
    assert!(em
        .snapshot()
        .iter()
        .any(|e| e.stream == LocalSshOutputStream::Closed));
}

#[test]
fn ssh_ipc_stale_auth_epoch_fails_closed() {
    let (auth, mut target) = authed_target();
    target.session_epoch = target.session_epoch.wrapping_add(99);
    let sessions = Arc::new(LocalSshSessionManager::new());
    let sink = IpcTerminalSink::new(Arc::new(RecordingEmitter::new()) as Arc<_>);
    wire_ended(Arc::clone(&sessions), &sink);
    let mut driver = MockDriver {
        steps: Arc::new(Mutex::new(Vec::new())),
        open_steps: Arc::new(Mutex::new(Vec::new())),
        target,
        sink: Arc::clone(&sink),
        during_connect: vec![],
        fail_at: None,
        connector_steps: Arc::new(Mutex::new(Vec::new())),
    };
    let mut steps = Vec::new();
    let err = perform_local_ssh_open_with_driver(
        &auth,
        sessions.as_ref(),
        &LocalSshOpenRequest {
            server_id: "srv".into(),
            credential_id: "cred".into(),
        },
        &mut driver,
        sink,
        &DetRng([3u8; 32]),
        &mut steps,
    );
    assert!(matches!(err, Err(SshSessionError::AuthorizationFailed)));
    assert_eq!(sessions.session_count(), 0);
}

#[test]
fn ssh_ipc_user_messages_never_debug_raw() {
    for e in [
        SshSessionError::ConnectFailed,
        SshSessionError::AuthenticationFailed,
        SshSessionError::TransportClosed,
        SshSessionError::Internal,
    ] {
        let m = map_ssh_user(e.clone());
        assert!(!m.is_empty());
        assert!(!m.contains("pem"));
        assert!(!format!("{e:?}").contains(&m) || m.chars().any(|c| c > '\u{7f}'));
        // user_message is not the Debug repr
        assert_ne!(m, format!("{e:?}"));
    }
}

#[test]
fn ssh_ipc_strict_open_dto_and_write_close() {
    let raw_ok = r#"{"serverId":"s","credentialId":"c"}"#;
    let req: LocalSshOpenRequest = serde_json::from_str(raw_ok).unwrap();
    assert_eq!(req.server_id, "s");

    let bad = r#"{"serverId":"s","credentialId":"c","host":"x"}"#;
    assert!(serde_json::from_str::<LocalSshOpenRequest>(bad).is_err());

    let (auth, target) = authed_target();
    let sessions = LocalSshSessionManager::new();
    let conn = ScriptedConnector::new(
        IpcTerminalSink::new(Arc::new(RecordingEmitter::new()) as Arc<_>),
        Arc::new(Mutex::new(Vec::new())),
    );
    let resp = sessions
        .open_session(&auth, &target, &conn, &DetRng([4u8; 32]))
        .unwrap();

    // write uses string data field
    let w = LocalSshWriteRequest {
        session_id: resp.session_id.clone(),
        data: "hi".into(),
    };
    perform_local_ssh_write(&auth, &sessions, &w).unwrap();
    perform_local_ssh_resize(
        &auth,
        &sessions,
        &LocalSshResizeRequest {
            session_id: resp.session_id.clone(),
            cols: 80,
            rows: 24,
        },
    )
    .unwrap();
    perform_local_ssh_close(
        &auth,
        &sessions,
        &LocalSshCloseRequest {
            session_id: resp.session_id,
        },
    )
    .unwrap();
    assert_eq!(sessions.session_count(), 0);
}

/// Post-bind emitter failure must end the live session and close transport once
/// off the sink/callback thread (channel handoff — no sleep correctness).
#[test]
fn ssh_ipc_post_bind_emit_failure_ends_session_and_closes_transport_once() {
    let (auth, target) = authed_target();
    let sessions = Arc::new(LocalSshSessionManager::new());

    let (close_tx, close_rx) = mpsc::sync_channel::<std::thread::ThreadId>(1);
    let closes = Arc::new(AtomicUsize::new(0));
    let close_tx = Arc::new(Mutex::new(Some(close_tx)));

    struct CountClose {
        n: Arc<AtomicUsize>,
        notify: Arc<Mutex<Option<mpsc::SyncSender<std::thread::ThreadId>>>>,
    }
    impl LocalSshTransport for CountClose {
        fn write(&self, _: &[u8]) -> Result<(), SshSessionError> {
            Ok(())
        }
        fn resize(&self, _: u32, _: u32) -> Result<(), SshSessionError> {
            Ok(())
        }
        fn close(&self) -> Result<(), SshSessionError> {
            if self.n.fetch_add(1, Ordering::SeqCst) == 0 {
                if let Some(tx) = self.notify.lock().unwrap().take() {
                    let _ = tx.send(thread::current().id());
                }
            }
            Ok(())
        }
    }
    struct C {
        n: Arc<AtomicUsize>,
        notify: Arc<Mutex<Option<mpsc::SyncSender<std::thread::ThreadId>>>>,
    }
    impl LocalSshConnector for C {
        fn connect(
            &self,
            _: &PreparedSshTarget,
        ) -> Result<Arc<dyn LocalSshTransport>, SshSessionError> {
            Ok(Arc::new(CountClose {
                n: Arc::clone(&self.n),
                notify: Arc::clone(&self.notify),
            }))
        }
    }

    let em = Arc::new(RecordingEmitter::new());
    // First live emit fails (bind has empty pending).
    *em.fail_after.lock().unwrap() = Some(0);
    let sink = IpcTerminalSink::new(em as Arc<dyn LocalSshOutputEmitter>);
    wire_ended(Arc::clone(&sessions), &sink);

    let resp = sessions
        .open_session(
            &auth,
            &target,
            &C {
                n: Arc::clone(&closes),
                notify: Arc::clone(&close_tx),
            },
            &DetRng([5u8; 32]),
        )
        .unwrap();
    assert_eq!(sink.bind(&resp.session_id).unwrap(), BindOutcome::Ready);
    assert_eq!(sessions.session_count(), 1);

    let caller = thread::current().id();
    // Live output fails emitter → invoke_ended_once → remove + off-thread close.
    sink.on_output(TerminalOutput::Data(b"x".to_vec()));
    assert!(sink.is_failed());

    let close_tid = close_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("transport.close must run once on helper thread");
    assert_ne!(
        close_tid, caller,
        "close must not run on sink callback thread (no self-join)"
    );
    assert_eq!(closes.load(Ordering::SeqCst), 1);
    assert_eq!(sessions.session_count(), 0);

    // Further events / second ended are no-ops (exact-once).
    sink.on_output(TerminalOutput::Data(b"y".to_vec()));
    sink.on_output(TerminalOutput::Closed);
    assert_eq!(closes.load(Ordering::SeqCst), 1);
    match close_rx.recv_timeout(Duration::from_millis(50)) {
        Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {}
        Ok(_) => panic!("transport must not close twice"),
    }
}

#[test]
fn ssh_ipc_remove_on_transport_ended_closes_once_off_caller_thread() {
    let (auth, target) = authed_target();
    let sessions = Arc::new(LocalSshSessionManager::new());
    let (close_tx, close_rx) = mpsc::sync_channel::<std::thread::ThreadId>(1);
    let closes = Arc::new(AtomicUsize::new(0));
    let notify = Arc::new(Mutex::new(Some(close_tx)));

    struct CountClose {
        n: Arc<AtomicUsize>,
        notify: Arc<Mutex<Option<mpsc::SyncSender<std::thread::ThreadId>>>>,
    }
    impl LocalSshTransport for CountClose {
        fn write(&self, _: &[u8]) -> Result<(), SshSessionError> {
            Ok(())
        }
        fn resize(&self, _: u32, _: u32) -> Result<(), SshSessionError> {
            Ok(())
        }
        fn close(&self) -> Result<(), SshSessionError> {
            if self.n.fetch_add(1, Ordering::SeqCst) == 0 {
                if let Some(tx) = self.notify.lock().unwrap().take() {
                    let _ = tx.send(thread::current().id());
                }
            }
            Ok(())
        }
    }
    struct C {
        n: Arc<AtomicUsize>,
        notify: Arc<Mutex<Option<mpsc::SyncSender<std::thread::ThreadId>>>>,
    }
    impl LocalSshConnector for C {
        fn connect(
            &self,
            _: &PreparedSshTarget,
        ) -> Result<Arc<dyn LocalSshTransport>, SshSessionError> {
            Ok(Arc::new(CountClose {
                n: Arc::clone(&self.n),
                notify: Arc::clone(&self.notify),
            }))
        }
    }
    let resp = sessions
        .open_session(
            &auth,
            &target,
            &C {
                n: Arc::clone(&closes),
                notify: Arc::clone(&notify),
            },
            &DetRng([6u8; 32]),
        )
        .unwrap();
    assert_eq!(sessions.session_count(), 1);
    let caller = thread::current().id();
    sessions.remove_on_transport_ended(&resp.session_id);
    assert_eq!(sessions.session_count(), 0);
    let close_tid = close_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("helper thread must invoke transport.close once");
    assert_ne!(
        close_tid, caller,
        "close must be off caller/callback thread"
    );
    assert_eq!(closes.load(Ordering::SeqCst), 1);
    // Second remove is a no-op (no session / close_invoked).
    sessions.remove_on_transport_ended(&resp.session_id);
    assert_eq!(closes.load(Ordering::SeqCst), 1);
}

#[test]
fn ssh_ipc_commands_registered_in_lib_source() {
    let raw = include_str!("lib.rs");
    for name in [
        "local_ssh_open",
        "local_ssh_write",
        "local_ssh_resize",
        "local_ssh_close",
    ] {
        assert!(raw.contains(name), "lib.rs must register/define {name}");
    }
    assert!(raw.contains("generate_handler!["));
    assert!(raw.contains("spawn_blocking") || raw.contains("async fn local_ssh_open"));
    assert!(raw.contains("mod ssh_ipc"));
    assert!(raw.contains("user_message") || raw.contains("map_ssh"));
}

#[test]
fn ssh_ipc_vault_error_mapping_no_secret() {
    let e = vault_error_to_ssh(VaultError::NotFound);
    assert!(matches!(e, SshSessionError::AuthorizationFailed));
    assert!(!map_ssh_user(e).contains("NotFound"));
}

// silence unused import warnings in some builds
#[allow(dead_code)]
fn _lease_type(_: VaultCredentialLease) {}
#[allow(dead_code)]
fn _principal(_: NativePrincipal) {}
