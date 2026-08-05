//! Local Stronghold credential vault (Task 8A1 core + 8A2A runtime).
//!
//! Stronghold namespace is **tenant_id + Logto subject + credential_id** only.
//! Never username/user_id. WebView DTOs accept only credentialId.
//! Named IPC lives in `lib.rs`. No Stronghold plugin registration/capability.

use crate::auth::{AuthBinding, AuthStore, NativePrincipal};
use crate::secure_prompt::{PromptError, SecurePrompt};
use argon2::{self, Config};
use russh::keys::{decode_secret_key, HashAlg};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::ThreadId;
use std::time::{Duration, Instant};
use tauri_plugin_stronghold::stronghold::Stronghold;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Hooks for sealing vault / deleting credentials — close SSH sessions **before** Stronghold lock.
pub trait SessionLifecycleSink: Send + Sync {
    fn close_all_sessions(&self);
    /// Tenant-isolated: only sessions for this principal + credential_id.
    fn close_sessions_for_credential(&self, principal: &NativePrincipal, credential_id: &str);
}

/// Internal SSH lease: PEM/passphrase never leave native / never IPC.
/// Not Clone, not Serialize. Debug redacts secrets.
pub struct VaultCredentialLease {
    pub credential_id: String,
    pub fingerprint: String,
    pub pem: Zeroizing<String>,
    pub passphrase: Option<Zeroizing<String>>,
}

impl std::fmt::Debug for VaultCredentialLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultCredentialLease")
            .field("credential_id", &"<redacted>")
            .field("fingerprint", &self.fingerprint)
            .field("pem", &"<redacted>")
            .field("passphrase", &"<redacted>")
            .finish()
    }
}

impl Drop for VaultCredentialLease {
    fn drop(&mut self) {
        // Zeroizing fields wipe on drop; explicit zeroize keeps fail-closed contract clear.
        self.pem.zeroize();
        if let Some(ref mut p) = self.passphrase {
            p.zeroize();
        }
        self.credential_id.zeroize();
        self.fingerprint.zeroize();
    }
}

/// Idle lock after this duration without key-related native activity.
pub const VAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const CLIENT_PATH: &[u8] = b"opsmate-vault-client";
const INDEX_KEY: &[u8] = b"__opsmate_credential_index__";
const SALT_LEN: usize = 16;

// ─── Errors (no secret payloads) ─────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("vault is locked")]
    Locked,
    #[error("vault already unlocked")]
    AlreadyUnlocked,
    #[error("vault not initialized")]
    NotInitialized,
    #[error("vault already initialized")]
    AlreadyInitialized,
    #[error("invalid password")]
    InvalidPassword,
    #[error("invalid key identity")]
    InvalidIdentity,
    #[error("not authenticated")]
    Unauthenticated,
    #[error("credential not found")]
    NotFound,
    #[error("invalid private key")]
    InvalidPrivateKey,
    #[error("prompt cancelled")]
    PromptCancelled,
    #[error("prompt failed")]
    PromptFailed,
    #[error("storage error")]
    Storage,
    #[error("internal error")]
    Internal,
    /// OS sleep/lock observers died unexpectedly — unlock fail-closed (Task 4 health latch).
    #[error("vault lifecycle observer unavailable")]
    ObserverUnavailable,
}

impl From<PromptError> for VaultError {
    fn from(e: PromptError) -> Self {
        match e {
            PromptError::Cancelled => VaultError::PromptCancelled,
            PromptError::UnsupportedPlatform => VaultError::PromptFailed,
            PromptError::Native(_) => VaultError::PromptFailed,
        }
    }
}

/// Outcome of a conditional lifecycle seal attempt (honest, not always Sealed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SealAttempt {
    /// Stronghold sealed with the requested reason.
    Sealed,
    /// Not unlocked / not still idle / gate busy — no seal; pre-seal callback **not** run.
    NotNeeded,
}

// ─── Safe IPC DTOs (no tenant/subject/user/path/PEM from WebView) ────────────

/// Design: only `unlocked` + `locked_reason` — never expose tenant/subject IDs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub unlocked: bool,
    /// Absent when unlocked. Fixed public codes only, e.g.:
    /// not_initialized | locked | idle_timeout | principal_changed | logout |
    /// system_sleep | process_exit.
    pub locked_reason: Option<String>,
}

/// Fixed public locked_reason values (secret-free).
pub mod locked_reason {
    pub const NOT_INITIALIZED: &str = "not_initialized";
    pub const LOCKED: &str = "locked";
    pub const IDLE_TIMEOUT: &str = "idle_timeout";
    pub const PRINCIPAL_CHANGED: &str = "principal_changed";
    pub const LOGOUT: &str = "logout";
    pub const SYSTEM_SLEEP: &str = "system_sleep";
    pub const PROCESS_EXIT: &str = "process_exit";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultMetaItem {
    pub credential_id: String,
    pub fingerprint: String,
    pub device_present: bool,
}

/// WebView may supply **only** `credential_id`. File vs paste is native-only.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VaultImportRequest {
    pub credential_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultImportResponse {
    pub credential_id: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VaultDeleteLocalRequest {
    pub credential_id: String,
}

// ─── Stored record (never Clone; never returned over IPC) ────────────────────

/// On-disk Stronghold record. Serialize for storage only — never Clone, never IPC.
/// Debug redacts secrets. Drop zeroizes PEM/passphrase.
#[derive(Serialize, Deserialize)]
struct StoredCredential {
    tenant_id: String,
    /// Server-verified Logto subject (never username / user_id).
    subject: String,
    credential_id: String,
    fingerprint: String,
    pem: String,
    passphrase: Option<String>,
}

impl std::fmt::Debug for StoredCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredCredential")
            .field("tenant_id", &"<redacted>")
            .field("subject", &"<redacted>")
            .field("credential_id", &"<redacted>")
            .field("fingerprint", &self.fingerprint)
            .field("pem", &"<redacted>")
            .field("passphrase", &"<redacted>")
            .finish()
    }
}

