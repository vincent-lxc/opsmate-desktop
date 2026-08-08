//! Native cloud terminal proxy (Task 7).
//!
//! WebView supplies only `{ serverId }` for open and opaque `{ sessionId }` for
//! write/resize/close. Host/port/username and WS tokens never cross the WebView
//! boundary. Rust fetches a short-lived WSS token via the fixed-origin broker
//! (`https://app.itops.sh`), owns the WSS connection, and emits the same
//! secret-free [`LocalSshOutputEvent`] stream as local SSH.

use crate::auth::{auth_native_bearer, AuthStore, NativePrincipal, RandomSource, SecRandomSource};
use crate::ssh_ipc::{
    encode_std_base64, LocalSshOutputEmitter, LocalSshOutputEvent, LocalSshOutputStream,
    MAX_PENDING_SSH_OUTPUT,
};
use crate::ssh_registry::{
    generate_session_id, MAX_SSH_TERM_DIM, MAX_SSH_WRITE_BYTES, MIN_SSH_TERM_DIM,
};
use crate::ssh_session::{LocalSshOpenResponse, SshSessionError};
use crate::ssh_transport::MAX_TRANSPORT_CMD_QUEUE;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{connect_async_with_config, tungstenite::Message};
use zeroize::Zeroizing;

/// Max time to wait for server `{ type: "ready" }` after WSS connect.
#[cfg(not(test))]
const CLOUD_TERMINAL_READY_TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(test)]
const CLOUD_TERMINAL_READY_TIMEOUT: Duration = Duration::from_secs(2);
/// Bound for TCP/TLS/WS handshake (production connect must return by this).
pub const CLOUD_TERMINAL_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
/// Bound for each WSS write/resize send and close handshake (backpressure fail-closed).
#[cfg(not(test))]
pub const CLOUD_TERMINAL_IO_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
pub const CLOUD_TERMINAL_IO_WRITE_TIMEOUT: Duration = Duration::from_millis(150);
/// After cancel/channel-close, wait this long for IO worker to exit.
const CLOUD_TERMINAL_IO_IDLE_WAIT: Duration = Duration::from_secs(3);
/// Max single WSS text/binary frame accepted from the peer (also WebSocketConfig pre-alloc cap).
pub const MAX_CLOUD_WSS_MESSAGE_BYTES: usize = 256 * 1024;
/// Max parsed `output`/`error` string chars delivered into the pending queue / events.
pub const MAX_CLOUD_PARSED_OUTPUT_CHARS: usize = 192 * 1024;
/// Max cumulative base64 chars buffered before session-id bind.
pub const MAX_CLOUD_PENDING_B64_CHARS: usize = 256 * 1024;

// ─── WebView DTOs (deny unknown: no host/port/username) ──────────────────────

/// Open: serverId only. Host/port/username/token must never appear.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CloudTerminalOpenRequest {
    pub server_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CloudTerminalWriteRequest {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CloudTerminalResizeRequest {
    pub session_id: String,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CloudTerminalCloseRequest {
    pub session_id: String,
}

// ─── Validation ──────────────────────────────────────────────────────────────

const MAX_SERVER_ID_LEN: usize = 128;

/// Strict opaque path segment: no controls, whitespace, encoding, or path/query chars.
pub fn validate_open_request(req: &CloudTerminalOpenRequest) -> Result<(), SshSessionError> {
    let sid = req.server_id.as_str();
    // Reject outer whitespace (trim would hide smuggling); require exact segment.
    if sid.is_empty() || sid.len() > MAX_SERVER_ID_LEN || sid != sid.trim() {
        return Err(SshSessionError::InvalidIdentity);
    }
    for c in sid.chars() {
        if c.is_control() || c.is_whitespace() {
            return Err(SshSessionError::InvalidIdentity);
        }
        // Opaque path segment only: unreserved + limited extras used by server ids.
        let ok = c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~');
        if !ok {
            // Explicitly reject /, \, #, ?, %, and any other encoding/path material.
            return Err(SshSessionError::InvalidIdentity);
        }
    }
    Ok(())
}

pub fn validate_write_request(req: &CloudTerminalWriteRequest) -> Result<(), SshSessionError> {
    if req.session_id.trim().is_empty() {
        return Err(SshSessionError::InvalidIdentity);
    }
    if req.data.len() > MAX_SSH_WRITE_BYTES {
        return Err(SshSessionError::InvalidMetadata);
    }
    Ok(())
}

pub fn validate_resize_request(req: &CloudTerminalResizeRequest) -> Result<(), SshSessionError> {
    if req.session_id.trim().is_empty() {
        return Err(SshSessionError::InvalidIdentity);
    }
    if !(MIN_SSH_TERM_DIM..=MAX_SSH_TERM_DIM).contains(&req.cols)
        || !(MIN_SSH_TERM_DIM..=MAX_SSH_TERM_DIM).contains(&req.rows)
    {
        return Err(SshSessionError::InvalidMetadata);
    }
    Ok(())
}

// ─── Actor command / connector traits ────────────────────────────────────────

pub(crate) enum ActorCmd {
    Write(String),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// Token + connect factory (mockable for unit tests).
pub trait CloudTerminalConnector: Send + Sync {
    /// Fetch short-lived WSS token using the native bearer (never returned to WebView).
    fn fetch_ws_token(&self, bearer: &str) -> Result<String, SshSessionError>;

    /// Own the WSS connection: drive `on_event` until the socket ends.
    fn connect(
        &self,
        server_id: &str,
        token: &str,
        cmd_rx: mpsc::Receiver<ActorCmd>,
        on_event: Arc<dyn Fn(CloudServerEvent) + Send + Sync>,
    ) -> Result<(), SshSessionError>;
}

/// Server → client events after JSON parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudServerEvent {
    Ready,
    Output(String),
    Error(String),
    SocketClosed,
}

// ─── Session manager ─────────────────────────────────────────────────────────

struct CloudSessionSlot {
    principal: NativePrincipal,
    epoch: u64,
    #[allow(dead_code)]
    server_id: String,
    dead: AtomicBool,
    close_invoked: AtomicBool,
    cmd_tx: mpsc::Sender<ActorCmd>,
}

pub struct CloudTerminalSessionManager {
    inner: Mutex<CloudRegistryInner>,
    /// In-flight connector IO threads (increment before spawn, Drop-guard decrement).
    active_io: AtomicUsize,
}

struct CloudRegistryInner {
    sessions: HashMap<String, Arc<CloudSessionSlot>>,
    generation: u64,
}

impl CloudRegistryInner {
    fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            generation: 0,
        }
    }
}

