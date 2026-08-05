//! Local SSH session authority / registry (Task 8B2).
//!
//! Two-phase registration for future 8B3 connectors:
//!   1. [`LocalSshSessionManager::begin_establishment`] — live checks + sealed ticket
//!   2. [`LocalSshSessionManager::complete_established`] — verify ticket, register close handle
//!
//! Integrates with [`crate::vault::SessionLifecycleSink`] so vault seal/delete closes
//! sessions before Stronghold lock.
//!
//! **Non-claims:** no russh network connection, no TOFU UI, no Tauri SSH IPC.

// Production: attach + sink; full registry API reserved for 8B3 (unit-tested).
#![cfg_attr(not(test), allow(dead_code))]

use super::prepare::{LocalSshConnectAuthority, LocalSshError, LocalSshOpenRequest};
use crate::auth::{base64url_nopad, AuthBinding, AuthStore, NativePrincipal, RandomSource};
use crate::security_cutoff::SecurityCutoff;
use crate::vault::{validate_id, SessionLifecycleSink, VaultService};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Max attempts to mint a unique 32-byte session id (no overwrite on collision).
const MAX_SESSION_ID_ATTEMPTS: usize = 8;

/// Opaque session id generated only by the manager (never caller-supplied).
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct LocalSshSessionId(String);

impl LocalSshSessionId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for LocalSshSessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LocalSshSessionId(<redacted>)")
    }
}

/// Close capability for an established transport. Invoked **outside** the registry mutex.
pub trait SessionCloseHandle: Send + Sync {
    /// Called at most once after removal or rejected complete.
    fn on_close(&self);
}

/// Secret-free session list item for the current principal+epoch only.
#[derive(Clone, PartialEq, Eq)]
#[allow(dead_code)] // list_for_current reserved for 8B3 IPC
pub struct LocalSshSessionMeta {
    pub session_id: LocalSshSessionId,
    pub server_id: String,
    pub credential_id: String,
}

impl std::fmt::Debug for LocalSshSessionMeta {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalSshSessionMeta")
            .field("session_id", &"<redacted>")
            .field("server_id", &"<redacted>")
            .field("credential_id", &"<redacted>")
            .finish()
    }
}

/// Per-credential invalidation key: tenant + Logto subject + credential_id.
#[derive(Clone, PartialEq, Eq, Hash)]
struct CredentialKey {
    tenant_id: String,
    subject: String,
    credential_id: String,
}

impl CredentialKey {
    fn from_principal(p: &NativePrincipal, credential_id: &str) -> Self {
        Self {
            tenant_id: p.tenant_id.clone(),
            subject: p.subject.clone(),
            credential_id: credential_id.to_string(),
        }
    }
}

/// Sealed crate-internal ticket from [`LocalSshSessionManager::begin_establishment`].
/// Not Serialize; consumed once by `complete_established`. Debug redacts identity.
pub struct LocalSshRegistrationTicket {
    principal: NativePrincipal,
    auth_epoch: u64,
    server_id: String,
    credential_id: String,
    prepared_ssh_generation: u64,
    registry_global_generation: u64,
    credential_invalidation_epoch: u64,
}

/// Secret-free barrier snapshot for mid-handshake revalidation (TOFU post-cloud).
/// Cloneable so the handshake can revalidate while the ticket is still held for complete.
#[derive(Clone)]
pub struct TicketBarrierSnapshot {
    pub principal: NativePrincipal,
    /// Captured for future barrier equality / audit; revalidation uses gen epochs today.
    #[allow(dead_code)]
    pub auth_epoch: u64,
    /// Captured for future barrier equality / audit; revalidation uses gen epochs today.
    #[allow(dead_code)]
    pub server_id: String,
    pub credential_id: String,
    pub prepared_ssh_generation: u64,
    pub registry_global_generation: u64,
    pub credential_invalidation_epoch: u64,
}

impl LocalSshRegistrationTicket {
    /// Capture barriers for handshake revalidation without consuming the ticket.
    pub fn barrier_snapshot(&self) -> TicketBarrierSnapshot {
        TicketBarrierSnapshot {
            principal: self.principal.clone(),
            auth_epoch: self.auth_epoch,
            server_id: self.server_id.clone(),
            credential_id: self.credential_id.clone(),
            prepared_ssh_generation: self.prepared_ssh_generation,
            registry_global_generation: self.registry_global_generation,
            credential_invalidation_epoch: self.credential_invalidation_epoch,
        }
    }
}

impl std::fmt::Debug for LocalSshRegistrationTicket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalSshRegistrationTicket")
            .field("principal", &"<redacted>")
            .field("auth_epoch", &"<redacted>")
            .field("server_id", &"<redacted>")
            .field("credential_id", &"<redacted>")
            .field("prepared_ssh_generation", &self.prepared_ssh_generation)
            .field(
                "registry_global_generation",
                &self.registry_global_generation,
            )
            .field(
                "credential_invalidation_epoch",
                &self.credential_invalidation_epoch,
            )
            .finish()
    }
}

impl std::fmt::Debug for TicketBarrierSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TicketBarrierSnapshot")
            .field("principal", &"<redacted>")
            .field("auth_epoch", &"<redacted>")
            .field("server_id", &"<redacted>")
            .field("credential_id", &"<redacted>")
            .field("prepared_ssh_generation", &self.prepared_ssh_generation)
            .field(
                "registry_global_generation",
                &self.registry_global_generation,
            )
            .field(
                "credential_invalidation_epoch",
                &self.credential_invalidation_epoch,
            )
            .finish()
    }
}

struct SessionRecord {
    principal: NativePrincipal,
    epoch: u64,
    server_id: String,
    credential_id: String,
    ssh_generation: u64,
    /// Barriers at registration (for stale detection vs later close_all / per-cred close).
    registered_global_generation: u64,
    registered_credential_epoch: u64,
    #[allow(dead_code)] // retained for identity / future status IPC
    session_id: LocalSshSessionId,
    close: Arc<dyn SessionCloseHandle>,
}

struct RegistryInner {
    sessions: HashMap<String, SessionRecord>,
    /// Bumped by `close_all_sessions` before drain.
    global_generation: u64,
    /// Bumped by `close_sessions_for_credential` for that exact key before drain.
    credential_epochs: HashMap<CredentialKey, u64>,
}

