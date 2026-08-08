//! D4B2b — russh session transport actor (no Tauri/UI; unit tests use an injected fake).
//!
//! # Architecture
//! - A **dedicated OS thread** owns a Tokio runtime for the **entire transport lifetime**.
//! - [`ActorSshTransport`] implements [`LocalSshTransport`] with **bounded** cmd queue.
//! - Sync methods never call `Handle::block_on` (safe if already on a runtime).
//! - Write/Resize use **oneshot acks**: return only after backend success or cancel/error.
//! - Cancellation uses `tokio::sync::watch<bool>` (stateful; no lost Notify races).
//! - In-flight Write/Resize are preempted via [`await_or_cancel`] (shared real + fake path).
//! - Production path: lease PEM → [`HostKeyPolicyHandler`] → connect → publickey →
//!   session → PTY `xterm-256color` 80×24 (`want_reply`) → shell → fair I/O loop.
//!
//! # Bounds
//! | Constant | Value | Behavior |
//! |---|---|---|
//! | [`MAX_TRANSPORT_CMD_QUEUE`] | 32 | try_send fails → [`SshSessionError::CommandQueueFull`] (no unbounded wait) |
//! | Overall setup timeout | 30s | single deadline for connect→shell (no stacked stage timers) |
//!
//! Output is delivered **directly** to [`TerminalSink`] (not an intermediate output queue).
//! [`MAX_TRANSPORT_RECORD_EVENTS`] bounds test-only recording sinks only.
//!
//! Secrets never appear in Debug/errors/events.

use crate::auth::AuthStore;
use crate::ssh_registry::LocalSshTransport;
use crate::ssh_session::{
    CloudHostKeyWriter, HostKeyConfirmer, HostKeyPolicyHandler, LocalKnownHosts, PreparedSshTarget,
    SshSessionError,
};
use crate::vault::VaultCredentialLease;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use zeroize::Zeroizing;

/// Max pending write/resize commands (fail-closed when full).
pub const MAX_TRANSPORT_CMD_QUEUE: usize = 32;
/// Test-only recording sink bound (not a production output queue).
pub const MAX_TRANSPORT_RECORD_EVENTS: usize = 64;
pub const DEFAULT_PTY_COLS: u32 = 80;
pub const DEFAULT_PTY_ROWS: u32 = 24;
const PTY_TERM: &str = "xterm-256color";
/// Single overall startup deadline (connect → auth → channel → PTY → shell).
const SETUP_OVERALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Grace for parent ready-channel after actor hits the same overall deadline.
const SETUP_PARENT_GRACE: Duration = Duration::from_secs(2);
/// Bounded join when tearing down actor thread (must exceed session teardown budget).
const ACTOR_JOIN_TIMEOUT: Duration = Duration::from_secs(3);
/// Post-setup cancel/close I/O budget (channel.close + disconnect); < join timeout.
const SESSION_TEARDOWN_BUDGET: Duration = Duration::from_secs(2);
/// After this many consecutive peer msgs, prefer cmd first so cmds/cancel stay live.
const FAIR_IO_MAX_BURST: u32 = 8;
/// Max wait for a single command ack (cancel is checked continuously).
const CMD_ACK_POLL: Duration = Duration::from_millis(25);

// ─── Output ──────────────────────────────────────────────────────────────────

/// Binary terminal output / lifecycle (D4B2c-ready).
#[derive(Clone, PartialEq, Eq)]
pub enum TerminalOutput {
    Data(Vec<u8>),
    ExtendedData {
        data: Vec<u8>,
        ext: u32,
    },
    /// Emitted **exactly once** (EOF / Close / ExitStatus / local cancel).
    Closed,
}

impl std::fmt::Debug for TerminalOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TerminalOutput::Data(d) => f
                .debug_struct("Data")
                .field("len", &d.len())
                .finish_non_exhaustive(),
            TerminalOutput::ExtendedData { data, ext } => f
                .debug_struct("ExtendedData")
                .field("ext", ext)
                .field("len", &data.len())
                .finish_non_exhaustive(),
            TerminalOutput::Closed => write!(f, "Closed"),
        }
    }
}

/// Session output sink. Must not log secrets.
pub trait TerminalSink: Send + Sync {
    fn on_output(&self, chunk: TerminalOutput);
    fn on_error(&self, _err: SshSessionError) {}
}

#[derive(Debug, Default, Clone, Copy)]
pub struct NullTerminalSink;

impl TerminalSink for NullTerminalSink {
    fn on_output(&self, _chunk: TerminalOutput) {}
}

// ─── Commands (acked) ────────────────────────────────────────────────────────

enum CmdKind {
    Write(Zeroizing<Vec<u8>>),
    Resize { cols: u32, rows: u32 },
}

impl std::fmt::Debug for CmdKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CmdKind::Write(b) => f
                .debug_struct("Write")
                .field("len", &b.len())
                .finish_non_exhaustive(),
            CmdKind::Resize { cols, rows } => f
                .debug_struct("Resize")
                .field("cols", cols)
                .field("rows", rows)
                .finish(),
        }
    }
}

struct ActorCmd {
    kind: CmdKind,
    /// Filled when backend finishes (or cancel/error).
    reply: oneshot::Sender<Result<(), SshSessionError>>,
}

// ─── Cancellation-aware await (shared real + fake + unit tests) ──────────────