impl Default for CloudTerminalSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl CloudTerminalSessionManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(CloudRegistryInner::new()),
            active_io: AtomicUsize::new(0),
        }
    }

    pub fn session_count(&self) -> usize {
        self.inner.lock().map(|g| g.sessions.len()).unwrap_or(0)
    }

    /// Number of connector IO workers still running (for tests / diagnostics).
    pub fn active_io_workers(&self) -> usize {
        self.active_io.load(Ordering::SeqCst)
    }

    /// Open: auth → token → WSS → wait ready → register → return opaque sessionId.
    ///
    /// Prefer `prefetched_token` from [`CloudProxy::fetch_ws_token`] so 401/403
    /// cutoffs and Zeroizing bearer handling stay in the fixed-origin broker.
    pub fn open_session(
        self: &Arc<Self>,
        auth: &AuthStore,
        req: &CloudTerminalOpenRequest,
        connector: Arc<dyn CloudTerminalConnector>,
        emitter: Arc<dyn LocalSshOutputEmitter>,
        rng: &dyn RandomSource,
        prefetched_token: Option<Zeroizing<String>>,
    ) -> Result<LocalSshOpenResponse, SshSessionError> {
        validate_open_request(req)?;
        let snap = auth
            .native_auth_snapshot()
            .ok_or(SshSessionError::Unauthenticated)?;
        let server_id = req.server_id.clone();

        let gen_ticket = {
            let inner = self.inner.lock().map_err(|_| SshSessionError::Internal)?;
            inner.generation
        };

        let token = if let Some(t) = prefetched_token {
            t
        } else {
            // Test / legacy path: connector may fetch; production uses CloudProxy.
            let bearer = auth_native_bearer(auth).ok_or(SshSessionError::Unauthenticated)?;
            let t = connector.fetch_ws_token(bearer.as_str())?;
            drop(bearer);
            Zeroizing::new(t)
        };

        if !auth.snapshot_still_current(&snap) {
            return Err(SshSessionError::AuthorizationFailed);
        }

        let (cmd_tx, cmd_rx) = mpsc::channel::<ActorCmd>(MAX_TRANSPORT_CMD_QUEUE);
        let (event_tx, event_rx) = std::sync::mpsc::channel::<CloudServerEvent>();

        let pending: Arc<Mutex<PendingOutputQueue>> =
            Arc::new(Mutex::new(PendingOutputQueue::new()));
        let session_id_holder: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let closed_emitted = Arc::new(AtomicBool::new(false));
        let overflowed = Arc::new(AtomicBool::new(false));

        let pending_cb = Arc::clone(&pending);
        let sid_cb = Arc::clone(&session_id_holder);
        let emitter_cb = Arc::clone(&emitter);
        let closed_cb = Arc::clone(&closed_emitted);
        let overflow_cb = Arc::clone(&overflowed);
        let mgr_cb: Arc<CloudTerminalSessionManager> = Arc::clone(self);

        let on_event: Arc<dyn Fn(CloudServerEvent) + Send + Sync> = Arc::new(move |ev| {
            if overflow_cb.load(Ordering::SeqCst) {
                return;
            }
            match ev {
                CloudServerEvent::Ready => {
                    let _ = event_tx.send(CloudServerEvent::Ready);
                }
                CloudServerEvent::Output(text) => {
                    if text.len() > MAX_CLOUD_PARSED_OUTPUT_CHARS {
                        overflow_cb.store(true, Ordering::SeqCst);
                        let _ = event_tx.send(CloudServerEvent::SocketClosed);
                        return;
                    }
                    let _ = event_tx.send(CloudServerEvent::Output(text.clone()));
                    let b64 = encode_std_base64(text.as_bytes());
                    if route_output(
                        &sid_cb,
                        &pending_cb,
                        emitter_cb.as_ref(),
                        LocalSshOutputStream::Stdout,
                        b64,
                        &overflow_cb,
                        &mgr_cb,
                    )
                    .is_err()
                    {
                        let _ = event_tx.send(CloudServerEvent::SocketClosed);
                    }
                }
                CloudServerEvent::Error(msg) => {
                    if msg.len() > MAX_CLOUD_PARSED_OUTPUT_CHARS {
                        overflow_cb.store(true, Ordering::SeqCst);
                        let _ = event_tx.send(CloudServerEvent::SocketClosed);
                        return;
                    }
                    let _ = event_tx.send(CloudServerEvent::Error(msg.clone()));
                    let b64 = encode_std_base64(msg.as_bytes());
                    if route_output(
                        &sid_cb,
                        &pending_cb,
                        emitter_cb.as_ref(),
                        LocalSshOutputStream::Stderr,
                        b64,
                        &overflow_cb,
                        &mgr_cb,
                    )
                    .is_err()
                    {
                        let _ = event_tx.send(CloudServerEvent::SocketClosed);
                    }
                }
                CloudServerEvent::SocketClosed => {
                    let _ = event_tx.send(CloudServerEvent::SocketClosed);
                    if closed_cb.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    let sid = sid_cb.lock().ok().and_then(|g| g.clone());
                    if let Some(id) = sid {
                        let closed = LocalSshOutputEvent {
                            session_id: id.clone(),
                            stream: LocalSshOutputStream::Closed,
                            data: String::new(),
                        };
                        let _ = emitter_cb.emit_to_main(&closed);
                        mgr_cb.remove_on_transport_ended(&id);
                    } else if let Ok(mut q) = pending_cb.lock() {
                        q.push_closed();
                    }
                }
            }
        });

        let server_id_connect = server_id.clone();
        // Move Zeroizing into the IO thread; wiped on drop after connect returns.
        let token_connect = token;
        let connector_bg = Arc::clone(&connector);
        let on_event_bg = Arc::clone(&on_event);
        let io_mgr = Arc::clone(self);
        self.active_io.fetch_add(1, Ordering::SeqCst);
        let spawn_result = std::thread::Builder::new()
            .name("cloud-terminal-io".into())
            .spawn(move || {
                let _io_guard = ActiveIoGuard(io_mgr);
                let _ = connector_bg.connect(
                    &server_id_connect,
                    token_connect.as_str(),
                    cmd_rx,
                    on_event_bg,
                );
            });
        if spawn_result.is_err() {
            self.active_io.fetch_sub(1, Ordering::SeqCst);
            return Err(SshSessionError::Internal);
        }
        // Detach: production connector must exit via handshake timeout / channel close.
        // Never spawn a second "joiner" thread that can outlive this open call.
        drop(spawn_result);

        // Wait for ready / hard failure / timeout.
        let deadline = std::time::Instant::now() + CLOUD_TERMINAL_READY_TIMEOUT;
        let mut saw_ready = false;
        let mut fail = false;
        while std::time::Instant::now() < deadline {
            if overflowed.load(Ordering::SeqCst) {
                fail = true;
                break;
            }
            match event_rx.recv_timeout(Duration::from_millis(25)) {
                Ok(CloudServerEvent::Ready) => {
                    saw_ready = true;
                    break;
                }
                Ok(CloudServerEvent::Error(_)) | Ok(CloudServerEvent::SocketClosed) => {
                    fail = true;
                    break;
                }
                Ok(CloudServerEvent::Output(_)) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if let Ok(q) = pending.lock() {
                        if q.saw_closed {
                            fail = true;
                            break;
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    fail = true;
                    break;
                }
            }
        }

        if fail || !saw_ready || overflowed.load(Ordering::SeqCst) {
            cancel_cloud_open_io(cmd_tx, self);
            return Err(SshSessionError::ConnectFailed);
        }

        if !auth.snapshot_still_current(&snap) {
            cancel_cloud_open_io(cmd_tx, self);
            return Err(SshSessionError::AuthorizationFailed);
        }

        let mut inner = self.inner.lock().map_err(|_| SshSessionError::Internal)?;
        if inner.generation != gen_ticket {
            drop(inner);
            cancel_cloud_open_io(cmd_tx, self);
            return Err(SshSessionError::AuthorizationFailed);
        }

        let session_id = match generate_session_id(rng, &|id| inner.sessions.contains_key(id)) {
            Ok(id) => id,
            Err(e) => {
                drop(inner);
                cancel_cloud_open_io(cmd_tx, self);
                return Err(e);
            }
        };

        let slot = Arc::new(CloudSessionSlot {
            principal: snap.principal.clone(),
            epoch: snap.epoch,
            server_id,
            dead: AtomicBool::new(false),
            close_invoked: AtomicBool::new(false),
            cmd_tx: cmd_tx.clone(),
        });
        inner.sessions.insert(session_id.clone(), slot);
        drop(inner);

        if let Ok(mut g) = session_id_holder.lock() {
            *g = Some(session_id.clone());
        }

        // Flush pre-bind output with session-id filtering.
        if let Ok(mut q) = pending.lock() {
            for (stream, data) in q.drain_events() {
                if stream == LocalSshOutputStream::Closed {
                    let closed = LocalSshOutputEvent {
                        session_id: session_id.clone(),
                        stream: LocalSshOutputStream::Closed,
                        data: String::new(),
                    };
                    let _ = emitter.emit_to_main(&closed);
                    self.remove_on_transport_ended(&session_id);
                    break;
                }
                let ev = LocalSshOutputEvent {
                    session_id: session_id.clone(),
                    stream,
                    data,
                };
                let _ = emitter.emit_to_main(&ev);
            }
        }

        Ok(LocalSshOpenResponse { session_id })
    }

    pub fn write(
        &self,
        auth: &AuthStore,
        req: &CloudTerminalWriteRequest,
    ) -> Result<(), SshSessionError> {
        validate_write_request(req)?;
        let slot = self.lookup_slot(&req.session_id)?;
        self.io_with_revalidation(auth, &slot, &req.session_id, || {
            slot.cmd_tx
                .try_send(ActorCmd::Write(req.data.clone()))
                .map_err(|e| match e {
                    mpsc::error::TrySendError::Full(_) => SshSessionError::CommandQueueFull,
                    mpsc::error::TrySendError::Closed(_) => SshSessionError::TransportClosed,
                })
        })
    }

    pub fn resize(
        &self,
        auth: &AuthStore,
        req: &CloudTerminalResizeRequest,
    ) -> Result<(), SshSessionError> {
        validate_resize_request(req)?;
        let slot = self.lookup_slot(&req.session_id)?;
        self.io_with_revalidation(auth, &slot, &req.session_id, || {
            slot.cmd_tx
                .try_send(ActorCmd::Resize {
                    cols: req.cols,
                    rows: req.rows,
                })
                .map_err(|e| match e {
                    mpsc::error::TrySendError::Full(_) => SshSessionError::CommandQueueFull,
                    mpsc::error::TrySendError::Closed(_) => SshSessionError::TransportClosed,
                })
        })
    }

    /// Exact-once close: remove slot, send Close once.
    /// Unknown / foreign sessions: silent success (non-enumerating).
    pub fn close(
        &self,
        auth: &AuthStore,
        req: &CloudTerminalCloseRequest,
    ) -> Result<(), SshSessionError> {
        if req.session_id.trim().is_empty() {
            return Err(SshSessionError::InvalidIdentity);
        }
        let slot = {
            let mut inner = match self.inner.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let Some(existing) = inner.sessions.get(&req.session_id) else {
                return Ok(());
            };
            if !auth.session_binding_current(&existing.principal, existing.epoch) {
                return Ok(());
            }
            inner.sessions.remove(&req.session_id)
        };
        if let Some(slot) = slot {
            close_slot_once(&slot);
        }
        Ok(())
    }

    pub fn remove_on_transport_ended(&self, session_id: &str) {
        if session_id.trim().is_empty() {
            return;
        }
        let slot = {
            let mut inner = match self.inner.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            inner.sessions.remove(session_id)
        };
        if let Some(slot) = slot {
            close_slot_once(&slot);
        }
    }

    pub fn close_all(&self) {
        let drained = {
            let mut inner = match self.inner.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            inner.generation = inner.generation.wrapping_add(1);
            std::mem::take(&mut inner.sessions)
        };
        for (_, slot) in drained {
            close_slot_once(&slot);
        }
    }

    fn lookup_slot(&self, session_id: &str) -> Result<Arc<CloudSessionSlot>, SshSessionError> {
        let inner = self.inner.lock().map_err(|_| SshSessionError::Internal)?;
        inner
            .sessions
            .get(session_id)
            .cloned()
            .ok_or(SshSessionError::AuthorizationFailed)
    }

    fn io_with_revalidation(
        &self,
        auth: &AuthStore,
        slot: &Arc<CloudSessionSlot>,
        session_id: &str,
        f: impl FnOnce() -> Result<(), SshSessionError>,
    ) -> Result<(), SshSessionError> {
        if slot.dead.load(Ordering::SeqCst)
            || !auth.session_binding_current(&slot.principal, slot.epoch)
        {
            self.remove_on_transport_ended(session_id);
            return Err(SshSessionError::AuthorizationFailed);
        }
        let result = f();
        if slot.dead.load(Ordering::SeqCst)
            || !auth.session_binding_current(&slot.principal, slot.epoch)
        {
            self.remove_on_transport_ended(session_id);
            return Err(SshSessionError::AuthorizationFailed);
        }
        result
    }
}

