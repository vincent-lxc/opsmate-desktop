//! 8B3b — native russh terminal transport actor (no Tauri IPC / React UI).
//!
//! Dedicated OS thread + current-thread Tokio runtime owns the established
//! russh handle for the full transport lifetime. After handshake: channel →
//! PTY `xterm-256color` 80×24 (`want_reply`) → shell, under the **same overall
//! setup deadline** begun at handshake. Bounded cmd queue, oneshot acks,
//! watch cancellation, fair select.
//!
//! **Non-claims:** no Tauri SSH IPC, React terminal, upload, AI.

#![cfg_attr(not(test), allow(dead_code))]

use super::connect::{HostKeyPolicyHandler, HANDSHAKE_OVERALL_TIMEOUT};
use super::prepare::LocalSshError;
use super::session::SessionCloseHandle;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use zeroize::Zeroizing;

/// Max pending write/resize commands (fail-closed when full).
pub const MAX_TRANSPORT_CMD_QUEUE: usize = 32;
/// Test-only recording sink bound.
pub const MAX_TRANSPORT_RECORD_EVENTS: usize = 64;
pub const DEFAULT_PTY_COLS: u32 = 80;
pub const DEFAULT_PTY_ROWS: u32 = 24;
/// Strict input bound (bytes per write).
pub const MAX_WRITE_BYTES: usize = 64 * 1024;
/// Strict PTY dimension bounds.
pub const MAX_PTY_COLS: u32 = 512;
pub const MAX_PTY_ROWS: u32 = 512;
const PTY_TERM: &str = "xterm-256color";
const ACTOR_JOIN_TIMEOUT: Duration = Duration::from_secs(3);
const SESSION_TEARDOWN_BUDGET: Duration = Duration::from_secs(2);
const SETUP_PARENT_GRACE: Duration = Duration::from_secs(2);
const FAIR_IO_MAX_BURST: u32 = 8;
const CMD_ACK_POLL: Duration = Duration::from_millis(25);

// ─── Output / sink ───────────────────────────────────────────────────────────

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

pub trait TerminalSink: Send + Sync {
    fn on_output(&self, chunk: TerminalOutput);
    #[allow(dead_code)] // reserved for future sink error path
    fn on_error(&self, _err: LocalSshError) {}
}

#[derive(Debug, Default, Clone, Copy)]
#[allow(dead_code)] // native null sink for production wiring without a UI sink
pub struct NullTerminalSink;

impl TerminalSink for NullTerminalSink {
    fn on_output(&self, _chunk: TerminalOutput) {}
}

// ─── LocalSshTransport trait ─────────────────────────────────────────────────

/// Native-only transport ops (no WebView surface).
pub trait LocalSshTransport: Send + Sync {
    fn write(&self, data: &[u8]) -> Result<(), LocalSshError>;
    fn resize(&self, cols: u32, rows: u32) -> Result<(), LocalSshError>;
    fn close(&self) -> Result<(), LocalSshError>;
}

// ─── Commands ────────────────────────────────────────────────────────────────

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
    reply: oneshot::Sender<Result<(), LocalSshError>>,
}

// ─── Fair I/O ────────────────────────────────────────────────────────────────

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

    pub(crate) fn peer_arm_enabled(&self) -> bool {
        true
    }

    pub(crate) fn cmd_arm_enabled(&self) -> bool {
        true
    }
}

// ─── Setup cleanup planner ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SetupFailKind {
    /// No handle yet.
    Connect,
    /// Handle exists, no channel.
    PostConnectNoChannel,
    /// Channel open.
    PostChannel,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct SetupCleanupState {
    pub channel_closes: u32,
    pub disconnects: u32,
}

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

pub(crate) async fn bounded_await<F>(deadline: tokio::time::Instant, fut: F)
where
    F: std::future::Future,
{
    let _ = tokio::time::timeout_at(deadline, fut).await;
}

pub(crate) fn cleanup_deadline(
    setup_deadline: Option<tokio::time::Instant>,
) -> tokio::time::Instant {
    let now = tokio::time::Instant::now();
    match setup_deadline {
        Some(d) if d > now => d,
        _ => now + SESSION_TEARDOWN_BUDGET,
    }
}

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

// ─── Cancel-aware await ──────────────────────────────────────────────────────

pub(crate) async fn await_or_cancel<F, T>(
    cancel_rx: &mut watch::Receiver<bool>,
    op: F,
) -> Result<T, LocalSshError>
where
    F: std::future::Future<Output = Result<T, LocalSshError>>,
{
    if *cancel_rx.borrow() {
        return Err(LocalSshError::TransportClosed);
    }
    tokio::select! {
        biased;
        changed = cancel_rx.changed() => {
            let _ = changed;
            Err(LocalSshError::TransportClosed)
        }
        result = op => result,
    }
}

// ─── Actor transport ─────────────────────────────────────────────────────────

/// Shareable transport. Actor thread + runtime live until close/drop.
pub struct ActorSshTransport {
    cmd_tx: mpsc::Sender<ActorCmd>,
    cancel_tx: watch::Sender<bool>,
    cancel_rx: watch::Receiver<bool>,
    closed: AtomicBool,
    thread: Mutex<Option<JoinHandle<()>>>,
    /// Test-only: count of commands successfully enqueued via `try_send`.
    /// Not present in non-test builds (no production layout or hot-path cost).
    #[cfg(test)]
    cmds_submitted: AtomicUsize,
}