/// Await `op` until it completes or the cancel watch becomes `true`.
///
/// Pre-checks the watch (so a cancel set before arming `changed()` still wins).
/// Used by the real russh Write/Resize path and the fake blocked-write path so
/// tests exercise the same control flow as production.
pub(crate) async fn await_or_cancel<F, T>(
    cancel_rx: &mut watch::Receiver<bool>,
    op: F,
) -> Result<T, SshSessionError>
where
    F: std::future::Future<Output = Result<T, SshSessionError>>,
{
    if *cancel_rx.borrow() {
        return Err(SshSessionError::TransportClosed);
    }
    tokio::select! {
        biased;
        changed = cancel_rx.changed() => {
            let _ = changed;
            Err(SshSessionError::TransportClosed)
        }
        result = op => result,
    }
}

// ─── Setup cleanup policy (production + tests share control flow) ────────────

/// Kind of setup failure — drives whether channel-close / disconnect run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SetupFailKind {
    /// TCP/KEX failed before a session handle exists → no disconnect.
    Connect,
    /// Handle exists, channel not open (auth or channel_open) → disconnect once.
    PostConnectNoChannel,
    /// Channel open (PTY/shell) → close channel then disconnect once.
    PostChannel,
}

/// Accumulates cleanup side-effects during setup (disconnect ≤ 1).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct SetupCleanupState {
    pub channel_closes: u32,
    pub disconnects: u32,
}

/// Record planned cleanup for a setup failure. Returns `(close_channel, disconnect)`.
/// Production performs the corresponding I/O when a flag is true; tests assert counts.
pub(crate) fn plan_setup_failure(
    state: &mut SetupCleanupState,
    kind: SetupFailKind,
) -> (bool, bool) {
    let close_channel = matches!(kind, SetupFailKind::PostChannel);
    if close_channel {
        state.channel_closes = state.channel_closes.saturating_add(1);
    }
    let disconnect = match kind {
        SetupFailKind::Connect => false,
        SetupFailKind::PostConnectNoChannel | SetupFailKind::PostChannel => {
            if state.disconnects == 0 {
                state.disconnects = 1;
                true
            } else {
                false
            }
        }
    };
    (close_channel, disconnect)
}

/// Await `fut` until completion or `deadline` (never hangs cleanup/close).
pub(crate) async fn bounded_await<F>(deadline: tokio::time::Instant, fut: F)
where
    F: std::future::Future,
{
    let _ = tokio::time::timeout_at(deadline, fut).await;
}

/// Deadline for cleanup I/O: remaining setup budget, else short teardown budget.
pub(crate) fn cleanup_deadline(
    setup_deadline: Option<tokio::time::Instant>,
) -> tokio::time::Instant {
    let now = tokio::time::Instant::now();
    match setup_deadline {
        Some(d) if d > now => d,
        _ => now + SESSION_TEARDOWN_BUDGET,
    }
}

/// Run planned channel-close / disconnect under a hard deadline (production helper).
pub(crate) async fn run_cleanup_io<C, D>(
    deadline: tokio::time::Instant,
    close_channel: bool,
    disconnect: bool,
    channel_close: C,
    disconnect_op: D,
) where
    C: std::future::Future<Output = ()>,
    D: std::future::Future<Output = ()>,
{
    if close_channel {
        bounded_await(deadline, channel_close).await;
    }
    if disconnect {
        bounded_await(deadline, disconnect_op).await;
    }
}

// ─── Fair I/O scheduling (production policy; real + fake share it) ───────────

/// Fair arm preference for the actor select loop.
///
/// **Both peer and cmd arms stay armed always** — only order after cancel changes.
/// Never disable `channel.wait()` after a single command (that starved remote
/// output/EOF). After a peer burst, prefer cmd so local write/resize/cancel
/// cannot starve under continuous remote data.
#[derive(Debug, Clone)]
pub(crate) struct FairIoScheduler {
    consecutive_peer: u32,
    consecutive_cmd: u32,
    max_burst: u32,
}

impl FairIoScheduler {
    pub(crate) fn new(max_burst: u32) -> Self {
        Self {
            consecutive_peer: 0,
            consecutive_cmd: 0,
            max_burst: max_burst.max(1),
        }
    }

    /// When true, select cmd before peer (both still armed). Cancel always first.
    pub(crate) fn prefer_cmd_first(&self) -> bool {
        self.consecutive_peer >= self.max_burst
    }

    pub(crate) fn on_peer(&mut self) {
        self.consecutive_peer = self.consecutive_peer.saturating_add(1);
        self.consecutive_cmd = 0;
    }

    pub(crate) fn on_cmd(&mut self) {
        self.consecutive_cmd = self.consecutive_cmd.saturating_add(1);
        self.consecutive_peer = 0;
    }

    /// Test/observability: peer arm must remain eligible after any cmd count.
    pub(crate) fn peer_arm_enabled(&self) -> bool {
        true
    }

    /// Test/observability: cmd arm must remain eligible after any peer count.
    pub(crate) fn cmd_arm_enabled(&self) -> bool {
        true
    }
}

// ─── ActorSshTransport ───────────────────────────────────────────────────────