impl Drop for StoredCredential {
    fn drop(&mut self) {
        self.pem.zeroize();
        if let Some(ref mut p) = self.passphrase {
            p.zeroize();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CredentialIndex {
    entries: Vec<String>,
}

// ─── Vault service ────────────────────────────────────────────────────────────

struct UnlockedState {
    stronghold: Stronghold,
    last_activity: Instant,
    /// Bound principal + auth session epoch at unlock (no bearer).
    binding: AuthBinding,
    snapshot_path: PathBuf,
    /// When true (test inject only), seal drops Stronghold without `save()`.
    /// Debug-profile snapshot commits are multi-second and dominate serial suites;
    /// gate/lease/race tests need seal transitions, not disk persistence.
    #[cfg(test)]
    skip_persist: bool,
}

// Keep Unlocked inline (no Box): avoid extra indirection on secret-bearing vault state.
#[allow(clippy::large_enum_variant)]
enum VaultInner {
    Locked {
        snapshot_path: PathBuf,
        reason: &'static str,
    },
    Unlocked(UnlockedState),
}

/// Lifecycle gate kind. Coordination uses [`LifecycleGate`] (Mutex+Condvar), never nested with `inner`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateKind {
    Idle,
    Operating,
    Sealing,
}

struct GateState {
    kind: GateKind,
    /// Thread that owns OPERATING (for same-thread nested lock detection).
    operating_owner: Option<ThreadId>,
    /// Count of lock/logout sealers that have published intent (waiting or sealing).
    /// While > 0, [`claim_operating`] rejects so continuous ops cannot starve logout.
    seal_waiters: u32,
}

/// Blocking lifecycle gate: seal waits on Condvar while OPERATING (no busy-spin).
/// Never held across `inner` (Stronghold) locks.
struct LifecycleGate {
    mu: Mutex<GateState>,
    cv: Condvar,
}

impl LifecycleGate {
    fn new() -> Self {
        Self {
            mu: Mutex::new(GateState {
                kind: GateKind::Idle,
                operating_owner: None,
                seal_waiters: 0,
            }),
            cv: Condvar::new(),
        }
    }
}

pub struct VaultService {
    default_snapshot: PathBuf,
    inner: Mutex<VaultInner>,
    /// Optional SSH session closer (set by desktop runtime). Closed before every seal.
    session_sink: Mutex<Option<Arc<dyn SessionLifecycleSink>>>,
    /// Gate between vault ops and seal (lock/logout/idle). Not nested with `inner`.
    lifecycle: LifecycleGate,
    /// Test-only counter at credential secret store mutation boundary (insert/delete of PEM records).
    /// Compiled out of production builds; never alters production control flow.
    #[cfg(test)]
    credential_store_writes: AtomicU64,
    /// Test-only: next lifecycle seal primitive returns `VaultError::Storage` **before**
    /// `pre_seal` (so coordinator fail-closed must still close SSH).
    #[cfg(test)]
    fail_next_lifecycle_seal_before_pre_seal: AtomicBool,
    /// Test-only: next lifecycle seal returns `VaultError::Storage` **after** `pre_seal`
    /// (proves SSH/cutoff ran while Stronghold still unlocked).
    #[cfg(test)]
    fail_next_lifecycle_seal_after_pre_seal: AtomicBool,
}

impl VaultService {
    pub fn new(default_snapshot: PathBuf) -> Self {
        Self {
            default_snapshot: default_snapshot.clone(),
            inner: Mutex::new(VaultInner::Locked {
                snapshot_path: default_snapshot,
                reason: "not_initialized",
            }),
            session_sink: Mutex::new(None),
            lifecycle: LifecycleGate::new(),
            #[cfg(test)]
            credential_store_writes: AtomicU64::new(0),
            #[cfg(test)]
            fail_next_lifecycle_seal_before_pre_seal: AtomicBool::new(false),
            #[cfg(test)]
            fail_next_lifecycle_seal_after_pre_seal: AtomicBool::new(false),
        }
    }

    /// Arm a one-shot lifecycle seal error (before pre_seal). cfg(test) only.
    #[cfg(test)]
    pub fn test_arm_lifecycle_seal_error_before_pre_seal(&self) {
        self.fail_next_lifecycle_seal_before_pre_seal
            .store(true, Ordering::SeqCst);
    }

    /// Arm a one-shot seal error after pre_seal (SSH/cutoff already applied). cfg(test) only.
    #[cfg(test)]
    pub fn test_arm_lifecycle_seal_error_after_pre_seal(&self) {
        self.fail_next_lifecycle_seal_after_pre_seal
            .store(true, Ordering::SeqCst);
    }

    #[cfg(test)]
    fn take_lifecycle_seal_error_before_pre_seal(&self) -> bool {
        self.fail_next_lifecycle_seal_before_pre_seal
            .swap(false, Ordering::SeqCst)
    }

    #[cfg(not(test))]
    fn take_lifecycle_seal_error_before_pre_seal(&self) -> bool {
        false
    }

    #[cfg(test)]
    fn take_lifecycle_seal_error_after_pre_seal(&self) -> bool {
        self.fail_next_lifecycle_seal_after_pre_seal
            .swap(false, Ordering::SeqCst)
    }

    #[cfg(not(test))]
    fn take_lifecycle_seal_error_after_pre_seal(&self) -> bool {
        false
    }

    /// Observe a credential secret store mutation. No-op outside tests.
    #[inline]
    fn note_credential_store_write(&self) {
        #[cfg(test)]
        {
            self.credential_store_writes.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Register lifecycle sink so idle/logout/lock close sessions before Stronghold seal.
    pub fn set_session_lifecycle_sink(&self, sink: Arc<dyn SessionLifecycleSink>) {
        if let Ok(mut g) = self.session_sink.lock() {
            *g = Some(sink);
        }
    }

    pub fn snapshot_path(&self) -> PathBuf {
        self.default_snapshot.clone()
    }

    /// Snapshot only — **no** idle seal side effects.
    /// Production idle sealing is exclusively via
    /// [`VaultLifecycleCoordinator`](crate::vault_lifecycle_coordinator::VaultLifecycleCoordinator)
    /// (SecurityCutoff before Stronghold).
    pub fn status(&self) -> Result<VaultStatus, VaultError> {
        self.status_without_idle_seal()
    }

    pub fn init_with_password(
        &self,
        snapshot_path: Option<PathBuf>,
        password: Zeroizing<String>,
    ) -> Result<VaultStatus, VaultError> {
        let path = snapshot_path.unwrap_or_else(|| self.default_snapshot.clone());
        if path.exists() || salt_path(&path).exists() {
            return Err(VaultError::AlreadyInitialized);
        }
        // Own Operating through final inner assignment; never clear a concurrent sealer.
        let _op = self.claim_operating()?;
        // Re-check under claim (another init may have raced before claim).
        if path.exists() || salt_path(&path).exists() {
            return Err(VaultError::AlreadyInitialized);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| VaultError::Storage)?;
        }
        let mut salt = random_salt()?;
        write_salt_file(&path, &salt)?;
        let mut key = derive_vault_key(password.as_str(), &salt)?;
        salt.zeroize();
        let sh = Stronghold::new(&path, key.clone()).map_err(|_| VaultError::Storage)?;
        key.zeroize();
        sh.create_client(CLIENT_PATH)
            .map_err(|_| VaultError::Storage)?;
        let client = sh
            .get_client(CLIENT_PATH)
            .map_err(|_| VaultError::Storage)?;
        let index =
            serde_json::to_vec(&CredentialIndex::default()).map_err(|_| VaultError::Internal)?;
        client
            .store()
            .insert(INDEX_KEY.to_vec(), index, None)
            .map_err(|_| VaultError::Storage)?;
        sh.save().map_err(|_| VaultError::Storage)?;
        {
            let mut guard = self.lock_inner()?;
            if !self.gate_is_operating() {
                // Pre-empted/raced; do not mutate lifecycle under a sealer.
                return Err(VaultError::Locked);
            }
            *guard = VaultInner::Locked {
                snapshot_path: path,
                reason: "locked",
            };
        }
        // OpGuard Drop: OPERATING -> IDLE only (never clears SEALING).
        self.status_without_idle_seal()
    }

    /// Unlock using the current AuthStore binding (captures principal+epoch first).
    pub fn unlock_with_password(
        &self,
        auth: &AuthStore,
        password: Zeroizing<String>,
    ) -> Result<VaultStatus, VaultError> {
        let binding = auth.auth_binding().ok_or(VaultError::Unauthenticated)?;
        self.unlock_with_password_for_binding(auth, &binding, password)
    }

    /// Core unlock with an **expected** binding captured before any password prompt (8A2).
    /// Revalidates binding before Stronghold work and again before installing UnlockedState.
    pub fn unlock_with_password_for_binding(
        &self,
        auth: &AuthStore,
        expected: &AuthBinding,
        password: Zeroizing<String>,
    ) -> Result<VaultStatus, VaultError> {
        if !auth.binding_still_current(expected) {
            return Err(VaultError::Unauthenticated);
        }
        let path = self.default_snapshot.clone();
        if !path.exists() {
            return Err(VaultError::NotInitialized);
        }
        // Claim Operating for the entire unlock — spans key derivation / Stronghold load
        // through final inner assignment. Concurrent logout waits (claim_sealing) until we finish.
        let _op = self.claim_operating()?;
        // Revalidate after gate claim (session may have switched while waiting).
        if !auth.binding_still_current(expected) {
            return Err(VaultError::Unauthenticated);
        }
        {
            let guard = self.lock_inner()?;
            if matches!(*guard, VaultInner::Unlocked(_)) {
                return Err(VaultError::AlreadyUnlocked);
            }
        }
        let mut salt = read_salt_file(&path)?;
        let mut key = derive_vault_key(password.as_str(), &salt)?;
        salt.zeroize();
        let sh = match Stronghold::new(&path, key.clone()) {
            Ok(s) => s,
            Err(_) => {
                key.zeroize();
                return Err(VaultError::InvalidPassword);
            }
        };
        key.zeroize();
        // Existing snapshot must already contain the vault client — never create on unlock.
        require_existing_client(&sh)?;
        // Fail closed if index missing/corrupt (missing client/index is not a blank vault).
        let _ = load_index(&sh)?;
        // Revalidate before install: same principal re-login (new epoch) must not bind.
        if !auth.binding_still_current(expected) {
            return Err(VaultError::Unauthenticated);
        }
        {
            let mut guard = self.lock_inner()?;
            // Linearization: only assign Unlocked while we still own OPERATING.
            // Never store GATE_IDLE here (would clear a concurrent sealer).
            if !self.gate_is_operating() {
                return Err(VaultError::Locked);
            }
            if matches!(*guard, VaultInner::Unlocked(_)) {
                return Err(VaultError::AlreadyUnlocked);
            }
            // Final binding check under vault lock before publish.
            if !auth.binding_still_current(expected) {
                return Err(VaultError::Unauthenticated);
            }
            *guard = VaultInner::Unlocked(UnlockedState {
                stronghold: sh,
                last_activity: Instant::now(),
                binding: expected.clone(),
                snapshot_path: path,
                #[cfg(test)]
                skip_persist: false,
            });
        }
        // OpGuard Drop: OPERATING -> IDLE only.
        self.status_without_idle_seal()
    }

    pub fn lock(&self) -> Result<VaultStatus, VaultError> {
        self.lock_with_reason("locked")
    }

    /// Close SSH sessions (if sink set), then seal Stronghold. Sessions close **before** seal.
    ///
    /// Wait/preemption protocol: never blind-overwrite OPERATING. Wait until gate is IDLE,
    /// then CAS IDLE→SEALING. Concurrent unlock/init holding OPERATING finish first (or fail);
    /// sealer then closes sessions and seals. RAII [`SealGuard`] always clears SEALING.
    fn lock_with_reason(&self, reason: &'static str) -> Result<VaultStatus, VaultError> {
        let _seal = self.claim_sealing()?;
        self.close_all_sessions_before_seal();
        self.seal_vault(reason)?;
        drop(_seal);
        self.status_without_idle_seal()
    }

    /// Status snapshot without running idle seal (used under Operating/Sealing claims).
    fn status_without_idle_seal(&self) -> Result<VaultStatus, VaultError> {
        let guard = self.lock_inner()?;
        match &*guard {
            VaultInner::Locked {
                snapshot_path,
                reason,
            } => Ok(VaultStatus {
                unlocked: false,
                locked_reason: Some(resolve_locked_reason(snapshot_path, reason).to_string()),
            }),
            VaultInner::Unlocked(_) => Ok(VaultStatus {
                unlocked: true,
                locked_reason: None,
            }),
        }
    }

    fn seal_vault(&self, reason: &'static str) -> Result<(), VaultError> {
        let mut guard = self.lock_inner()?;
        let path = match &*guard {
            VaultInner::Locked { snapshot_path, .. } => snapshot_path.clone(),
            VaultInner::Unlocked(u) => {
                #[cfg(test)]
                let skip = u.skip_persist;
                #[cfg(not(test))]
                let skip = false;
                if !skip {
                    let _ = u.stronghold.save();
                }
                u.snapshot_path.clone()
            }
        };
        *guard = VaultInner::Locked {
            snapshot_path: path,
            reason,
        };
        Ok(())
    }

    fn gate_is_operating(&self) -> bool {
        self.lifecycle
            .mu
            .lock()
            .map(|g| g.kind == GateKind::Operating)
            .unwrap_or(false)
    }

    /// Claim OPERATING. Rejects while SEALING **or** any seal waiter is pending
    /// (logout/lock requested and waiting). Never clears SEALING. RAII [`OpGuard`] notifies.
    fn claim_operating(&self) -> Result<OpGuard<'_>, VaultError> {
        let mut g = self.lifecycle.mu.lock().map_err(|_| VaultError::Internal)?;
        // Pending sealers outrank new ops even if kind is still Operating/Idle mid-handoff.
        if g.seal_waiters > 0 || g.kind == GateKind::Sealing {
            return Err(VaultError::Locked);
        }
        match g.kind {
            GateKind::Idle => {
                g.kind = GateKind::Operating;
                g.operating_owner = Some(std::thread::current().id());
                Ok(OpGuard(self))
            }
            GateKind::Operating => Err(VaultError::Internal),
            GateKind::Sealing => Err(VaultError::Locked),
        }
    }

    /// Publish seal intent (`seal_waiters++`) under the gate mutex **before** waiting,
    /// then block on Condvar until IDLE and take SEALING. No busy-spin.
    /// Same-thread nested lock while holding OPERATING → Internal (not infinite wait).
    /// Multiple concurrent sealers are serialized; Condvar wake order is **not** FIFO.
    /// Never held across `inner` locks.
    fn claim_sealing(&self) -> Result<SealGuard<'_>, VaultError> {
        let mut g = self.lifecycle.mu.lock().map_err(|_| VaultError::Internal)?;
        let me = std::thread::current().id();
        // Publish intent first so claim_operating cannot sneak in after OpGuard release.
        g.seal_waiters = g.seal_waiters.saturating_add(1);
        // RAII ticket: clears waiter if we leave without transferring ownership to SealGuard.
        // **Must not Drop while `g` is held** — debit under `g` and disarm before any early return.
        struct WaiterTicket<'a> {
            v: &'a VaultService,
            live: bool,
        }
        impl Drop for WaiterTicket<'_> {
            fn drop(&mut self) {
                if !self.live {
                    return;
                }
                // Only runs when mutex is not held by this thread (e.g. panic after g dropped).
                if let Ok(mut g) = self.v.lifecycle.mu.lock() {
                    g.seal_waiters = g.seal_waiters.saturating_sub(1);
                    self.v.lifecycle.cv.notify_all();
                }
            }
        }
        let mut ticket = WaiterTicket {
            v: self,
            live: true,
        };

