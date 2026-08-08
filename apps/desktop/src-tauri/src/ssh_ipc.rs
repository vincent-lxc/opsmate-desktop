//! D4B2c — local SSH IPC orchestration (testable; Tauri commands stay thin).
//!
//! Trust order for open:
//! 1. [`prepare_local_ssh_open`] (auth snapshot + HTTPS metadata + binding)
//! 2. [`VaultService::lease_for_ssh`] (same principal + epoch + credential)
//! 3. [`RusshLeaseConnector`] (TOFU / cloud pin / isolated known-hosts)
//! 4. [`LocalSshSessionManager::open_session`] + secure RNG
//! 5. Bind pending output sink to `sessionId` (flush / early-Closed fail-closed)
//!
//! Terminal output is emitted **only** to the privileged `main` window via
//! [`LocalSshOutputEmitter`]. No tenant/user/server/credential/key/bearer fields.

use crate::auth::{AuthStore, RandomSource, SecRandomSource};
use crate::ssh_registry::{
    LocalSshCloseRequest, LocalSshConnector, LocalSshResizeRequest, LocalSshSessionManager,
    LocalSshWriteRequest,
};
use crate::ssh_session::{
    prepare_local_ssh_open, CloudHostKeyWriter, FsLocalKnownHosts, HostKeyConfirmer,
    LocalKnownHosts, LocalSshOpenRequest, LocalSshOpenResponse, NativeTofuConfirmer,
    PreparedSshTarget, ReqwestCloudHostKeyWriter, ReqwestServerMetadataClient,
    ServerMetadataClient, SshSessionError,
};
use crate::ssh_transport::{
    NullTerminalSink, RusshLeaseConnector, TerminalOutput, TerminalSink,
    MAX_TRANSPORT_RECORD_EVENTS,
};
use crate::vault::{VaultError, VaultService};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

/// Event name delivered to the main WebView only.
pub const LOCAL_SSH_OUTPUT_EVENT: &str = "local-ssh-output";

/// Max chunks buffered before session id bind (fail-closed on overflow).
pub const MAX_PENDING_SSH_OUTPUT: usize = MAX_TRANSPORT_RECORD_EVENTS;

// ─── Output event DTO (secret-free) ──────────────────────────────────────────

/// Stream kind for terminal output events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalSshOutputStream {
    Stdout,
    Stderr,
    Closed,
}

/// Payload: sessionId + stream + base64 data (empty when closed).
/// Never includes tenant/user/server/credential/key/bearer.
///
/// **Debug is redacted** — terminal bytes (passwords, tokens, logs) must never
/// appear in logs via `{:?}`; Serialize still carries base64 for WebView delivery.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSshOutputEvent {
    pub session_id: String,
    pub stream: LocalSshOutputStream,
    /// Standard base64 of binary payload; empty string for `closed`.
    pub data: String,
}

impl std::fmt::Debug for LocalSshOutputEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Opaque session id is fine (random base64url); never print payload contents.
        f.debug_struct("LocalSshOutputEvent")
            .field("session_id", &self.session_id)
            .field("stream", &self.stream)
            .field("data_b64_len", &self.data.len())
            .finish_non_exhaustive()
    }
}

impl LocalSshOutputEvent {
    pub fn from_output(session_id: &str, chunk: &TerminalOutput) -> Self {
        match chunk {
            TerminalOutput::Data(d) => Self {
                session_id: session_id.to_string(),
                stream: LocalSshOutputStream::Stdout,
                data: encode_std_base64(d),
            },
            TerminalOutput::ExtendedData { data, .. } => Self {
                session_id: session_id.to_string(),
                stream: LocalSshOutputStream::Stderr,
                data: encode_std_base64(data),
            },
            TerminalOutput::Closed => Self {
                session_id: session_id.to_string(),
                stream: LocalSshOutputStream::Closed,
                data: String::new(),
            },
        }
    }
}