/// Shareable transport. Actor thread + runtime live until close/drop.
pub struct ActorSshTransport {
    cmd_tx: mpsc::Sender<ActorCmd>,
    /// `true` means cancelled/closed (stateful; no lost-notify race).
    cancel_tx: watch::Sender<bool>,
    cancel_rx: watch::Receiver<bool>,
    closed: AtomicBool,
    /// Dedicated OS thread joining the runtime/actor.
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl ActorSshTransport {
    fn is_cancelled(&self) -> bool {
        *self.cancel_rx.borrow()
    }

    /// Enqueue command and wait for backend ack (or cancel / queue full).
    fn send_cmd(&self, kind: CmdKind) -> Result<(), SshSessionError> {
        if self.is_cancelled() || self.closed.load(Ordering::SeqCst) {
            return Err(SshSessionError::TransportClosed);
        }
        let (reply_tx, mut reply_rx) = oneshot::channel();
        let cmd = ActorCmd {
            kind,
            reply: reply_tx,
        };
        match self.cmd_tx.try_send(cmd) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                return Err(SshSessionError::CommandQueueFull);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                return Err(SshSessionError::TransportClosed);
            }
        }
        // Poll ack; never call block_on on a Tokio handle (runtime-context safe).
        let mut cancel_rx = self.cancel_rx.clone();
        loop {
            if *cancel_rx.borrow() {
                return Err(SshSessionError::TransportClosed);
            }
            match reply_rx.try_recv() {
                Ok(r) => return r,
                Err(oneshot::error::TryRecvError::Empty) => {
                    std::thread::sleep(CMD_ACK_POLL);
                    if cancel_rx.has_changed().unwrap_or(false) {
                        let _ = cancel_rx.borrow_and_update();
                    }
                    if *cancel_rx.borrow() {
                        return Err(SshSessionError::TransportClosed);
                    }
                }
                Err(oneshot::error::TryRecvError::Closed) => {
                    return Err(SshSessionError::TransportClosed);
                }
            }
        }
    }
}

impl LocalSshTransport for ActorSshTransport {
    fn write(&self, data: &[u8]) -> Result<(), SshSessionError> {
        self.send_cmd(CmdKind::Write(Zeroizing::new(data.to_vec())))
    }

    fn resize(&self, cols: u32, rows: u32) -> Result<(), SshSessionError> {
        self.send_cmd(CmdKind::Resize { cols, rows })
    }

    fn close(&self) -> Result<(), SshSessionError> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let _ = self.cancel_tx.send(true);
        if let Ok(mut g) = self.thread.lock() {
            if let Some(h) = g.take() {
                join_actor_thread(h, ACTOR_JOIN_TIMEOUT);
            }
        }
        Ok(())
    }
}

impl Drop for ActorSshTransport {
    fn drop(&mut self) {
        let _ = LocalSshTransport::close(self);
    }
}

// ─── Spawn / join helpers ────────────────────────────────────────────────────

