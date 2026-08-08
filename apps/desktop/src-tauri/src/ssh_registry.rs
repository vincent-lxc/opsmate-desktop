//! D4B1 — local SSH session registry (no real russh network).
//!
//! Lifecycle generation barrier + concurrent-close transports (`&self` close signal).
//! Registry mutex is never held during connector/transport I/O or transport.close.

use crate::auth::{base64url_nopad, AuthStore, NativePrincipal, RandomSource};
use crate::ssh_session::{LocalSshOpenResponse, PreparedSshTarget, SshSessionError};
use crate::vault::SessionLifecycleSink;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Max terminal write payload (bytes).
pub const MAX_SSH_WRITE_BYTES: usize = 64 * 1024;
/// Inclusive terminal size bounds.
pub const MIN_SSH_TERM_DIM: u32 = 1;
pub const MAX_SSH_TERM_DIM: u32 = 1000;
const SESSION_ID_RANDOM_BYTES: usize = 32;
const SESSION_ID_MAX_ATTEMPTS: usize = 16;

// ─── Strict IPC DTOs ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalSshWriteRequest {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalSshResizeRequest {
    pub session_id: String,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalSshCloseRequest {
    pub session_id: String,
}

// ─── Transport / connector (mockable; no real network in D4B1) ───────────────

/// Transport is shareable: `close` is a prompt concurrent signal (not serialized behind write).
/// D4B2 russh will map this to an actor/channel stop message.
pub trait LocalSshTransport: Send + Sync {
    fn write(&self, data: &[u8]) -> Result<(), SshSessionError>;
    fn resize(&self, cols: u32, rows: u32) -> Result<(), SshSessionError>;
    /// Idempotent; safe concurrent with write/resize. Must return only after close is recorded.
    fn close(&self) -> Result<(), SshSessionError>;
}

/// Connect after policy + lease; failures must not register a session.
pub trait LocalSshConnector: Send + Sync {
    fn connect(
        &self,
        target: &PreparedSshTarget,
    ) -> Result<Arc<dyn LocalSshTransport>, SshSessionError>;
}

// ─── Session id ──────────────────────────────────────────────────────────────

/// 32 random bytes → base64url; no timestamp/counter. Retries on collision.
pub fn generate_session_id(
    rng: &dyn RandomSource,
    existing: &impl Fn(&str) -> bool,
) -> Result<String, SshSessionError> {
    for _ in 0..SESSION_ID_MAX_ATTEMPTS {
        let mut buf = [0u8; SESSION_ID_RANDOM_BYTES];
        rng.fill_bytes(&mut buf)
            .map_err(|_| SshSessionError::Internal)?;
        let id = base64url_nopad(&buf);
        buf.fill(0);
        if !existing(&id) {
            return Ok(id);
        }
    }
    Err(SshSessionError::Internal)
}

pub fn validate_write_request(req: &LocalSshWriteRequest) -> Result<(), SshSessionError> {
    if req.session_id.trim().is_empty() {
        return Err(SshSessionError::InvalidIdentity);
    }
    if req.data.len() > MAX_SSH_WRITE_BYTES {
        return Err(SshSessionError::InvalidMetadata);
    }
    Ok(())
}

