//! D4B2b — deterministic actor transport tests (fake backend; no external SSH).

use super::*;
use crate::auth::{AuthError, AuthStore, RandomSource};
use crate::ssh_registry::{LocalSshConnector, LocalSshSessionManager, LocalSshTransport};
use crate::ssh_session::{
    CloudHostKeyParams, CloudHostKeyWriter, HostKeyConfirmer, LocalKnownHosts, PreparedSshTarget,
    SshSessionError, TofuPrompt,
};
use crate::vault::VaultCredentialLease;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroizing;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// Deterministic RNG for registry open_session tests.
struct DetRng([u8; 32]);

impl RandomSource for DetRng {
    fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), AuthError> {
        for (i, b) in dest.iter_mut().enumerate() {
            *b = self.0[i % 32];
        }
        Ok(())
    }
}

fn sample_target() -> PreparedSshTarget {
    PreparedSshTarget {
        server_id: "s".into(),
        name: "n".into(),
        host: "127.0.0.1".into(),
        port: 1,
        username: "u".into(),
        credential_id: "c".into(),
        host_key_status: crate::ssh_session::HostKeyStatus::Unpinned,
        host_key_type: None,
        host_key_fingerprint: None,
        principal: crate::auth::NativePrincipal {
            tenant_id: "t".into(),
            user_id: "u".into(),
            subject: "sub:u".into(),
        },
        session_epoch: 1,
    }
}

// ─── Fair I/O scheduling (production policy; regresses cmd_burst starvation) ─

/// Documents the pre-fix bug: after one cmd, peer wait was disabled.
fn old_buggy_peer_arm_enabled(cmd_burst: u32) -> bool {
    let prefer_wait = cmd_burst >= 8;
    prefer_wait || cmd_burst == 0
}

#[test]
fn fair_io_scheduler_peer_armed_after_single_cmd() {
    // Old policy starved remote output/EOF after exactly one write/resize.
    assert!(
        !old_buggy_peer_arm_enabled(1),
        "documents historical bug: peer disarmed after one cmd"
    );

    let mut sched = FairIoScheduler::new(FAIR_IO_MAX_BURST);
    sched.on_cmd(); // one successful write/resize
    assert!(
        sched.peer_arm_enabled(),
        "production policy must keep peer arm enabled after one cmd"
    );
    assert!(sched.cmd_arm_enabled(), "cmd arm must remain enabled");
    assert!(
        !sched.prefer_cmd_first(),
        "after a single cmd, prefer peer first so remote Data/EOF is consumed"
    );
}

#[test]
fn fair_io_scheduler_prefers_cmd_after_peer_burst_without_disabling_peer() {
    let mut sched = FairIoScheduler::new(FAIR_IO_MAX_BURST);
    for _ in 0..FAIR_IO_MAX_BURST {
        sched.on_peer();
    }
    assert!(sched.prefer_cmd_first());
    assert!(sched.peer_arm_enabled());
    assert!(sched.cmd_arm_enabled());
    sched.on_cmd();
    assert!(!sched.prefer_cmd_first());
}

#[test]
fn russh_transport_peer_data_eof_after_single_write_without_more_cmds() {
    // Regression: one write then remote Data+EOF must deliver without more cmds.
    let sink = Arc::new(RecordingSink::default());
    let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
    t.write(b"x").expect("single write");
    peer.peer_tx
        .try_send(PeerEvent::Data(b"out".to_vec()))
        .unwrap();
    peer.peer_tx.try_send(PeerEvent::Eof).unwrap();

    let mut saw_data = false;
    let mut saw_closed = false;
    for _ in 0..100 {
        let ev = sink.events.lock().unwrap().clone();
        saw_data = ev
            .iter()
            .any(|e| matches!(e, TerminalOutput::Data(d) if d == b"out"));
        saw_closed = ev.iter().any(|e| matches!(e, TerminalOutput::Closed));
        if saw_data && saw_closed {
            break;
        }
        sleep_ms(10);
    }
    assert!(
        saw_data,
        "remote Data after single write must be delivered without further commands"
    );
    assert!(
        saw_closed,
        "remote EOF after single write must emit Closed without further commands"
    );
    assert!(matches!(
        t.write(b"after"),
        Err(SshSessionError::TransportClosed)
    ));
}