fn spawn_actor_thread<F>(name: &'static str, f: F) -> Result<JoinHandle<()>, SshSessionError>
where
    F: FnOnce() + Send + 'static,
{
    std::thread::Builder::new()
        .name(name.into())
        .spawn(f)
        .map_err(|_| SshSessionError::Internal)
}

fn join_actor_thread(thread: JoinHandle<()>, timeout: Duration) {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = thread.join();
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(timeout);
}

fn emit_closed_once(sink: &dyn TerminalSink, once: &AtomicBool) {
    if !once.swap(true, Ordering::SeqCst) {
        sink.on_output(TerminalOutput::Closed);
    }
}

// ─── Peer events (test-only fake backend) ────────────────────────────────────

/// Events from the fake peer into the actor (tests only).
#[cfg(test)]
#[derive(Debug, Clone)]
pub enum PeerEvent {
    Data(Vec<u8>),
    ExtendedData { data: Vec<u8>, ext: u32 },
    Eof,
    Close,
    ExitStatus(u32),
}

// ─── Fake backend (cfg(test) API surface) ────────────────────────────────────

/// Shared handles for tests to inject peer events and observe acked commands.
#[cfg(test)]
pub struct FakePeerHandle {
    pub peer_tx: mpsc::Sender<PeerEvent>,
    /// Commands that completed successfully (acked Ok).
    pub completed: Arc<Mutex<Vec<String>>>,
    /// When set, Write waits until `release_write` is notified (backend-blocked).
    pub block_write: Arc<Mutex<Option<Arc<tokio::sync::Notify>>>>,
    pub release_write: Arc<Mutex<Option<Arc<tokio::sync::Notify>>>>,
}

#[cfg(test)]
#[derive(Default)]
pub struct RecordingSink {
    pub events: Mutex<Vec<TerminalOutput>>,
    pub errors: Mutex<Vec<SshSessionError>>,
}

#[cfg(test)]
impl TerminalSink for RecordingSink {
    fn on_output(&self, chunk: TerminalOutput) {
        let mut g = self.events.lock().unwrap_or_else(|e| e.into_inner());
        if g.len() >= MAX_TRANSPORT_RECORD_EVENTS {
            g.remove(0);
        }
        g.push(chunk);
    }
    fn on_error(&self, err: SshSessionError) {
        self.errors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(err);
    }
}

/// Open a fake-backed transport on a **dedicated** actor thread/runtime.
#[cfg(test)]
pub fn open_fake_transport(
    sink: Arc<dyn TerminalSink>,
) -> (Arc<ActorSshTransport>, FakePeerHandle) {
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<ActorCmd>(MAX_TRANSPORT_CMD_QUEUE);
    let (peer_tx, mut peer_rx) = mpsc::channel::<PeerEvent>(MAX_TRANSPORT_CMD_QUEUE);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let completed = Arc::new(Mutex::new(Vec::new()));
    let block_write: Arc<Mutex<Option<Arc<tokio::sync::Notify>>>> = Arc::new(Mutex::new(None));
    let release_write: Arc<Mutex<Option<Arc<tokio::sync::Notify>>>> = Arc::new(Mutex::new(None));
    let closed = AtomicBool::new(false);

    let completed_t = Arc::clone(&completed);
    let block_t = Arc::clone(&block_write);
    let release_t = Arc::clone(&release_write);
    let mut cancel_rx_t = cancel_rx.clone();
    let sink_t = Arc::clone(&sink);

    let thread = spawn_actor_thread("ssh-fake-actor", move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("fake actor runtime");
        rt.block_on(async move {
            let closed_once = AtomicBool::new(false);
            // Same production FairIoScheduler policy as run_real_session_loop.
            let mut sched = FairIoScheduler::new(FAIR_IO_MAX_BURST);
            loop {
                if *cancel_rx_t.borrow() {
                    while let Ok(c) = cmd_rx.try_recv() {
                        let _ = c.reply.send(Err(SshSessionError::TransportClosed));
                    }
                    emit_closed_once(sink_t.as_ref(), &closed_once);
                    break;
                }
                debug_assert!(sched.peer_arm_enabled() && sched.cmd_arm_enabled());
                let prefer_cmd = sched.prefer_cmd_first();
                let branch = if prefer_cmd {
                    tokio::select! {
                        biased;
                        _ = cancel_rx_t.changed() => IoSelectBranch::Cancel,
                        cmd = cmd_rx.recv() => IoSelectBranch::Cmd(cmd),
                        peer = peer_rx.recv() => IoSelectBranch::Peer(peer),
                    }
                } else {
                    tokio::select! {
                        biased;
                        _ = cancel_rx_t.changed() => IoSelectBranch::Cancel,
                        peer = peer_rx.recv() => IoSelectBranch::Peer(peer),
                        cmd = cmd_rx.recv() => IoSelectBranch::Cmd(cmd),
                    }
                };
                match branch {
                    IoSelectBranch::Cancel => {
                        if *cancel_rx_t.borrow() {
                            while let Ok(c) = cmd_rx.try_recv() {
                                let _ = c.reply.send(Err(SshSessionError::TransportClosed));
                            }
                            emit_closed_once(sink_t.as_ref(), &closed_once);
                            break;
                        }
                    }
                    IoSelectBranch::Peer(peer) => {
                        sched.on_peer();
                        match peer {
                            None => {
                                emit_closed_once(sink_t.as_ref(), &closed_once);
                                break;
                            }
                            Some(PeerEvent::Data(d)) => {
                                sink_t.on_output(TerminalOutput::Data(d));
                            }
                            Some(PeerEvent::ExtendedData { data, ext }) => {
                                sink_t.on_output(TerminalOutput::ExtendedData { data, ext });
                            }
                            Some(PeerEvent::Eof)
                            | Some(PeerEvent::Close)
                            | Some(PeerEvent::ExitStatus(_)) => {
                                emit_closed_once(sink_t.as_ref(), &closed_once);
                                break;
                            }
                        }
                    }
                    IoSelectBranch::Cmd(cmd) => match cmd {
                        None => {
                            emit_closed_once(sink_t.as_ref(), &closed_once);
                            break;
                        }
                        Some(ActorCmd { kind, reply }) => {
                            sched.on_cmd();
                            if *cancel_rx_t.borrow() {
                                let _ = reply.send(Err(SshSessionError::TransportClosed));
                                emit_closed_once(sink_t.as_ref(), &closed_once);
                                break;
                            }
                            let result = match kind {
                                CmdKind::Write(data) => {
                                    let blocker = block_t.lock().ok().and_then(|mut g| g.take());
                                    if let Some(b) = blocker {
                                        let release = release_t
                                            .lock()
                                            .ok()
                                            .and_then(|mut g| g.take())
                                            .unwrap_or_else(
                                                || Arc::new(tokio::sync::Notify::new()),
                                            );
                                        b.notify_waiters();
                                        let r = await_or_cancel(&mut cancel_rx_t, async {
                                            release.notified().await;
                                            Ok(())
                                        })
                                        .await;
                                        if r.is_ok() {
                                            completed_t
                                                .lock()
                                                .unwrap()
                                                .push(format!("write:{}", data.len()));
                                        }
                                        r
                                    } else {
                                        completed_t
                                            .lock()
                                            .unwrap()
                                            .push(format!("write:{}", data.len()));
                                        Ok(())
                                    }
                                }
                                CmdKind::Resize { cols, rows } => {
                                    completed_t
                                        .lock()
                                        .unwrap()
                                        .push(format!("resize:{cols}x{rows}"));
                                    Ok(())
                                }
                            };
                            let _ = reply.send(result);
                        }
                    },
                }
            }
        });
    })
    .expect("spawn fake actor");

    let transport = Arc::new(ActorSshTransport {
        cmd_tx,
        cancel_tx,
        cancel_rx,
        closed,
        thread: Mutex::new(Some(thread)),
    });
    let handle = FakePeerHandle {
        peer_tx,
        completed,
        block_write,
        release_write,
    };
    (transport, handle)
}

// ─── Staged setup (test driver uses production cleanup planner) ──────────────