pub fn validate_resize_request(req: &LocalSshResizeRequest) -> Result<(), SshSessionError> {
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

// ─── Registry ────────────────────────────────────────────────────────────────

struct SessionSlot {
    principal: NativePrincipal,
    epoch: u64,
    server_id: String,
    credential_id: String,
    generation: u64,
    /// Lifecycle/explicit close requested; I/O must fail closed.
    dead: AtomicBool,
    /// Ensures transport.close is invoked exactly once for this slot.
    close_invoked: AtomicBool,
    transport: Arc<dyn LocalSshTransport>,
}

struct RegistryInner {
    /// Bumped on every close_all — open tickets with older generation cannot insert.
    generation: u64,
    sessions: HashMap<String, Arc<SessionSlot>>,
    /// Principal+credential invalidation epochs.
    cred_epoch: HashMap<(String, String, String), u64>,
}

impl RegistryInner {
    fn new() -> Self {
        Self {
            generation: 0,
            sessions: HashMap::new(),
            cred_epoch: HashMap::new(),
        }
    }

    fn cred_key(p: &NativePrincipal, credential_id: &str) -> (String, String, String) {
        (
            p.tenant_id.clone(),
            p.user_id.clone(),
            credential_id.to_string(),
        )
    }

    fn cred_epoch_of(&self, p: &NativePrincipal, credential_id: &str) -> u64 {
        self.cred_epoch
            .get(&Self::cred_key(p, credential_id))
            .copied()
            .unwrap_or(0)
    }
}

pub struct LocalSshSessionManager {
    inner: Mutex<RegistryInner>,
}

impl Default for LocalSshSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalSshSessionManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RegistryInner::new()),
        }
    }

    pub fn session_count(&self) -> usize {
        self.lock_inner().map(|g| g.sessions.len()).unwrap_or(0)
    }

    /// Open after connector success only. Response is `{ sessionId }` only.
    pub fn open_session(
        &self,
        auth: &AuthStore,
        target: &PreparedSshTarget,
        connector: &dyn LocalSshConnector,
        rng: &dyn RandomSource,
    ) -> Result<LocalSshOpenResponse, SshSessionError> {
        if !auth.session_binding_current(&target.principal, target.session_epoch) {
            return Err(SshSessionError::AuthorizationFailed);
        }

        let (gen_ticket, cred_ticket) = {
            let inner = self.lock_inner()?;
            (
                inner.generation,
                inner.cred_epoch_of(&target.principal, &target.credential_id),
            )
        };

        // Connect **outside** registry mutex.
        let transport = connector.connect(target)?;

        if !auth.session_binding_current(&target.principal, target.session_epoch) {
            let _ = transport.close();
            return Err(SshSessionError::AuthorizationFailed);
        }

        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(_poison) => {
                // Never leak a live transport after connector success.
                let _ = transport.close();
                return Err(SshSessionError::Internal);
            }
        };
        if inner.generation != gen_ticket
            || inner.cred_epoch_of(&target.principal, &target.credential_id) != cred_ticket
        {
            drop(inner);
            let _ = transport.close();
            return Err(SshSessionError::AuthorizationFailed);
        }

        let session_id = match generate_session_id(rng, &|id| inner.sessions.contains_key(id)) {
            Ok(id) => id,
            Err(e) => {
                drop(inner);
                let _ = transport.close();
                return Err(e);
            }
        };
        let slot = Arc::new(SessionSlot {
            principal: target.principal.clone(),
            epoch: target.session_epoch,
            server_id: target.server_id.clone(),
            credential_id: target.credential_id.clone(),
            generation: gen_ticket,
            dead: AtomicBool::new(false),
            close_invoked: AtomicBool::new(false),
            transport,
        });
        inner.sessions.insert(session_id.clone(), slot);
        Ok(LocalSshOpenResponse { session_id })
    }

    pub fn write(
        &self,
        auth: &AuthStore,
        req: &LocalSshWriteRequest,
    ) -> Result<(), SshSessionError> {
        validate_write_request(req)?;
        let slot = self.lookup_slot(&req.session_id)?;
        self.io_with_revalidation(auth, &slot, &req.session_id, |t| {
            t.write(req.data.as_bytes())
        })
    }

    pub fn resize(
        &self,
        auth: &AuthStore,
        req: &LocalSshResizeRequest,
    ) -> Result<(), SshSessionError> {
        validate_resize_request(req)?;
        let slot = self.lookup_slot(&req.session_id)?;
        self.io_with_revalidation(auth, &slot, &req.session_id, |t| {
            t.resize(req.cols, req.rows)
        })
    }

    /// Idempotent close bound to current auth.
    ///
    /// Only removes a slot when its stored principal+epoch still matches `auth`
    /// (`session_binding_current`). Unknown session ids and foreign/stale bindings
    /// are a silent success (non-enumerating: no existence leak, no cross-tenant close).
    pub fn close(
        &self,
        auth: &AuthStore,
        req: &LocalSshCloseRequest,
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
                // Unknown id — no-op success (non-enumeration).
                return Ok(());
            };
            if !auth.session_binding_current(&existing.principal, existing.epoch) {
                // Foreign tenant or stale epoch — do not remove; no-op success.
                return Ok(());
            }
            inner.sessions.remove(&req.session_id)
        };
        if let Some(slot) = slot {
            close_slot_transport(&slot);
        }
        Ok(())
    }

    /// Transport ended or IPC sink fail-closed: remove **exact** session only.
    /// Non-public / no WebView surface — IPC orchestration only.
    ///
    /// Never calls `transport.close()` on the calling thread (may be the actor /
    /// sink callback thread — would self-join). Marks dead + close_invoked, then
    /// a **bounded helper thread** performs prompt `transport.close()` exactly
    /// once (if not already closed) and drops the slot.
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
            slot.dead.store(true, Ordering::SeqCst);
            // First closer wins; later close_slot_transport / second remove are no-ops.
            let should_close = !slot.close_invoked.swap(true, Ordering::SeqCst);
            std::thread::Builder::new()
                .name("ssh-transport-ended".into())
                .spawn(move || {
                    if should_close {
                        let _ = slot.transport.close();
                    }
                    drop(slot);
                })
                .ok();
        }
    }

    /// Drain all sessions, then **synchronously** invoke transport.close for each (outside registry lock).
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
            close_slot_transport(&slot);
        }
    }

    /// Close sessions for **exact** principal + credential_id only (tenant isolation).
    pub fn close_for_principal_credential(&self, principal: &NativePrincipal, credential_id: &str) {
        let drained = {
            let mut inner = match self.inner.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let key = RegistryInner::cred_key(principal, credential_id);
            let e = inner.cred_epoch.entry(key).or_insert(0);
            *e = e.wrapping_add(1);

            let keys: Vec<String> = inner
                .sessions
                .iter()
                .filter(|(_, s)| s.principal == *principal && s.credential_id == credential_id)
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter()
                .filter_map(|k| inner.sessions.remove(&k))
                .collect::<Vec<_>>()
        };
        for slot in drained {
            close_slot_transport(&slot);
        }
    }

    fn lookup_slot(&self, session_id: &str) -> Result<Arc<SessionSlot>, SshSessionError> {
        let inner = self.lock_inner()?;
        inner
            .sessions
            .get(session_id)
            .cloned()
            .ok_or(SshSessionError::AuthorizationFailed)
    }

    fn io_with_revalidation(
        &self,
        auth: &AuthStore,
        slot: &Arc<SessionSlot>,
        session_id: &str,
        f: impl FnOnce(&dyn LocalSshTransport) -> Result<(), SshSessionError>,
    ) -> Result<(), SshSessionError> {
        // Before I/O.
        if slot.dead.load(Ordering::SeqCst)
            || !auth.session_binding_current(&slot.principal, slot.epoch)
        {
            self.remove_and_close_id(session_id);
            return Err(SshSessionError::AuthorizationFailed);
        }

        // I/O without registry mutex; close can run concurrently via Arc.
        let result = f(slot.transport.as_ref());

        // After I/O.
        if slot.dead.load(Ordering::SeqCst)
            || !auth.session_binding_current(&slot.principal, slot.epoch)
        {
            // Transport already closed by lifecycle (or we close if remove still needed).
            self.remove_and_close_id(session_id);
            return Err(SshSessionError::AuthorizationFailed);
        }
        result
    }

    fn remove_and_close_id(&self, session_id: &str) {
        let slot = {
            let mut inner = match self.inner.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            inner.sessions.remove(session_id)
        };
        if let Some(slot) = slot {
            close_slot_transport(&slot);
        } else {
            // Already drained by lifecycle — close was invoked there.
        }
    }

    fn lock_inner(&self) -> Result<std::sync::MutexGuard<'_, RegistryInner>, SshSessionError> {
        self.inner.lock().map_err(|_| SshSessionError::Internal)
    }
}

/// Synchronously invoke transport.close exactly once for the slot.
fn close_slot_transport(slot: &SessionSlot) {
    slot.dead.store(true, Ordering::SeqCst);
    if slot.close_invoked.swap(true, Ordering::SeqCst) {
        return;
    }
    // Concurrent with write/resize — transport close is a prompt signal on &self.
    let _ = slot.transport.close();
}

impl SessionLifecycleSink for LocalSshSessionManager {
    fn close_all_sessions(&self) {
        self.close_all();
    }

    fn close_sessions_for_credential(&self, principal: &NativePrincipal, credential_id: &str) {
        self.close_for_principal_credential(principal, credential_id);
    }
}

#[cfg(test)]
#[path = "ssh_registry_tests.rs"]
mod tests;