// ─── Bounded cleanup (production helper) ─────────────────────────────────────

#[test]
fn bounded_await_times_out_hung_cleanup_op() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("rt");
    rt.block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(40);
        let start = std::time::Instant::now();
        bounded_await(deadline, std::future::pending::<()>()).await;
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_millis(250),
            "hung cleanup must not exceed deadline, took {elapsed:?}"
        );
        assert!(
            elapsed >= Duration::from_millis(25),
            "must actually wait until near deadline, took {elapsed:?}"
        );
    });
}

#[test]
fn run_cleanup_io_respects_deadline_and_flags() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("rt");
    rt.block_on(async {
        let closed = Arc::new(AtomicBool::new(false));
        let disc = Arc::new(AtomicBool::new(false));
        let c1 = Arc::clone(&closed);
        let d1 = Arc::clone(&disc);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(80);
        let start = std::time::Instant::now();
        run_cleanup_io(
            deadline,
            true,
            true,
            async move {
                c1.store(true, Ordering::SeqCst);
                std::future::pending::<()>().await;
            },
            async move {
                d1.store(true, Ordering::SeqCst);
                std::future::pending::<()>().await;
            },
        )
        .await;
        assert!(start.elapsed() < Duration::from_millis(300));
        // close_channel ran (flag set) before hanging; disconnect may or may not
        // start if close consumed the full deadline — both paths are deadline-capped.
        assert!(closed.load(Ordering::SeqCst));

        // Flags false → ops not invoked.
        let ran = AtomicBool::new(false);
        let r1 = Arc::new(AtomicBool::new(false));
        let r2 = Arc::clone(&r1);
        let r3 = Arc::clone(&r1);
        run_cleanup_io(
            tokio::time::Instant::now() + Duration::from_secs(1),
            false,
            false,
            async move {
                r2.store(true, Ordering::SeqCst);
            },
            async move {
                r3.store(true, Ordering::SeqCst);
            },
        )
        .await;
        assert!(
            !r1.load(Ordering::SeqCst) && !ran.load(Ordering::SeqCst),
            "disabled cleanup flags must not run ops"
        );
    });
}

// ─── Shared cancel helper (production control path) ──────────────────────────

#[test]
fn await_or_cancel_preempts_in_flight_op() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("rt");
    rt.block_on(async {
        let (tx, mut rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            await_or_cancel(&mut rx, async {
                std::future::pending::<Result<(), SshSessionError>>().await
            })
            .await
        });
        tokio::task::yield_now().await;
        tx.send(true).expect("cancel");
        let r = task.await.expect("join");
        assert!(
            matches!(r, Err(SshSessionError::TransportClosed)),
            "cancel must preempt pending op, got {r:?}"
        );
    });
}

#[test]
fn await_or_cancel_returns_ok_when_op_completes() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("rt");
    rt.block_on(async {
        let (_tx, mut rx) = watch::channel(false);
        let r = await_or_cancel(&mut rx, async { Ok::<_, SshSessionError>(42u32) }).await;
        assert_eq!(r.unwrap(), 42);
    });
}

#[test]
fn await_or_cancel_pre_check_already_cancelled() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("rt");
    rt.block_on(async {
        let (tx, mut rx) = watch::channel(false);
        tx.send(true).unwrap();
        let mut ran = false;
        let r = await_or_cancel(&mut rx, async {
            ran = true;
            Ok::<_, SshSessionError>(())
        })
        .await;
        assert!(matches!(r, Err(SshSessionError::TransportClosed)));
        assert!(!ran, "op must not run when already cancelled");
    });
}

// ─── Lifecycle / ack ─────────────────────────────────────────────────────────

#[test]
fn russh_transport_dedicated_runtime_alive_after_open() {
    let sink = Arc::new(RecordingSink::default());
    let (t, peer) = open_fake_transport(sink as Arc<dyn TerminalSink>);
    t.write(b"ping").unwrap();
    sleep_ms(50);
    let done = peer.completed.lock().unwrap().clone();
    assert_eq!(done, vec!["write:4".to_string()]);
    t.close().unwrap();
}