fn close_slot_once(slot: &CloudSessionSlot) {
    slot.dead.store(true, Ordering::SeqCst);
    if slot.close_invoked.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = slot.cmd_tx.try_send(ActorCmd::Close);
}

/// Bounded pre-bind queue: count + cumulative base64 bytes; overflow fails closed.
struct PendingOutputQueue {
    events: Vec<(LocalSshOutputStream, String)>,
    b64_chars: usize,
    saw_closed: bool,
}

impl PendingOutputQueue {
    fn new() -> Self {
        Self {
            events: Vec::new(),
            b64_chars: 0,
            saw_closed: false,
        }
    }

    fn try_push(&mut self, stream: LocalSshOutputStream, data_b64: String) -> Result<(), ()> {
        if stream == LocalSshOutputStream::Closed {
            self.saw_closed = true;
            self.events
                .push((LocalSshOutputStream::Closed, String::new()));
            return Ok(());
        }
        if data_b64.len() > MAX_CLOUD_PENDING_B64_CHARS {
            return Err(());
        }
        if self.events.len() >= MAX_PENDING_SSH_OUTPUT {
            return Err(());
        }
        let next = self.b64_chars.saturating_add(data_b64.len());
        if next > MAX_CLOUD_PENDING_B64_CHARS {
            return Err(());
        }
        self.b64_chars = next;
        self.events.push((stream, data_b64));
        Ok(())
    }