/// Thread-safe registry of local SSH session authority (not network state).
pub struct LocalSshSessionManager {
    auth: Arc<AuthStore>,
    vault: Arc<VaultService>,
    cutoff: Arc<SecurityCutoff>,
    inner: Mutex<RegistryInner>,
    rng: Arc<dyn RandomSource>,
    /// Test/observability: total on_close invocations.
    close_invocations: AtomicU64,
    /// Test-only: run once after successful insert, before post-insert revalidation.
    #[cfg(test)]
    post_insert_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl std::fmt::Debug for LocalSshSessionManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let n = self.inner.lock().map(|g| g.sessions.len()).unwrap_or(0);
        f.debug_struct("LocalSshSessionManager")
            .field("session_count", &n)
            .field("auth", &"<redacted>")
            .field("vault", &"<redacted>")
            .field("cutoff", &"<redacted>")
            .finish()
    }
}

impl LocalSshSessionManager {
    /// Production constructor: CSPRNG via [`crate::auth::SecRandomSource`].
    pub fn new(
        auth: Arc<AuthStore>,
        vault: Arc<VaultService>,
        cutoff: Arc<SecurityCutoff>,
    ) -> Arc<Self> {
        Self::with_rng(auth, vault, cutoff, Arc::new(crate::auth::SecRandomSource))
    }

    pub fn with_rng(
        auth: Arc<AuthStore>,
        vault: Arc<VaultService>,
        cutoff: Arc<SecurityCutoff>,
        rng: Arc<dyn RandomSource>,
    ) -> Arc<Self> {
        Arc::new(Self {
            auth,
            vault,
            cutoff,
            inner: Mutex::new(RegistryInner {
                sessions: HashMap::new(),
                global_generation: 0,
                credential_epochs: HashMap::new(),
            }),
            rng,
            close_invocations: AtomicU64::new(0),
            #[cfg(test)]
            post_insert_hook: Mutex::new(None),
        })
    }

    /// Install a one-shot hook after insert / before post-insert revalidation (tests).
    #[cfg(test)]
    pub fn test_set_post_insert_hook(&self, hook: impl FnOnce() + Send + 'static) {
        *self.post_insert_hook.lock().unwrap() = Some(Box::new(hook));
    }