#[test]
fn russh_transport_write_acks_after_backend_success_exact_bytes() {
    let sink = Arc::new(RecordingSink::default());
    let (t, peer) = open_fake_transport(sink as Arc<dyn TerminalSink>);
    t.write(b"hello").unwrap();
    t.write(&[0x00, 0xff, 0x80]).unwrap();
    let done = peer.completed.lock().unwrap().clone();
    assert_eq!(done, vec!["write:5".to_string(), "write:3".to_string()]);
    t.close().unwrap();
}

#[test]
fn russh_transport_resize_acks() {
    let sink = Arc::new(RecordingSink::default());
    let (t, peer) = open_fake_transport(sink as Arc<dyn TerminalSink>);
    t.resize(120, 40).unwrap();
    assert_eq!(
        *peer.completed.lock().unwrap(),
        vec!["resize:120x40".to_string()]
    );
    t.close().unwrap();
}

#[test]
fn russh_transport_close_while_write_blocked_returns_transport_closed() {
    let sink = Arc::new(RecordingSink::default());
    let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);

    let blocked = Arc::new(tokio::sync::Notify::new());
    let never_release = Arc::new(tokio::sync::Notify::new());
    *peer.block_write.lock().unwrap() = Some(Arc::clone(&blocked));
    *peer.release_write.lock().unwrap() = Some(never_release);

    let t_w = Arc::clone(&t);
    let writer = std::thread::spawn(move || t_w.write(b"blocked-payload"));

    for _ in 0..50 {
        if peer.block_write.lock().unwrap().is_none() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    t.close().unwrap();
    let wr = writer.join().expect("join");
    assert!(
        matches!(wr, Err(SshSessionError::TransportClosed)),
        "writer must get TransportClosed, got {wr:?}"
    );
    sleep_ms(30);
    let n_closed = sink
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, TerminalOutput::Closed))
        .count();
    assert_eq!(n_closed, 1);
    t.close().unwrap(); // idempotent
    assert_eq!(
        sink.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count(),
        1
    );
}

#[test]
fn russh_transport_queue_full_fail_closed() {
    let sink = Arc::new(RecordingSink::default());
    let (t, peer) = open_fake_transport(sink as Arc<dyn TerminalSink>);
    let blocked = Arc::new(tokio::sync::Notify::new());
    let never = Arc::new(tokio::sync::Notify::new());
    *peer.block_write.lock().unwrap() = Some(Arc::clone(&blocked));
    *peer.release_write.lock().unwrap() = Some(never);

    let t_w = Arc::clone(&t);
    let writer = std::thread::spawn(move || {
        let _ = t_w.write(b"hold");
    });
    for _ in 0..100 {
        if peer.block_write.lock().unwrap().is_none() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }

    let saw_full = Arc::new(AtomicBool::new(false));
    let mut fillers = Vec::with_capacity(MAX_TRANSPORT_CMD_QUEUE + 8);
    for i in 0..(MAX_TRANSPORT_CMD_QUEUE + 8) {
        let t_c = Arc::clone(&t);
        let saw = Arc::clone(&saw_full);
        fillers.push(std::thread::spawn(move || {
            match t_c.resize(80 + i as u32, 24) {
                Err(SshSessionError::CommandQueueFull) => {
                    saw.store(true, Ordering::SeqCst);
                }
                Ok(()) | Err(SshSessionError::TransportClosed) => {}
                Err(e) => panic!("unexpected {e:?}"),
            }
        }));
    }
    for _ in 0..200 {
        if saw_full.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        saw_full.load(Ordering::SeqCst),
        "expected CommandQueueFull from concurrent enqueue while write blocked"
    );
    t.close().unwrap();
    let _ = writer.join();
    for h in fillers {
        let _ = h.join();
    }
}