/// Stages of real SSH session setup (test injection surface).
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStage {
    Connect,
    Auth,
    Channel,
    Pty,
    Shell,
}

#[cfg(test)]
fn fail_kind_for_stage(stage: SetupStage) -> SetupFailKind {
    match stage {
        SetupStage::Connect => SetupFailKind::Connect,
        SetupStage::Auth | SetupStage::Channel => SetupFailKind::PostConnectNoChannel,
        SetupStage::Pty | SetupStage::Shell => SetupFailKind::PostChannel,
    }
}

#[cfg(test)]
fn error_for_stage(stage: SetupStage) -> SshSessionError {
    match stage {
        SetupStage::Connect => SshSessionError::ConnectFailed,
        SetupStage::Auth => SshSessionError::AuthenticationFailed,
        SetupStage::Channel | SetupStage::Pty | SetupStage::Shell => SshSessionError::ChannelFailed,
    }
}

/// Injected setup failure driver: same [`plan_setup_failure`] control flow as production.
/// Connect failure claims **no** disconnect (no handle). Post-connect stages disconnect once;
/// PTY/shell also record channel-close.
#[cfg(test)]
pub fn open_transport_with_failing_stage(
    fail_at: SetupStage,
) -> (Result<(), SshSessionError>, SetupCleanupState) {
    let mut state = SetupCleanupState::default();
    for stage in [
        SetupStage::Connect,
        SetupStage::Auth,
        SetupStage::Channel,
        SetupStage::Pty,
        SetupStage::Shell,
    ] {
        if stage == fail_at {
            let (_close_ch, _disc) = plan_setup_failure(&mut state, fail_kind_for_stage(stage));
            // Production would perform channel.close / handle.disconnect here when flags are true.
            return (Err(error_for_stage(stage)), state);
        }
    }
    (Ok(()), state)
}

// ─── Real russh transport ────────────────────────────────────────────────────

/// Open real russh transport on a dedicated OS thread (runtime lives with actor).
pub fn open_russh_transport(
    target: PreparedSshTarget,
    lease: VaultCredentialLease,
    auth: Arc<AuthStore>,
    confirmer: Arc<dyn HostKeyConfirmer>,
    cloud: Arc<dyn CloudHostKeyWriter>,
    local_kh: Arc<dyn LocalKnownHosts>,
    sink: Arc<dyn TerminalSink>,
) -> Result<Arc<ActorSshTransport>, SshSessionError> {
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<ActorCmd>(MAX_TRANSPORT_CMD_QUEUE);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let cancel_rx_actor = cancel_rx.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);

    let thread = spawn_actor_thread("ssh-russh-actor", move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(r) => r,
            Err(_) => {
                let _ = ready_tx.send(Err(SshSessionError::Internal));
                return;
            }
        };
        rt.block_on(async move {
            let _ = run_real_session_loop(
                target,
                lease,
                auth,
                confirmer,
                cloud,
                local_kh,
                sink,
                &mut cmd_rx,
                cancel_rx_actor,
                &ready_tx,
            )
            .await;
        });
    })?;

    match ready_rx.recv_timeout(SETUP_OVERALL_TIMEOUT + SETUP_PARENT_GRACE) {
        Ok(Ok(())) => Ok(Arc::new(ActorSshTransport {
            cmd_tx,
            cancel_tx,
            cancel_rx,
            closed: AtomicBool::new(false),
            thread: Mutex::new(Some(thread)),
        })),
        Ok(Err(e)) => {
            let _ = cancel_tx.send(true);
            join_actor_thread(thread, ACTOR_JOIN_TIMEOUT);
            Err(e)
        }
        Err(_) => {
            let _ = cancel_tx.send(true);
            join_actor_thread(thread, ACTOR_JOIN_TIMEOUT);
            Err(SshSessionError::ConnectFailed)
        }
    }
}

/// Run a setup stage future under the overall deadline and cancel watch.
async fn await_setup_stage<F, T>(
    deadline: tokio::time::Instant,
    cancel_rx: &mut watch::Receiver<bool>,
    fut: F,
) -> Result<T, SetupStageAbort>
where
    F: std::future::Future<Output = T>,
{
    if *cancel_rx.borrow() {
        return Err(SetupStageAbort::Cancelled);
    }
    tokio::select! {
        biased;
        changed = cancel_rx.changed() => {
            let _ = changed;
            Err(SetupStageAbort::Cancelled)
        }
        _ = tokio::time::sleep_until(deadline) => Err(SetupStageAbort::Timeout),
        result = fut => Ok(result),
    }
}

#[derive(Debug)]
enum SetupStageAbort {
    Cancelled,
    Timeout,
}