    pub fn is_empty(&self) -> bool {
        self.inner
            .lock()
            .map(|g| g.sessions.is_empty())
            .unwrap_or(true)
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|g| g.sessions.len()).unwrap_or(0)
    }

    pub fn close_invocation_count(&self) -> u64 {
        self.close_invocations.load(Ordering::SeqCst)
    }

    /// Mid-handshake: ticket registry barriers still current (close_all / per-cred close).
    /// Used by 8B3a TOFU revalidation after cloud CAS and before local known-hosts write.
    pub fn ensure_ticket_barriers_current(
        &self,
        barriers: &TicketBarrierSnapshot,
    ) -> Result<(), LocalSshError> {
        let g = self.inner.lock().map_err(|_| LocalSshError::Internal)?;
        if g.global_generation != barriers.registry_global_generation {
            return Err(LocalSshError::SshCutoff);
        }
        let key = CredentialKey::from_principal(&barriers.principal, &barriers.credential_id);
        let cred_epoch = g.credential_epochs.get(&key).copied().unwrap_or(0);
        if cred_epoch != barriers.credential_invalidation_epoch {
            return Err(LocalSshError::SshCutoff);
        }
        Ok(())
    }

    /// Phase 1: secret-free request only (no vault lease yet).
    ///
    /// Required 8B3 order: `begin(request)` → `prepare_local_ssh_open(request)` →
    /// connector → `complete_established(ticket, authority, close)`.
    pub fn begin_establishment(
        &self,
        req: &LocalSshOpenRequest,
    ) -> Result<LocalSshRegistrationTicket, LocalSshError> {
        validate_id(&req.server_id).map_err(|_| LocalSshError::InvalidInput)?;
        validate_id(&req.credential_id).map_err(|_| LocalSshError::InvalidInput)?;

        let binding = self
            .auth
            .auth_binding()
            .ok_or(LocalSshError::Unauthenticated)?;
        let ssh_gen = self.cutoff.ssh_generation();
        self.ensure_vault_and_cutoff_unlocked()?;

        let inner = self.inner.lock().map_err(|_| LocalSshError::Internal)?;
        let key = CredentialKey::from_principal(&binding.principal, &req.credential_id);
        let cred_epoch = inner.credential_epochs.get(&key).copied().unwrap_or(0);
        Ok(LocalSshRegistrationTicket {
            principal: binding.principal,
            auth_epoch: binding.epoch,
            server_id: req.server_id.clone(),
            credential_id: req.credential_id.clone(),
            // Captured cutoff generation at ticket time (before prepare/lease).
            prepared_ssh_generation: ssh_gen,
            registry_global_generation: inner.global_generation,
            credential_invalidation_epoch: cred_epoch,
        })
    }

    /// Phase 2: consume ticket + secret-free authority + live close handle; register only if still current.
    ///
    /// Authority must not carry PEM/passphrase — split the lease-bearing prepared open first.
    /// On **any** `Err` after receiving `close`, invokes `close` exactly once outside the mutex.
    pub fn complete_established(
        &self,
        ticket: LocalSshRegistrationTicket,
        authority: LocalSshConnectAuthority,
        close: Arc<dyn SessionCloseHandle>,
    ) -> Result<LocalSshSessionId, LocalSshError> {
        // Guard: close handle if we return Err without transferring ownership to a record.
        // Note: dropping the Arc alone does not call on_close; only the Err path below
        // invokes the handle. A panic inside complete_established_inner will not close.
        let mut close_on_err: Option<Arc<dyn SessionCloseHandle>> = Some(close);
        let result = self.complete_established_inner(ticket, authority, &mut close_on_err);
        if let Some(c) = close_on_err.take() {
            // Error path: established transport must not leak after a failed complete.
            if result.is_err() {
                self.invoke_close_handle(c);
            }
        }
        result
    }

    fn complete_established_inner(
        &self,
        ticket: LocalSshRegistrationTicket,
        authority: LocalSshConnectAuthority,
        close_slot: &mut Option<Arc<dyn SessionCloseHandle>>,
    ) -> Result<LocalSshSessionId, LocalSshError> {
        if !ticket_matches_authority(&ticket, &authority) {
            return Err(LocalSshError::BindingMismatch);
        }
        let expected = AuthBinding {
            principal: authority.principal.clone(),
            epoch: authority.epoch,
        };
        self.ensure_live_authority(&expected, authority.ssh_generation)?;

        let close = close_slot.take().ok_or(LocalSshError::Internal)?;

        let session_id = match self.insert_session(&ticket, &authority, close) {
            Ok(id) => id,
            Err((e, returned_close)) => {
                // Put close back so outer path closes outside mutex.
                *close_slot = Some(returned_close);
                return Err(e);
            }
        };

        #[cfg(test)]
        if let Some(hook) = self.post_insert_hook.lock().unwrap().take() {
            hook();
        }

        // Post-insert: auth/vault/cutoff + registry barriers + record still present.
        if let Err(e) = self.ensure_post_insert(
            &ticket,
            session_id.as_str(),
            &expected,
            authority.ssh_generation,
        ) {
            // If lifecycle already drained/closed, do not double-close.
            if let Some(rec) = self.remove_raw(session_id.as_str()) {
                self.invoke_close(rec);
            }
            drop(authority);
            return Err(e);
        }
        drop(authority);
        Ok(session_id)
    }

    /// Auth/vault/cutoff still live, ticket barriers current, and exact session record present.
    fn ensure_post_insert(
        &self,
        ticket: &LocalSshRegistrationTicket,
        session_id: &str,
        expected: &AuthBinding,
        prepared_gen: u64,
    ) -> Result<(), LocalSshError> {
        self.ensure_live_authority(expected, prepared_gen)?;
        let g = self.inner.lock().map_err(|_| LocalSshError::Internal)?;
        if g.global_generation != ticket.registry_global_generation {
            return Err(LocalSshError::SshCutoff);
        }
        let key = CredentialKey::from_principal(&ticket.principal, &ticket.credential_id);
        let cred_epoch = g.credential_epochs.get(&key).copied().unwrap_or(0);
        if cred_epoch != ticket.credential_invalidation_epoch {
            return Err(LocalSshError::SshCutoff);
        }
        match g.sessions.get(session_id) {
            Some(rec)
                if rec.principal == ticket.principal
                    && rec.epoch == ticket.auth_epoch
                    && rec.server_id == ticket.server_id
                    && rec.credential_id == ticket.credential_id
                    && rec.ssh_generation == ticket.prepared_ssh_generation =>
            {
                Ok(())
            }
            // Missing (already closed by lifecycle) or mismatched identity.
            _ => Err(LocalSshError::Internal),
        }
    }

    /// Insert under lock; on failure return close handle for outer close.
    fn insert_session(
        &self,
        ticket: &LocalSshRegistrationTicket,
        authority: &LocalSshConnectAuthority,
        close: Arc<dyn SessionCloseHandle>,
    ) -> Result<LocalSshSessionId, (LocalSshError, Arc<dyn SessionCloseHandle>)> {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return Err((LocalSshError::Internal, close)),
        };

        if inner.global_generation != ticket.registry_global_generation {
            return Err((LocalSshError::SshCutoff, close));
        }
        let key = CredentialKey::from_principal(&authority.principal, &authority.credential_id);
        let cred_epoch = inner.credential_epochs.get(&key).copied().unwrap_or(0);
        if cred_epoch != ticket.credential_invalidation_epoch {
            return Err((LocalSshError::SshCutoff, close));
        }

        let session_id = match self.mint_unique_session_id(&mut inner) {
            Ok(id) => id,
            Err(e) => return Err((e, close)),
        };

        let record = SessionRecord {
            principal: authority.principal.clone(),
            epoch: authority.epoch,
            server_id: authority.server_id.clone(),
            credential_id: authority.credential_id.clone(),
            ssh_generation: authority.ssh_generation,
            registered_global_generation: ticket.registry_global_generation,
            registered_credential_epoch: ticket.credential_invalidation_epoch,
            session_id: session_id.clone(),
            close,
        };
        // Never overwrite: mint_unique ensures vacant key.
        debug_assert!(!inner.sessions.contains_key(session_id.as_str()));
        inner.sessions.insert(session_id.0.clone(), record);
        Ok(session_id)
    }

    fn mint_unique_session_id(
        &self,
        inner: &mut RegistryInner,
    ) -> Result<LocalSshSessionId, LocalSshError> {
        for _ in 0..MAX_SESSION_ID_ATTEMPTS {
            let id = self.generate_session_id_bytes()?;
            if !inner.sessions.contains_key(id.as_str()) {
                return Ok(id);
            }
        }
        Err(LocalSshError::Internal)
    }

    fn generate_session_id_bytes(&self) -> Result<LocalSshSessionId, LocalSshError> {
        let mut buf = [0u8; 32];
        self.rng
            .fill_bytes(&mut buf)
            .map_err(|_| LocalSshError::Internal)?;
        let id = base64url_nopad(&buf);
        buf.fill(0);
        Ok(LocalSshSessionId(id))
    }

    /// Authorize later ops. Unknown and foreign IDs share one fixed public error.
    pub fn authorize(&self, session_id: &str) -> Result<(), LocalSshError> {
        let binding = self
            .auth
            .auth_binding()
            .ok_or(LocalSshError::Unauthenticated)?;
        let stale = self.drain_invalid_sessions();
        for rec in stale {
            self.invoke_close(rec);
        }
        self.ensure_vault_and_cutoff_unlocked()?;

        let g = self.inner.lock().map_err(|_| LocalSshError::Internal)?;
        match g.sessions.get(session_id) {
            Some(rec)
                if rec.principal == binding.principal
                    && rec.epoch == binding.epoch
                    && self.cutoff.ssh_session_still_valid(rec.ssh_generation)
                    && self.barriers_still_valid(rec, &g) =>
            {
                Ok(())
            }
            // Unknown or foreign / stale: same fixed code (no existence disclosure).
            _ => Err(LocalSshError::Internal),
        }
    }

    /// Explicit close: cross-principal non-disclosing and idempotent.
    pub fn close_session(&self, session_id: &str) -> Result<(), LocalSshError> {
        let Some(binding) = self.auth.auth_binding() else {
            return Ok(());
        };
        let removed = {
            let mut g = self.inner.lock().map_err(|_| LocalSshError::Internal)?;
            match g.sessions.get(session_id) {
                Some(rec) if rec.principal == binding.principal && rec.epoch == binding.epoch => {
                    g.sessions.remove(session_id)
                }
                _ => None,
            }
        };
        if let Some(rec) = removed {
            self.invoke_close(rec);
        }
        Ok(())
    }

    #[allow(dead_code)] // reserved for 8B3 IPC
    pub fn list_for_current(&self) -> Result<Vec<LocalSshSessionMeta>, LocalSshError> {
        let binding = self
            .auth
            .auth_binding()
            .ok_or(LocalSshError::Unauthenticated)?;
        let stale = self.drain_invalid_sessions();
        for rec in stale {
            self.invoke_close(rec);
        }
        let g = self.inner.lock().map_err(|_| LocalSshError::Internal)?;
        let mut out = Vec::new();
        for rec in g.sessions.values() {
            if rec.principal == binding.principal
                && rec.epoch == binding.epoch
                && self.cutoff.ssh_session_still_valid(rec.ssh_generation)
                && self.barriers_still_valid(rec, &g)
            {
                out.push(LocalSshSessionMeta {
                    session_id: rec.session_id.clone(),
                    server_id: rec.server_id.clone(),
                    credential_id: rec.credential_id.clone(),
                });
            }
        }
        Ok(out)
    }

    fn barriers_still_valid(&self, rec: &SessionRecord, inner: &RegistryInner) -> bool {
        if rec.registered_global_generation != inner.global_generation {
            return false;
        }
        let key = CredentialKey::from_principal(&rec.principal, &rec.credential_id);
        let epoch = inner.credential_epochs.get(&key).copied().unwrap_or(0);
        rec.registered_credential_epoch == epoch
    }

    fn ensure_live_authority(
        &self,
        expected: &AuthBinding,
        captured_gen: u64,
    ) -> Result<(), LocalSshError> {
        let current = self
            .auth
            .auth_binding()
            .ok_or(LocalSshError::Unauthenticated)?;
        if current != *expected {
            return Err(LocalSshError::BindingMismatch);
        }
        self.ensure_vault_and_cutoff_unlocked()?;
        if !self.cutoff.ssh_session_still_valid(captured_gen) {
            return Err(LocalSshError::SshCutoff);
        }
        Ok(())
    }

    fn ensure_vault_and_cutoff_unlocked(&self) -> Result<(), LocalSshError> {
        if self.cutoff.is_vault_locked() {
            return Err(LocalSshError::VaultLocked);
        }
        let st = self.vault.status().map_err(|_| LocalSshError::Internal)?;
        if !st.unlocked {
            return Err(LocalSshError::VaultLocked);
        }
        Ok(())
    }

    fn remove_raw(&self, session_id: &str) -> Option<SessionRecord> {
        self.inner
            .lock()
            .ok()
            .and_then(|mut g| g.sessions.remove(session_id))
    }

    fn drain_invalid_sessions(&self) -> Vec<SessionRecord> {
        let binding = self.auth.auth_binding();
        let vault_ok = !self.cutoff.is_vault_locked()
            && self.vault.status().map(|s| s.unlocked).unwrap_or(false);
        let mut g = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        let mut stale_keys = Vec::new();
        for (k, rec) in g.sessions.iter() {
            let binding_ok = match &binding {
                Some(b) => rec.principal == b.principal && rec.epoch == b.epoch,
                None => false,
            };
            let gen_ok = self.cutoff.ssh_session_still_valid(rec.ssh_generation);
            let barriers_ok = self.barriers_still_valid(rec, &g);
            if !binding_ok || !gen_ok || !vault_ok || !barriers_ok {
                stale_keys.push(k.clone());
            }
        }
        stale_keys
            .into_iter()
            .filter_map(|k| g.sessions.remove(&k))
            .collect()
    }

    fn invoke_close(&self, rec: SessionRecord) {
        self.invoke_close_handle(rec.close);
    }

    fn invoke_close_handle(&self, close: Arc<dyn SessionCloseHandle>) {
        self.close_invocations.fetch_add(1, Ordering::SeqCst);
        close.on_close();
    }
}