#[test]
fn russh_transport_peer_eof_close_exit_emits_closed_once_via_actor() {
    let sink = Arc::new(RecordingSink::default());
    let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
    peer.peer_tx
        .try_send(PeerEvent::Data(b"x".to_vec()))
        .unwrap();
    peer.peer_tx.try_send(PeerEvent::Eof).unwrap();
    let _ = peer.peer_tx.try_send(PeerEvent::Close);
    sleep_ms(80);
    let n = sink
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, TerminalOutput::Closed))
        .count();
    assert_eq!(n, 1, "EOF yields exactly one Closed");
    // Exact TransportClosed only — no CommandQueueFull allowance.
    assert!(
        matches!(t.write(b"after"), Err(SshSessionError::TransportClosed)),
        "write after peer EOF must be exact TransportClosed"
    );
}

#[test]
fn russh_transport_stdout_stderr_binary_via_peer_channel() {
    let sink = Arc::new(RecordingSink::default());
    let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
    peer.peer_tx
        .try_send(PeerEvent::Data(vec![0x00, 0xff]))
        .unwrap();
    peer.peer_tx
        .try_send(PeerEvent::ExtendedData {
            data: vec![0xfe],
            ext: 1,
        })
        .unwrap();
    sleep_ms(50);
    let ev = sink.events.lock().unwrap().clone();
    assert!(ev
        .iter()
        .any(|e| matches!(e, TerminalOutput::Data(d) if d == &[0x00, 0xff])));
    assert!(ev.iter().any(|e| matches!(
        e,
        TerminalOutput::ExtendedData { data, ext: 1 } if data == &[0xfe]
    )));
    let dbg = format!("{ev:?}");
    assert!(!dbg.contains("pem"));
    t.close().unwrap();
}

#[test]
fn russh_transport_cmd_debug_redacts_bytes() {
    let k = CmdKind::Write(Zeroizing::new(b"secret-payload".to_vec()));
    let d = format!("{k:?}");
    assert!(d.contains("len"));
    assert!(!d.contains("secret-payload"));
}

#[test]
fn russh_error_variants_secret_free() {
    for e in [
        SshSessionError::AuthenticationFailed,
        SshSessionError::ConnectFailed,
        SshSessionError::ChannelFailed,
        SshSessionError::TransportClosed,
        SshSessionError::CommandQueueFull,
    ] {
        assert!(!e.user_message().is_empty());
        let d = format!("{e:?}");
        assert!(!d.to_lowercase().contains("pem"));
        assert!(!d.to_lowercase().contains("bearer"));
    }
}

// ─── Staged startup failures (production cleanup planner) ────────────────────

#[test]
fn russh_setup_stage_failures_use_production_cleanup_plan() {
    // Connect: no handle → no disconnect claim.
    let (res, st) = open_transport_with_failing_stage(SetupStage::Connect);
    assert!(matches!(res, Err(SshSessionError::ConnectFailed)));
    assert_eq!(
        st.disconnects, 0,
        "connect failure has no handle to disconnect"
    );
    assert_eq!(st.channel_closes, 0);

    // Auth: disconnect exactly once, no channel.
    let (res, st) = open_transport_with_failing_stage(SetupStage::Auth);
    assert!(matches!(res, Err(SshSessionError::AuthenticationFailed)));
    assert_eq!(st.disconnects, 1);
    assert_eq!(st.channel_closes, 0);

    // Channel open fail: disconnect once, no channel-close (never opened for I/O cleanup beyond open fail).
    let (res, st) = open_transport_with_failing_stage(SetupStage::Channel);
    assert!(matches!(res, Err(SshSessionError::ChannelFailed)));
    assert_eq!(st.disconnects, 1);
    assert_eq!(st.channel_closes, 0);

    // PTY/shell: channel-close + disconnect once.
    for stage in [SetupStage::Pty, SetupStage::Shell] {
        let (res, st) = open_transport_with_failing_stage(stage);
        assert!(
            matches!(res, Err(SshSessionError::ChannelFailed)),
            "stage {stage:?}"
        );
        assert_eq!(st.disconnects, 1, "disconnect once for {stage:?}");
        assert_eq!(st.channel_closes, 1, "channel close for {stage:?}");
    }
}