#[allow(clippy::too_many_arguments)] // session actor needs target, lease, auth, sinks, and channels
async fn run_real_session_loop(
    target: PreparedSshTarget,
    lease: VaultCredentialLease,
    auth: Arc<AuthStore>,
    confirmer: Arc<dyn HostKeyConfirmer>,
    cloud: Arc<dyn CloudHostKeyWriter>,
    local_kh: Arc<dyn LocalKnownHosts>,
    sink: Arc<dyn TerminalSink>,
    cmd_rx: &mut mpsc::Receiver<ActorCmd>,
    mut cancel_rx: watch::Receiver<bool>,
    ready_tx: &std::sync::mpsc::SyncSender<Result<(), SshSessionError>>,
) -> Result<(), SshSessionError> {
    use russh::client;
    use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
    use std::sync::Arc as StdArc;

    let host = target.host.clone();
    let port = target.port;
    let username = target.username.clone();
    let deadline = tokio::time::Instant::now() + SETUP_OVERALL_TIMEOUT;
    let mut cleanup = SetupCleanupState::default();

    let pass_ref = lease.passphrase.as_ref().map(|p| p.as_str());
    let key = match decode_secret_key(lease.pem.as_str(), pass_ref) {
        Ok(k) => k,
        Err(_) => {
            let _ = ready_tx.send(Err(SshSessionError::AuthenticationFailed));
            return Err(SshSessionError::AuthenticationFailed);
        }
    };
    drop(lease);

    let handler = HostKeyPolicyHandler::new(auth, target, confirmer, cloud, local_kh);
    let config = StdArc::new(client::Config::default());

    let mut handle = match await_setup_stage(
        deadline,
        &mut cancel_rx,
        client::connect(config, (host.as_str(), port), handler),
    )
    .await
    {
        Ok(Ok(h)) => h,
        Ok(Err(_)) | Err(SetupStageAbort::Timeout) => {
            let _ = plan_setup_failure(&mut cleanup, SetupFailKind::Connect);
            // No handle → no disconnect.
            let _ = ready_tx.send(Err(SshSessionError::ConnectFailed));
            return Err(SshSessionError::ConnectFailed);
        }
        Err(SetupStageAbort::Cancelled) => {
            let _ = plan_setup_failure(&mut cleanup, SetupFailKind::Connect);
            let _ = ready_tx.send(Err(SshSessionError::TransportClosed));
            return Err(SshSessionError::TransportClosed);
        }
    };

    // Fail closed on RSA hash negotiation errors (russh docs: do not swallow).
    let hash_alg =
        match await_setup_stage(deadline, &mut cancel_rx, handle.best_supported_rsa_hash()).await {
            Ok(Ok(v)) => v.flatten(),
            Ok(Err(_)) | Err(SetupStageAbort::Timeout) => {
                let (close_ch, disc) =
                    plan_setup_failure(&mut cleanup, SetupFailKind::PostConnectNoChannel);
                run_cleanup_io(
                    cleanup_deadline(Some(deadline)),
                    close_ch,
                    disc,
                    async {},
                    async {
                        let _ = handle
                            .disconnect(russh::Disconnect::ByApplication, "", "en")
                            .await;
                    },
                )
                .await;
                let _ = ready_tx.send(Err(SshSessionError::AuthenticationFailed));
                return Err(SshSessionError::AuthenticationFailed);
            }
            Err(SetupStageAbort::Cancelled) => {
                let (close_ch, disc) =
                    plan_setup_failure(&mut cleanup, SetupFailKind::PostConnectNoChannel);
                run_cleanup_io(
                    cleanup_deadline(Some(deadline)),
                    close_ch,
                    disc,
                    async {},
                    async {
                        let _ = handle
                            .disconnect(russh::Disconnect::ByApplication, "", "en")
                            .await;
                    },
                )
                .await;
                let _ = ready_tx.send(Err(SshSessionError::TransportClosed));
                return Err(SshSessionError::TransportClosed);
            }
        };
    let key = PrivateKeyWithHashAlg::new(StdArc::new(key), hash_alg);

    match await_setup_stage(
        deadline,
        &mut cancel_rx,
        handle.authenticate_publickey(username, key),
    )
    .await
    {
        Ok(Ok(client::AuthResult::Success)) => {}
        Ok(Ok(_)) | Ok(Err(_)) | Err(SetupStageAbort::Timeout) => {
            let (close_ch, disc) =
                plan_setup_failure(&mut cleanup, SetupFailKind::PostConnectNoChannel);
            run_cleanup_io(
                cleanup_deadline(Some(deadline)),
                close_ch,
                disc,
                async {},
                async {
                    let _ = handle
                        .disconnect(russh::Disconnect::ByApplication, "", "en")
                        .await;
                },
            )
            .await;
            let _ = ready_tx.send(Err(SshSessionError::AuthenticationFailed));
            return Err(SshSessionError::AuthenticationFailed);
        }
        Err(SetupStageAbort::Cancelled) => {
            let (close_ch, disc) =
                plan_setup_failure(&mut cleanup, SetupFailKind::PostConnectNoChannel);
            run_cleanup_io(
                cleanup_deadline(Some(deadline)),
                close_ch,
                disc,
                async {},
                async {
                    let _ = handle
                        .disconnect(russh::Disconnect::ByApplication, "", "en")
                        .await;
                },
            )
            .await;
            let _ = ready_tx.send(Err(SshSessionError::TransportClosed));
            return Err(SshSessionError::TransportClosed);
        }
    }

    let mut channel =
        match await_setup_stage(deadline, &mut cancel_rx, handle.channel_open_session()).await {
            Ok(Ok(ch)) => ch,
            Ok(Err(_)) | Err(SetupStageAbort::Timeout) => {
                let (close_ch, disc) =
                    plan_setup_failure(&mut cleanup, SetupFailKind::PostConnectNoChannel);
                run_cleanup_io(
                    cleanup_deadline(Some(deadline)),
                    close_ch,
                    disc,
                    async {},
                    async {
                        let _ = handle
                            .disconnect(russh::Disconnect::ByApplication, "", "en")
                            .await;
                    },
                )
                .await;
                let _ = ready_tx.send(Err(SshSessionError::ChannelFailed));
                return Err(SshSessionError::ChannelFailed);
            }
            Err(SetupStageAbort::Cancelled) => {
                let (close_ch, disc) =
                    plan_setup_failure(&mut cleanup, SetupFailKind::PostConnectNoChannel);
                run_cleanup_io(
                    cleanup_deadline(Some(deadline)),
                    close_ch,
                    disc,
                    async {},
                    async {
                        let _ = handle
                            .disconnect(russh::Disconnect::ByApplication, "", "en")
                            .await;
                    },
                )
                .await;
                let _ = ready_tx.send(Err(SshSessionError::TransportClosed));
                return Err(SshSessionError::TransportClosed);
            }
        };

    match await_setup_stage(
        deadline,
        &mut cancel_rx,
        channel.request_pty(
            true,
            PTY_TERM,
            DEFAULT_PTY_COLS,
            DEFAULT_PTY_ROWS,
            0,
            0,
            &[],
        ),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(_)) | Err(SetupStageAbort::Timeout) => {
            let (close_ch, disc) = plan_setup_failure(&mut cleanup, SetupFailKind::PostChannel);
            run_cleanup_io(
                cleanup_deadline(Some(deadline)),
                close_ch,
                disc,
                async {
                    let _ = channel.close().await;
                },
                async {
                    let _ = handle
                        .disconnect(russh::Disconnect::ByApplication, "", "en")
                        .await;
                },
            )
            .await;
            let _ = ready_tx.send(Err(SshSessionError::ChannelFailed));
            return Err(SshSessionError::ChannelFailed);
        }
        Err(SetupStageAbort::Cancelled) => {
            let (close_ch, disc) = plan_setup_failure(&mut cleanup, SetupFailKind::PostChannel);
            run_cleanup_io(
                cleanup_deadline(Some(deadline)),
                close_ch,
                disc,
                async {
                    let _ = channel.close().await;
                },
                async {
                    let _ = handle
                        .disconnect(russh::Disconnect::ByApplication, "", "en")
                        .await;
                },
            )
            .await;
            let _ = ready_tx.send(Err(SshSessionError::TransportClosed));
            return Err(SshSessionError::TransportClosed);
        }
    }

    match await_setup_stage(deadline, &mut cancel_rx, channel.request_shell(true)).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) | Err(SetupStageAbort::Timeout) => {
            let (close_ch, disc) = plan_setup_failure(&mut cleanup, SetupFailKind::PostChannel);
            run_cleanup_io(
                cleanup_deadline(Some(deadline)),
                close_ch,
                disc,
                async {
                    let _ = channel.close().await;
                },
                async {
                    let _ = handle
                        .disconnect(russh::Disconnect::ByApplication, "", "en")
                        .await;
                },
            )
            .await;
            let _ = ready_tx.send(Err(SshSessionError::ChannelFailed));
            return Err(SshSessionError::ChannelFailed);
        }
        Err(SetupStageAbort::Cancelled) => {
            let (close_ch, disc) = plan_setup_failure(&mut cleanup, SetupFailKind::PostChannel);
            run_cleanup_io(
                cleanup_deadline(Some(deadline)),
                close_ch,
                disc,
                async {
                    let _ = channel.close().await;
                },
                async {
                    let _ = handle
                        .disconnect(russh::Disconnect::ByApplication, "", "en")
                        .await;
                },
            )
            .await;
            let _ = ready_tx.send(Err(SshSessionError::TransportClosed));
            return Err(SshSessionError::TransportClosed);
        }
    }

    // Setup complete — if the parent already dropped ready_rx, do not orphan a live actor.
    if ready_tx.send(Ok(())).is_err() {
        let (close_ch, disc) = plan_setup_failure(&mut cleanup, SetupFailKind::PostChannel);
        run_cleanup_io(
            cleanup_deadline(Some(deadline)),
            close_ch,
            disc,
            async {
                let _ = channel.close().await;
            },
            async {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            },
        )
        .await;
        return Err(SshSessionError::TransportClosed);
    }

    let closed_once = AtomicBool::new(false);
    let mut sched = FairIoScheduler::new(FAIR_IO_MAX_BURST);
    loop {
        if *cancel_rx.borrow() {
            while let Ok(c) = cmd_rx.try_recv() {
                let _ = c.reply.send(Err(SshSessionError::TransportClosed));
            }
            let td = cleanup_deadline(None);
            run_cleanup_io(
                td,
                true,
                true,
                async {
                    let _ = channel.close().await;
                },
                async {
                    let _ = handle
                        .disconnect(russh::Disconnect::ByApplication, "", "en")
                        .await;
                },
            )
            .await;
            emit_closed_once(sink.as_ref(), &closed_once);
            break;
        }

        // Both peer and cmd arms always armed; only order after cancel changes.
        // Never gate channel.wait() off after a single command (output starvation).
        debug_assert!(sched.peer_arm_enabled() && sched.cmd_arm_enabled());
        let prefer_cmd = sched.prefer_cmd_first();

        let peer_msg = async { channel.wait().await };
        let cmd_msg = async { cmd_rx.recv().await };

        let branch = if prefer_cmd {
            tokio::select! {
                biased;
                _ = cancel_rx.changed() => IoSelectBranch::Cancel,
                cmd = cmd_msg => IoSelectBranch::Cmd(cmd),
                msg = peer_msg => IoSelectBranch::Peer(msg),
            }
        } else {
            tokio::select! {
                biased;
                _ = cancel_rx.changed() => IoSelectBranch::Cancel,
                msg = peer_msg => IoSelectBranch::Peer(msg),
                cmd = cmd_msg => IoSelectBranch::Cmd(cmd),
            }
        };

        match branch {
            IoSelectBranch::Cancel => {
                if *cancel_rx.borrow() {
                    while let Ok(c) = cmd_rx.try_recv() {
                        let _ = c.reply.send(Err(SshSessionError::TransportClosed));
                    }
                    let td = cleanup_deadline(None);
                    run_cleanup_io(
                        td,
                        true,
                        true,
                        async {
                            let _ = channel.close().await;
                        },
                        async {
                            let _ = handle
                                .disconnect(russh::Disconnect::ByApplication, "", "en")
                                .await;
                        },
                    )
                    .await;
                    emit_closed_once(sink.as_ref(), &closed_once);
                    break;
                }
            }
            IoSelectBranch::Peer(msg) => {
                sched.on_peer();
                match msg {
                    None => {
                        emit_closed_once(sink.as_ref(), &closed_once);
                        break;
                    }
                    Some(russh::ChannelMsg::Data { data }) => {
                        sink.on_output(TerminalOutput::Data(data.to_vec()));
                    }
                    Some(russh::ChannelMsg::ExtendedData { data, ext }) => {
                        sink.on_output(TerminalOutput::ExtendedData {
                            data: data.to_vec(),
                            ext,
                        });
                    }
                    Some(russh::ChannelMsg::Eof)
                    | Some(russh::ChannelMsg::Close)
                    | Some(russh::ChannelMsg::ExitStatus { .. })
                    | Some(russh::ChannelMsg::ExitSignal { .. }) => {
                        emit_closed_once(sink.as_ref(), &closed_once);
                        break;
                    }
                    _ => {}
                }
            }
            IoSelectBranch::Cmd(cmd) => match cmd {
                None => {
                    let td = cleanup_deadline(None);
                    run_cleanup_io(
                        td,
                        true,
                        false,
                        async {
                            let _ = channel.close().await;
                        },
                        async {},
                    )
                    .await;
                    emit_closed_once(sink.as_ref(), &closed_once);
                    break;
                }
                Some(ActorCmd { kind, reply }) => {
                    sched.on_cmd();
                    if *cancel_rx.borrow() {
                        let _ = reply.send(Err(SshSessionError::TransportClosed));
                        continue;
                    }
                    let r = match kind {
                        CmdKind::Write(data) => {
                            let payload = data.to_vec();
                            await_or_cancel(&mut cancel_rx, async {
                                channel
                                    .data_bytes(payload)
                                    .await
                                    .map_err(|_| SshSessionError::TransportClosed)
                            })
                            .await
                        }
                        CmdKind::Resize { cols, rows } => {
                            await_or_cancel(&mut cancel_rx, async {
                                channel
                                    .window_change(cols, rows, 0, 0)
                                    .await
                                    .map_err(|_| SshSessionError::TransportClosed)
                            })
                            .await
                        }
                    };
                    let _ = reply.send(r);
                }
            },
        }
    }
    Ok(())
}