fn ticket_matches_authority(
    ticket: &LocalSshRegistrationTicket,
    authority: &LocalSshConnectAuthority,
) -> bool {
    ticket.principal == authority.principal
        && ticket.auth_epoch == authority.epoch
        && ticket.server_id == authority.server_id
        && ticket.credential_id == authority.credential_id
        && ticket.prepared_ssh_generation == authority.ssh_generation
}

impl SessionLifecycleSink for LocalSshSessionManager {
    fn close_all_sessions(&self) {
        let drained = {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            g.global_generation = g.global_generation.wrapping_add(1);
            g.sessions.drain().map(|(_, r)| r).collect::<Vec<_>>()
        };
        for rec in drained {
            self.invoke_close(rec);
        }
    }

    fn close_sessions_for_credential(&self, principal: &NativePrincipal, credential_id: &str) {
        let drained = {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let key = CredentialKey::from_principal(principal, credential_id);
            let e = g.credential_epochs.entry(key).or_insert(0);
            *e = e.wrapping_add(1);
            // Ownership namespace: tenant_id + Logto subject + credential_id (not username).
            let keys: Vec<String> = g
                .sessions
                .iter()
                .filter(|(_, r)| {
                    r.principal.tenant_id == principal.tenant_id
                        && r.principal.subject == principal.subject
                        && r.credential_id == credential_id
                })
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter()
                .filter_map(|k| g.sessions.remove(&k))
                .collect::<Vec<_>>()
        };
        for rec in drained {
            self.invoke_close(rec);
        }
    }
}

/// Shared attach path: register an already-constructed manager as the vault lifecycle sink.
/// Production and test wrappers both construct then call this — sink wiring lives only here.
fn attach_session_manager_to_vault_inner(
    manager: Arc<LocalSshSessionManager>,
    vault: &VaultService,
) -> Arc<LocalSshSessionManager> {
    vault.set_session_lifecycle_sink(manager.clone());
    manager
}

/// Production helper: create one manager Arc (SecRandomSource) and attach as vault sink.
/// Used by `run()` so wiring is testable without Tauri.
pub fn attach_session_manager_to_vault(
    auth: Arc<AuthStore>,
    vault: Arc<VaultService>,
    cutoff: Arc<SecurityCutoff>,
) -> Arc<LocalSshSessionManager> {
    // Route through `new()` so production CSPRNG path stays single-sourced.
    let manager = LocalSshSessionManager::new(auth, vault.clone(), cutoff);
    attach_session_manager_to_vault_inner(manager, vault.as_ref())
}