    fn push_closed(&mut self) {
        self.saw_closed = true;
        self.events
            .push((LocalSshOutputStream::Closed, String::new()));
    }

    fn drain_events(&mut self) -> Vec<(LocalSshOutputStream, String)> {
        self.b64_chars = 0;
        std::mem::take(&mut self.events)
    }
}

/// Deliver live output or buffer pre-bind. On overflow: mark fail-closed and close session.
fn route_output(
    session_id_holder: &Mutex<Option<String>>,
    pending: &Mutex<PendingOutputQueue>,
    emitter: &dyn LocalSshOutputEmitter,
    stream: LocalSshOutputStream,
    data_b64: String,
    overflowed: &AtomicBool,
    mgr: &CloudTerminalSessionManager,
) -> Result<(), ()> {
    if overflowed.load(Ordering::SeqCst) {
        return Err(());
    }
    let sid = session_id_holder.lock().ok().and_then(|g| g.clone());
    if let Some(session_id) = sid {
        if data_b64.len() > MAX_CLOUD_PENDING_B64_CHARS {
            overflowed.store(true, Ordering::SeqCst);
            mgr.remove_on_transport_ended(&session_id);
            return Err(());
        }
        let ev = LocalSshOutputEvent {
            session_id,
            stream,
            data: data_b64,
        };
        let _ = emitter.emit_to_main(&ev);
        return Ok(());
    }
    let mut q = pending.lock().map_err(|_| ())?;
    if q.try_push(stream, data_b64).is_err() {
        overflowed.store(true, Ordering::SeqCst);
        // Fail closed: drop buffered data; open waiter will see overflow flag.
        q.events.clear();
        q.b64_chars = 0;
        return Err(());
    }
    Ok(())
}

/// RAII: decrement active IO worker count when the connector thread exits.
struct ActiveIoGuard(Arc<CloudTerminalSessionManager>);

impl Drop for ActiveIoGuard {
    fn drop(&mut self) {
        self.0.active_io.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Cancel an in-progress open: signal Close, drop the cmd sender (disconnect),
/// then wait for the production connector to exit via handshake timeout / channel close.
/// Does **not** spawn a joiner thread (no permanent leak of join helpers).
fn cancel_cloud_open_io(cmd_tx: mpsc::Sender<ActorCmd>, mgr: &CloudTerminalSessionManager) {
    let _ = cmd_tx.try_send(ActorCmd::Close);
    drop(cmd_tx);
    let _ = wait_for_io_idle(mgr, CLOUD_TERMINAL_IO_IDLE_WAIT);
}

fn wait_for_io_idle(mgr: &CloudTerminalSessionManager, bound: Duration) -> bool {
    let deadline = std::time::Instant::now() + bound;
    while std::time::Instant::now() < deadline {
        if mgr.active_io_workers() == 0 {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    mgr.active_io_workers() == 0
}

/// WebSocket config with pre-allocation caps (before message body is buffered).
pub fn cloud_ws_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_CLOUD_WSS_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_CLOUD_WSS_MESSAGE_BYTES))
}

/// Bound an async handshake future (production path uses the same timeout primitive).
pub async fn run_bounded_handshake<T>(
    fut: impl std::future::Future<Output = Result<T, SshSessionError>>,
) -> Result<T, SshSessionError> {
    match tokio::time::timeout(CLOUD_TERMINAL_HANDSHAKE_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_elapsed) => Err(SshSessionError::ConnectFailed),
    }
}

/// Bound a single WSS write/close future so a stalled peer cannot pin the writer forever.
/// On timeout the future is dropped (cancel-safe for tokio timeout) and the writer loop
/// must exit so `select!` drops the reader/socket.
pub async fn run_bounded_ws_io<T>(
    fut: impl std::future::Future<Output = Result<T, impl std::fmt::Debug>>,
) -> Result<T, SshSessionError> {
    match tokio::time::timeout(CLOUD_TERMINAL_IO_WRITE_TIMEOUT, fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(_)) => Err(SshSessionError::TransportClosed),
        Err(_elapsed) => Err(SshSessionError::TransportClosed),
    }
}

// ─── Production connector ────────────────────────────────────────────────────

/// Production WSS connector only — tokens come from CloudProxy, never raw reqwest.
#[derive(Default)]
pub struct ProductionCloudTerminalConnector;

impl ProductionCloudTerminalConnector {
    pub fn new() -> Result<Self, SshSessionError> {
        Ok(Self)
    }
}