        loop {
            match g.kind {
                GateKind::Idle => {
                    // Win the seal; keep seal_waiters until SealGuard Drop (blocks new ops).
                    g.kind = GateKind::Sealing;
                    g.operating_owner = None;
                    ticket.live = false; // SealGuard owns waiter debit
                    drop(g); // release before return (clear drop order)
                    return Ok(SealGuard {
                        vault: self,
                        owns_waiter: true,
                    });
                }
                GateKind::Operating => {
                    if g.operating_owner == Some(me) {
                        // Debit under the existing guard; disarm ticket so Drop does not re-lock.
                        g.seal_waiters = g.seal_waiters.saturating_sub(1);
                        ticket.live = false;
                        self.lifecycle.cv.notify_all();
                        drop(g);
                        return Err(VaultError::Internal);
                    }
                    g = match self.lifecycle.cv.wait(g) {
                        Ok(ng) => ng,
                        Err(e) => {
                            // Poisoned wait: debit under recovered guard; never re-lock in Drop.
                            let mut pg = e.into_inner();
                            pg.seal_waiters = pg.seal_waiters.saturating_sub(1);
                            ticket.live = false;
                            self.lifecycle.cv.notify_all();
                            drop(pg);
                            return Err(VaultError::Internal);
                        }
                    };
                }
                GateKind::Sealing => {
                    // Another sealer holds SEALING; wait for their SealGuard to finish.
                    g = match self.lifecycle.cv.wait(g) {
                        Ok(ng) => ng,
                        Err(e) => {
                            let mut pg = e.into_inner();
                            pg.seal_waiters = pg.seal_waiters.saturating_sub(1);
                            ticket.live = false;
                            self.lifecycle.cv.notify_all();
                            drop(pg);
                            return Err(VaultError::Internal);
                        }
                    };
                }
            }
        }
    }

    /// Non-blocking seal for idle watchdog: skip if not fully Idle (incl. pending sealers).
    /// Does **not** set seal_waiters / pending when it skips.
    fn try_claim_sealing(&self) -> Result<Option<SealGuard<'_>>, VaultError> {
        let mut g = self.lifecycle.mu.lock().map_err(|_| VaultError::Internal)?;
        if g.kind != GateKind::Idle || g.seal_waiters > 0 {
            return Ok(None);
        }
        g.kind = GateKind::Sealing;
        g.operating_owner = None;
        Ok(Some(SealGuard {
            vault: self,
            owns_waiter: false,
        }))
    }

    fn end_op(&self) {
        if let Ok(mut g) = self.lifecycle.mu.lock() {
            if g.kind == GateKind::Operating {
                g.kind = GateKind::Idle;
                g.operating_owner = None;
                // Wake seal waiters that published seal_waiters while we ran.
                self.lifecycle.cv.notify_all();
            }
        }
    }

    fn end_seal(&self, owns_waiter: bool) {
        if let Ok(mut g) = self.lifecycle.mu.lock() {
            if g.kind == GateKind::Sealing {
                g.kind = GateKind::Idle;
                g.operating_owner = None;
            }
            if owns_waiter {
                g.seal_waiters = g.seal_waiters.saturating_sub(1);
            }
            self.lifecycle.cv.notify_all();
        }
    }

    /// Begin a vault op. Never nests gate waits with `inner` holds.
    ///
    /// If idle-expired while unlocked: return `Locked` **without** sealing Stronghold and
    /// **without** refreshing activity. Production idle seal (cutoff-before-seal) is only via
    /// the lifecycle coordinator / watchdog tick.
    fn enter_op(&self) -> Result<OpGuard<'_>, VaultError> {
        // Observe vault without holding the gate.
        {
            let guard = self.lock_inner()?;
            match &*guard {
                VaultInner::Locked { .. } => return Err(VaultError::Locked),
                VaultInner::Unlocked(u) if u.last_activity.elapsed() >= VAULT_IDLE_TIMEOUT => {
                    // Fail closed: do not seal here (would bypass SecurityCutoff).
                    return Err(VaultError::Locked);
                }
                VaultInner::Unlocked(_) => {}
            }
        }

        let op = self.claim_operating()?;

        {
            let guard = self.lock_inner()?;
            match &*guard {
                VaultInner::Locked { .. } => {
                    drop(op);
                    return Err(VaultError::Locked);
                }
                VaultInner::Unlocked(u) if u.last_activity.elapsed() >= VAULT_IDLE_TIMEOUT => {
                    // Expired under claim — fail without seal and without touching last_activity.
                    drop(op);
                    return Err(VaultError::Locked);
                }
                VaultInner::Unlocked(_) => {}
            }
        }
        Ok(op)
    }

    fn close_all_sessions_before_seal(&self) {
        let sink = self
            .session_sink
            .lock()
            .ok()
            .and_then(|g| g.as_ref().cloned());
        if let Some(s) = sink {
            // No vault lock held — transport close must not contend with Stronghold.
            s.close_all_sessions();
        }
    }

    fn close_sessions_for_principal_credential(
        &self,
        principal: &NativePrincipal,
        credential_id: &str,
    ) {
        let sink = self
            .session_sink
            .lock()
            .ok()
            .and_then(|g| g.as_ref().cloned());
        if let Some(s) = sink {
            s.close_sessions_for_credential(principal, credential_id);
        }
    }

    /// Read-only: unlocked and last activity older than [`VAULT_IDLE_TIMEOUT`].
    /// No seal, no SSH, no side effects (for coordinator pre-check only — not authoritative).
    pub fn idle_timeout_due(&self) -> bool {
        self.inner
            .lock()
            .map(|g| match &*g {
                VaultInner::Unlocked(u) => u.last_activity.elapsed() >= VAULT_IDLE_TIMEOUT,
                VaultInner::Locked { .. } => false,
            })
            .unwrap_or(false)
    }

    /// Read-only unlocked probe for lifecycle (crate-internal).
    pub(crate) fn is_unlocked_inner(&self) -> bool {
        self.inner
            .lock()
            .map(|g| matches!(*g, VaultInner::Unlocked(_)))
            .unwrap_or(false)
    }

    /// Idle TOCTOU-safe seal: claim SEALING, recheck unlocked+idle under claim, then
    /// `pre_seal` (SSH cutoff) only if still due, then seal. If activity refreshed →
    /// `NotNeeded` with **zero** pre_seal side effects.
    pub fn seal_if_still_idle_with_pre_seal<F>(
        &self,
        pre_seal: F,
    ) -> Result<SealAttempt, VaultError>
    where
        F: FnOnce(),
    {
        // Nonblocking: if Operating or another sealer, skip this tick (watchdog retries).
        let Some(_seal_guard) = self.try_claim_sealing()? else {
            return Ok(SealAttempt::NotNeeded);
        };
        let still_due = {
            let guard = self.lock_inner()?;
            match &*guard {
                VaultInner::Unlocked(u) => u.last_activity.elapsed() >= VAULT_IDLE_TIMEOUT,
                VaultInner::Locked { .. } => false,
            }
        };
        if !still_due {
            // Drop SealGuard → release SEALING; pre_seal never ran.
            return Ok(SealAttempt::NotNeeded);
        }
        // Still unlocked + idle under SEALING (no concurrent op can refresh activity).
        if self.take_lifecycle_seal_error_before_pre_seal() {
            return Err(VaultError::Storage);
        }
        pre_seal();
        if self.take_lifecycle_seal_error_after_pre_seal() {
            return Err(VaultError::Storage);
        }
        self.close_all_sessions_before_seal();
        self.seal_vault("idle_timeout")?;
        Ok(SealAttempt::Sealed)
    }

    /// Unlocked seal with pre-seal callback under SEALING claim (sleep / exit / wake / user lock).
    /// Rechecks unlocked after claim; if already locked → `NotNeeded` (no pre_seal).
    pub fn seal_if_unlocked_with_pre_seal<F>(
        &self,
        reason: &'static str,
        pre_seal: F,
    ) -> Result<SealAttempt, VaultError>
    where
        F: FnOnce(),
    {
        if !self.is_unlocked_inner() {
            return Ok(SealAttempt::NotNeeded);
        }
        // Blocking claim: wait for OPERATING ops to finish (exit/sleep must complete).
        let _seal_guard = self.claim_sealing()?;
        if !self.is_unlocked_inner() {
            return Ok(SealAttempt::NotNeeded);
        }
        if self.take_lifecycle_seal_error_before_pre_seal() {
            return Err(VaultError::Storage);
        }
        pre_seal();
        if self.take_lifecycle_seal_error_after_pre_seal() {
            return Err(VaultError::Storage);
        }
        self.close_all_sessions_before_seal();
        self.seal_vault(reason)?;
        Ok(SealAttempt::Sealed)
    }

    pub fn on_logout(&self) -> Result<(), VaultError> {
        let _ = self.lock_with_reason("logout")?;
        Ok(())
    }

    /// Seal on successful re-login / principal transition (keeps snapshot path).
    pub fn seal_for_principal_change(&self) -> Result<(), VaultError> {
        let _ = self.lock_with_reason("principal_changed")?;
        Ok(())
    }

    /// True when Stronghold is currently unlocked (test probe only).
    #[cfg(test)]
    pub fn is_unlocked(&self) -> bool {
        self.is_unlocked_inner()
    }

    /// Map vault errors to fixed public IPC codes (never raw secret text).
    pub fn map_vault_public(e: VaultError) -> &'static str {
        match e {
            VaultError::Locked => "vault_locked",
            VaultError::AlreadyUnlocked => "vault_already_unlocked",
            VaultError::NotInitialized => "vault_not_initialized",
            VaultError::AlreadyInitialized => "vault_already_initialized",
            VaultError::InvalidPassword => "vault_invalid_password",
            VaultError::InvalidIdentity => "vault_invalid_identity",
            VaultError::Unauthenticated => "vault_unauthenticated",
            VaultError::NotFound => "vault_not_found",
            VaultError::InvalidPrivateKey => "vault_invalid_private_key",
            VaultError::PromptCancelled => "vault_prompt_cancelled",
            VaultError::PromptFailed => "vault_prompt_failed",
            VaultError::Storage => "vault_storage_error",
            VaultError::Internal => "vault_internal_error",
            VaultError::ObserverUnavailable => "vault_observer_unavailable",
        }
    }

    /// If current auth binding differs from unlocked vault binding (principal or epoch), seal.
    /// Missing/poisoned auth → logout seal. Same principal with newer epoch → principal_changed.
    pub fn observe_binding(&self, auth: &AuthStore) -> Result<(), VaultError> {
        let action = {
            let guard = self.lock_inner()?;
            if let VaultInner::Unlocked(u) = &*guard {
                match auth.auth_binding() {
                    None => Some("logout"),
                    Some(b) if b != u.binding => Some("principal_changed"),
                    _ => None,
                }
            } else {
                None
            }
        };
        if let Some(reason) = action {
            let _ = self.lock_with_reason(reason)?;
        }
        Ok(())
    }

    /// Seal fail-closed when `expected` is no longer current or vault binding diverges.
    /// Returns Unauthenticated after seal when mismatch (never leaves stale unlock usable).
    fn ensure_binding_live(
        &self,
        auth: &AuthStore,
        expected: &AuthBinding,
    ) -> Result<(), VaultError> {
        self.observe_binding(auth)?;
        if !auth.binding_still_current(expected) {
            // Seal any unlock that might still match old principal under a new epoch.
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }
        // If vault is unlocked under a different binding, observe already sealed;
        // re-check unlocked state matches expected when unlocked.
        let guard = self.lock_inner()?;
        match &*guard {
            VaultInner::Locked { .. } => {
                // Already sealed by observe or was locked — ops that need unlocked fail later.
                Ok(())
            }
            VaultInner::Unlocked(u) if u.binding != *expected => {
                drop(guard);
                let _ = self.lock_with_reason("principal_changed");
                Err(VaultError::Unauthenticated)
            }
            VaultInner::Unlocked(_) => Ok(()),
        }
    }

    pub fn import_pem(
        &self,
        auth: &AuthStore,
        credential_id: &str,
        pem: Zeroizing<String>,
        passphrase: Option<Zeroizing<String>>,
    ) -> Result<VaultImportResponse, VaultError> {
        let binding = auth.auth_binding().ok_or(VaultError::Unauthenticated)?;
        self.import_pem_with_binding(auth, &binding, credential_id, pem, passphrase)
    }

    /// Import under a captured binding (used by native prompt path after post-prompt revalidation).
    pub fn import_pem_with_binding(
        &self,
        auth: &AuthStore,
        expected: &AuthBinding,
        credential_id: &str,
        pem: Zeroizing<String>,
        passphrase: Option<Zeroizing<String>>,
    ) -> Result<VaultImportResponse, VaultError> {
        validate_id(credential_id)?;
        self.ensure_binding_live(auth, expected)?;

        let pass_ref = passphrase.as_ref().map(|p| p.as_str());
        let key =
            decode_secret_key(pem.as_str(), pass_ref).map_err(|_| VaultError::InvalidPrivateKey)?;
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        drop(key);

        let principal = &expected.principal;
        let store_key = make_key(&principal.tenant_id, &principal.subject, credential_id)?;

        let _op = self.enter_op()?;
        // After gate: revalidate before any write.
        if !auth.binding_still_current(expected) {
            drop(_op);
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }
        let mut guard = self.lock_inner()?;
        let u = match &mut *guard {
            VaultInner::Unlocked(u) => u,
            VaultInner::Locked { .. } => return Err(VaultError::Locked),
        };
        if u.binding != *expected {
            drop(guard);
            drop(_op);
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }
        u.last_activity = Instant::now();

        let mut record = StoredCredential {
            tenant_id: principal.tenant_id.clone(),
            subject: principal.subject.clone(),
            credential_id: credential_id.to_string(),
            fingerprint: fingerprint.clone(),
            pem: pem.to_string(),
            passphrase: passphrase.as_ref().map(|p| p.to_string()),
        };
        // RAII: Zeroizing wipes caller-side serialized PEM/passphrase on every path
        // (including early Storage errors). Stronghold keeps its own stored copy.
        let secret_bytes = secret_json_bytes(&record)?;
        record.pem.zeroize();
        if let Some(ref mut p) = record.passphrase {
            p.zeroize();
        }

        {
            let client = u
                .stronghold
                .get_client(CLIENT_PATH)
                .or_else(|_| u.stronghold.load_client(CLIENT_PATH))
                .map_err(|_| VaultError::Storage)?;
            // Credential secret mutation boundary (test observer hooks here only).
            self.note_credential_store_write();
            client
                .store()
                .insert(store_key.as_bytes().to_vec(), secret_bytes.to_vec(), None)
                .map_err(|_| VaultError::Storage)?;
            // secret_bytes Drop zeroizes remaining caller buffer

            let mut index: CredentialIndex = load_index(&u.stronghold)?;
            if !index.entries.iter().any(|e| e == &store_key) {
                index.entries.push(store_key);
            }
            let index_bytes = serde_json::to_vec(&index).map_err(|_| VaultError::Internal)?;
            client
                .store()
                .insert(INDEX_KEY.to_vec(), index_bytes, None)
                .map_err(|_| VaultError::Storage)?;
        }
        u.stronghold.save().map_err(|_| VaultError::Storage)?;
        drop(guard);
        drop(_op);

        // Before success return: binding still exact.
        if !auth.binding_still_current(expected) {
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }

        Ok(VaultImportResponse {
            credential_id: credential_id.to_string(),
            fingerprint,
        })
    }

    pub fn list_meta(&self, auth: &AuthStore) -> Result<Vec<VaultMetaItem>, VaultError> {
        let expected = auth.auth_binding().ok_or(VaultError::Unauthenticated)?;
        self.ensure_binding_live(auth, &expected)?;
        let _op = self.enter_op()?;
        if !auth.binding_still_current(&expected) {
            drop(_op);
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }
        let mut guard = self.lock_inner()?;
        let u = match &mut *guard {
            VaultInner::Unlocked(u) => u,
            VaultInner::Locked { .. } => return Err(VaultError::Locked),
        };
        if u.binding != expected {
            drop(guard);
            drop(_op);
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }
        u.last_activity = Instant::now();
        let principal = &expected.principal;
        let index = load_index(&u.stronghold)?;
        let prefix = namespace_prefix(&principal.tenant_id, &principal.subject)?;
        let client = u
            .stronghold
            .get_client(CLIENT_PATH)
            .or_else(|_| u.stronghold.load_client(CLIENT_PATH))
            .map_err(|_| VaultError::Storage)?;
        let mut out = Vec::new();
        for k in &index.entries {
            if !k.starts_with(&prefix) {
                continue;
            }
            let raw = match client.store().get(k.as_bytes()) {
                Ok(Some(b)) => Zeroizing::new(b),
                // Index points at missing key or store I/O failed — fail closed.
                Ok(None) | Err(_) => return Err(VaultError::Storage),
            };
            let rec = match serde_json::from_slice::<StoredCredential>(&raw) {
                Ok(r) => r,
                Err(_) => {
                    // raw Drop zeroizes on early return
                    return Err(VaultError::Storage);
                }
            };
            drop(raw); // wipe store blob before further work
                       // Record must match authenticated principal and the index key.
            if rec.tenant_id != principal.tenant_id || rec.subject != principal.subject {
                return Err(VaultError::Storage);
            }
            let expected_key = make_key(&rec.tenant_id, &rec.subject, &rec.credential_id)?;
            if expected_key != *k {
                return Err(VaultError::Storage);
            }
            out.push(VaultMetaItem {
                credential_id: rec.credential_id.clone(),
                fingerprint: rec.fingerprint.clone(),
                device_present: true,
            });
            // rec Drop zeroizes pem/passphrase
        }
        drop(guard);
        drop(_op);
        if !auth.binding_still_current(&expected) {
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }
        Ok(out)
    }

    pub fn delete_local(&self, auth: &AuthStore, credential_id: &str) -> Result<(), VaultError> {
        validate_id(credential_id)?;
        let expected = auth.auth_binding().ok_or(VaultError::Unauthenticated)?;
        self.ensure_binding_live(auth, &expected)?;
        let principal = &expected.principal;
        let key = make_key(&principal.tenant_id, &principal.subject, credential_id)?;
        // Obtain op claim **before** any session close side effects.
        // Failed Locked/Internal from enter_op must not close sessions.
        let _op = self.enter_op()?;
        if !auth.binding_still_current(&expected) {
            drop(_op);
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }
        // Scoped close only after claim + binding check; principal-bound (tenant isolation).
        // Never close/delete under a recaptured principal from a different session.
        {
            let guard = self.lock_inner()?;
            match &*guard {
                VaultInner::Unlocked(u) if u.binding == expected => {}
                VaultInner::Unlocked(_) => {
                    drop(guard);
                    drop(_op);
                    let _ = self.lock_with_reason("principal_changed");
                    return Err(VaultError::Unauthenticated);
                }
                VaultInner::Locked { .. } => return Err(VaultError::Locked),
            }
        }
        self.close_sessions_for_principal_credential(principal, credential_id);
        let mut guard = self.lock_inner()?;
        let u = match &mut *guard {
            VaultInner::Unlocked(u) => u,
            VaultInner::Locked { .. } => return Err(VaultError::Locked),
        };
        if u.binding != expected {
            drop(guard);
            drop(_op);
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }
        u.last_activity = Instant::now();
        {
            let client = u
                .stronghold
                .get_client(CLIENT_PATH)
                .or_else(|_| u.stronghold.load_client(CLIENT_PATH))
                .map_err(|_| VaultError::Storage)?;
            // Credential secret mutation boundary (delete).
            self.note_credential_store_write();
            let deleted = client
                .store()
                .delete(key.as_bytes())
                .map_err(|_| VaultError::Storage)?;
            let Some(blob) = deleted else {
                return Err(VaultError::NotFound);
            };
            // RAII wipe of deleted secret blob (not the remaining Stronghold state).
            let _blob = Zeroizing::new(blob);
            let mut index = load_index(&u.stronghold)?;
            index.entries.retain(|e| e != &key);
            let index_bytes = serde_json::to_vec(&index).map_err(|_| VaultError::Internal)?;
            client
                .store()
                .insert(INDEX_KEY.to_vec(), index_bytes, None)
                .map_err(|_| VaultError::Storage)?;
        }
        u.stronghold.save().map_err(|_| VaultError::Storage)?;
        drop(guard);
        drop(_op);
        if !auth.binding_still_current(&expected) {
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }
        Ok(())
    }

    pub fn import_begin_native(
        &self,
        auth: &AuthStore,
        prompt: &dyn SecurePrompt,
        req: &VaultImportRequest,
    ) -> Result<VaultImportResponse, VaultError> {
        validate_id(&req.credential_id)?;
        // Capture binding **before** any native prompt so a mid-prompt session switch
        // cannot write into a newly installed principal/epoch namespace.
        let expected = auth.auth_binding().ok_or(VaultError::Unauthenticated)?;
        // Native-only file-vs-paste choice — WebView never supplies a mode flag.
        let pem = prompt.choose_pem_import()?;
        let passphrase = prompt.prompt_passphrase(
            "Key passphrase",
            "Optional passphrase (leave empty if none)",
        )?;
        // Immediately after prompts: exact binding still required (zero write on mismatch).
        if !auth.binding_still_current(&expected) {
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }
        self.import_pem_with_binding(auth, &expected, &req.credential_id, pem, passphrase)
    }

    /// Internal lease for SSH connect. Never exposed as a Tauri command.
    /// Validates credential_id, auth epoch+principal binding, vault principal/unlocked/idle,
    /// and Stronghold record identity before returning PEM/passphrase.
    pub fn lease_for_ssh(
        &self,
        auth: &AuthStore,
        expected_principal: &NativePrincipal,
        expected_epoch: u64,
        credential_id: &str,
    ) -> Result<VaultCredentialLease, VaultError> {
        validate_id(credential_id)?;
        let expected = AuthBinding {
            principal: expected_principal.clone(),
            epoch: expected_epoch,
        };
        if !auth.binding_still_current(&expected) {
            return Err(VaultError::Unauthenticated);
        }
        self.ensure_binding_live(auth, &expected)?;
        let _op = self.enter_op()?;
        if !auth.binding_still_current(&expected) {
            drop(_op);
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }

        let store_key = make_key(
            &expected_principal.tenant_id,
            &expected_principal.subject,
            credential_id,
        )?;

        // Load secret bytes under lock; release Stronghold lock before constructing lease.
        let raw = {
            let mut guard = self.lock_inner()?;
            let u = match &mut *guard {
                VaultInner::Unlocked(u) => u,
                VaultInner::Locked { .. } => return Err(VaultError::Locked),
            };
            // Vault-bound principal **and** epoch must match caller expectation.
            if u.binding != expected {
                return Err(VaultError::Unauthenticated);
            }
            u.last_activity = Instant::now();
            let client = u
                .stronghold
                .get_client(CLIENT_PATH)
                .or_else(|_| u.stronghold.load_client(CLIENT_PATH))
                .map_err(|_| VaultError::Storage)?;
            // Index must list this key (fail closed if index missing/corrupt).
            let index = load_index(&u.stronghold)?;
            if !index.entries.iter().any(|e| e == &store_key) {
                return Err(VaultError::NotFound);
            }
            match client.store().get(store_key.as_bytes()) {
                Ok(Some(b)) => Zeroizing::new(b),
                Ok(None) | Err(_) => return Err(VaultError::NotFound),
            }
        };

        if !auth.binding_still_current(&expected) {
            let _ = self.lock_with_reason("principal_changed");
            return Err(VaultError::Unauthenticated);
        }

        let rec: StoredCredential =
            serde_json::from_slice(&raw).map_err(|_| VaultError::Storage)?;
        drop(raw);

        if rec.tenant_id != expected_principal.tenant_id
            || rec.subject != expected_principal.subject
            || rec.credential_id != credential_id
        {
            return Err(VaultError::Storage);
        }
        let expected_key = make_key(&rec.tenant_id, &rec.subject, &rec.credential_id)?;
        if expected_key != store_key {
            return Err(VaultError::Storage);
        }

        Ok(VaultCredentialLease {
            credential_id: rec.credential_id.clone(),
            fingerprint: rec.fingerprint.clone(),
            pem: Zeroizing::new(rec.pem.clone()),
            passphrase: rec.passphrase.as_ref().map(|p| Zeroizing::new(p.clone())),
        })
        // rec Drop zeroizes pem/passphrase in StoredCredential
    }

    fn lock_inner(&self) -> Result<std::sync::MutexGuard<'_, VaultInner>, VaultError> {
        self.inner.lock().map_err(|_| VaultError::Internal)
    }

    /// Test-only: credential secret store mutation count on this service instance.
    #[cfg(test)]
    pub fn test_credential_store_write_count(&self) -> u64 {
        self.credential_store_writes.load(Ordering::SeqCst)
    }

    /// Test-only: inject unlocked Stronghold without Argon2 init cycle.
    #[cfg(test)]
    pub fn test_inject_unlocked(
        &self,
        stronghold: Stronghold,
        binding: AuthBinding,
        snapshot_path: PathBuf,
        last_activity: Instant,
    ) {
        *self.inner.lock().expect("vault lock") = VaultInner::Unlocked(UnlockedState {
            stronghold,
            last_activity,
            binding,
            snapshot_path,
            // Injected fixtures seal for lifecycle only; skip multi-second debug snapshot commit.
            skip_persist: true,
        });
    }

    /// Test seam: attempt to install unlocked under OPERATING without Argon2/Stronghold open.
    /// Used to prove stale expected binding cannot install UnlockedState.
    #[cfg(test)]
    pub fn test_try_install_unlocked_for_binding(
        &self,
        auth: &AuthStore,
        expected: &AuthBinding,
        stronghold: Stronghold,
        snapshot_path: PathBuf,
    ) -> Result<(), VaultError> {
        if !auth.binding_still_current(expected) {
            return Err(VaultError::Unauthenticated);
        }
        let _op = self.claim_operating()?;
        if !auth.binding_still_current(expected) {
            return Err(VaultError::Unauthenticated);
        }
        {
            let mut guard = self.lock_inner()?;
            if !self.gate_is_operating() {
                return Err(VaultError::Locked);
            }
            if matches!(*guard, VaultInner::Unlocked(_)) {
                return Err(VaultError::AlreadyUnlocked);
            }
            if !auth.binding_still_current(expected) {
                return Err(VaultError::Unauthenticated);
            }
            *guard = VaultInner::Unlocked(UnlockedState {
                stronghold,
                last_activity: Instant::now(),
                binding: expected.clone(),
                snapshot_path,
                skip_persist: true,
            });
        }
        Ok(())
    }

    /// Test-only: hold Operating gate around `f` (no idle check). RAII-safe on panic.
    #[cfg(test)]
    pub fn test_with_operating_gate<R>(&self, f: impl FnOnce() -> R) -> Result<R, VaultError> {
        let _op = self.claim_operating()?;
        Ok(f())
    }

    /// Test-only: refresh last_activity while unlocked.
    #[cfg(test)]
    pub fn test_touch_activity(&self) {
        let mut g = self.inner.lock().expect("vault lock");
        if let VaultInner::Unlocked(u) = &mut *g {
            u.last_activity = Instant::now();
        }
    }

    /// Test-only: read gate for assertions.
    #[cfg(test)]
    pub fn test_gate_is_idle(&self) -> bool {
        self.lifecycle
            .mu
            .lock()
            .map(|g| g.kind == GateKind::Idle && g.seal_waiters == 0)
            .unwrap_or(false)
    }

    /// Test-only: true if a sealer has published intent (waiting or holding SEALING).
    #[cfg(test)]
    pub fn test_seal_pending(&self) -> bool {
        self.lifecycle
            .mu
            .lock()
            .map(|g| g.seal_waiters > 0 || g.kind == GateKind::Sealing)
            .unwrap_or(false)
    }

    /// Test-only: simulate unlock under OPERATING claim (no Argon2).
    /// After claim: `ready.wait()`, then `hold.wait()` while OPERATING, then assign Unlocked.
    #[cfg(test)]
    pub fn test_simulate_unlock_under_operating(
        &self,
        binding: AuthBinding,
        stronghold: Stronghold,
        snapshot_path: PathBuf,
        ready: &std::sync::Barrier,
        hold: &std::sync::Barrier,
    ) -> Result<(), VaultError> {
        let _op = self.claim_operating()?;
        ready.wait(); // published OPERATING
        hold.wait(); // sealer blocks on Condvar here
        {
            let mut guard = self.lock_inner()?;
            if !self.gate_is_operating() {
                return Err(VaultError::Locked);
            }
            *guard = VaultInner::Unlocked(UnlockedState {
                stronghold,
                last_activity: Instant::now(),
                binding,
                snapshot_path,
                skip_persist: true,
            });
        }
        Ok(()) // OpGuard releases OPERATING + notify
    }

    /// Test-only: claim OPERATING (RAII) for race tests. Returns unit; guard drops at end of call.
    #[cfg(test)]
    #[allow(dead_code)]
    pub fn test_claim_operating_then<R>(&self, f: impl FnOnce() -> R) -> Result<R, VaultError> {
        let _op = self.claim_operating()?;
        Ok(f())
    }
}