/// Standard base64 (RFC 4648) with padding — no new dependency.
pub fn encode_std_base64(input: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(T[((n >> 6) & 63) as usize] as char);
        out.push(T[(n & 63) as usize] as char);
        i += 3;
    }
    match input.len() - i {
        1 => {
            let n = (input[i] as u32) << 16;
            out.push(T[((n >> 18) & 63) as usize] as char);
            out.push(T[((n >> 12) & 63) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
            out.push(T[((n >> 18) & 63) as usize] as char);
            out.push(T[((n >> 12) & 63) as usize] as char);
            out.push(T[((n >> 6) & 63) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

// ─── Emitter (main window only) ──────────────────────────────────────────────

/// Privileged main-window event delivery. Implementations must not broadcast.
pub trait LocalSshOutputEmitter: Send + Sync {
    fn emit_to_main(&self, event: &LocalSshOutputEvent) -> Result<(), SshSessionError>;
}

/// Recording emitter for unit tests.
#[derive(Default)]
pub struct RecordingEmitter {
    pub events: Mutex<Vec<LocalSshOutputEvent>>,
    pub fail_after: Mutex<Option<usize>>,
    /// When true, every emit fails closed.
    pub always_fail: AtomicBool,
    pub target_window: Mutex<String>,
}

impl RecordingEmitter {
    pub fn new() -> Self {
        Self {
            events: Mutex::new(Vec::new()),
            fail_after: Mutex::new(None),
            always_fail: AtomicBool::new(false),
            target_window: Mutex::new("main".into()),
        }
    }

    pub fn snapshot(&self) -> Vec<LocalSshOutputEvent> {
        self.events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

impl LocalSshOutputEmitter for RecordingEmitter {
    fn emit_to_main(&self, event: &LocalSshOutputEvent) -> Result<(), SshSessionError> {
        if self.always_fail.load(Ordering::SeqCst) {
            return Err(SshSessionError::Internal);
        }
        let mut g = self.events.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(limit) = *self.fail_after.lock().unwrap_or_else(|e| e.into_inner()) {
            if g.len() >= limit {
                return Err(SshSessionError::Internal);
            }
        }
        // Prove targeting contract in tests: only "main".
        let win = self
            .target_window
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if win != "main" {
            return Err(SshSessionError::Internal);
        }
        g.push(event.clone());
        Ok(())
    }
}

// ─── Pending / bound terminal sink ───────────────────────────────────────────

enum SinkPhase {
    /// Connect may emit before session id exists.
    Pending {
        queue: VecDeque<TerminalOutput>,
        saw_closed: bool,
        failed: bool,
    },
    /// Flushing pending under bind; concurrent live output goes to `deferred`
    /// so emitted order stays linearizable (pending first, then deferred).
    Binding {
        session_id: String,
        flush: VecDeque<TerminalOutput>,
        deferred: VecDeque<TerminalOutput>,
        saw_closed: bool,
    },
    Bound {
        session_id: String,
    },
    /// Overflow or emit failure — drop further output.
    Failed,
}

/// Session-ended callback (session id).
type OnEndedCb = Arc<dyn Fn(&str) + Send + Sync>;

/// Bounded pending sink: buffer until bind, flush in order, fail closed.
pub struct IpcTerminalSink {
    phase: Mutex<SinkPhase>,
    emitter: Arc<dyn LocalSshOutputEmitter>,
    /// Called at most once on Closed / post-bind emit failure (session teardown).
    on_ended: Mutex<Option<OnEndedCb>>,
    closed_emitted: AtomicBool,
    ended_once: AtomicBool,
}

impl IpcTerminalSink {
    pub fn new(emitter: Arc<dyn LocalSshOutputEmitter>) -> Arc<Self> {
        Arc::new(Self {
            phase: Mutex::new(SinkPhase::Pending {
                queue: VecDeque::new(),
                saw_closed: false,
                failed: false,
            }),
            emitter,
            on_ended: Mutex::new(None),
            closed_emitted: AtomicBool::new(false),
            ended_once: AtomicBool::new(false),
        })
    }

    pub fn set_transport_ended_handler(&self, handler: Arc<dyn Fn(&str) + Send + Sync>) {
        *self.on_ended.lock().unwrap_or_else(|e| e.into_inner()) = Some(handler);
    }

    fn invoke_ended_once(&self, session_id: &str) {
        if self.ended_once.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(h) = self
            .on_ended
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            h(session_id);
        }
    }

    /// Returns `Ok(true)` when this call delivered a first-time Closed.
    fn emit_one(&self, session_id: &str, chunk: &TerminalOutput) -> Result<bool, SshSessionError> {
        if matches!(chunk, TerminalOutput::Closed)
            && self.closed_emitted.swap(true, Ordering::SeqCst)
        {
            return Ok(false);
        }
        let ev = LocalSshOutputEvent::from_output(session_id, chunk);
        self.emitter.emit_to_main(&ev)?;
        Ok(matches!(chunk, TerminalOutput::Closed))
    }

    fn mark_failed(&self) {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = SinkPhase::Failed;
    }

    /// Bind session id after registry insert. Flushes pending output in order.
    ///
    /// Uses a `Binding` phase so concurrent `on_output` cannot overtake the
    /// pending flush (linearizable: pending then deferred). Exactly-once bind.
    pub fn bind(&self, session_id: &str) -> Result<BindOutcome, SshSessionError> {
        if session_id.trim().is_empty() {
            return Err(SshSessionError::InvalidIdentity);
        }
        {
            let mut phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
            match &mut *phase {
                SinkPhase::Pending {
                    queue,
                    saw_closed,
                    failed,
                } => {
                    if *failed {
                        *phase = SinkPhase::Failed;
                        return Err(SshSessionError::Internal);
                    }
                    let flush = std::mem::take(queue);
                    let early = *saw_closed;
                    *phase = SinkPhase::Binding {
                        session_id: session_id.to_string(),
                        flush,
                        deferred: VecDeque::new(),
                        saw_closed: early,
                    };
                }
                // Exactly-once: already binding/bound/failed.
                SinkPhase::Binding { .. } | SinkPhase::Bound { .. } | SinkPhase::Failed => {
                    return Err(SshSessionError::Internal);
                }
            }
        }

        let mut delivered_closed = false;
        loop {
            enum Step {
                Emit(TerminalOutput),
                Done { early_closed: bool },
                Abort,
            }
            let step = {
                let mut phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
                match &mut *phase {
                    SinkPhase::Binding {
                        flush,
                        deferred,
                        session_id: sid,
                        saw_closed,
                    } => {
                        if let Some(chunk) = flush.pop_front() {
                            Step::Emit(chunk)
                        } else if let Some(chunk) = deferred.pop_front() {
                            Step::Emit(chunk)
                        } else {
                            let early = *saw_closed;
                            *phase = SinkPhase::Bound {
                                session_id: sid.clone(),
                            };
                            Step::Done {
                                early_closed: early,
                            }
                        }
                    }
                    SinkPhase::Failed => Step::Abort,
                    _ => Step::Abort,
                }
            };
            match step {
                Step::Emit(chunk) => match self.emit_one(session_id, &chunk) {
                    Ok(true) => delivered_closed = true,
                    Ok(false) => {}
                    Err(e) => {
                        // Flush failure: open path removes session (zero leak).
                        self.mark_failed();
                        return Err(e);
                    }
                },
                Step::Done { early_closed } => {
                    if early_closed || delivered_closed {
                        self.invoke_ended_once(session_id);
                        return Ok(BindOutcome::ClosedDuringConnect);
                    }
                    return Ok(BindOutcome::Ready);
                }
                Step::Abort => return Err(SshSessionError::Internal),
            }
        }
    }

    pub fn is_failed(&self) -> bool {
        matches!(
            *self.phase.lock().unwrap_or_else(|e| e.into_inner()),
            SinkPhase::Failed
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindOutcome {
    Ready,
    /// Remote Closed (or local) arrived before/during bind; session must not leak.
    ClosedDuringConnect,
}

impl TerminalSink for IpcTerminalSink {
    fn on_output(&self, chunk: TerminalOutput) {
        let mut phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *phase {
            SinkPhase::Pending {
                queue,
                saw_closed,
                failed,
            } => {
                if *failed {
                    return;
                }
                if queue.len() >= MAX_PENDING_SSH_OUTPUT {
                    *failed = true;
                    *phase = SinkPhase::Failed;
                    return;
                }
                if matches!(chunk, TerminalOutput::Closed) {
                    *saw_closed = true;
                }
                queue.push_back(chunk);
            }
            SinkPhase::Binding {
                flush,
                deferred,
                saw_closed,
                ..
            } => {
                // Keep bounded; do not emit while Binding (preserve flush order).
                if flush.len().saturating_add(deferred.len()) >= MAX_PENDING_SSH_OUTPUT {
                    *phase = SinkPhase::Failed;
                    return;
                }
                if matches!(chunk, TerminalOutput::Closed) {
                    *saw_closed = true;
                }
                deferred.push_back(chunk);
            }
            SinkPhase::Bound { session_id } => {
                let sid = session_id.clone();
                drop(phase);
                match self.emit_one(&sid, &chunk) {
                    Ok(true) => self.invoke_ended_once(&sid),
                    Ok(false) => {}
                    Err(_) => {
                        // Post-bind emit failure: fail closed + tear down session once.
                        self.mark_failed();
                        self.invoke_ended_once(&sid);
                    }
                }
            }
            SinkPhase::Failed => {}
        }
    }
}

// ─── Error mapping ───────────────────────────────────────────────────────────

pub fn map_ssh_user(err: SshSessionError) -> String {
    err.user_message()
}

pub fn vault_error_to_ssh(err: VaultError) -> SshSessionError {
    match err {
        VaultError::Unauthenticated | VaultError::InvalidIdentity => {
            SshSessionError::Unauthenticated
        }
        VaultError::Locked | VaultError::NotInitialized => SshSessionError::AuthorizationFailed,
        VaultError::NotFound => SshSessionError::AuthorizationFailed,
        VaultError::InvalidPrivateKey => SshSessionError::AuthenticationFailed,
        VaultError::PromptCancelled | VaultError::PromptFailed => {
            SshSessionError::AuthorizationFailed
        }
        _ => SshSessionError::Internal,
    }
}

// ─── Open orchestration ──────────────────────────────────────────────────────

/// Steps recorded for order proofs in tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalSshOpenStep {
    Prepare,
    Lease,
    ConnectRegister,
    BindSink,
}

/// Injectable open stages (production uses vault + russh; tests use mocks).
pub trait LocalSshOpenDriver: Send {
    fn prepare(
        &mut self,
        auth: &AuthStore,
        req: &LocalSshOpenRequest,
    ) -> Result<PreparedSshTarget, SshSessionError>;

    fn lease(
        &mut self,
        auth: &AuthStore,
        target: &PreparedSshTarget,
    ) -> Result<(), SshSessionError>;

    fn connector(
        &mut self,
        sink: Arc<dyn TerminalSink>,
    ) -> Result<Box<dyn LocalSshConnector>, SshSessionError>;
}

/// Core open path used by production and tests (exact trust order).
pub fn perform_local_ssh_open_with_driver(
    auth: &AuthStore,
    sessions: &LocalSshSessionManager,
    req: &LocalSshOpenRequest,
    driver: &mut dyn LocalSshOpenDriver,
    sink: Arc<IpcTerminalSink>,
    rng: &dyn RandomSource,
    steps: &mut Vec<LocalSshOpenStep>,
) -> Result<LocalSshOpenResponse, SshSessionError> {
    // Wire transport-ended removal without actor self-join (Weak avoids cycles).
    // Caller should have set handler; production sets it before this call.

    steps.push(LocalSshOpenStep::Prepare);
    let target = driver.prepare(auth, req)?;

    // Epoch revalidation before lease.
    if !auth.session_binding_current(&target.principal, target.session_epoch) {
        return Err(SshSessionError::AuthorizationFailed);
    }

    steps.push(LocalSshOpenStep::Lease);
    driver.lease(auth, &target)?;

    if !auth.session_binding_current(&target.principal, target.session_epoch) {
        return Err(SshSessionError::AuthorizationFailed);
    }

    steps.push(LocalSshOpenStep::ConnectRegister);
    let connector = driver.connector(sink.clone() as Arc<dyn TerminalSink>)?;
    let resp = sessions.open_session(auth, &target, connector.as_ref(), rng)?;

    steps.push(LocalSshOpenStep::BindSink);
    match sink.bind(&resp.session_id) {
        Ok(BindOutcome::Ready) => Ok(resp),
        Ok(BindOutcome::ClosedDuringConnect) => {
            // Handler may already have removed; ensure zero leak.
            sessions.remove_on_transport_ended(&resp.session_id);
            Err(SshSessionError::TransportClosed)
        }
        Err(e) => {
            // Overflow / emit failure after register — no session leak.
            sessions.remove_on_transport_ended(&resp.session_id);
            Err(e)
        }
    }
}

/// Production driver: metadata client + vault lease + russh connector.
pub struct ProductionOpenDriver {
    meta: Box<dyn ServerMetadataClient>,
    vault: Arc<VaultService>,
    auth: Arc<AuthStore>,
    confirmer: Arc<dyn HostKeyConfirmer>,
    cloud: Arc<dyn CloudHostKeyWriter>,
    local_kh: Arc<dyn LocalKnownHosts>,
    lease: Mutex<Option<crate::vault::VaultCredentialLease>>,
}

impl ProductionOpenDriver {
    pub fn new(vault: Arc<VaultService>, auth: Arc<AuthStore>, app_data: impl AsRef<Path>) -> Self {
        Self {
            meta: Box::new(ReqwestServerMetadataClient::new()),
            vault,
            auth,
            confirmer: Arc::new(NativeTofuConfirmer),
            cloud: Arc::new(ReqwestCloudHostKeyWriter::new()),
            local_kh: Arc::new(FsLocalKnownHosts::under_app_data(app_data)),
            lease: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub fn with_meta(
        vault: Arc<VaultService>,
        auth: Arc<AuthStore>,
        meta: Box<dyn ServerMetadataClient>,
        app_data: impl AsRef<Path>,
    ) -> Self {
        let mut d = Self::new(vault, auth, app_data);
        d.meta = meta;
        d
    }
}

impl LocalSshOpenDriver for ProductionOpenDriver {
    fn prepare(
        &mut self,
        auth: &AuthStore,
        req: &LocalSshOpenRequest,
    ) -> Result<PreparedSshTarget, SshSessionError> {
        prepare_local_ssh_open(auth, req, self.meta.as_ref())
    }

    fn lease(
        &mut self,
        auth: &AuthStore,
        target: &PreparedSshTarget,
    ) -> Result<(), SshSessionError> {
        let lease = self
            .vault
            .lease_for_ssh(
                auth,
                &target.principal,
                target.session_epoch,
                &target.credential_id,
            )
            .map_err(vault_error_to_ssh)?;
        *self.lease.lock().unwrap_or_else(|e| e.into_inner()) = Some(lease);
        Ok(())
    }

    fn connector(
        &mut self,
        sink: Arc<dyn TerminalSink>,
    ) -> Result<Box<dyn LocalSshConnector>, SshSessionError> {
        let lease = self
            .lease
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .ok_or(SshSessionError::Internal)?;
        Ok(Box::new(RusshLeaseConnector::new(
            lease,
            Arc::clone(&self.auth),
            Arc::clone(&self.confirmer),
            Arc::clone(&self.cloud),
            Arc::clone(&self.local_kh),
            sink,
        )))
    }
}

/// Full production open (blocking — call from `spawn_blocking` only).
pub fn perform_local_ssh_open(
    auth: Arc<AuthStore>,
    vault: Arc<VaultService>,
    sessions: Arc<LocalSshSessionManager>,
    req: LocalSshOpenRequest,
    app_data: PathBuf,
    emitter: Arc<dyn LocalSshOutputEmitter>,
) -> Result<LocalSshOpenResponse, SshSessionError> {
    let sink = IpcTerminalSink::new(emitter);
    let sessions_w: Weak<LocalSshSessionManager> = Arc::downgrade(&sessions);
    sink.set_transport_ended_handler(Arc::new(move |sid: &str| {
        if let Some(mgr) = sessions_w.upgrade() {
            mgr.remove_on_transport_ended(sid);
        }
    }));

    let mut driver = ProductionOpenDriver::new(vault, Arc::clone(&auth), app_data);
    let mut steps = Vec::new();
    let rng = SecRandomSource;
    perform_local_ssh_open_with_driver(
        auth.as_ref(),
        sessions.as_ref(),
        &req,
        &mut driver,
        sink,
        &rng,
        &mut steps,
    )
}

pub fn perform_local_ssh_write(
    auth: &AuthStore,
    sessions: &LocalSshSessionManager,
    req: &LocalSshWriteRequest,
) -> Result<(), SshSessionError> {
    sessions.write(auth, req)
}

pub fn perform_local_ssh_resize(
    auth: &AuthStore,
    sessions: &LocalSshSessionManager,
    req: &LocalSshResizeRequest,
) -> Result<(), SshSessionError> {
    sessions.resize(auth, req)
}

pub fn perform_local_ssh_close(
    auth: &AuthStore,
    sessions: &LocalSshSessionManager,
    req: &LocalSshCloseRequest,
) -> Result<(), SshSessionError> {
    sessions.close(auth, req)
}

/// Null sink helper for tests that do not care about output.
#[allow(dead_code)]
pub fn null_sink() -> Arc<dyn TerminalSink> {
    Arc::new(NullTerminalSink)
}

#[cfg(test)]
#[path = "ssh_ipc_tests.rs"]
mod tests;