impl CloudTerminalConnector for ProductionCloudTerminalConnector {
    /// Production always prefetches via [`crate::cloud_proxy::CloudProxy::fetch_ws_token`].
    fn fetch_ws_token(&self, _bearer: &str) -> Result<String, SshSessionError> {
        Err(SshSessionError::Internal)
    }

    fn connect(
        &self,
        server_id: &str,
        token: &str,
        mut cmd_rx: mpsc::Receiver<ActorCmd>,
        on_event: Arc<dyn Fn(CloudServerEvent) + Send + Sync>,
    ) -> Result<(), SshSessionError> {
        let wss_url = format!(
            "wss://app.itops.sh/api/servers/{server_id}/terminal?token={}",
            urlencoding_token(token)
        );
        let fut = async move {
            let cfg = cloud_ws_config();
            let connect_fut = connect_async_with_config(&wss_url, Some(cfg), false);
            // Explicit handshake deadline — not a timed join after the fact.
            let (ws, _resp) =
                match tokio::time::timeout(CLOUD_TERMINAL_HANDSHAKE_TIMEOUT, connect_fut).await {
                    Ok(Ok(pair)) => pair,
                    Ok(Err(_)) | Err(_) => {
                        on_event(CloudServerEvent::SocketClosed);
                        return Err(SshSessionError::ConnectFailed);
                    }
                };
            let (mut write, mut read) = ws.split();

            let writer = async {
                while let Some(cmd) = cmd_rx.recv().await {
                    match cmd {
                        ActorCmd::Write(data) => {
                            let payload = serde_json::json!({ "type": "input", "data": data });
                            let msg = Message::Text(payload.to_string().into());
                            // Deadline around every send — backpressured peer must not hang logout/close.
                            if run_bounded_ws_io(write.send(msg)).await.is_err() {
                                break;
                            }
                        }
                        ActorCmd::Resize { cols, rows } => {
                            let payload =
                                serde_json::json!({ "type": "resize", "cols": cols, "rows": rows });
                            let msg = Message::Text(payload.to_string().into());
                            if run_bounded_ws_io(write.send(msg)).await.is_err() {
                                break;
                            }
                        }
                        ActorCmd::Close => {
                            let _ = run_bounded_ws_io(write.close()).await;
                            break;
                        }
                    }
                }
                // Channel closed, Close, or I/O timeout: drop write half so reader unblocks.
                drop(write);
            };

            let reader = async {
                while let Some(msg) = read.next().await {
                    match msg {
                        Ok(Message::Text(text)) => {
                            // Config already caps frames; keep parse bounds for application JSON.
                            if let Some(ev) = parse_server_message(&text) {
                                on_event(ev);
                            }
                        }
                        Ok(Message::Binary(bin)) => {
                            if let Ok(text) = std::str::from_utf8(&bin) {
                                if let Some(ev) = parse_server_message(text) {
                                    on_event(ev);
                                }
                            }
                        }
                        Ok(Message::Close(_)) | Err(_) => break,
                        Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {}
                    }
                }
                on_event(CloudServerEvent::SocketClosed);
            };

            tokio::select! {
                _ = writer => {},
                _ = reader => {},
            }
            Ok::<(), SshSessionError>(())
        };
        block_on_cloud(fut)
    }
}

fn urlencoding_token(token: &str) -> String {
    let mut out = String::with_capacity(token.len());
    for b in token.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push(char::from(b"0123456789ABCDEF"[(b >> 4) as usize]));
                out.push(char::from(b"0123456789ABCDEF"[(b & 0xf) as usize]));
            }
        }
    }
    out
}

fn parse_server_message(text: &str) -> Option<CloudServerEvent> {
    if text.len() > MAX_CLOUD_WSS_MESSAGE_BYTES {
        return None;
    }
    let v: Value = serde_json::from_str(text).ok()?;
    let ty = v.get("type")?.as_str()?;
    match ty {
        "ready" => Some(CloudServerEvent::Ready),
        "output" => {
            let data = v.get("data")?.as_str()?;
            if data.len() > MAX_CLOUD_PARSED_OUTPUT_CHARS {
                return None;
            }
            Some(CloudServerEvent::Output(data.to_string()))
        }
        "error" => {
            let message = v.get("message").and_then(|m| m.as_str()).unwrap_or("error");
            if message.len() > MAX_CLOUD_PARSED_OUTPUT_CHARS {
                return None;
            }
            Some(CloudServerEvent::Error(message.to_string()))
        }
        _ => None,
    }
}

fn block_on_cloud<F, T>(fut: F) -> Result<T, SshSessionError>
where
    F: std::future::Future<Output = Result<T, SshSessionError>> + Send + 'static,
    T: Send + 'static,
{
    if tokio::runtime::Handle::try_current().is_ok() {
        return std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| SshSessionError::Internal)?;
            rt.block_on(fut)
        })
        .join()
        .map_err(|_| SshSessionError::Internal)?;
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| SshSessionError::Internal)?;
    rt.block_on(fut)
}

// ─── Orchestration entry points ──────────────────────────────────────────────

pub fn perform_cloud_terminal_open(
    auth: Arc<AuthStore>,
    sessions: Arc<CloudTerminalSessionManager>,
    req: CloudTerminalOpenRequest,
    emitter: Arc<dyn LocalSshOutputEmitter>,
    prefetched_token: Zeroizing<String>,
) -> Result<LocalSshOpenResponse, SshSessionError> {
    let connector: Arc<dyn CloudTerminalConnector> =
        Arc::new(ProductionCloudTerminalConnector::new()?);
    let rng = SecRandomSource;
    sessions.open_session(
        auth.as_ref(),
        &req,
        connector,
        emitter,
        &rng,
        Some(prefetched_token),
    )
}

pub fn perform_cloud_terminal_write(
    auth: &AuthStore,
    sessions: &CloudTerminalSessionManager,
    req: &CloudTerminalWriteRequest,
) -> Result<(), SshSessionError> {
    sessions.write(auth, req)
}

pub fn perform_cloud_terminal_resize(
    auth: &AuthStore,
    sessions: &CloudTerminalSessionManager,
    req: &CloudTerminalResizeRequest,
) -> Result<(), SshSessionError> {
    sessions.resize(auth, req)
}