// ─── Op gate RAII ────────────────────────────────────────────────────────────

/// Clears OPERATING on drop and notifies seal waiters; never clobbers SEALING.
struct OpGuard<'a>(&'a VaultService);

impl Drop for OpGuard<'_> {
    fn drop(&mut self) {
        self.0.end_op();
    }
}

/// Clears SEALING → IDLE on drop; decrements `seal_waiters` when this sealer published intent.
struct SealGuard<'a> {
    vault: &'a VaultService,
    /// True when obtained via [`VaultService::claim_sealing`] (waiter counted).
    owns_waiter: bool,
}

impl Drop for SealGuard<'_> {
    fn drop(&mut self) {
        self.vault.end_seal(self.owns_waiter);
    }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/// Map stored seal reason + filesystem presence to user-facing locked_reason.
/// Explicit operational reasons (idle/logout/principal) always win over path heuristics.
fn resolve_locked_reason(snapshot_path: &Path, reason: &'static str) -> &'static str {
    match reason {
        // Fixed lifecycle / user-lock reasons always surface as-is (secret-free codes).
        "idle_timeout" | "logout" | "principal_changed" | "system_sleep" | "process_exit"
        | "locked" => reason,
        "not_initialized" if snapshot_path.exists() && salt_path(snapshot_path).exists() => {
            "locked"
        }
        _ if !snapshot_path.exists() || !salt_path(snapshot_path).exists() => "not_initialized",
        other => other,
    }
}

fn salt_path(snapshot: &Path) -> PathBuf {
    let mut p = snapshot.as_os_str().to_os_string();
    p.push(".salt");
    PathBuf::from(p)
}

fn random_salt() -> Result<Vec<u8>, VaultError> {
    use crate::auth::{RandomSource, SystemRandomSource};
    let mut salt = vec![0u8; SALT_LEN];
    SystemRandomSource
        .fill_bytes(&mut salt)
        .map_err(|_| VaultError::Storage)?;
    Ok(salt)
}

fn write_salt_file(snapshot: &Path, salt: &[u8]) -> Result<(), VaultError> {
    let sp = salt_path(snapshot);
    std::fs::write(&sp, salt).map_err(|_| VaultError::Storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&sp, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn read_salt_file(snapshot: &Path) -> Result<Vec<u8>, VaultError> {
    let sp = salt_path(snapshot);
    let salt = std::fs::read(&sp).map_err(|_| VaultError::Storage)?;
    if salt.len() != SALT_LEN {
        return Err(VaultError::Storage);
    }
    Ok(salt)
}

/// Production Argon2id configuration.
///
/// Uses `rust-argon2` `Config::default()`: Argon2id, m=19456 KiB (19 MiB), t=2, p=1,
/// hash_len=32. Justification vs Stronghold: `iota_stronghold::KeyProvider::try_from`
/// stores a pre-derived 32-byte key and does **not** run Argon2; passphrase helpers
/// only Blake2b-hash. Our outer Argon2id therefore supplies password hardness. These
/// defaults match the crate’s PHC-aligned profile and are stronger than the historical
/// `Config::original()` (m=4096, t=3, Argon2i). **Do not weaken for tests** — use
/// [`test_only_argon2_config`] for fast unit checks of salt/key variance only.
pub fn production_argon2_config<'a>() -> Config<'a> {
    Config::default()
}

/// Test-only weak Argon2id (not used by production `derive_vault_key`).
#[cfg(test)]
pub fn test_only_argon2_config<'a>() -> Config<'a> {
    Config {
        variant: argon2::Variant::Argon2id,
        hash_length: 32,
        lanes: 1,
        mem_cost: 1024,
        time_cost: 1,
        ..Default::default()
    }
}

pub fn derive_vault_key_with_config(
    password: &str,
    salt: &[u8],
    config: &Config<'_>,
) -> Result<Vec<u8>, VaultError> {
    if salt.len() != SALT_LEN {
        return Err(VaultError::Storage);
    }
    argon2::hash_raw(password.as_bytes(), salt, config).map_err(|_| VaultError::Storage)
}

/// Production password → 32-byte vault key (Argon2id + per-vault salt).
pub fn derive_vault_key(password: &str, salt: &[u8]) -> Result<Vec<u8>, VaultError> {
    derive_vault_key_with_config(password, salt, &production_argon2_config())
}

/// Encode a namespace component so `/` and other raw separators cannot collide.
/// Uses unpadded base64url of UTF-8 bytes; rejects empty/control input.
pub fn encode_ns_component(s: &str) -> Result<String, VaultError> {
    if s.is_empty() || s.len() > 256 {
        return Err(VaultError::InvalidIdentity);
    }
    if s.chars().any(|c| c.is_control() || c == '\0') {
        return Err(VaultError::InvalidIdentity);
    }
    Ok(crate::auth::base64url_nopad(s.as_bytes()))
}

pub fn namespace_prefix(tenant_id: &str, subject: &str) -> Result<String, VaultError> {
    let t = encode_ns_component(tenant_id)?;
    let s = encode_ns_component(subject)?;
    Ok(format!("{t}/{s}/"))
}

/// Build store key: `base64url(tenant)/base64url(subject)/credential_id`.
/// Never uses username / user_id.
pub fn make_key(tenant_id: &str, subject: &str, credential_id: &str) -> Result<String, VaultError> {
    validate_id(credential_id)?;
    let prefix = namespace_prefix(tenant_id, subject)?;
    Ok(format!("{prefix}{credential_id}"))
}

/// Strict conservative id allowlist for credential_id: `[A-Za-z0-9._-]+`, no
/// leading/trailing dots, no `..`, no path separators / control / whitespace.
pub fn validate_id(id: &str) -> Result<(), VaultError> {
    if id.is_empty() || id.len() > 128 {
        return Err(VaultError::InvalidIdentity);
    }
    if id.starts_with('.') || id.ends_with('.') || id.contains("..") {
        return Err(VaultError::InvalidIdentity);
    }
    if id.contains('/') || id.contains('\\') || id.contains('\0') {
        return Err(VaultError::InvalidIdentity);
    }
    if id.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(VaultError::InvalidIdentity);
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(VaultError::InvalidIdentity);
    }
    Ok(())
}

/// Unlock path: client must already exist in the snapshot (corruption if missing).
/// Never creates a blank client on unlock — only `init_with_password` creates CLIENT_PATH.
fn require_existing_client(sh: &Stronghold) -> Result<(), VaultError> {
    if sh.get_client(CLIENT_PATH).is_ok() {
        return Ok(());
    }
    if sh.load_client(CLIENT_PATH).is_ok() {
        return Ok(());
    }
    Err(VaultError::Storage)
}

/// Serialize secret-bearing value into a RAII-zeroized buffer.
/// Drop always wipes the caller-side `Vec` on success and error paths.
fn secret_json_bytes<T: Serialize>(value: &T) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    Ok(Zeroizing::new(
        serde_json::to_vec(value).map_err(|_| VaultError::Internal)?,
    ))
}

/// Load credential index. Fail closed on missing client, missing entry, store I/O, or bad JSON.
/// Zeroizes the raw store buffer on every path via `Zeroizing`. Only init seeds the default index.
fn load_index(sh: &Stronghold) -> Result<CredentialIndex, VaultError> {
    let client = sh
        .get_client(CLIENT_PATH)
        .or_else(|_| sh.load_client(CLIENT_PATH))
        .map_err(|_| VaultError::Storage)?;
    let raw = match client.store().get(INDEX_KEY) {
        Ok(Some(b)) => Zeroizing::new(b),
        Ok(None) | Err(_) => return Err(VaultError::Storage),
    };
    let parsed = serde_json::from_slice::<CredentialIndex>(&raw);
    // raw Drop zeroizes
    parsed.map_err(|_| VaultError::Storage)
}

pub fn default_snapshot_path(app_data: &Path) -> PathBuf {
    app_data.join("opsmate-vault.hold")
}

/// Parse PEM and return SSH SHA256 fingerprint string (OpenSSH format).
pub fn fingerprint_from_pem(pem: &str, passphrase: Option<&str>) -> Result<String, VaultError> {
    let key = decode_secret_key(pem, passphrase).map_err(|_| VaultError::InvalidPrivateKey)?;
    Ok(key.fingerprint(HashAlg::Sha256).to_string())
}

#[cfg(test)]
mod tests;