/// Test wrapper: same sink attach as production with injectable RNG.
#[cfg(test)]
pub fn attach_session_manager_to_vault_with_rng(
    auth: Arc<AuthStore>,
    vault: Arc<VaultService>,
    cutoff: Arc<SecurityCutoff>,
    rng: Arc<dyn RandomSource>,
) -> Arc<LocalSshSessionManager> {
    let manager = LocalSshSessionManager::with_rng(auth, vault.clone(), cutoff, rng);
    attach_session_manager_to_vault_inner(manager, vault.as_ref())
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::AuthError;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Mutex as StdMutex;
    use std::time::Instant;
    use tauri_plugin_stronghold::stronghold::Stronghold;

    struct SeqRng {
        bytes: Vec<u8>,
        pos: StdMutex<usize>,
        fail: AtomicBool,
    }

    impl SeqRng {
        fn new(bytes: Vec<u8>) -> Arc<Self> {
            Arc::new(Self {
                bytes,
                pos: StdMutex::new(0),
                fail: AtomicBool::new(false),
            })
        }
        fn fail_next(&self) {
            self.fail.store(true, AtomicOrdering::SeqCst);
        }
    }

    impl RandomSource for SeqRng {
        fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), AuthError> {
            if self.fail.swap(false, AtomicOrdering::SeqCst) {
                return Err(AuthError::Random);
            }
            let mut pos = self.pos.lock().unwrap();
            for b in dest.iter_mut() {
                if self.bytes.is_empty() {
                    return Err(AuthError::Random);
                }
                *b = self.bytes[*pos % self.bytes.len()];
                *pos += 1;
            }
            Ok(())
        }
    }

    struct CountingClose {
        count: Arc<AtomicUsize>,
        on_close_hook: StdMutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    impl CountingClose {
        fn new(count: Arc<AtomicUsize>) -> Arc<Self> {
            Arc::new(Self {
                count,
                on_close_hook: StdMutex::new(None),
            })
        }
        fn with_hook(count: Arc<AtomicUsize>, hook: impl FnOnce() + Send + 'static) -> Arc<Self> {
            let c = Self::new(count);
            *c.on_close_hook.lock().unwrap() = Some(Box::new(hook));
            c
        }
    }

    impl SessionCloseHandle for CountingClose {
        fn on_close(&self) {
            self.count.fetch_add(1, AtomicOrdering::SeqCst);
            if let Some(h) = self.on_close_hook.lock().unwrap().take() {
                h();
            }
        }
    }

    fn temp_hold(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "opsmate-8b2-{}-{}-{}.hold",
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

    fn unlocked_pair(
        tenant: &str,
        user: &str,
        subject: &str,
    ) -> (
        Arc<AuthStore>,
        Arc<VaultService>,
        Arc<SecurityCutoff>,
        std::path::PathBuf,
        AuthBinding,
    ) {
        let auth = Arc::new(AuthStore::new());
        auth.install_session_for_tests(tenant, user, "admin", subject);
        let binding = auth.auth_binding().unwrap();
        let path = temp_hold("v");
        let sh = Stronghold::new(&path, vec![0x8Cu8; 32]).expect("sh");
        let vault = Arc::new(VaultService::new(path.clone()));
        vault.test_inject_unlocked(sh, binding.clone(), path.clone(), Instant::now());
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        (auth, vault, cutoff, path, binding)
    }

    fn fixture_authority(
        binding: &AuthBinding,
        server_id: &str,
        credential_id: &str,
        gen: u64,
    ) -> LocalSshConnectAuthority {
        LocalSshConnectAuthority {
            server_id: server_id.into(),
            credential_id: credential_id.into(),
            target_host: "10.0.0.1".into(),
            ssh_port: 22,
            ssh_user: "admin".into(),
            host_key: None,
            principal: binding.principal.clone(),
            epoch: binding.epoch,
            ssh_generation: gen,
        }
    }

    /// Distinct 32-byte blocks for unique session ids.
    fn distinct_rng_bytes(n_ids: usize) -> Vec<u8> {
        let mut v = Vec::with_capacity(n_ids * 32);
        for i in 0..n_ids {
            for j in 0..32u8 {
                v.push((i as u8).wrapping_mul(31).wrapping_add(j));
            }
        }
        v
    }

    fn mgr_with(
        auth: Arc<AuthStore>,
        vault: Arc<VaultService>,
        cutoff: Arc<SecurityCutoff>,
        rng_bytes: Vec<u8>,
    ) -> (Arc<LocalSshSessionManager>, Arc<SeqRng>) {
        let rng = SeqRng::new(rng_bytes);
        let m = LocalSshSessionManager::with_rng(auth, vault, cutoff, rng.clone());
        (m, rng)
    }

    fn open_req(server_id: &str, credential_id: &str) -> LocalSshOpenRequest {
        LocalSshOpenRequest {
            server_id: server_id.into(),
            credential_id: credential_id.into(),
        }
    }

    /// Real 8B3 order: begin(request) → prepared fixture (stand-in for prepare) → complete.
    fn register_ok(
        m: &LocalSshSessionManager,
        binding: &AuthBinding,
        server_id: &str,
        credential_id: &str,
        gen: u64,
        close: Arc<dyn SessionCloseHandle>,
    ) -> LocalSshSessionId {
        let req = open_req(server_id, credential_id);
        let ticket = m.begin_establishment(&req).unwrap();
        let authority = fixture_authority(binding, server_id, credential_id, gen);
        m.complete_established(ticket, authority, close).unwrap()
    }

    #[test]
    fn manager_starts_empty() {
        let (auth, vault, cutoff, path, _) = unlocked_pair("t", "u", "s");
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, distinct_rng_bytes(1));
        assert!(m.is_empty());
        assert_eq!(m.len(), 0);
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn two_phase_register_generates_32byte_opaque_id() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let bytes = vec![0xABu8; 32];
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, bytes.clone());
        let id = register_ok(
            &m,
            &binding,
            "srv-1",
            "cred-1",
            gen,
            CountingClose::new(Arc::new(AtomicUsize::new(0))),
        );
        assert_eq!(id.as_str(), base64url_nopad(&bytes));
        assert_eq!(id.as_str().len(), 43);
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn id_collision_retries_then_unique_no_overwrite() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let mut bytes = vec![0x01u8; 32];
        bytes.extend_from_slice(&[0x01u8; 32]);
        bytes.extend_from_slice(&[0x02u8; 32]);
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, bytes);
        let c1 = Arc::new(AtomicUsize::new(0));
        let c2 = Arc::new(AtomicUsize::new(0));
        let id1 = register_ok(
            &m,
            &binding,
            "s1",
            "c1",
            gen,
            CountingClose::new(c1.clone()),
        );
        let id2 = register_ok(
            &m,
            &binding,
            "s2",
            "c2",
            gen,
            CountingClose::new(c2.clone()),
        );
        assert_ne!(id1.as_str(), id2.as_str());
        assert_eq!(m.len(), 2);
        assert_eq!(c1.load(AtomicOrdering::SeqCst), 0);
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn id_collision_exhaustion_closes_rejected_handle_once_first_intact() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let bytes = vec![0x55u8; 32 * (MAX_SESSION_ID_ATTEMPTS + 1)];
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, bytes);
        let c1 = Arc::new(AtomicUsize::new(0));
        let c2 = Arc::new(AtomicUsize::new(0));
        let id1 = register_ok(
            &m,
            &binding,
            "s1",
            "c1",
            gen,
            CountingClose::new(c1.clone()),
        );
        let req2 = open_req("s2", "c2");
        let ticket2 = m.begin_establishment(&req2).unwrap();
        let authority2 = fixture_authority(&binding, "s2", "c2", gen);
        let err = m
            .complete_established(ticket2, authority2, CountingClose::new(c2.clone()))
            .unwrap_err();
        assert_eq!(err, LocalSshError::Internal);
        assert_eq!(c2.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(c1.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(m.len(), 1);
        assert!(m.authorize(id1.as_str()).is_ok());
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn begin_then_close_all_then_complete_no_insert_closes_once() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, distinct_rng_bytes(2));
        let ticket = m.begin_establishment(&open_req("s", "c")).unwrap();
        m.close_all_sessions();
        let authority = fixture_authority(&binding, "s", "c", gen);
        let count = Arc::new(AtomicUsize::new(0));
        let err = m
            .complete_established(ticket, authority, CountingClose::new(count.clone()))
            .unwrap_err();
        assert_eq!(err, LocalSshError::SshCutoff);
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        assert!(m.is_empty());
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn begin_then_credential_close_then_complete_no_insert_closes_once() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, distinct_rng_bytes(2));
        let ticket = m.begin_establishment(&open_req("s", "cred-x")).unwrap();
        m.close_sessions_for_credential(&binding.principal, "cred-x");
        let authority = fixture_authority(&binding, "s", "cred-x", gen);
        let count = Arc::new(AtomicUsize::new(0));
        let err = m
            .complete_established(ticket, authority, CountingClose::new(count.clone()))
            .unwrap_err();
        assert_eq!(err, LocalSshError::SshCutoff);
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        assert!(m.is_empty());
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn close_other_principal_or_credential_does_not_invalidate_ticket() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("ten-A", "alice", "sub-A");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, distinct_rng_bytes(3));
        let ticket = m.begin_establishment(&open_req("s", "cred-A")).unwrap();
        m.close_sessions_for_credential(&binding.principal, "cred-OTHER");
        let other = NativePrincipal {
            tenant_id: "ten-B".into(),
            user_id: "bob".into(),
            subject: "sub-B".into(),
        };
        m.close_sessions_for_credential(&other, "cred-A");
        let authority = fixture_authority(&binding, "s", "cred-A", gen);
        let id = m
            .complete_established(
                ticket,
                authority,
                CountingClose::new(Arc::new(AtomicUsize::new(0))),
            )
            .unwrap();
        assert_eq!(m.len(), 1);
        assert!(m.authorize(id.as_str()).is_ok());
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn later_authorize_after_cutoff_bump_purges_stale_session() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth, vault.clone(), cutoff.clone(), distinct_rng_bytes(1));
        let count = Arc::new(AtomicUsize::new(0));
        let id = register_ok(
            &m,
            &binding,
            "s",
            "c",
            gen,
            CountingClose::new(count.clone()),
        );
        let _ = cutoff.close_all_ssh();
        assert!(m.authorize(id.as_str()).is_err());
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        assert!(m.is_empty());
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn complete_post_insert_auth_clear_closes_once_no_leak() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth.clone(), vault.clone(), cutoff, distinct_rng_bytes(1));
        let count = Arc::new(AtomicUsize::new(0));
        let ticket = m.begin_establishment(&open_req("s", "c")).unwrap();
        let authority = fixture_authority(&binding, "s", "c", gen);
        let auth_hook = auth.clone();
        m.test_set_post_insert_hook(move || {
            let _ = auth_hook.clear_native();
        });
        let err = m
            .complete_established(ticket, authority, CountingClose::new(count.clone()))
            .unwrap_err();
        assert_eq!(err, LocalSshError::Unauthenticated);
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        assert!(m.is_empty());
        let _ = vault.lock();
        cleanup(&path);
    }

    /// Post-insert close_all drains record; complete must Err once, no double close.
    #[test]
    fn complete_post_insert_close_all_err_no_double_close() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, distinct_rng_bytes(1));
        let count = Arc::new(AtomicUsize::new(0));
        let ticket = m.begin_establishment(&open_req("s", "c")).unwrap();
        let authority = fixture_authority(&binding, "s", "c", gen);
        let m_hook = m.clone();
        m.test_set_post_insert_hook(move || {
            m_hook.close_all_sessions();
        });
        let err = m
            .complete_established(ticket, authority, CountingClose::new(count.clone()))
            .unwrap_err();
        assert!(matches!(
            err,
            LocalSshError::SshCutoff | LocalSshError::Internal
        ));
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        assert!(m.is_empty());
        assert_eq!(m.close_invocation_count(), 1);
        let _ = vault.lock();
        cleanup(&path);
    }

    /// Post-insert per-credential close drains record; complete Err; single close.
    #[test]
    fn complete_post_insert_credential_close_err_no_double_close() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, distinct_rng_bytes(1));
        let count = Arc::new(AtomicUsize::new(0));
        let ticket = m.begin_establishment(&open_req("s", "cred-x")).unwrap();
        let authority = fixture_authority(&binding, "s", "cred-x", gen);
        let m_hook = m.clone();
        let principal = binding.principal.clone();
        m.test_set_post_insert_hook(move || {
            m_hook.close_sessions_for_credential(&principal, "cred-x");
        });
        let err = m
            .complete_established(ticket, authority, CountingClose::new(count.clone()))
            .unwrap_err();
        assert!(matches!(
            err,
            LocalSshError::SshCutoff | LocalSshError::Internal
        ));
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        assert!(m.is_empty());
        assert_eq!(m.close_invocation_count(), 1);
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn complete_after_auth_clear_before_insert_closes_handle() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth.clone(), vault.clone(), cutoff, distinct_rng_bytes(1));
        let ticket = m.begin_establishment(&open_req("s", "c")).unwrap();
        let authority = fixture_authority(&binding, "s", "c", gen);
        let _ = auth.clear_native();
        let count = Arc::new(AtomicUsize::new(0));
        let err = m
            .complete_established(ticket, authority, CountingClose::new(count.clone()))
            .unwrap_err();
        assert_eq!(err, LocalSshError::Unauthenticated);
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        assert!(m.is_empty());
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn ab_same_credential_isolation_same_manager() {
        let (auth, vault, cutoff, path, bind_a) = unlocked_pair("ten-A", "alice", "sub-A");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth.clone(), vault.clone(), cutoff, distinct_rng_bytes(4));
        let ca = Arc::new(AtomicUsize::new(0));
        let cb = Arc::new(AtomicUsize::new(0));
        let id_a = register_ok(
            &m,
            &bind_a,
            "srv",
            "cred-shared",
            gen,
            CountingClose::new(ca.clone()),
        );
        let _ = auth.clear_native();
        auth.install_session_for_tests("ten-B", "bob", "admin", "sub-B");
        let bind_b = auth.auth_binding().unwrap();
        let id_b = register_ok(
            &m,
            &bind_b,
            "srv",
            "cred-shared",
            gen,
            CountingClose::new(cb.clone()),
        );
        assert_ne!(id_a.as_str(), id_b.as_str());
        assert_eq!(m.len(), 2);
        m.close_sessions_for_credential(&bind_a.principal, "cred-shared");
        assert_eq!(ca.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(cb.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(m.len(), 1);
        assert!(m.authorize(id_b.as_str()).is_ok());
        m.close_session(id_a.as_str()).unwrap();
        assert_eq!(ca.load(AtomicOrdering::SeqCst), 1);
        let _ = vault.lock();
        cleanup(&path);
    }

    /// Same tenant+subject, username change: close by namespace still invalidates session.
    #[test]
    fn same_tenant_subject_username_change_credential_close_invalidates() {
        let (auth, vault, cutoff, path, bind) = unlocked_pair("ten-A", "alice", "sub-A");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth.clone(), vault.clone(), cutoff, distinct_rng_bytes(2));
        let count = Arc::new(AtomicUsize::new(0));
        let id = register_ok(
            &m,
            &bind,
            "s",
            "cred-1",
            gen,
            CountingClose::new(count.clone()),
        );
        // New username, same tenant + Logto subject (new auth epoch).
        let _ = auth.clear_native();
        auth.install_session_for_tests("ten-A", "alice-renamed", "admin", "sub-A");
        let renamed = auth.auth_binding().unwrap();
        assert_eq!(renamed.principal.subject, "sub-A");
        assert_ne!(renamed.principal.user_id, bind.principal.user_id);
        m.close_sessions_for_credential(&renamed.principal, "cred-1");
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        assert!(m.is_empty());
        // Old id gone; authorize with current binding fails identically to unknown.
        assert_eq!(m.authorize(id.as_str()), Err(LocalSshError::Internal));
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn different_subject_same_credential_id_isolated() {
        let (auth, vault, cutoff, path, bind_a) = unlocked_pair("ten-A", "alice", "sub-A");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth.clone(), vault.clone(), cutoff, distinct_rng_bytes(3));
        let ca = Arc::new(AtomicUsize::new(0));
        let cb = Arc::new(AtomicUsize::new(0));
        register_ok(
            &m,
            &bind_a,
            "s",
            "cred-x",
            gen,
            CountingClose::new(ca.clone()),
        );
        let _ = auth.clear_native();
        auth.install_session_for_tests("ten-A", "bob", "admin", "sub-B");
        let bind_b = auth.auth_binding().unwrap();
        register_ok(
            &m,
            &bind_b,
            "s",
            "cred-x",
            gen,
            CountingClose::new(cb.clone()),
        );
        assert_eq!(m.len(), 2);
        // Close only sub-B's cred-x; sub-A remains.
        m.close_sessions_for_credential(&bind_b.principal, "cred-x");
        assert_eq!(cb.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(ca.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(m.len(), 1);
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn authorize_unknown_and_foreign_same_error() {
        let (auth, vault, cutoff, path, bind) = unlocked_pair("ten-A", "alice", "sub-A");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth.clone(), vault.clone(), cutoff, distinct_rng_bytes(2));
        let id = register_ok(
            &m,
            &bind,
            "s",
            "c",
            gen,
            CountingClose::new(Arc::new(AtomicUsize::new(0))),
        );
        let unknown = m.authorize("not-exist");
        let _ = auth.clear_native();
        auth.install_session_for_tests("ten-B", "bob", "admin", "sub-B");
        let foreign = m.authorize(id.as_str());
        assert_eq!(unknown, foreign);
        assert_eq!(unknown, Err(LocalSshError::Internal));
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn explicit_close_idempotent_and_cross_principal_nondisclosure() {
        let (auth, vault, cutoff, path, bind) = unlocked_pair("ten-A", "alice", "sub-A");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth.clone(), vault.clone(), cutoff, distinct_rng_bytes(2));
        let count = Arc::new(AtomicUsize::new(0));
        let id = register_ok(&m, &bind, "s", "c", gen, CountingClose::new(count.clone()));
        m.close_session(id.as_str()).unwrap();
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        m.close_session(id.as_str()).unwrap();
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        m.close_session("missing").unwrap();

        let count2 = Arc::new(AtomicUsize::new(0));
        let bind_a = auth.auth_binding().unwrap();
        let id2 = register_ok(
            &m,
            &bind_a,
            "s2",
            "c2",
            gen,
            CountingClose::new(count2.clone()),
        );
        let _ = auth.clear_native();
        auth.install_session_for_tests("ten-B", "bob", "admin", "sub-B");
        m.close_session(id2.as_str()).unwrap();
        assert_eq!(count2.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(m.len(), 1);
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn close_all_exact_once_and_reentrant_callback() {
        let (auth, vault, cutoff, path, bind) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, distinct_rng_bytes(2));
        let c1 = Arc::new(AtomicUsize::new(0));
        let c2 = Arc::new(AtomicUsize::new(0));
        register_ok(&m, &bind, "s1", "c1", gen, CountingClose::new(c1.clone()));
        let m2 = m.clone();
        register_ok(
            &m,
            &bind,
            "s2",
            "c2",
            gen,
            CountingClose::with_hook(c2.clone(), move || {
                m2.close_all_sessions();
            }),
        );
        m.close_all_sessions();
        assert_eq!(c1.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(c2.load(AtomicOrdering::SeqCst), 1);
        assert!(m.is_empty());
        m.close_all_sessions();
        assert_eq!(c1.load(AtomicOrdering::SeqCst), 1);
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn debug_redacts_ticket_and_manager() {
        let (auth, vault, cutoff, path, bind) = unlocked_pair("tenant-secret", "u", "sub-secret");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, distinct_rng_bytes(1));
        let ticket = m
            .begin_establishment(&open_req("srv-secret", "cred-secret"))
            .unwrap();
        let authority = fixture_authority(&bind, "srv-secret", "cred-secret", gen);
        let dbg_t = format!("{ticket:?}");
        let dbg_a = format!("{authority:?}");
        let id = m
            .complete_established(
                ticket,
                authority,
                CountingClose::new(Arc::new(AtomicUsize::new(0))),
            )
            .unwrap();
        let dbg_m = format!("{m:?}");
        let dbg_id = format!("{id:?}");
        for s in [&dbg_t, &dbg_a, &dbg_m, &dbg_id] {
            assert!(!s.contains("tenant-secret"));
            assert!(!s.contains("sub-secret"));
            assert!(!s.contains("srv-secret"));
            assert!(!s.contains("cred-secret"));
            assert!(!s.contains(id.as_str()));
        }
        let _ = vault.lock();
        cleanup(&path);
    }

    /// Behavioral proof via test attach wrapper (shares inner sink wiring with production).
    #[test]
    fn attach_helper_wires_vault_sink_closes_on_seal() {
        let (auth, vault, cutoff, path, bind) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let rng = SeqRng::new(distinct_rng_bytes(1));
        let m = attach_session_manager_to_vault_with_rng(auth, vault.clone(), cutoff, rng);
        assert!(m.is_empty());
        let count = Arc::new(AtomicUsize::new(0));
        register_ok(&m, &bind, "s", "c", gen, CountingClose::new(count.clone()));
        assert_eq!(m.len(), 1);
        let _ = vault.lock();
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        assert!(m.is_empty());
        cleanup(&path);
    }

    #[test]
    fn attach_session_manager_to_vault_returns_empty_manager() {
        let (auth, vault, cutoff, path, _) = unlocked_pair("t", "u", "s");
        let m = attach_session_manager_to_vault(auth, vault.clone(), cutoff);
        assert!(m.is_empty());
        let _ = vault.lock();
        cleanup(&path);
    }

    /// Source assertion: production helper constructs via `new` then calls shared inner;
    /// sink wiring (`set_session_lifecycle_sink`) occurs only inside that inner.
    #[test]
    fn production_attach_helper_calls_shared_inner() {
        let src = include_str!("session.rs");
        // Locate production attach by signature; stop before the test-only wrapper.
        let after_prod_sig = src
            .split("pub fn attach_session_manager_to_vault(\n")
            .nth(1)
            .expect("production attach_session_manager_to_vault present");
        let attach_prod_body = after_prod_sig
            .split("/// Test wrapper")
            .next()
            .expect("test wrapper marker after production attach");
        assert!(
            attach_prod_body.contains("LocalSshSessionManager::new"),
            "production attach must construct via new/SecRandomSource"
        );
        assert!(
            attach_prod_body.contains("attach_session_manager_to_vault_inner"),
            "production attach must call shared inner (not duplicate sink wiring)"
        );
        assert!(
            !attach_prod_body.contains("set_session_lifecycle_sink"),
            "production attach must not wire the sink itself"
        );
        // Shared inner is the only non-test call site for sink wiring in this module.
        let before_tests = src
            .split("// ─── Tests ─")
            .next()
            .expect("tests section marker");
        let sink_hits: usize = before_tests.matches("set_session_lifecycle_sink").count();
        assert_eq!(
            sink_hits, 1,
            "set_session_lifecycle_sink must appear only in shared inner (production source)"
        );
        assert!(
            before_tests.contains("fn attach_session_manager_to_vault_inner("),
            "shared inner must exist"
        );
    }

    #[test]
    fn ticket_mismatch_closes_handle() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, distinct_rng_bytes(1));
        let ticket = m.begin_establishment(&open_req("s1", "c1")).unwrap();
        let other = fixture_authority(&binding, "s-OTHER", "c1", gen);
        let count = Arc::new(AtomicUsize::new(0));
        let err = m
            .complete_established(ticket, other, CountingClose::new(count.clone()))
            .unwrap_err();
        assert_eq!(err, LocalSshError::BindingMismatch);
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        assert!(m.is_empty());
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn rng_failure_on_complete_closes_handle() {
        let (auth, vault, cutoff, path, binding) = unlocked_pair("t", "u", "s");
        let gen = cutoff.ssh_generation();
        let (m, rng) = mgr_with(auth, vault.clone(), cutoff, distinct_rng_bytes(1));
        let ticket = m.begin_establishment(&open_req("s", "c")).unwrap();
        let authority = fixture_authority(&binding, "s", "c", gen);
        rng.fail_next();
        let count = Arc::new(AtomicUsize::new(0));
        let err = m
            .complete_established(ticket, authority, CountingClose::new(count.clone()))
            .unwrap_err();
        assert_eq!(err, LocalSshError::Internal);
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
        assert!(m.is_empty());
        let _ = vault.lock();
        cleanup(&path);
    }

    #[test]
    fn production_lib_uses_attach_helper() {
        let lib = include_str!("../lib.rs");
        let prod = lib.split("#[cfg(test)]").next().unwrap_or(lib);
        assert!(prod.contains("attach_session_manager_to_vault"));
        assert!(!prod.contains("clippy::borrow_deref_ref"));
    }

    #[test]
    fn begin_rejects_invalid_request_ids() {
        let (auth, vault, cutoff, path, _) = unlocked_pair("t", "u", "s");
        let (m, _) = mgr_with(auth, vault.clone(), cutoff, distinct_rng_bytes(1));
        let err = m
            .begin_establishment(&open_req("../evil", "c"))
            .unwrap_err();
        assert_eq!(err, LocalSshError::InvalidInput);
        let _ = vault.lock();
        cleanup(&path);
    }
}