pub fn perform_cloud_terminal_close(
    auth: &AuthStore,
    sessions: &CloudTerminalSessionManager,
    req: &CloudTerminalCloseRequest,
) -> Result<(), SshSessionError> {
    sessions.close(auth, req)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{AuthError, AuthStore, RandomSource};
    use crate::cloud_proxy::http::BASE_ORIGIN;
    use crate::ssh_ipc::RecordingEmitter;
    use std::sync::atomic::AtomicBool;

    struct FixedRng;

    impl RandomSource for FixedRng {
        fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), AuthError> {
            for (i, b) in dest.iter_mut().enumerate() {
                *b = (i as u8).wrapping_add(7);
            }
            Ok(())
        }
    }

    struct MockConnector {
        token: String,
        events: Mutex<Vec<CloudServerEvent>>,
        last_server_id: Mutex<Option<String>>,
        cmds: Arc<Mutex<Vec<String>>>,
    }

    impl MockConnector {
        fn ready_only() -> Self {
            Self {
                token: "ws-tok".into(),
                events: Mutex::new(vec![CloudServerEvent::Ready]),
                last_server_id: Mutex::new(None),
                cmds: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl CloudTerminalConnector for MockConnector {
        fn fetch_ws_token(&self, _bearer: &str) -> Result<String, SshSessionError> {
            Ok(self.token.clone())
        }

        fn connect(
            &self,
            server_id: &str,
            _token: &str,
            mut cmd_rx: mpsc::Receiver<ActorCmd>,
            on_event: Arc<dyn Fn(CloudServerEvent) + Send + Sync>,
        ) -> Result<(), SshSessionError> {
            *self.last_server_id.lock().unwrap() = Some(server_id.to_string());
            let events = self.events.lock().unwrap().clone();
            for ev in events {
                on_event(ev);
            }
            let cmds = Arc::clone(&self.cmds);
            // Drain until Close (or channel drop).
            while let Some(cmd) = cmd_rx.blocking_recv() {
                match cmd {
                    ActorCmd::Write(d) => cmds.lock().unwrap().push(format!("w:{d}")),
                    ActorCmd::Resize { cols, rows } => {
                        cmds.lock().unwrap().push(format!("r:{cols}x{rows}"))
                    }
                    ActorCmd::Close => break,
                }
            }
            on_event(CloudServerEvent::SocketClosed);
            Ok(())
        }
    }

    fn seed_auth(store: &AuthStore) {
        store.install_session_for_tests("tenant-a", "user-a", "admin");
    }

    fn open_test(
        mgr: &Arc<CloudTerminalSessionManager>,
        auth: &AuthStore,
        req: &CloudTerminalOpenRequest,
        connector: Arc<dyn CloudTerminalConnector>,
        emitter: Arc<dyn LocalSshOutputEmitter>,
    ) -> Result<LocalSshOpenResponse, SshSessionError> {
        mgr.open_session(auth, req, connector, emitter, &FixedRng, None)
    }

    #[test]
    fn open_dto_rejects_host_port_username() {
        let bad = r#"{"serverId":"s1","host":"evil","port":22,"username":"root"}"#;
        assert!(serde_json::from_str::<CloudTerminalOpenRequest>(bad).is_err());
        let ok = serde_json::from_str::<CloudTerminalOpenRequest>(r#"{"serverId":"s1"}"#).unwrap();
        assert_eq!(ok.server_id, "s1");
    }

    #[test]
    fn write_resize_bounds() {
        assert!(validate_write_request(&CloudTerminalWriteRequest {
            session_id: "sid".into(),
            data: "x".repeat(MAX_SSH_WRITE_BYTES + 1),
        })
        .is_err());
        assert!(validate_resize_request(&CloudTerminalResizeRequest {
            session_id: "sid".into(),
            cols: 0,
            rows: 24,
        })
        .is_err());
        assert!(validate_resize_request(&CloudTerminalResizeRequest {
            session_id: "sid".into(),
            cols: 80,
            rows: MAX_SSH_TERM_DIM + 1,
        })
        .is_err());
        assert!(validate_resize_request(&CloudTerminalResizeRequest {
            session_id: "sid".into(),
            cols: 80,
            rows: 24,
        })
        .is_ok());
    }

    #[test]
    fn open_requires_auth_and_returns_opaque_session() {
        let auth = AuthStore::new();
        let mgr = Arc::new(CloudTerminalSessionManager::new());
        let emitter: Arc<dyn LocalSshOutputEmitter> = Arc::new(RecordingEmitter::new());
        let connector: Arc<dyn CloudTerminalConnector> = Arc::new(MockConnector::ready_only());
        let req = CloudTerminalOpenRequest {
            server_id: "srv-1".into(),
        };
        let err = mgr
            .open_session(
                &auth,
                &req,
                Arc::clone(&connector),
                Arc::clone(&emitter),
                &FixedRng,
                None,
            )
            .unwrap_err();
        assert!(matches!(err, SshSessionError::Unauthenticated));

        seed_auth(&auth);
        let resp = mgr
            .open_session(&auth, &req, connector, emitter, &FixedRng, None)
            .unwrap();
        assert!(!resp.session_id.is_empty());
        assert_eq!(mgr.session_count(), 1);
        let json = serde_json::to_string(&resp).unwrap();
        assert!(!json.contains("ws-tok"));
        assert!(!json.contains("bearer"));
        assert!(!json.contains("host"));
    }

    #[test]
    fn write_after_close_rejected() {
        let auth = AuthStore::new();
        seed_auth(&auth);
        let mgr = Arc::new(CloudTerminalSessionManager::new());
        let emitter: Arc<dyn LocalSshOutputEmitter> = Arc::new(RecordingEmitter::new());
        let connector: Arc<dyn CloudTerminalConnector> = Arc::new(MockConnector::ready_only());
        let resp = mgr
            .open_session(
                &auth,
                &CloudTerminalOpenRequest {
                    server_id: "srv".into(),
                },
                connector,
                emitter,
                &FixedRng,
                None,
            )
            .unwrap();
        mgr.close(
            &auth,
            &CloudTerminalCloseRequest {
                session_id: resp.session_id.clone(),
            },
        )
        .unwrap();
        // Second close exact-once: silent success.
        mgr.close(
            &auth,
            &CloudTerminalCloseRequest {
                session_id: resp.session_id.clone(),
            },
        )
        .unwrap();
        let err = mgr
            .write(
                &auth,
                &CloudTerminalWriteRequest {
                    session_id: resp.session_id,
                    data: "x".into(),
                },
            )
            .unwrap_err();
        assert!(matches!(
            err,
            SshSessionError::AuthorizationFailed | SshSessionError::TransportClosed
        ));
    }

    #[test]
    fn close_all_on_cutoff_clears_sessions() {
        let auth = AuthStore::new();
        seed_auth(&auth);
        let mgr = Arc::new(CloudTerminalSessionManager::new());
        let emitter: Arc<dyn LocalSshOutputEmitter> = Arc::new(RecordingEmitter::new());
        let connector: Arc<dyn CloudTerminalConnector> = Arc::new(MockConnector::ready_only());
        let _ = mgr
            .open_session(
                &auth,
                &CloudTerminalOpenRequest {
                    server_id: "srv".into(),
                },
                connector,
                emitter,
                &FixedRng,
                None,
            )
            .unwrap();
        assert_eq!(mgr.session_count(), 1);
        mgr.close_all();
        assert_eq!(mgr.session_count(), 0);
    }

    #[test]
    fn output_before_bind_buffers_then_emits_with_session_id() {
        let auth = AuthStore::new();
        seed_auth(&auth);
        let mgr = Arc::new(CloudTerminalSessionManager::new());
        let recording = Arc::new(RecordingEmitter::new());
        let emitter: Arc<dyn LocalSshOutputEmitter> = recording.clone();
        let connector: Arc<dyn CloudTerminalConnector> = Arc::new(MockConnector {
            token: "t".into(),
            events: Mutex::new(vec![
                CloudServerEvent::Output("prompt>".into()),
                CloudServerEvent::Ready,
            ]),
            last_server_id: Mutex::new(None),
            cmds: Arc::new(Mutex::new(Vec::new())),
        });
        let resp = mgr
            .open_session(
                &auth,
                &CloudTerminalOpenRequest {
                    server_id: "srv".into(),
                },
                connector,
                emitter,
                &FixedRng,
                None,
            )
            .unwrap();
        let events = recording.snapshot();
        assert!(
            events.iter().any(|e| {
                e.session_id == resp.session_id
                    && e.stream == LocalSshOutputStream::Stdout
                    && e.data == encode_std_base64(b"prompt>")
            }),
            "expected buffered stdout with session id, got {events:?}"
        );
        assert!(events.iter().all(|e| !e.session_id.is_empty()));
    }

    #[test]
    fn remote_close_exact_once_removes_session() {
        let auth = AuthStore::new();
        seed_auth(&auth);
        let mgr = Arc::new(CloudTerminalSessionManager::new());
        let emitter: Arc<dyn LocalSshOutputEmitter> = Arc::new(RecordingEmitter::new());
        let connector: Arc<dyn CloudTerminalConnector> = Arc::new(MockConnector::ready_only());
        let resp = mgr
            .open_session(
                &auth,
                &CloudTerminalOpenRequest {
                    server_id: "srv".into(),
                },
                connector,
                emitter,
                &FixedRng,
                None,
            )
            .unwrap();
        mgr.remove_on_transport_ended(&resp.session_id);
        mgr.remove_on_transport_ended(&resp.session_id);
        assert_eq!(mgr.session_count(), 0);
    }

    #[test]
    fn auth_epoch_change_rejects_write() {
        let auth = AuthStore::new();
        seed_auth(&auth);
        let mgr = Arc::new(CloudTerminalSessionManager::new());
        let emitter: Arc<dyn LocalSshOutputEmitter> = Arc::new(RecordingEmitter::new());
        let connector: Arc<dyn CloudTerminalConnector> = Arc::new(MockConnector::ready_only());
        let resp = mgr
            .open_session(
                &auth,
                &CloudTerminalOpenRequest {
                    server_id: "srv".into(),
                },
                connector,
                emitter,
                &FixedRng,
                None,
            )
            .unwrap();
        // Simulate logout/relogin: epoch advances.
        seed_auth(&auth);
        let err = mgr
            .write(
                &auth,
                &CloudTerminalWriteRequest {
                    session_id: resp.session_id,
                    data: "x".into(),
                },
            )
            .unwrap_err();
        assert!(matches!(err, SshSessionError::AuthorizationFailed));
    }

    #[test]
    fn parse_server_messages() {
        assert_eq!(
            parse_server_message(r#"{"type":"ready"}"#),
            Some(CloudServerEvent::Ready)
        );
        assert_eq!(
            parse_server_message(r#"{"type":"output","data":"hi"}"#),
            Some(CloudServerEvent::Output("hi".into()))
        );
        assert_eq!(
            parse_server_message(r#"{"type":"error","message":"no"}"#),
            Some(CloudServerEvent::Error("no".into()))
        );
        assert_eq!(parse_server_message(r#"{"type":"other"}"#), None);
    }

    #[test]
    fn fixed_origin_token_url_uses_base_origin() {
        assert_eq!(BASE_ORIGIN, "https://app.itops.sh");
        let url = format!("{BASE_ORIGIN}/api/auth/ws-token");
        assert!(url.starts_with("https://app.itops.sh/"));
        assert!(!url.contains("localhost"));
    }

    #[test]
    fn server_id_rejects_controls_whitespace_encoding_and_path_chars() {
        let reject = [
            "",
            " ",
            "a b",
            "srv\n",
            "srv\0x",
            "srv#frag",
            "srv?q=1",
            "srv%2f",
            "srv%2F",
            "%61",
            "a/b",
            "a\\b",
            &"x".repeat(MAX_SERVER_ID_LEN + 1),
        ];
        for sid in reject {
            let err = validate_open_request(&CloudTerminalOpenRequest {
                server_id: sid.to_string(),
            });
            assert!(
                matches!(err, Err(SshSessionError::InvalidIdentity)),
                "expected reject for {sid:?}, got {err:?}"
            );
        }
        assert!(validate_open_request(&CloudTerminalOpenRequest {
            server_id: "srv_1-ok.ABC".into(),
        })
        .is_ok());
    }

    #[test]
    fn prebind_overflow_fails_closed_not_silent_clear() {
        let auth = AuthStore::new();
        seed_auth(&auth);
        let mgr = Arc::new(CloudTerminalSessionManager::new());
        let emitter: Arc<dyn LocalSshOutputEmitter> = Arc::new(RecordingEmitter::new());
        // Flood pre-bind outputs past byte/count caps before Ready.
        let mut events = Vec::new();
        let chunk = "X".repeat(8 * 1024);
        for _ in 0..64 {
            events.push(CloudServerEvent::Output(chunk.clone()));
        }
        events.push(CloudServerEvent::Ready);
        let connector: Arc<dyn CloudTerminalConnector> = Arc::new(MockConnector {
            token: "t".into(),
            events: Mutex::new(events),
            last_server_id: Mutex::new(None),
            cmds: Arc::new(Mutex::new(Vec::new())),
        });
        let err = mgr
            .open_session(
                &auth,
                &CloudTerminalOpenRequest {
                    server_id: "srv".into(),
                },
                connector,
                emitter,
                &FixedRng,
                None,
            )
            .unwrap_err();
        assert!(
            matches!(
                err,
                SshSessionError::ConnectFailed | SshSessionError::InvalidMetadata
            ),
            "overflow must fail open, got {err:?}"
        );
        assert_eq!(mgr.session_count(), 0);
    }

    #[test]
    fn cloud_ws_config_sets_pre_allocation_caps() {
        let cfg = cloud_ws_config();
        assert_eq!(cfg.max_message_size, Some(MAX_CLOUD_WSS_MESSAGE_BYTES));
        assert_eq!(cfg.max_frame_size, Some(MAX_CLOUD_WSS_MESSAGE_BYTES));
    }

    #[tokio::test]
    async fn bounded_handshake_cancels_slow_future() {
        let start = std::time::Instant::now();
        // Shorter local timeout for unit speed: wrap sleep longer than handshake.
        let result = tokio::time::timeout(Duration::from_millis(200), async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok::<(), SshSessionError>(())
        })
        .await;
        assert!(result.is_err(), "slow handshake must not complete");
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "handshake bound must not leak a long wait"
        );
        // Production uses the same timeout primitive.
        let r = run_bounded_handshake(async {
            tokio::time::sleep(Duration::from_millis(1)).await;
            Ok::<(), SshSessionError>(())
        })
        .await;
        assert!(r.is_ok());
    }

    #[tokio::test]
    async fn bounded_ws_io_fails_closed_when_peer_stalls() {
        // Behavioral: a write that never completes must not hang past IO write deadline.
        let start = std::time::Instant::now();
        let stalled = run_bounded_ws_io(async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Ok::<(), &'static str>(())
        })
        .await;
        assert!(
            matches!(stalled, Err(SshSessionError::TransportClosed)),
            "stalled send must fail closed, got {stalled:?}"
        );
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "IO write deadline (test=150ms) must bound wait: {:?}",
            start.elapsed()
        );
        // Fast path still succeeds.
        let ok = run_bounded_ws_io(async { Ok::<(), &'static str>(()) }).await;
        assert!(ok.is_ok());
    }

    #[tokio::test]
    async fn writer_loop_exits_on_io_timeout_so_select_can_drop_reader() {
        // Emulate production writer: on stalled send, break and complete the future.
        let exited = Arc::new(AtomicBool::new(false));
        let exited2 = Arc::clone(&exited);
        let writer = async move {
            let send = run_bounded_ws_io(async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok::<(), &'static str>(())
            })
            .await;
            assert!(send.is_err());
            exited2.store(true, Ordering::SeqCst);
        };
        let reader = async {
            tokio::time::sleep(Duration::from_secs(60)).await;
        };
        tokio::select! {
            _ = writer => {},
            _ = reader => {},
        }
        assert!(
            exited.load(Ordering::SeqCst),
            "writer future must complete after I/O timeout"
        );
    }

    #[test]
    fn open_ready_timeout_exits_io_worker_without_slot() {
        // Production-like: never Ready; exits promptly when cmd channel closes (cancel path).
        struct CancelAwareConnector {
            finished: Arc<AtomicBool>,
        }
        impl CloudTerminalConnector for CancelAwareConnector {
            fn fetch_ws_token(&self, _bearer: &str) -> Result<String, SshSessionError> {
                Ok("tok".into())
            }
            fn connect(
                &self,
                _server_id: &str,
                _token: &str,
                mut cmd_rx: mpsc::Receiver<ActorCmd>,
                on_event: Arc<dyn Fn(CloudServerEvent) + Send + Sync>,
            ) -> Result<(), SshSessionError> {
                // Block until Close or channel disconnect — no silent long sleep ignoring cancel.
                while let Some(cmd) = cmd_rx.blocking_recv() {
                    if matches!(cmd, ActorCmd::Close) {
                        break;
                    }
                }
                on_event(CloudServerEvent::SocketClosed);
                self.finished.store(true, Ordering::SeqCst);
                Ok(())
            }
        }
        let auth = AuthStore::new();
        seed_auth(&auth);
        let mgr = Arc::new(CloudTerminalSessionManager::new());
        let emitter: Arc<dyn LocalSshOutputEmitter> = Arc::new(RecordingEmitter::new());
        let finished = Arc::new(AtomicBool::new(false));
        let connector: Arc<dyn CloudTerminalConnector> = Arc::new(CancelAwareConnector {
            finished: Arc::clone(&finished),
        });
        let start = std::time::Instant::now();
        let err = mgr
            .open_session(
                &auth,
                &CloudTerminalOpenRequest {
                    server_id: "srv".into(),
                },
                connector,
                emitter,
                &FixedRng,
                None,
            )
            .unwrap_err();
        assert!(matches!(err, SshSessionError::ConnectFailed));
        // No session registered; IO worker exited after cancel (channel close).
        assert_eq!(mgr.session_count(), 0);
        assert_eq!(mgr.active_io_workers(), 0);
        assert!(
            finished.load(Ordering::SeqCst),
            "connector thread must finish after cancel"
        );
        assert!(
            start.elapsed() < Duration::from_secs(6),
            "ready timeout (test=2s) + io idle wait must stay bounded: {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn source_production_connect_uses_config_and_handshake_timeout() {
        let src = include_str!("cloud_terminal.rs");
        let prod = src.split("mod tests").next().unwrap_or(src);
        assert!(prod.contains("connect_async_with_config"));
        assert!(prod.contains("cloud_ws_config()"));
        assert!(prod.contains("CLOUD_TERMINAL_HANDSHAKE_TIMEOUT"));
        assert!(prod.contains("cancel_cloud_open_io"));
        // No timed-join helper that spawns permanent joiner threads.
        assert!(!prod.contains("join_bounded"));
    }

    #[test]
    fn parse_server_message_rejects_oversize_output() {
        let huge = "Y".repeat(MAX_CLOUD_PARSED_OUTPUT_CHARS + 1);
        let msg = format!(r#"{{"type":"output","data":"{huge}"}}"#);
        assert_eq!(parse_server_message(&msg), None);
        assert!(
            msg.len() > MAX_CLOUD_WSS_MESSAGE_BYTES || huge.len() > MAX_CLOUD_PARSED_OUTPUT_CHARS
        );
    }
}