#[test]
fn plan_setup_failure_disconnect_exactly_once() {
    let mut state = SetupCleanupState::default();
    let (c1, d1) = plan_setup_failure(&mut state, SetupFailKind::PostConnectNoChannel);
    assert!(!c1 && d1);
    assert_eq!(state.disconnects, 1);
    let (c2, d2) = plan_setup_failure(&mut state, SetupFailKind::PostChannel);
    assert!(c2 && !d2, "second plan must not disconnect again");
    assert_eq!(state.disconnects, 1);
    assert_eq!(state.channel_closes, 1);
}

// ─── Connector single-use ────────────────────────────────────────────────────

struct NopConfirm;
impl HostKeyConfirmer for NopConfirm {
    fn confirm_tofu(&self, _: &TofuPrompt) -> Result<bool, SshSessionError> {
        Ok(true)
    }
}
struct NopCloud;
impl CloudHostKeyWriter for NopCloud {
    fn write_host_key(&self, _: &CloudHostKeyParams, _: &str) -> Result<(), SshSessionError> {
        Ok(())
    }
}
struct NopKh;
impl LocalKnownHosts for NopKh {
    fn record_host_key(&self, _: &str, _: &str, _: &str) -> Result<(), SshSessionError> {
        Ok(())
    }
}

#[test]
fn russh_lease_connector_second_use_fails_closed() {
    let lease = VaultCredentialLease {
        credential_id: "c".into(),
        fingerprint: "fp".into(),
        pem: Zeroizing::new("-----BEGIN OPENSSH PRIVATE KEY-----\n".into()),
        passphrase: None,
    };
    let auth = Arc::new(AuthStore::new());
    let conn = RusshLeaseConnector::new(
        lease,
        auth,
        Arc::new(NopConfirm),
        Arc::new(NopCloud),
        Arc::new(NopKh),
        Arc::new(NullTerminalSink),
    );
    let target = sample_target();
    let first = conn.connect(&target);
    assert!(first.is_err());
    let second = conn.connect(&target);
    assert!(
        matches!(second, Err(SshSessionError::Internal)),
        "second use must fail closed"
    );
}

#[test]
fn russh_connector_failure_does_not_register_session() {
    let mgr = LocalSshSessionManager::new();
    assert_eq!(mgr.session_count(), 0);
    let lease = VaultCredentialLease {
        credential_id: "c".into(),
        fingerprint: "fp".into(),
        pem: Zeroizing::new("not-a-key".into()),
        passphrase: None,
    };
    let auth = Arc::new(AuthStore::new());
    auth.install_session_for_tests("t", "u", "admin");
    // Bind target epoch to the installed session.
    let snap = auth.native_auth_snapshot().expect("session");
    let mut target = sample_target();
    target.principal = snap.principal.clone();
    target.session_epoch = snap.epoch;

    let conn = RusshLeaseConnector::new(
        lease,
        Arc::clone(&auth),
        Arc::new(NopConfirm),
        Arc::new(NopCloud),
        Arc::new(NopKh),
        Arc::new(NullTerminalSink),
    );
    let rng = DetRng([7u8; 32]);
    // Must go through the registry open path (not connector alone).
    let result = mgr.open_session(auth.as_ref(), &target, &conn, &rng);
    assert!(result.is_err(), "open_session must fail with bad lease/PEM");
    assert_eq!(
        mgr.session_count(),
        0,
        "failed connector must not register a session"
    );
}

#[test]
fn russh_open_path_symbol_linked() {
    let _ = open_russh_transport
        as fn(
            PreparedSshTarget,
            VaultCredentialLease,
            Arc<AuthStore>,
            Arc<dyn HostKeyConfirmer>,
            Arc<dyn CloudHostKeyWriter>,
            Arc<dyn LocalKnownHosts>,
            Arc<dyn TerminalSink>,
        ) -> Result<Arc<ActorSshTransport>, SshSessionError>;
    let _ = DEFAULT_PTY_COLS;
    let _ = MAX_TRANSPORT_CMD_QUEUE;
}