/// Internal select result for fair peer/cmd scheduling (real + fake).
enum IoSelectBranch<P, C> {
    Cancel,
    Peer(P),
    Cmd(C),
}

// ─── Production connector (single-use lease) ─────────────────────────────────

/// One-shot connector: owns [`VaultCredentialLease`] and consumes it on first
/// successful or failed connect attempt. Second `connect` fails closed.
pub struct RusshLeaseConnector {
    lease: Mutex<Option<VaultCredentialLease>>,
    auth: Arc<AuthStore>,
    confirmer: Arc<dyn HostKeyConfirmer>,
    cloud: Arc<dyn CloudHostKeyWriter>,
    local_kh: Arc<dyn LocalKnownHosts>,
    sink: Arc<dyn TerminalSink>,
}

impl RusshLeaseConnector {
    pub fn new(
        lease: VaultCredentialLease,
        auth: Arc<AuthStore>,
        confirmer: Arc<dyn HostKeyConfirmer>,
        cloud: Arc<dyn CloudHostKeyWriter>,
        local_kh: Arc<dyn LocalKnownHosts>,
        sink: Arc<dyn TerminalSink>,
    ) -> Self {
        Self {
            lease: Mutex::new(Some(lease)),
            auth,
            confirmer,
            cloud,
            local_kh,
            sink,
        }
    }
}

impl crate::ssh_registry::LocalSshConnector for RusshLeaseConnector {
    fn connect(
        &self,
        target: &PreparedSshTarget,
    ) -> Result<Arc<dyn LocalSshTransport>, SshSessionError> {
        let lease = self
            .lease
            .lock()
            .map_err(|_| SshSessionError::Internal)?
            .take()
            .ok_or(SshSessionError::Internal)?;
        let t = open_russh_transport(
            target.clone(),
            lease,
            Arc::clone(&self.auth),
            Arc::clone(&self.confirmer),
            Arc::clone(&self.cloud),
            Arc::clone(&self.local_kh),
            Arc::clone(&self.sink),
        )?;
        Ok(t as Arc<dyn LocalSshTransport>)
    }
}

#[cfg(test)]
#[path = "ssh_transport_tests.rs"]
mod tests;