impl std::fmt::Debug for ActorSshTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActorSshTransport")
            .field("closed", &self.closed.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

impl ActorSshTransport {
    fn is_cancelled(&self) -> bool {
        *self.cancel_rx.borrow()
    }

    fn send_cmd(&self, kind: CmdKind) -> Result<(), LocalSshError> {
        if self.is_cancelled() || self.closed.load(Ordering::SeqCst) {
            return Err(LocalSshError::TransportClosed);
        }
        let (reply_tx, mut reply_rx) = oneshot::channel();
        let cmd = ActorCmd {
            kind,
            reply: reply_tx,
        };
        match self.cmd_tx.try_send(cmd) {
            Ok(()) => {
                #[cfg(test)]
                self.cmds_submitted.fetch_add(1, Ordering::SeqCst);
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                return Err(LocalSshError::CommandQueueFull);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                return Err(LocalSshError::TransportClosed);
            }
        }
        // Poll ack; never block_on on a Tokio handle (runtime-context safe).
        let mut cancel_rx = self.cancel_rx.clone();
        loop {
            if *cancel_rx.borrow() {
                return Err(LocalSshError::TransportClosed);
            }
            match reply_rx.try_recv() {
                Ok(r) => return r,
                Err(oneshot::error::TryRecvError::Empty) => {
                    std::thread::sleep(CMD_ACK_POLL);
                    if cancel_rx.has_changed().unwrap_or(false) {
                        let _ = cancel_rx.borrow_and_update();
                    }
                    if *cancel_rx.borrow() {
                        return Err(LocalSshError::TransportClosed);
                    }
                }
                Err(oneshot::error::TryRecvError::Closed) => {
                    return Err(LocalSshError::TransportClosed);
                }
            }
        }
    }
}

impl LocalSshTransport for ActorSshTransport {
    fn write(&self, data: &[u8]) -> Result<(), LocalSshError> {
        if data.is_empty() || data.len() > MAX_WRITE_BYTES {
            return Err(LocalSshError::InvalidInput);
        }
        self.send_cmd(CmdKind::Write(Zeroizing::new(data.to_vec())))
    }

    fn resize(&self, cols: u32, rows: u32) -> Result<(), LocalSshError> {
        if cols == 0 || rows == 0 || cols > MAX_PTY_COLS || rows > MAX_PTY_ROWS {
            return Err(LocalSshError::InvalidInput);
        }
        self.send_cmd(CmdKind::Resize { cols, rows })
    }

    fn close(&self) -> Result<(), LocalSshError> {
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

impl SessionCloseHandle for ActorSshTransport {
    fn on_close(&self) {
        let _ = LocalSshTransport::close(self);
    }
}

impl Drop for ActorSshTransport {
    fn drop(&mut self) {
        let _ = LocalSshTransport::close(self);
    }
}

fn spawn_actor_thread<F>(name: &'static str, f: F) -> Result<JoinHandle<()>, LocalSshError>
where
    F: FnOnce() + Send + 'static,
{
    std::thread::Builder::new()
        .name(name.into())
        .spawn(f)
        .map_err(|_| LocalSshError::Internal)
}

fn join_actor_thread(thread: JoinHandle<()>, timeout: Duration) {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = thread.join();
        let _ = tx.send(());
    });
    // Hard bound: do not join forever if hung.
    let _ = rx.recv_timeout(timeout);
}

fn emit_closed_once(sink: &dyn TerminalSink, once: &AtomicBool) {
    if !once.swap(true, Ordering::SeqCst) {
        sink.on_output(TerminalOutput::Closed);
    }
}

// ─── Open: handshake + PTY/shell on the actor runtime (single overall deadline) ─

/// Result of transport open: secret-free authority for `complete_established` + actor.
pub struct OpenTransportResult {
    pub authority: super::prepare::LocalSshConnectAuthority,
    pub transport: Arc<ActorSshTransport>,
}

/// Open transport on a **dedicated OS thread / runtime** that owns the russh handle
/// for its entire lifetime: handshake (8B3a) → channel → PTY → shell → I/O loop,
/// under one overall setup deadline. Does not clone authority or bearer.
pub fn open_session_transport(
    authority: super::prepare::LocalSshConnectAuthority,
    lease: crate::vault::VaultCredentialLease,
    deps: super::connect::HandshakeDeps,
    sink: Arc<dyn TerminalSink>,
) -> Result<OpenTransportResult, LocalSshError> {
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<ActorCmd>(MAX_TRANSPORT_CMD_QUEUE);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let cancel_rx_actor = cancel_rx.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<
        Result<super::prepare::LocalSshConnectAuthority, LocalSshError>,
    >(1);
    let overall = if deps.overall_timeout.is_zero() {
        HANDSHAKE_OVERALL_TIMEOUT
    } else {
        deps.overall_timeout
    };

    let thread = spawn_actor_thread("opsmate-ssh-transport", move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(r) => r,
            Err(_) => {
                let _ = ready_tx.send(Err(LocalSshError::Internal));
                return;
            }
        };
        rt.block_on(async move {
            let deadline = tokio::time::Instant::now() + overall;
            match super::connect::establish_local_ssh_handshake(authority, lease, deps).await {
                Ok(hs) => {
                    if !hs.bearer_is_spent() {
                        let _ = ready_tx.send(Err(LocalSshError::Internal));
                        return;
                    }
                    let (authority, handle, _started) = match hs.into_transport_parts() {
                        Ok(p) => p,
                        Err(e) => {
                            let _ = ready_tx.send(Err(e));
                            return;
                        }
                    };
                    let _ = run_transport_loop(
                        handle,
                        sink,
                        &mut cmd_rx,
                        cancel_rx_actor,
                        &ready_tx,
                        deadline,
                        authority,
                    )
                    .await;
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        });
    })?;

    match ready_rx.recv_timeout(overall + SETUP_PARENT_GRACE) {
        Ok(Ok(authority)) => Ok(OpenTransportResult {
            authority,
            transport: Arc::new(ActorSshTransport {
                cmd_tx,
                cancel_tx,
                cancel_rx,
                closed: AtomicBool::new(false),
                thread: Mutex::new(Some(thread)),
                #[cfg(test)]
                cmds_submitted: AtomicUsize::new(0),
            }),
        }),
        Ok(Err(e)) => {
            let _ = cancel_tx.send(true);
            join_actor_thread(thread, ACTOR_JOIN_TIMEOUT);
            Err(e)
        }
        Err(_) => {
            let _ = cancel_tx.send(true);
            join_actor_thread(thread, ACTOR_JOIN_TIMEOUT);
            Err(LocalSshError::ConnectFailed)
        }
    }
}

enum SetupStageAbort {
    Cancelled,
    Timeout,
}

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

enum IoSelectBranch {
    Cancel,
    Peer(Option<russh::ChannelMsg>),
    Cmd(Option<ActorCmd>),
}

async fn run_transport_loop(
    handle: russh::client::Handle<HostKeyPolicyHandler>,
    sink: Arc<dyn TerminalSink>,
    cmd_rx: &mut mpsc::Receiver<ActorCmd>,
    mut cancel_rx: watch::Receiver<bool>,
    ready_tx: &std::sync::mpsc::SyncSender<
        Result<super::prepare::LocalSshConnectAuthority, LocalSshError>,
    >,
    deadline: tokio::time::Instant,
    authority: super::prepare::LocalSshConnectAuthority,
) -> Result<(), LocalSshError> {
    let mut cleanup = SetupCleanupState::default();

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
                let _ = ready_tx.send(Err(LocalSshError::ChannelFailed));
                return Err(LocalSshError::ChannelFailed);
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
                let _ = ready_tx.send(Err(LocalSshError::TransportClosed));
                return Err(LocalSshError::TransportClosed);
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
            let _ = ready_tx.send(Err(LocalSshError::ChannelFailed));
            return Err(LocalSshError::ChannelFailed);
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
            let _ = ready_tx.send(Err(LocalSshError::TransportClosed));
            return Err(LocalSshError::TransportClosed);
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
            let _ = ready_tx.send(Err(LocalSshError::ChannelFailed));
            return Err(LocalSshError::ChannelFailed);
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
            let _ = ready_tx.send(Err(LocalSshError::TransportClosed));
            return Err(LocalSshError::TransportClosed);
        }
    }

    // Setup complete — hand authority to parent for complete_established.
    if ready_tx.send(Ok(authority)).is_err() {
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
        return Err(LocalSshError::TransportClosed);
    }

    let closed_once = AtomicBool::new(false);
    let mut sched = FairIoScheduler::new(FAIR_IO_MAX_BURST);
    loop {
        if *cancel_rx.borrow() {
            while let Ok(c) = cmd_rx.try_recv() {
                let _ = c.reply.send(Err(LocalSshError::TransportClosed));
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
                        let _ = c.reply.send(Err(LocalSshError::TransportClosed));
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
                    None
                    | Some(russh::ChannelMsg::Eof)
                    | Some(russh::ChannelMsg::Close)
                    | Some(russh::ChannelMsg::ExitStatus { .. })
                    | Some(russh::ChannelMsg::ExitSignal { .. }) => {
                        // Peer terminal end: fail-closed queued cmds, bounded cleanup, Closed once.
                        while let Ok(c) = cmd_rx.try_recv() {
                            let _ = c.reply.send(Err(LocalSshError::TransportClosed));
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
                    Some(russh::ChannelMsg::Data { data }) => {
                        sink.on_output(TerminalOutput::Data(data.to_vec()));
                    }
                    Some(russh::ChannelMsg::ExtendedData { data, ext }) => {
                        sink.on_output(TerminalOutput::ExtendedData {
                            data: data.to_vec(),
                            ext,
                        });
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
                Some(ActorCmd { kind, reply }) => {
                    sched.on_cmd();
                    if *cancel_rx.borrow() {
                        let _ = reply.send(Err(LocalSshError::TransportClosed));
                        while let Ok(c) = cmd_rx.try_recv() {
                            let _ = c.reply.send(Err(LocalSshError::TransportClosed));
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
                    let result = match kind {
                        CmdKind::Write(data) => {
                            await_or_cancel(&mut cancel_rx, async {
                                channel
                                    .data(&data[..])
                                    .await
                                    .map_err(|_| LocalSshError::TransportClosed)
                            })
                            .await
                        }
                        CmdKind::Resize { cols, rows } => {
                            await_or_cancel(&mut cancel_rx, async {
                                channel
                                    .window_change(cols, rows, 0, 0)
                                    .await
                                    .map_err(|_| LocalSshError::TransportClosed)
                            })
                            .await
                        }
                    };
                    let failed = result.is_err();
                    let _ = reply.send(result);
                    if failed {
                        // Backend write/resize failure: channel unusable → fail-closed.
                        while let Ok(c) = cmd_rx.try_recv() {
                            let _ = c.reply.send(Err(LocalSshError::TransportClosed));
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
            },
        }
    }
    Ok(())
}

// ─── Fake backend (tests) ────────────────────────────────────────────────────

#[cfg(test)]
#[derive(Debug, Clone)]
pub enum PeerEvent {
    Data(Vec<u8>),
    ExtendedData { data: Vec<u8>, ext: u32 },
    Eof,
    Close,
    ExitStatus(u32),
}

#[cfg(test)]
pub struct FakePeerHandle {
    pub peer_tx: mpsc::Sender<PeerEvent>,
    pub completed: Arc<Mutex<Vec<String>>>,
    /// Ordered branch labels processed by the actor (`peer` / `cmd`).
    pub branch_log: Arc<Mutex<Vec<&'static str>>>,
    pub block_write: Arc<Mutex<Option<Arc<tokio::sync::Notify>>>>,
    pub release_write: Arc<Mutex<Option<Arc<tokio::sync::Notify>>>>,
    /// When true, next write backend returns fixed public TransportClosed and fail-closes.
    pub fail_write: Arc<AtomicBool>,
    /// When true, next resize backend returns fixed public TransportClosed and fail-closes.
    pub fail_resize: Arc<AtomicBool>,
    /// Counts of peer-EOF-path drain replies (TransportClosed).
    pub drained_cmd_replies: Arc<AtomicUsize>,
    /// Releases a held fake actor into its select loop (see `open_fake_transport_held`).
    pub start_gate: Arc<tokio::sync::Notify>,
}

#[cfg(test)]
#[derive(Default)]
pub struct RecordingSink {
    pub events: Mutex<Vec<TerminalOutput>>,
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
}

/// Open fake-backed transport on a dedicated actor thread/runtime.
#[cfg(test)]
pub fn open_fake_transport(
    sink: Arc<dyn TerminalSink>,
) -> (Arc<ActorSshTransport>, FakePeerHandle) {
    open_fake_transport_inner(sink, false)
}

/// Like [`open_fake_transport`], but the actor waits on `start_gate` before the
/// first select iteration so tests can enqueue peer + cmd under contention
/// before fairness is observed (deterministic, no sleep races).
#[cfg(test)]
pub fn open_fake_transport_held(
    sink: Arc<dyn TerminalSink>,
) -> (Arc<ActorSshTransport>, FakePeerHandle) {
    open_fake_transport_inner(sink, true)
}

#[cfg(test)]
fn open_fake_transport_inner(
    sink: Arc<dyn TerminalSink>,
    hold_start: bool,
) -> (Arc<ActorSshTransport>, FakePeerHandle) {
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<ActorCmd>(MAX_TRANSPORT_CMD_QUEUE);
    // Peer capacity large enough for fairness flood tests without blocking the feeder.
    let (peer_tx, mut peer_rx) = mpsc::channel::<PeerEvent>(256);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let completed = Arc::new(Mutex::new(Vec::new()));
    let branch_log = Arc::new(Mutex::new(Vec::new()));
    let block_write: Arc<Mutex<Option<Arc<tokio::sync::Notify>>>> = Arc::new(Mutex::new(None));
    let release_write: Arc<Mutex<Option<Arc<tokio::sync::Notify>>>> = Arc::new(Mutex::new(None));
    let fail_write = Arc::new(AtomicBool::new(false));
    let fail_resize = Arc::new(AtomicBool::new(false));
    let drained_cmd_replies = Arc::new(AtomicUsize::new(0));
    let start_gate = Arc::new(tokio::sync::Notify::new());

    let completed_t = Arc::clone(&completed);
    let branch_t = Arc::clone(&branch_log);
    let block_t = Arc::clone(&block_write);
    let release_t = Arc::clone(&release_write);
    let fail_w = Arc::clone(&fail_write);
    let fail_r = Arc::clone(&fail_resize);
    let drained_t = Arc::clone(&drained_cmd_replies);
    let start_gate_t = Arc::clone(&start_gate);
    let mut cancel_rx_t = cancel_rx.clone();
    let sink_t = Arc::clone(&sink);

    let thread = spawn_actor_thread("opsmate-ssh-fake", move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("fake actor runtime");
        rt.block_on(async move {
            if hold_start {
                start_gate_t.notified().await;
            }
            let closed_once = AtomicBool::new(false);
            let mut sched = FairIoScheduler::new(FAIR_IO_MAX_BURST);
            enum Br {
                Cancel,
                Peer(Option<PeerEvent>),
                Cmd(Option<ActorCmd>),
            }
            let drain_cmds = |cmd_rx: &mut mpsc::Receiver<ActorCmd>, drained: &AtomicUsize| {
                while let Ok(c) = cmd_rx.try_recv() {
                    let _ = c.reply.send(Err(LocalSshError::TransportClosed));
                    drained.fetch_add(1, Ordering::SeqCst);
                }
            };
            loop {
                if *cancel_rx_t.borrow() {
                    drain_cmds(&mut cmd_rx, drained_t.as_ref());
                    emit_closed_once(sink_t.as_ref(), &closed_once);
                    break;
                }
                debug_assert!(sched.peer_arm_enabled() && sched.cmd_arm_enabled());
                let prefer_cmd = sched.prefer_cmd_first();
                let br = if prefer_cmd {
                    tokio::select! {
                        biased;
                        _ = cancel_rx_t.changed() => Br::Cancel,
                        cmd = cmd_rx.recv() => Br::Cmd(cmd),
                        peer = peer_rx.recv() => Br::Peer(peer),
                    }
                } else {
                    tokio::select! {
                        biased;
                        _ = cancel_rx_t.changed() => Br::Cancel,
                        peer = peer_rx.recv() => Br::Peer(peer),
                        cmd = cmd_rx.recv() => Br::Cmd(cmd),
                    }
                };
                match br {
                    Br::Cancel => {
                        if *cancel_rx_t.borrow() {
                            drain_cmds(&mut cmd_rx, drained_t.as_ref());
                            emit_closed_once(sink_t.as_ref(), &closed_once);
                            break;
                        }
                    }
                    Br::Peer(peer) => {
                        sched.on_peer();
                        branch_t.lock().unwrap().push("peer");
                        match peer {
                            None | Some(PeerEvent::Eof) | Some(PeerEvent::Close) => {
                                drain_cmds(&mut cmd_rx, drained_t.as_ref());
                                emit_closed_once(sink_t.as_ref(), &closed_once);
                                break;
                            }
                            Some(PeerEvent::ExitStatus(code)) => {
                                completed_t.lock().unwrap().push(format!("exit:{code}"));
                                drain_cmds(&mut cmd_rx, drained_t.as_ref());
                                emit_closed_once(sink_t.as_ref(), &closed_once);
                                break;
                            }
                            Some(PeerEvent::Data(d)) => {
                                sink_t.on_output(TerminalOutput::Data(d));
                            }
                            Some(PeerEvent::ExtendedData { data, ext }) => {
                                sink_t.on_output(TerminalOutput::ExtendedData { data, ext });
                            }
                        }
                    }
                    Br::Cmd(cmd) => match cmd {
                        None => {
                            emit_closed_once(sink_t.as_ref(), &closed_once);
                            break;
                        }
                        Some(ActorCmd { kind, reply }) => {
                            sched.on_cmd();
                            branch_t.lock().unwrap().push("cmd");
                            if *cancel_rx_t.borrow() {
                                let _ = reply.send(Err(LocalSshError::TransportClosed));
                                drain_cmds(&mut cmd_rx, drained_t.as_ref());
                                emit_closed_once(sink_t.as_ref(), &closed_once);
                                break;
                            }
                            let result = match kind {
                                CmdKind::Write(data) => {
                                    if fail_w.swap(false, Ordering::SeqCst) {
                                        Err(LocalSshError::TransportClosed)
                                    } else {
                                        let blocker =
                                            block_t.lock().ok().and_then(|mut g| g.take());
                                        if let Some(b) = blocker {
                                            let release = release_t
                                                .lock()
                                                .ok()
                                                .and_then(|mut g| g.take())
                                                .unwrap_or_else(|| {
                                                    Arc::new(tokio::sync::Notify::new())
                                                });
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
                                }
                                CmdKind::Resize { cols, rows } => {
                                    if fail_r.swap(false, Ordering::SeqCst) {
                                        Err(LocalSshError::TransportClosed)
                                    } else {
                                        completed_t
                                            .lock()
                                            .unwrap()
                                            .push(format!("resize:{cols}x{rows}"));
                                        Ok(())
                                    }
                                }
                            };
                            let failed = result.is_err();
                            let _ = reply.send(result);
                            if failed {
                                drain_cmds(&mut cmd_rx, drained_t.as_ref());
                                emit_closed_once(sink_t.as_ref(), &closed_once);
                                break;
                            }
                        }
                    },
                }
            }
        });
    })
    .expect("spawn fake");

    let transport = Arc::new(ActorSshTransport {
        cmd_tx,
        cancel_tx,
        cancel_rx,
        closed: AtomicBool::new(false),
        thread: Mutex::new(Some(thread)),
        #[cfg(test)]
        cmds_submitted: AtomicUsize::new(0),
    });
    (
        transport,
        FakePeerHandle {
            peer_tx,
            completed,
            branch_log,
            block_write,
            release_write,
            fail_write,
            fail_resize,
            drained_cmd_replies,
            start_gate,
        },
    )
}

// ─── Faithful setup I/O (tests) ──────────────────────────────────────────────

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStage {
    Connect,
    Auth,
    Channel,
    Pty,
    Shell,
}

/// Counters for real async cleanup ops executed by the faithful setup runner.
#[cfg(test)]
#[derive(Default)]
pub struct FaithfulSetupCounters {
    pub channel_closes: AtomicUsize,
    pub disconnects: AtomicUsize,
}

/// Result of a faithful setup attempt (error + exact cleanup counts + elapsed).
#[cfg(test)]
pub struct FaithfulSetupOutcome {
    pub result: Result<(), LocalSshError>,
    pub channel_closes: usize,
    pub disconnects: usize,
    pub elapsed: Duration,
}

/// Run setup stages with real async cancel/timeout + counted cleanup I/O.
/// Mirrors production `run_transport_loop` stage order and cleanup planner usage.
#[cfg(test)]
async fn faithful_setup_actor(
    fail_at: Option<SetupStage>,
    hang_at: Option<SetupStage>,
    overall: Duration,
    counters: Arc<FaithfulSetupCounters>,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<(), LocalSshError> {
    let deadline = tokio::time::Instant::now() + overall;
    let mut cleanup = SetupCleanupState::default();

    // Connect stage (handle acquisition). No channel yet.
    if hang_at == Some(SetupStage::Connect) {
        match await_setup_stage(deadline, &mut cancel_rx, std::future::pending::<()>()).await {
            Ok(()) => {}
            Err(SetupStageAbort::Timeout) | Err(SetupStageAbort::Cancelled) => {
                let (close_ch, disc) = plan_setup_failure(&mut cleanup, SetupFailKind::Connect);
                run_counted_cleanup(&counters, cleanup_deadline(Some(deadline)), close_ch, disc)
                    .await;
                return Err(LocalSshError::ConnectFailed);
            }
        }
    }
    if fail_at == Some(SetupStage::Connect) {
        let (close_ch, disc) = plan_setup_failure(&mut cleanup, SetupFailKind::Connect);
        run_counted_cleanup(&counters, cleanup_deadline(Some(deadline)), close_ch, disc).await;
        return Err(LocalSshError::ConnectFailed);
    }

    // Auth — handle exists, no channel.
    if hang_at == Some(SetupStage::Auth) {
        match await_setup_stage(deadline, &mut cancel_rx, std::future::pending::<()>()).await {
            Ok(()) => {}
            Err(_) => {
                let (close_ch, disc) =
                    plan_setup_failure(&mut cleanup, SetupFailKind::PostConnectNoChannel);
                run_counted_cleanup(&counters, cleanup_deadline(Some(deadline)), close_ch, disc)
                    .await;
                return Err(LocalSshError::AuthenticationFailed);
            }
        }
    }
    if fail_at == Some(SetupStage::Auth) {
        let (close_ch, disc) =
            plan_setup_failure(&mut cleanup, SetupFailKind::PostConnectNoChannel);
        run_counted_cleanup(&counters, cleanup_deadline(Some(deadline)), close_ch, disc).await;
        return Err(LocalSshError::AuthenticationFailed);
    }

    // Channel open.
    if hang_at == Some(SetupStage::Channel) {
        match await_setup_stage(deadline, &mut cancel_rx, std::future::pending::<()>()).await {
            Ok(()) => {}
            Err(_) => {
                let (close_ch, disc) =
                    plan_setup_failure(&mut cleanup, SetupFailKind::PostConnectNoChannel);
                run_counted_cleanup(&counters, cleanup_deadline(Some(deadline)), close_ch, disc)
                    .await;
                return Err(LocalSshError::ChannelFailed);
            }
        }
    }
    if fail_at == Some(SetupStage::Channel) {
        let (close_ch, disc) =
            plan_setup_failure(&mut cleanup, SetupFailKind::PostConnectNoChannel);
        run_counted_cleanup(&counters, cleanup_deadline(Some(deadline)), close_ch, disc).await;
        return Err(LocalSshError::ChannelFailed);
    }

    // PTY (channel open).
    if hang_at == Some(SetupStage::Pty) {
        match await_setup_stage(deadline, &mut cancel_rx, std::future::pending::<()>()).await {
            Ok(()) => {}
            Err(_) => {
                let (close_ch, disc) = plan_setup_failure(&mut cleanup, SetupFailKind::PostChannel);
                run_counted_cleanup(&counters, cleanup_deadline(Some(deadline)), close_ch, disc)
                    .await;
                return Err(LocalSshError::ChannelFailed);
            }
        }
    }
    if fail_at == Some(SetupStage::Pty) {
        let (close_ch, disc) = plan_setup_failure(&mut cleanup, SetupFailKind::PostChannel);
        run_counted_cleanup(&counters, cleanup_deadline(Some(deadline)), close_ch, disc).await;
        return Err(LocalSshError::ChannelFailed);
    }

    // Shell.
    if hang_at == Some(SetupStage::Shell) {
        match await_setup_stage(deadline, &mut cancel_rx, std::future::pending::<()>()).await {
            Ok(()) => {}
            Err(_) => {
                let (close_ch, disc) = plan_setup_failure(&mut cleanup, SetupFailKind::PostChannel);
                run_counted_cleanup(&counters, cleanup_deadline(Some(deadline)), close_ch, disc)
                    .await;
                return Err(LocalSshError::ChannelFailed);
            }
        }
    }
    if fail_at == Some(SetupStage::Shell) {
        let (close_ch, disc) = plan_setup_failure(&mut cleanup, SetupFailKind::PostChannel);
        run_counted_cleanup(&counters, cleanup_deadline(Some(deadline)), close_ch, disc).await;
        return Err(LocalSshError::ChannelFailed);
    }

    Ok(())
}

#[cfg(test)]
async fn run_counted_cleanup(
    counters: &FaithfulSetupCounters,
    deadline: tokio::time::Instant,
    close_channel: bool,
    disconnect: bool,
) {
    run_cleanup_io(
        deadline,
        close_channel,
        disconnect,
        async {
            // Simulated bounded channel close I/O.
            tokio::task::yield_now().await;
            counters.channel_closes.fetch_add(1, Ordering::SeqCst);
        },
        async {
            tokio::task::yield_now().await;
            counters.disconnects.fetch_add(1, Ordering::SeqCst);
        },
    )
    .await;
}

/// Sync wrapper that returns the actual error from the setup actor via oneshot.
#[cfg(test)]
pub fn run_faithful_setup_checked(
    fail_at: Option<SetupStage>,
    hang_at: Option<SetupStage>,
    overall: Duration,
) -> FaithfulSetupOutcome {
    let counters = Arc::new(FaithfulSetupCounters::default());
    let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
    let start = std::time::Instant::now();
    let counters_t = Arc::clone(&counters);
    let thread = spawn_actor_thread("opsmate-ssh-setup-faithful", move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("setup runtime");
        let r = rt.block_on(async move {
            let (_cancel_tx, cancel_rx) = watch::channel(false);
            faithful_setup_actor(fail_at, hang_at, overall, counters_t, cancel_rx).await
        });
        let _ = result_tx.send(r);
    })
    .expect("spawn setup");
    join_actor_thread(thread, overall + Duration::from_secs(2));
    let result = result_rx
        .recv_timeout(Duration::from_millis(50))
        .unwrap_or(Err(LocalSshError::ConnectFailed));
    FaithfulSetupOutcome {
        result,
        channel_closes: counters.channel_closes.load(Ordering::SeqCst),
        disconnects: counters.disconnects.load(Ordering::SeqCst),
        elapsed: start.elapsed(),
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::super::connect::{
        CloudHostKeyWriter, HandshakeDeps, HostKeyConfirmer, LocalKnownHosts, PresentedHostKey,
        HANDSHAKE_OVERALL_TIMEOUT,
    };
    use super::super::prepare::{
        split_prepared_for_connect, LocalSshError, PreparedHostKey, PreparedLocalSshOpen,
    };
    use super::super::session::{LocalSshSessionManager, SessionCloseHandle};
    use super::*;
    use crate::auth::{AuthStore, RandomSource};
    use crate::security_cutoff::SecurityCutoff;
    use crate::vault::{VaultCredentialLease, VaultService};
    use russh::keys::decode_secret_key;
    use russh::server::{self, Auth, Server as _};
    use std::sync::atomic::{AtomicBool, Ordering as AO};
    use std::time::{Duration, Instant};
    use tauri_plugin_stronghold::stronghold::Stronghold;
    use tokio::net::TcpListener;
    use zeroize::Zeroizing;

    const HOST_PEM: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACD7ILTBkhQlxDnJStJbkhOXZhEo50wss6zr9l7tpwh4hwAAAJDrcBne63AZ
3gAAAAtzc2gtZWQyNTUxOQAAACD7ILTBkhQlxDnJStJbkhOXZhEo50wss6zr9l7tpwh4hw
AAAEBVhy4wSHnusdx9AcXErG/fW5RhUzOysy49pDb/VDdSqfsgtMGSFCXEOclK0luSE5dm
ESjnTCyzrOv2Xu2nCHiHAAAACXRlc3QtaG9zdAECAwQ=
-----END OPENSSH PRIVATE KEY-----
";
    const USER_PEM: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBfrXIKUaxZCh7B98eYI49ojzTsOPMF/27ica6zyTLBdAAAAJB2Ct+Vdgrf
lQAAAAtzc2gtZWQyNTUxOQAAACBfrXIKUaxZCh7B98eYI49ojzTsOPMF/27ica6zyTLBdA
AAAEA8su0SL298mxNfYFtbtZ+bBEGelnTnHGMBrUydKpBR41+tcgpRrFkKHsH3x5gjj2iP
NOw48wX/buJxrrPJMsF0AAAACXRlc3QtdXNlcgECAwQ=
-----END OPENSSH PRIVATE KEY-----
";

    fn sleep_ms(ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    fn authed() -> Arc<AuthStore> {
        let a = Arc::new(AuthStore::new());
        a.install_session_for_tests("ten-a", "alice", "admin", "sub-a");
        a
    }

    #[derive(Default)]
    struct MockConfirm {
        allow: AtomicBool,
    }
    impl HostKeyConfirmer for MockConfirm {
        fn confirm_tofu(
            &self,
            _: &super::super::connect::TofuPrompt,
        ) -> Result<bool, LocalSshError> {
            Ok(self.allow.load(AO::SeqCst))
        }
    }

    #[derive(Default)]
    struct MockCloud;
    impl CloudHostKeyWriter for MockCloud {
        fn write_host_key<'a>(
            &'a self,
            _: &'a super::super::connect::CloudHostKeyParams,
            _: &'a str,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), LocalSshError>> + Send + 'a>,
        > {
            Box::pin(async { Ok(()) })
        }
    }

    #[derive(Default)]
    struct MockLocal;
    impl LocalKnownHosts for MockLocal {
        fn record_host_key(&self, _: &str, _: &str, _: &str) -> Result<(), LocalSshError> {
            Ok(())
        }
    }

    fn old_buggy_peer_arm_enabled(cmd_burst: u32) -> bool {
        let prefer_wait = cmd_burst >= 8;
        prefer_wait || cmd_burst == 0
    }

    #[test]
    fn fair_io_scheduler_peer_armed_after_single_cmd() {
        assert!(!old_buggy_peer_arm_enabled(1));
        let mut sched = FairIoScheduler::new(FAIR_IO_MAX_BURST);
        sched.on_cmd();
        assert!(sched.peer_arm_enabled());
        assert!(sched.cmd_arm_enabled());
        assert!(!sched.prefer_cmd_first());
    }

    #[test]
    fn fair_io_scheduler_prefers_cmd_after_peer_burst() {
        let mut sched = FairIoScheduler::new(FAIR_IO_MAX_BURST);
        for _ in 0..FAIR_IO_MAX_BURST {
            sched.on_peer();
        }
        assert!(sched.prefer_cmd_first());
        assert!(sched.peer_arm_enabled());
        sched.on_cmd();
        assert!(!sched.prefer_cmd_first());
    }

    #[test]
    fn terminal_output_debug_length_only() {
        let d = TerminalOutput::Data(b"SECRET-payload".to_vec());
        let s = format!("{d:?}");
        assert!(!s.contains("SECRET"));
        assert!(s.contains("len"));
    }

    #[test]
    fn write_resize_bounds_reject() {
        let sink = Arc::new(RecordingSink::default());
        let (t, _) = open_fake_transport(sink);
        assert_eq!(t.write(&[]), Err(LocalSshError::InvalidInput));
        assert_eq!(
            t.write(&vec![0u8; MAX_WRITE_BYTES + 1]),
            Err(LocalSshError::InvalidInput)
        );
        assert_eq!(t.resize(0, 24), Err(LocalSshError::InvalidInput));
        assert_eq!(t.resize(80, 0), Err(LocalSshError::InvalidInput));
        assert_eq!(
            t.resize(MAX_PTY_COLS + 1, 24),
            Err(LocalSshError::InvalidInput)
        );
        t.close().unwrap();
    }

    #[test]
    fn peer_data_eof_after_single_write() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
        t.write(b"x").expect("write");
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
        assert!(saw_data && saw_closed);
        assert_eq!(t.write(b"after"), Err(LocalSshError::TransportClosed));
    }

    #[test]
    fn write_and_resize_ack() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport(sink);
        t.write(b"hello").unwrap();
        t.resize(120, 40).unwrap();
        sleep_ms(50);
        let done = peer.completed.lock().unwrap().clone();
        assert!(done.iter().any(|s| s == "write:5"));
        assert!(done.iter().any(|s| s == "resize:120x40"));
        t.close().unwrap();
    }

    #[test]
    fn queue_saturation_fail_closed() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport(sink);
        // Block first write so the actor stalls and the cmd queue can fill.
        let block = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        *peer.block_write.lock().unwrap() = Some(Arc::clone(&block));
        *peer.release_write.lock().unwrap() = Some(Arc::clone(&release));
        let t2 = Arc::clone(&t);
        let jh = std::thread::spawn(move || t2.write(b"blocked"));
        for _ in 0..50 {
            if peer.block_write.lock().unwrap().is_none() {
                break;
            }
            sleep_ms(5);
        }
        // Spawn concurrent resizes (each waits for ack) so try_send fills the queue.
        let mut fillers = Vec::new();
        let saw_full = Arc::new(AtomicBool::new(false));
        for i in 0..(MAX_TRANSPORT_CMD_QUEUE + 8) {
            let t_c = Arc::clone(&t);
            let full = Arc::clone(&saw_full);
            fillers.push(std::thread::spawn(move || {
                if let Err(LocalSshError::CommandQueueFull) = t_c.resize(80 + i as u32, 24) {
                    full.store(true, AO::SeqCst);
                }
            }));
        }
        for _ in 0..100 {
            if saw_full.load(AO::SeqCst) {
                break;
            }
            sleep_ms(10);
        }
        assert!(saw_full.load(AO::SeqCst), "queue must saturate");
        release.notify_waiters();
        let _ = jh.join();
        for f in fillers {
            let _ = f.join();
        }
        t.close().unwrap();
    }

    #[test]
    fn cancel_preempts_blocked_write() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport(sink);
        let block = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        *peer.block_write.lock().unwrap() = Some(Arc::clone(&block));
        *peer.release_write.lock().unwrap() = Some(Arc::clone(&release));
        let t_w = Arc::clone(&t);
        let jh = std::thread::spawn(move || t_w.write(b"hold"));
        for _ in 0..50 {
            if peer.block_write.lock().unwrap().is_none() {
                break;
            }
            sleep_ms(5);
        }
        t.close().unwrap();
        let r = jh.join().unwrap();
        assert_eq!(r, Err(LocalSshError::TransportClosed));
    }

    #[test]
    fn close_emits_closed_exactly_once() {
        let sink = Arc::new(RecordingSink::default());
        let (t, _) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
        t.close().unwrap();
        t.close().unwrap();
        sleep_ms(50);
        let n = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count();
        assert_eq!(n, 1);
    }

    #[test]
    fn faithful_setup_connect_fail_no_cleanup_io() {
        let out =
            run_faithful_setup_checked(Some(SetupStage::Connect), None, Duration::from_millis(500));
        assert_eq!(out.result, Err(LocalSshError::ConnectFailed));
        assert_eq!(out.channel_closes, 0);
        assert_eq!(out.disconnects, 0);
        assert!(out.elapsed < Duration::from_secs(2));
    }

    #[test]
    fn faithful_setup_channel_fail_disconnect_once_no_channel_close() {
        let out =
            run_faithful_setup_checked(Some(SetupStage::Channel), None, Duration::from_millis(500));
        assert_eq!(out.result, Err(LocalSshError::ChannelFailed));
        assert_eq!(out.channel_closes, 0);
        assert_eq!(out.disconnects, 1);
        assert!(out.elapsed < Duration::from_secs(2));
    }

    #[test]
    fn faithful_setup_pty_fail_closes_channel_and_disconnects_once() {
        let out =
            run_faithful_setup_checked(Some(SetupStage::Pty), None, Duration::from_millis(500));
        assert_eq!(out.result, Err(LocalSshError::ChannelFailed));
        assert_eq!(out.channel_closes, 1);
        assert_eq!(out.disconnects, 1);
        assert!(out.elapsed < Duration::from_secs(2));
    }

    #[test]
    fn faithful_setup_shell_fail_closes_channel_and_disconnects_once() {
        let out =
            run_faithful_setup_checked(Some(SetupStage::Shell), None, Duration::from_millis(500));
        assert_eq!(out.result, Err(LocalSshError::ChannelFailed));
        assert_eq!(out.channel_closes, 1);
        assert_eq!(out.disconnects, 1);
        assert!(out.elapsed < Duration::from_secs(2));
    }

    #[test]
    fn faithful_setup_pty_timeout_bounded_cleanup() {
        let out =
            run_faithful_setup_checked(None, Some(SetupStage::Pty), Duration::from_millis(80));
        assert_eq!(out.result, Err(LocalSshError::ChannelFailed));
        assert_eq!(out.channel_closes, 1);
        assert_eq!(out.disconnects, 1);
        assert!(out.elapsed < Duration::from_millis(1500));
        assert!(out.elapsed >= Duration::from_millis(50));
    }

    #[test]
    fn bounded_await_times_out() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(40);
            let start = Instant::now();
            bounded_await(deadline, std::future::pending::<()>()).await;
            assert!(start.elapsed() < Duration::from_millis(250));
        });
    }

    // ─── Review-fix: ExtendedData / Close / ExitStatus ──────────────────────

    #[test]
    fn peer_extended_data_emitted() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
        peer.peer_tx
            .try_send(PeerEvent::ExtendedData {
                data: b"stderr-chunk".to_vec(),
                ext: 1,
            })
            .unwrap();
        let mut saw = false;
        for _ in 0..100 {
            let ev = sink.events.lock().unwrap().clone();
            saw = ev.iter().any(|e| {
                matches!(
                    e,
                    TerminalOutput::ExtendedData { data, ext }
                        if data.as_slice() == b"stderr-chunk" && *ext == 1
                )
            });
            if saw {
                break;
            }
            sleep_ms(10);
        }
        assert!(saw, "ExtendedData must reach TerminalSink");
        let dbg = format!(
            "{:?}",
            TerminalOutput::ExtendedData {
                data: b"SECRET".to_vec(),
                ext: 1
            }
        );
        assert!(!dbg.contains("SECRET"));
        assert!(dbg.contains("len"));
        t.close().unwrap();
    }

    #[test]
    fn peer_close_emits_closed_once() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
        peer.peer_tx.try_send(PeerEvent::Close).unwrap();
        peer.peer_tx.try_send(PeerEvent::Eof).unwrap(); // extra should not double-close
        for _ in 0..100 {
            if sink
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, TerminalOutput::Closed))
            {
                break;
            }
            sleep_ms(10);
        }
        let n = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count();
        assert_eq!(n, 1);
        assert_eq!(t.write(b"x"), Err(LocalSshError::TransportClosed));
    }

    #[test]
    fn peer_exit_status_emits_closed_once() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
        peer.peer_tx.try_send(PeerEvent::ExitStatus(42)).unwrap();
        for _ in 0..100 {
            if sink
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, TerminalOutput::Closed))
            {
                break;
            }
            sleep_ms(10);
        }
        let n = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count();
        assert_eq!(n, 1);
        let done = peer.completed.lock().unwrap().clone();
        assert!(
            done.iter().any(|s| s == "exit:42"),
            "ExitStatus code must be observed by actor: {done:?}"
        );
        assert_eq!(t.resize(80, 24), Err(LocalSshError::TransportClosed));
    }

    // ─── Review-fix: actor fairness under continuous load ───────────────────

    /// Deterministic fairness harness: hold actor, enqueue 64 peers + 1 write,
    /// then release so both arms are ready under `FairIoScheduler` selection.
    ///
    /// Live CI (run 31005287693 / job 92303595760) failed the prior racy setup
    /// with `peers_before=64` (all peers drained before write was enqueued).
    /// Fairness only reorders when **both** arms are ready; this harness makes
    /// that precondition true without sleeps.
    fn run_actor_fairness_cmd_not_starved_once() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport_held(Arc::clone(&sink) as Arc<dyn TerminalSink>);
        for i in 0..64u8 {
            peer.peer_tx
                .try_send(PeerEvent::Data(vec![i]))
                .expect("peer capacity");
        }
        let t_w = Arc::clone(&t);
        let jh = std::thread::spawn(move || t_w.write(b"fair-cmd"));
        // Spin until write's try_send completed (no timed sleep).
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while t.cmds_submitted.load(AO::SeqCst) == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "write did not enqueue within deadline"
            );
            std::thread::yield_now();
        }
        peer.start_gate.notify_one();
        let r = jh.join().expect("join");
        assert_eq!(r, Ok(()), "write must not be starved by peer flood");
        let done = peer.completed.lock().unwrap().clone();
        assert!(done.iter().any(|s| s == "write:8"));
        let log = peer.branch_log.lock().unwrap().clone();
        assert!(log.contains(&"cmd"));
        assert!(log.contains(&"peer"));
        let first_cmd = log.iter().position(|b| *b == "cmd").expect("cmd branch");
        let peers_before = log[..first_cmd].iter().filter(|b| **b == "peer").count();
        assert!(
            peers_before <= FAIR_IO_MAX_BURST as usize + 2,
            "cmd must win after peer burst, peers_before={peers_before} log={log:?}"
        );
        t.close().unwrap();
    }

    #[test]
    fn actor_fairness_cmd_not_starved_by_continuous_peer() {
        run_actor_fairness_cmd_not_starved_once();
    }

    #[test]
    fn actor_fairness_cmd_not_starved_stress_repeat() {
        for _ in 0..64 {
            run_actor_fairness_cmd_not_starved_once();
        }
    }

    /// Documents the live CI failure mode: when the write is enqueued only after
    /// the peer flood is fully drained, `peers_before` is 64. Fairness does not
    /// invent a cmd that was never ready; the regression above holds the actor
    /// until both arms are ready.
    #[test]
    fn actor_fairness_peers_before_is_64_if_cmd_arrives_after_peer_drain() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport_held(Arc::clone(&sink) as Arc<dyn TerminalSink>);
        for i in 0..64u8 {
            peer.peer_tx
                .try_send(PeerEvent::Data(vec![i]))
                .expect("peer capacity");
        }
        // Release with peers only — no cmd yet.
        peer.start_gate.notify_one();
        // Wait until all peer events have been processed.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let n = peer.branch_log.lock().unwrap().len();
            if n >= 64 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "peers not drained, log_len={n}"
            );
            std::thread::yield_now();
        }
        let t_w = Arc::clone(&t);
        let jh = std::thread::spawn(move || t_w.write(b"late-cmd"));
        let r = jh.join().expect("join");
        assert_eq!(r, Ok(()));
        let log = peer.branch_log.lock().unwrap().clone();
        let first_cmd = log.iter().position(|b| *b == "cmd").expect("cmd branch");
        let peers_before = log[..first_cmd].iter().filter(|b| **b == "peer").count();
        assert_eq!(
            peers_before, 64,
            "documents CI failure mode when cmd is not ready during peer flood; log={log:?}"
        );
        t.close().unwrap();
    }

    #[test]
    fn actor_fairness_peer_eof_not_starved_by_continuous_cmds() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
        // Block first write so we can queue many cmds, then inject EOF while cmds pending.
        let block = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        *peer.block_write.lock().unwrap() = Some(Arc::clone(&block));
        *peer.release_write.lock().unwrap() = Some(Arc::clone(&release));
        let t_w = Arc::clone(&t);
        let jh = std::thread::spawn(move || t_w.write(b"hold"));
        for _ in 0..50 {
            if peer.block_write.lock().unwrap().is_none() {
                break;
            }
            sleep_ms(5);
        }
        // Queue several resizes while write is in-flight.
        let mut resizers = Vec::new();
        for i in 0..8 {
            let t_c = Arc::clone(&t);
            resizers.push(std::thread::spawn(move || t_c.resize(80 + i, 24)));
        }
        sleep_ms(30);
        peer.peer_tx.try_send(PeerEvent::Eof).unwrap();
        release.notify_waiters();
        let _ = jh.join();
        let mut any_closed_err = false;
        for j in resizers {
            match j.join().unwrap() {
                Err(LocalSshError::TransportClosed) => any_closed_err = true,
                Ok(()) => {}
                Err(e) => panic!("unexpected resize err {e:?}"),
            }
        }
        for _ in 0..100 {
            if sink
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, TerminalOutput::Closed))
            {
                break;
            }
            sleep_ms(10);
        }
        let closed = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count();
        assert_eq!(closed, 1, "peer EOF must emit Closed once despite cmd load");
        assert!(
            any_closed_err || peer.drained_cmd_replies.load(AO::SeqCst) > 0,
            "queued cmds after EOF must fail-closed"
        );
        let _ = t.close();
    }

    // ─── Review-fix: EOF/close + in-flight drain ────────────────────────────

    #[test]
    fn peer_eof_drains_queued_cmds_and_closed_once() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
        let block = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        *peer.block_write.lock().unwrap() = Some(Arc::clone(&block));
        *peer.release_write.lock().unwrap() = Some(Arc::clone(&release));
        let t_w = Arc::clone(&t);
        let jh = std::thread::spawn(move || t_w.write(b"inflight"));
        for _ in 0..50 {
            if peer.block_write.lock().unwrap().is_none() {
                break;
            }
            sleep_ms(5);
        }
        let mut queued = Vec::new();
        for i in 0..4 {
            let t_c = Arc::clone(&t);
            queued.push(std::thread::spawn(move || t_c.resize(100 + i, 30)));
        }
        sleep_ms(40);
        peer.peer_tx.try_send(PeerEvent::Eof).unwrap();
        release.notify_waiters();
        let write_r = jh.join().unwrap();
        // Write may Ok (completed before EOF processed) or TransportClosed (cancel path).
        assert!(
            write_r == Ok(()) || write_r == Err(LocalSshError::TransportClosed),
            "write_r={write_r:?}"
        );
        let mut drain_hits = 0usize;
        for j in queued {
            if j.join().unwrap() == Err(LocalSshError::TransportClosed) {
                drain_hits += 1;
            }
        }
        for _ in 0..100 {
            if sink
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, TerminalOutput::Closed))
            {
                break;
            }
            sleep_ms(10);
        }
        let closed = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count();
        assert_eq!(closed, 1);
        assert!(
            drain_hits > 0 || peer.drained_cmd_replies.load(AO::SeqCst) > 0,
            "queued/in-flight cmds must be replied TransportClosed"
        );
        assert_eq!(t.write(b"after"), Err(LocalSshError::TransportClosed));
    }

    #[test]
    fn local_close_drains_inflight_and_closed_once() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
        let block = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        *peer.block_write.lock().unwrap() = Some(Arc::clone(&block));
        *peer.release_write.lock().unwrap() = Some(Arc::clone(&release));
        let t_w = Arc::clone(&t);
        let jh = std::thread::spawn(move || t_w.write(b"hold"));
        for _ in 0..50 {
            if peer.block_write.lock().unwrap().is_none() {
                break;
            }
            sleep_ms(5);
        }
        let mut queued = Vec::new();
        for i in 0..3 {
            let t_c = Arc::clone(&t);
            queued.push(std::thread::spawn(move || t_c.resize(90 + i, 20)));
        }
        sleep_ms(30);
        t.close().unwrap();
        t.close().unwrap();
        let write_r = jh.join().unwrap();
        assert_eq!(write_r, Err(LocalSshError::TransportClosed));
        for j in queued {
            assert_eq!(j.join().unwrap(), Err(LocalSshError::TransportClosed));
        }
        sleep_ms(50);
        let closed = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count();
        assert_eq!(closed, 1);
    }

    // ─── Review-fix: write/resize backend failure fail-closed ───────────────

    #[test]
    fn write_backend_failure_public_error_and_fail_closed() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
        peer.fail_write.store(true, AO::SeqCst);
        let r = t.write(b"boom");
        assert_eq!(r, Err(LocalSshError::TransportClosed));
        use super::super::prepare::map_local_ssh_public;
        assert_eq!(
            map_local_ssh_public(LocalSshError::TransportClosed),
            "local_ssh_transport_closed"
        );
        // Subsequent ops must fail-closed after backend write failure.
        for _ in 0..100 {
            if sink
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, TerminalOutput::Closed))
            {
                break;
            }
            sleep_ms(10);
        }
        let closed = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count();
        assert_eq!(closed, 1);
        assert_eq!(t.write(b"again"), Err(LocalSshError::TransportClosed));
        assert_eq!(t.resize(80, 24), Err(LocalSshError::TransportClosed));
        let public = format!("{:?}", LocalSshError::TransportClosed);
        assert!(!public.to_lowercase().contains("secret"));
        assert!(!public.contains("127.0.0.1"));
    }

    #[test]
    fn resize_backend_failure_public_error_and_fail_closed() {
        let sink = Arc::new(RecordingSink::default());
        let (t, peer) = open_fake_transport(Arc::clone(&sink) as Arc<dyn TerminalSink>);
        peer.fail_resize.store(true, AO::SeqCst);
        let r = t.resize(120, 40);
        assert_eq!(r, Err(LocalSshError::TransportClosed));
        use super::super::prepare::map_local_ssh_public;
        assert_eq!(
            map_local_ssh_public(LocalSshError::TransportClosed),
            "local_ssh_transport_closed"
        );
        for _ in 0..100 {
            if sink
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, TerminalOutput::Closed))
            {
                break;
            }
            sleep_ms(10);
        }
        assert_eq!(
            sink.events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| matches!(e, TerminalOutput::Closed))
                .count(),
            1
        );
        assert_eq!(t.write(b"x"), Err(LocalSshError::TransportClosed));
    }

    // ─── Loopback russh ──────────────────────────────────────────────────────

    #[derive(Clone)]
    struct TestServer {
        accept: Arc<AtomicBool>,
    }
    impl server::Server for TestServer {
        type Handler = Self;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
            self.clone()
        }
    }
    impl server::Handler for TestServer {
        type Error = russh::Error;
        async fn auth_publickey(
            &mut self,
            _: &str,
            _: &russh::keys::PublicKey,
        ) -> Result<Auth, Self::Error> {
            if self.accept.load(AO::SeqCst) {
                Ok(Auth::Accept)
            } else {
                Ok(Auth::Reject {
                    proceed_with_methods: None,
                    partial_success: false,
                })
            }
        }
        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<russh::server::Msg>,
            reply: server::ChannelOpenHandle,
            _session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }
        async fn pty_request(
            &mut self,
            channel: russh::ChannelId,
            _: &str,
            _: u32,
            _: u32,
            _: u32,
            _: u32,
            _: &[(russh::Pty, u32)],
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            Ok(())
        }
        async fn shell_request(
            &mut self,
            channel: russh::ChannelId,
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            let _ = session.data(channel, b"welcome\n".to_vec());
            Ok(())
        }
    }

    /// Dedicated thread+runtime so the server keeps polling after bind returns.
    fn spawn_ssh_server(accept: bool) -> (u16, std::thread::JoinHandle<()>) {
        let (port_tx, port_rx) = std::sync::mpsc::sync_channel(1);
        let jh = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                let host_key = decode_secret_key(HOST_PEM, None).unwrap();
                let config = Arc::new(server::Config {
                    keys: vec![host_key],
                    ..Default::default()
                });
                let mut sh = TestServer {
                    accept: Arc::new(AtomicBool::new(accept)),
                };
                let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
                let port = listener.local_addr().unwrap().port();
                let _ = port_tx.send(port);
                let _ = sh.run_on_socket(config, &listener).await;
            });
        });
        let port = port_rx.recv().expect("server port");
        (port, jh)
    }

    struct DetRng([u8; 32]);
    impl RandomSource for DetRng {
        fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), crate::auth::AuthError> {
            for (i, b) in dest.iter_mut().enumerate() {
                *b = self.0[i % 32];
            }
            Ok(())
        }
    }

    fn live_ctx(
        auth: Arc<AuthStore>,
        cutoff: Arc<SecurityCutoff>,
    ) -> (
        Arc<LocalSshSessionManager>,
        Arc<VaultService>,
        std::path::PathBuf,
    ) {
        live_ctx_with_rng(auth, cutoff, [3u8; 32])
    }

    fn live_ctx_with_rng(
        auth: Arc<AuthStore>,
        cutoff: Arc<SecurityCutoff>,
        rng_seed: [u8; 32],
    ) -> (
        Arc<LocalSshSessionManager>,
        Arc<VaultService>,
        std::path::PathBuf,
    ) {
        let path = {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "opsmate-8b3b-{}-{}.hold",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            p
        };
        let sh = Stronghold::new(&path, vec![0x8Fu8; 32]).unwrap();
        let binding = auth.auth_binding().unwrap();
        let vault = Arc::new(VaultService::new(path.clone()));
        vault.test_inject_unlocked(sh, binding, path.clone(), Instant::now());
        let mgr = LocalSshSessionManager::with_rng(
            auth,
            vault.clone(),
            cutoff,
            Arc::new(DetRng(rng_seed)),
        );
        (mgr, vault, path)
    }

    fn host_presented() -> PresentedHostKey {
        let pk = decode_secret_key(HOST_PEM, None)
            .unwrap()
            .public_key()
            .clone();
        super::super::connect::presented_host_key_from_russh(&pk)
    }

    #[test]
    fn loopback_pty_shell_and_session_registry_close() {
        let (port, _srv) = spawn_ssh_server(true);
        let auth = authed();
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let (mgr, vault, path) = live_ctx(auth.clone(), cutoff.clone());
        let ticket = mgr
            .begin_establishment(&super::super::prepare::LocalSshOpenRequest {
                server_id: "srv-1".into(),
                credential_id: "cred-1".into(),
            })
            .unwrap();
        let barriers = ticket.barrier_snapshot();
        let presented = host_presented();
        let binding = auth.auth_binding().unwrap();
        let gen = cutoff.ssh_generation();
        let prepared = PreparedLocalSshOpen {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
            target_host: "127.0.0.1".into(),
            ssh_port: port,
            ssh_user: "admin".into(),
            host_key: Some(PreparedHostKey {
                key_type: presented.key_type.clone(),
                fingerprint: presented.fingerprint.clone(),
            }),
            principal: binding.principal.clone(),
            epoch: binding.epoch,
            ssh_generation: gen,
            lease: VaultCredentialLease {
                credential_id: "cred-1".into(),
                fingerprint: "SHA256:u".into(),
                pem: Zeroizing::new(USER_PEM.into()),
                passphrase: None,
            },
        };
        let (authority, lease) = split_prepared_for_connect(prepared);
        let sink = Arc::new(RecordingSink::default());
        // Handshake + PTY/shell all on the actor thread (single runtime for handle lifetime).
        let OpenTransportResult {
            authority,
            transport,
        } = open_session_transport(
            authority,
            lease,
            HandshakeDeps {
                auth: auth.clone(),
                cutoff: cutoff.clone(),
                confirmer: Arc::new(MockConfirm {
                    allow: AtomicBool::new(true),
                }),
                cloud: Arc::new(MockCloud),
                local_kh: Arc::new(MockLocal),
                session_manager: mgr.clone(),
                ticket_barriers: barriers,
                extra_revalidator: None,
                overall_timeout: HANDSHAKE_OVERALL_TIMEOUT,
            },
            Arc::clone(&sink) as Arc<dyn TerminalSink>,
        )
        .expect("transport");
        let id = mgr
            .complete_established(
                ticket,
                authority,
                Arc::clone(&transport) as Arc<dyn SessionCloseHandle>,
            )
            .unwrap();
        for _ in 0..50 {
            if sink
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, TerminalOutput::Data(_)))
            {
                break;
            }
            sleep_ms(20);
        }
        let _ = transport.write(b"hi");
        mgr.close_session(id.as_str()).unwrap();
        sleep_ms(80);
        let closed = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count();
        assert_eq!(closed, 1);
        assert_eq!(transport.write(b"x"), Err(LocalSshError::TransportClosed));
        let _ = vault.lock();
        let _ = std::fs::remove_file(&path);
    }

    /// Real A/B isolation: two principals, two live transports/sessions; neither
    /// can authorize or tear down the other's registered transport.
    #[test]
    fn ab_authority_isolation_separate_transports() {
        let (port, _srv) = spawn_ssh_server(true);
        let auth_a = Arc::new(AuthStore::new());
        auth_a.install_session_for_tests("ten-a", "alice", "admin", "sub-a");
        let auth_b = Arc::new(AuthStore::new());
        auth_b.install_session_for_tests("ten-b", "bob", "admin", "sub-b");
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        // Distinct RNG seeds so minted session ids cannot collide across A/B.
        let (mgr_a, vault_a, path_a) =
            live_ctx_with_rng(auth_a.clone(), cutoff.clone(), [0xAAu8; 32]);
        let (mgr_b, vault_b, path_b) =
            live_ctx_with_rng(auth_b.clone(), cutoff.clone(), [0xBBu8; 32]);
        let presented = host_presented();

        let open_for = |auth: Arc<AuthStore>,
                        mgr: Arc<LocalSshSessionManager>,
                        server_id: &str,
                        cred: &str|
         -> (String, Arc<ActorSshTransport>, Arc<RecordingSink>) {
            let ticket = mgr
                .begin_establishment(&super::super::prepare::LocalSshOpenRequest {
                    server_id: server_id.into(),
                    credential_id: cred.into(),
                })
                .unwrap();
            let barriers = ticket.barrier_snapshot();
            let binding = auth.auth_binding().unwrap();
            let gen = cutoff.ssh_generation();
            let prepared = PreparedLocalSshOpen {
                server_id: server_id.into(),
                credential_id: cred.into(),
                target_host: "127.0.0.1".into(),
                ssh_port: port,
                ssh_user: "admin".into(),
                host_key: Some(PreparedHostKey {
                    key_type: presented.key_type.clone(),
                    fingerprint: presented.fingerprint.clone(),
                }),
                principal: binding.principal.clone(),
                epoch: binding.epoch,
                ssh_generation: gen,
                lease: VaultCredentialLease {
                    credential_id: cred.into(),
                    fingerprint: "SHA256:u".into(),
                    pem: Zeroizing::new(USER_PEM.into()),
                    passphrase: None,
                },
            };
            let (authority, lease) = split_prepared_for_connect(prepared);
            let sink = Arc::new(RecordingSink::default());
            let OpenTransportResult {
                authority,
                transport,
            } = open_session_transport(
                authority,
                lease,
                HandshakeDeps {
                    auth: auth.clone(),
                    cutoff: cutoff.clone(),
                    confirmer: Arc::new(MockConfirm {
                        allow: AtomicBool::new(true),
                    }),
                    cloud: Arc::new(MockCloud),
                    local_kh: Arc::new(MockLocal),
                    session_manager: mgr.clone(),
                    ticket_barriers: barriers,
                    extra_revalidator: None,
                    overall_timeout: HANDSHAKE_OVERALL_TIMEOUT,
                },
                Arc::clone(&sink) as Arc<dyn TerminalSink>,
            )
            .expect("open transport");
            let id = mgr
                .complete_established(
                    ticket,
                    authority,
                    Arc::clone(&transport) as Arc<dyn SessionCloseHandle>,
                )
                .expect("complete");
            (id.as_str().to_string(), transport, sink)
        };

        let (id_a, transport_a, sink_a) =
            open_for(auth_a.clone(), mgr_a.clone(), "srv-a", "cred-a");
        let (id_b, transport_b, sink_b) =
            open_for(auth_b.clone(), mgr_b.clone(), "srv-b", "cred-b");

        // Own principal can authorize own session.
        assert!(mgr_a.authorize(&id_a).is_ok());
        assert!(mgr_b.authorize(&id_b).is_ok());
        // Cross-principal authorize is non-disclosing failure (fixed public Internal).
        assert_eq!(mgr_b.authorize(&id_a), Err(LocalSshError::Internal));
        assert_eq!(mgr_a.authorize(&id_b), Err(LocalSshError::Internal));
        // Cross-principal close_session is a silent no-op (no existence disclosure)
        // and must NOT close the peer's transport.
        mgr_b.close_session(&id_a).unwrap();
        mgr_a.close_session(&id_b).unwrap();
        sleep_ms(40);
        assert!(
            mgr_a.authorize(&id_a).is_ok(),
            "B must not close A's session"
        );
        assert!(
            mgr_b.authorize(&id_b).is_ok(),
            "A must not close B's session"
        );
        // Transports still accept writes after foreign close attempts.
        assert_eq!(transport_a.write(b"a"), Ok(()));
        assert_eq!(transport_b.write(b"b"), Ok(()));
        // Prefer proving still open via authorize + no Closed from foreign close.
        let closed_a = sink_a
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count();
        let closed_b = sink_b
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count();
        assert_eq!(closed_a, 0, "foreign close must not emit Closed for A");
        assert_eq!(closed_b, 0, "foreign close must not emit Closed for B");

        // Owner close tears down only own transport.
        mgr_a.close_session(&id_a).unwrap();
        sleep_ms(80);
        let closed_a = sink_a
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count();
        assert_eq!(closed_a, 1);
        assert_eq!(transport_a.write(b"x"), Err(LocalSshError::TransportClosed));
        // B still live.
        assert!(mgr_b.authorize(&id_b).is_ok());
        let closed_b = sink_b
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, TerminalOutput::Closed))
            .count();
        assert_eq!(closed_b, 0);
        mgr_b.close_session(&id_b).unwrap();
        sleep_ms(80);
        assert_eq!(transport_b.write(b"x"), Err(LocalSshError::TransportClosed));

        let _ = vault_a.lock();
        let _ = vault_b.lock();
        let _ = std::fs::remove_file(&path_a);
        let _ = std::fs::remove_file(&path_b);
    }

    #[test]
    fn public_error_codes_include_transport() {
        use super::super::prepare::map_local_ssh_public;
        for e in [
            LocalSshError::ChannelFailed,
            LocalSshError::TransportClosed,
            LocalSshError::CommandQueueFull,
        ] {
            let s = map_local_ssh_public(e);
            assert!(s.starts_with("local_ssh_"));
            assert_eq!(s, e.to_string());
        }
    }
}
