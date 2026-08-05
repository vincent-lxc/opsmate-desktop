//! 8B3a — russh handshake + fail-closed host-key policy (no PTY / shell / IPC).
//!
//! Order: split prepared → decode lease PEM once → drop lease → TCP/KEX/publickey
//! under one overall deadline. Host keys only via [`russh::client::Handler::check_server_key`].
//!
//! **Non-claims:** no PTY, shell actor, Tauri SSH IPC, React terminal, upload, AI.

// Production wiring (IPC open path) reserved for later 8B nodes; unit-tested here.
#![cfg_attr(not(test), allow(dead_code))]

use super::prepare::{LocalSshConnectAuthority, LocalSshError, PreparedHostKey};
use super::session::{LocalSshSessionManager, SessionCloseHandle, TicketBarrierSnapshot};
use crate::auth::{AuthBinding, AuthStore, NativePrincipal};
use crate::security_cutoff::SecurityCutoff;
use crate::vault::{validate_id, VaultCredentialLease};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zeroize::{Zeroize, Zeroizing};

/// Overall TCP + KEX + public-key auth deadline.
pub const HANDSHAKE_OVERALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Bounded disconnect after partial connect.
const TEARDOWN_BUDGET: Duration = Duration::from_secs(2);

// ─── Host-key domain ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresentedHostKey {
    pub key_type: String,
    pub fingerprint: String,
}

/// Safe native TOFU prompt fields only (no tenant/subject/bearer/PEM).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TofuPrompt {
    pub host: String,
    pub key_type: String,
    pub fingerprint: String,
}

/// Cloud CAS pin params — no bearer.
/// Wire body fields match backend `HostKeyBodySchema`: `host_key_type`, `fingerprint`,
/// optional/nullable `expected_fingerprint`. Path id is separate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudHostKeyParams {
    pub server_id: String,
    pub host_key_type: String,
    /// Backend wire field name is `fingerprint` (not `host_key_fingerprint`).
    pub fingerprint: String,
    /// Initial TOFU: None → JSON null (optional on the wire).
    pub expected_fingerprint: Option<String>,
}

/// JSON body for POST `/api/servers/{id}/host-key` (no bearer, no server id).
pub fn cloud_host_key_body(params: &CloudHostKeyParams) -> Value {
    json!({
        "expected_fingerprint": params.expected_fingerprint,
        "host_key_type": params.host_key_type,
        "fingerprint": params.fingerprint,
    })
}

/// Business input for native transport: path `id` + wire body fields.
pub fn cloud_host_key_business_input(params: &CloudHostKeyParams) -> Value {
    let mut body = cloud_host_key_body(params)
        .as_object()
        .cloned()
        .unwrap_or_default();
    body.insert("id".into(), Value::String(params.server_id.clone()));
    Value::Object(body)
}

pub trait HostKeyConfirmer: Send + Sync {
    fn confirm_tofu(&self, prompt: &TofuPrompt) -> Result<bool, LocalSshError>;
}

/// Object-safe async cloud CAS writer (no `block_in_place` / nested runtime).
pub trait CloudHostKeyWriter: Send + Sync {
    fn write_host_key<'a>(
        &'a self,
        params: &'a CloudHostKeyParams,
        bearer: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), LocalSshError>> + Send + 'a>>;
}

pub trait LocalKnownHosts: Send + Sync {
    /// Persist under opaque [`local_known_hosts_namespace`] only.
    fn record_host_key(
        &self,
        namespace: &str,
        key_type: &str,
        fingerprint: &str,
    ) -> Result<(), LocalSshError>;
}

/// Revalidate auth binding + cutoff + optional ticket/registry barriers during TOFU.
pub trait ConnectAuthorityRevalidator: Send + Sync {
    fn ensure_still_valid(&self) -> Result<(), LocalSshError>;
}

/// Default revalidator: exact principal+epoch + SSH generation + vault gate unlocked.
pub struct BindingCutoffRevalidator {
    pub auth: Arc<AuthStore>,
    pub cutoff: Arc<SecurityCutoff>,
    pub expected: AuthBinding,
    pub ssh_generation: u64,
}

impl ConnectAuthorityRevalidator for BindingCutoffRevalidator {
    fn ensure_still_valid(&self) -> Result<(), LocalSshError> {
        if !self
            .auth
            .session_binding_current(&self.expected.principal, self.expected.epoch)
        {
            return Err(LocalSshError::BindingMismatch);
        }
        if self.cutoff.is_vault_locked() {
            return Err(LocalSshError::VaultLocked);
        }
        if !self.cutoff.ssh_session_still_valid(self.ssh_generation) {
            return Err(LocalSshError::SshCutoff);
        }
        Ok(())
    }
}

/// Ticket/registry barriers: close_all / credential close must invalidate mid-TOFU.
pub struct TicketRegistryRevalidator {
    pub manager: Arc<LocalSshSessionManager>,
    pub barriers: TicketBarrierSnapshot,
}

impl ConnectAuthorityRevalidator for TicketRegistryRevalidator {
    fn ensure_still_valid(&self) -> Result<(), LocalSshError> {
        self.manager.ensure_ticket_barriers_current(&self.barriers)
    }
}

/// Production revalidator: auth/cutoff **and** ticket/registry barriers (always chained).
pub fn production_handshake_revalidator(
    auth: Arc<AuthStore>,
    cutoff: Arc<SecurityCutoff>,
    expected: AuthBinding,
    ssh_generation: u64,
    manager: Arc<LocalSshSessionManager>,
    barriers: TicketBarrierSnapshot,
) -> Arc<dyn ConnectAuthorityRevalidator> {
    Arc::new(ChainedRevalidator {
        first: Arc::new(BindingCutoffRevalidator {
            auth,
            cutoff,
            expected,
            ssh_generation,
        }),
        second: Arc::new(TicketRegistryRevalidator { manager, barriers }),
    })
}

/// Opaque known-hosts namespace: `kh/v1/{sha256_hex(tenant||0x1f||subject)}/{server_id}`.
pub fn local_known_hosts_namespace(
    principal: &NativePrincipal,
    server_id: &str,
) -> Result<String, LocalSshError> {
    validate_ns_component(&principal.tenant_id)?;
    validate_ns_component(&principal.subject)?;
    validate_id(server_id).map_err(|_| LocalSshError::InvalidInput)?;
    let mut h = Sha256::new();
    h.update(principal.tenant_id.as_bytes());
    h.update([0x1f]);
    h.update(principal.subject.as_bytes());
    let hex = hex::encode(h.finalize());
    Ok(format!("kh/v1/{hex}/{server_id}"))
}

fn validate_ns_component(s: &str) -> Result<(), LocalSshError> {
    if s.is_empty() || s != s.trim() || s.chars().any(|c| c.is_control()) {
        return Err(LocalSshError::InvalidInput);
    }
    Ok(())
}

pub fn presented_host_key_from_russh(
    server_public_key: &russh::keys::PublicKey,
) -> PresentedHostKey {
    use russh::keys::HashAlg;
    PresentedHostKey {
        key_type: server_public_key.algorithm().as_str().to_string(),
        fingerprint: server_public_key.fingerprint(HashAlg::Sha256).to_string(),
    }
}

/// Evaluate presented key against mutable policy snapshot.
///
/// Pinned: exact type+fingerprint, no prompt/cloud/bearer.
/// Unpinned TOFU: confirm → cloud CAS → revalidate → local KH → **pin policy for rekey**.
/// After a successful TOFU, later checks see a pinned key (zero prompt/cloud/bearer).
pub async fn verify_server_host_key(
    policy: &mut HostKeyPolicySnapshot,
    presented: &PresentedHostKey,
    confirmer: &dyn HostKeyConfirmer,
    cloud: &dyn CloudHostKeyWriter,
    local_kh: &dyn LocalKnownHosts,
    revalidator: &dyn ConnectAuthorityRevalidator,
    bearer: Option<&str>,
) -> Result<(), LocalSshError> {
    revalidator.ensure_still_valid()?;

    let p_type = presented.key_type.trim();
    let p_fp = presented.fingerprint.trim();
    if p_type.is_empty() || p_fp.is_empty() {
        return Err(LocalSshError::InvalidMetadata);
    }

    match &policy.host_key {
        Some(PreparedHostKey {
            key_type: m_type,
            fingerprint: m_fp,
        }) => {
            if m_type.trim() == p_type && m_fp.trim() == p_fp {
                // Pinned accept: no bearer / prompt / cloud.
                revalidator.ensure_still_valid()?;
                let ns = local_known_hosts_namespace(&policy.principal, &policy.server_id)?;
                local_kh.record_host_key(&ns, p_type, p_fp)?;
                revalidator.ensure_still_valid()?;
                Ok(())
            } else {
                Err(LocalSshError::HostKeyMismatch)
            }
        }
        None => {
            // Unpinned TOFU — bearer required for cloud CAS.
            let bearer = bearer.ok_or(LocalSshError::Unauthenticated)?;
            let prompt = TofuPrompt {
                host: policy.target_host.clone(),
                key_type: p_type.to_string(),
                fingerprint: p_fp.to_string(),
            };
            if !confirmer.confirm_tofu(&prompt)? {
                return Err(LocalSshError::HostKeyRejectedByUser);
            }
            revalidator.ensure_still_valid()?;
            let params = CloudHostKeyParams {
                server_id: policy.server_id.clone(),
                host_key_type: p_type.to_string(),
                fingerprint: p_fp.to_string(),
                expected_fingerprint: None,
            };
            cloud.write_host_key(&params, bearer).await?;
            revalidator.ensure_still_valid()?;
            let ns = local_known_hosts_namespace(&policy.principal, &policy.server_id)?;
            local_kh.record_host_key(&ns, p_type, p_fp)?;
            revalidator.ensure_still_valid()?;
            // Rekey safety: subsequent checks treat this as pinned (no second TOFU).
            policy.host_key = Some(PreparedHostKey {
                key_type: p_type.to_string(),
                fingerprint: p_fp.to_string(),
            });
            Ok(())
        }
    }
}

// ─── russh Handler ───────────────────────────────────────────────────────────

/// One-shot bearer: taken at most once at `check_server_key`, then gone.
/// Shared so tests prove emptiness after handshake; never stored on established transport.
#[derive(Default)]
pub struct EphemeralBearer {
    inner: Mutex<Option<Zeroizing<String>>>,
}

impl EphemeralBearer {
    pub fn new(bearer: Zeroizing<String>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Some(bearer)),
        })
    }

    fn take(&self) -> Option<Zeroizing<String>> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).take()
    }

    /// True when the slot is empty (spent or never installed).
    pub fn is_spent(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_none()
    }
}

impl Drop for EphemeralBearer {
    fn drop(&mut self) {
        if let Ok(mut g) = self.inner.lock() {
            if let Some(mut b) = g.take() {
                b.zeroize();
            }
        }
    }
}

/// Minimal secret-free policy snapshot for the long-lived russh handler.
/// Built from borrowed authority fields — does **not** require `LocalSshConnectAuthority: Clone`.
/// Selected fields may `Clone`; the full authority stays single-owned in `HandshakeResult`.
#[derive(Clone)]
pub struct HostKeyPolicySnapshot {
    pub server_id: String,
    pub target_host: String,
    pub host_key: Option<PreparedHostKey>,
    pub principal: NativePrincipal,
}

impl HostKeyPolicySnapshot {
    pub fn from_authority(authority: &LocalSshConnectAuthority) -> Self {
        Self {
            server_id: authority.server_id.clone(),
            target_host: authority.target_host.clone(),
            host_key: authority.host_key.clone(),
            principal: authority.principal.clone(),
        }
    }
}

impl std::fmt::Debug for HostKeyPolicySnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostKeyPolicySnapshot")
            .field("server_id", &"<redacted>")
            .field("target_host", &"<redacted>")
            .field("host_key", &self.host_key.as_ref().map(|_| "<present>"))
            .field("principal", &"<redacted>")
            .finish()
    }
}

/// Owned `'static` russh client handler — host-key only at `check_server_key`.
pub struct HostKeyPolicyHandler {
    policy: HostKeyPolicySnapshot,
    confirmer: Arc<dyn HostKeyConfirmer>,
    cloud: Arc<dyn CloudHostKeyWriter>,
    local_kh: Arc<dyn LocalKnownHosts>,
    revalidator: Arc<dyn ConnectAuthorityRevalidator>,
    /// One-shot for first TOFU only; pinned path / rekey does not take bearer.
    bearer: Arc<EphemeralBearer>,
}

impl HostKeyPolicyHandler {
    pub fn new(
        authority: &LocalSshConnectAuthority,
        confirmer: Arc<dyn HostKeyConfirmer>,
        cloud: Arc<dyn CloudHostKeyWriter>,
        local_kh: Arc<dyn LocalKnownHosts>,
        revalidator: Arc<dyn ConnectAuthorityRevalidator>,
        bearer: Arc<EphemeralBearer>,
    ) -> Self {
        Self {
            policy: HostKeyPolicySnapshot::from_authority(authority),
            confirmer,
            cloud,
            local_kh,
            revalidator,
            bearer,
        }
    }

    /// Test/helper: run host-key policy without a full TCP connect.
    pub async fn check_presented_for_tests(
        &mut self,
        presented: &PresentedHostKey,
    ) -> Result<(), LocalSshError> {
        self.apply_presented(presented).await
    }

    async fn apply_presented(&mut self, presented: &PresentedHostKey) -> Result<(), LocalSshError> {
        // Always take the one-shot slot so established transport never retains bearer.
        // Pinned path does not *use* bearer for cloud; TOFU borrows the Zeroizing until await ends.
        let bearer_owned = self.bearer.take();
        let is_pinned = self.policy.host_key.is_some();
        let result = if is_pinned {
            verify_server_host_key(
                &mut self.policy,
                presented,
                self.confirmer.as_ref(),
                self.cloud.as_ref(),
                self.local_kh.as_ref(),
                self.revalidator.as_ref(),
                None,
            )
            .await
        } else {
            let bearer = bearer_owned.as_ref().map(|b| b.as_str());
            verify_server_host_key(
                &mut self.policy,
                presented,
                self.confirmer.as_ref(),
                self.cloud.as_ref(),
                self.local_kh.as_ref(),
                self.revalidator.as_ref(),
                bearer,
            )
            .await
        };
        drop(bearer_owned);
        result
    }
}

impl From<russh::Error> for LocalSshError {
    fn from(_: russh::Error) -> Self {
        LocalSshError::ConnectFailed
    }
}

impl russh::client::Handler for HostKeyPolicyHandler {
    type Error = LocalSshError;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let presented = presented_host_key_from_russh(server_public_key);
        self.apply_presented(&presented).await?;
        Ok(true)
    }
}

// ─── Production native TOFU (rfd only; no new deps) ──────────────────────────

/// Production host-key confirmer; wired by later native open path (crate-internal surface).
#[derive(Debug, Default, Clone, Copy)]
#[allow(dead_code)]
pub struct NativeTofuConfirmer;

impl HostKeyConfirmer for NativeTofuConfirmer {
    fn confirm_tofu(&self, prompt: &TofuPrompt) -> Result<bool, LocalSshError> {
        use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
        let description = format!(
            "Host: {}\nKey type: {}\nFingerprint: {}\n\nAccept this host key?",
            prompt.host, prompt.key_type, prompt.fingerprint
        );
        let result = MessageDialog::new()
            .set_level(MessageLevel::Warning)
            .set_title("Confirm SSH host key")
            .set_description(&description)
            .set_buttons(MessageButtons::OkCancel)
            .show();
        Ok(matches!(result, MessageDialogResult::Ok))
    }
}

// ─── Local known-hosts filesystem sink ───────────────────────────────────────

/// Filesystem known-hosts sink; production integration surface not yet fully wired.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct FsLocalKnownHosts {
    root: std::path::PathBuf,
}

#[allow(dead_code)] // methods used via LocalKnownHosts when production wires FsLocalKnownHosts
impl FsLocalKnownHosts {
    pub fn new(root: impl Into<std::path::PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path_for_namespace(&self, namespace: &str) -> Result<std::path::PathBuf, LocalSshError> {
        if namespace.is_empty()
            || namespace.starts_with('/')
            || namespace.contains('\0')
            || namespace
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == "..")
        {
            return Err(LocalSshError::LocalKnownHostsFailed);
        }
        let mut path = self.root.clone();
        for seg in namespace.split('/') {
            path.push(seg);
        }
        if !path.starts_with(&self.root) {
            return Err(LocalSshError::LocalKnownHostsFailed);
        }
        Ok(path)
    }

    fn ensure_dir_0700(path: &std::path::Path) -> Result<(), LocalSshError> {
        if !path.exists() {
            std::fs::create_dir_all(path).map_err(|_| LocalSshError::LocalKnownHostsFailed)?;
        }
        let meta =
            std::fs::symlink_metadata(path).map_err(|_| LocalSshError::LocalKnownHostsFailed)?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(LocalSshError::LocalKnownHostsFailed);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| LocalSshError::LocalKnownHostsFailed)?;
        }
        Ok(())
    }
}

impl LocalKnownHosts for FsLocalKnownHosts {
    fn record_host_key(
        &self,
        namespace: &str,
        key_type: &str,
        fingerprint: &str,
    ) -> Result<(), LocalSshError> {
        use std::io::Write;
        let path = self.path_for_namespace(namespace)?;
        Self::ensure_dir_0700(&self.root)?;
        if let Some(parent) = path.parent() {
            let rel = parent
                .strip_prefix(&self.root)
                .map_err(|_| LocalSshError::LocalKnownHostsFailed)?;
            let mut walk = self.root.clone();
            for seg in rel.components() {
                walk.push(seg);
                Self::ensure_dir_0700(&walk)?;
            }
        }
        let body = format!("{key_type} {fingerprint}\n");
        let tmp = path.with_extension(format!(
            "tmp.{}-{}.part",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        let mut file = opts
            .open(&tmp)
            .map_err(|_| LocalSshError::LocalKnownHostsFailed)?;
        if file.write_all(body.as_bytes()).is_err() || file.sync_all().is_err() {
            drop(file);
            let _ = std::fs::remove_file(&tmp);
            return Err(LocalSshError::LocalKnownHostsFailed);
        }
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        if std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return Err(LocalSshError::LocalKnownHostsFailed);
        }
        Ok(())
    }
}

// ─── Established handle + close ──────────────────────────────────────────────

/// Hard wait bound for protocol disconnect after the handle is already fenced.
const CLOSE_WAIT_BOUND: Duration = Duration::from_secs(3);

/// Live russh session after successful handshake (no channel/PTY).
pub struct EstablishedLocalSsh {
    handle: Mutex<Option<russh::client::Handle<HostKeyPolicyHandler>>>,
    closed: AtomicBool,
    disconnects: AtomicU32,
    /// Test-only: extra sleep inside teardown worker (simulates hung disconnect).
    teardown_sleep: Mutex<Option<Duration>>,
}

impl std::fmt::Debug for EstablishedLocalSsh {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EstablishedLocalSsh")
            .field("closed", &self.closed.load(Ordering::SeqCst))
            .field("disconnects", &self.disconnects.load(Ordering::SeqCst))
            .field("fenced", &self.is_fenced())
            .finish_non_exhaustive()
    }
}

impl EstablishedLocalSsh {
    fn new(handle: russh::client::Handle<HostKeyPolicyHandler>) -> Arc<Self> {
        Arc::new(Self {
            handle: Mutex::new(Some(handle)),
            closed: AtomicBool::new(false),
            disconnects: AtomicU32::new(0),
            teardown_sleep: Mutex::new(None),
        })
    }

    pub fn disconnect_count(&self) -> u32 {
        self.disconnects.load(Ordering::SeqCst)
    }

    /// Immediate authority fence: handle slot is empty (not that protocol disconnect finished).
    pub fn is_fenced(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
            && self
                .handle
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_none()
    }

    /// Test inject: make the teardown worker sleep before protocol disconnect.
    #[cfg(test)]
    pub fn set_teardown_sleep_for_tests(&self, d: Duration) {
        *self
            .teardown_sleep
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(d);
    }

    /// Synchronously **fence** the handle, then best-effort wait for protocol disconnect.
    ///
    /// 1. Take the handle under mutex (authority fence) — no further use after return.
    /// 2. Spawn a worker that only owns the fenced handle to disconnect/drop.
    /// 3. If worker finishes within bound, join it; if timeout, return **without** join
    ///    (worker may still complete disconnect later; it holds no bearer/capability).
    ///
    /// Idempotent: second call is a no-op (no double disconnect).
    pub fn disconnect_now(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        // Immediate fence: take handle before any wait.
        let handle = {
            let mut g = match self.handle.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            g.take()
        };
        let Some(handle) = handle else {
            return;
        };
        self.disconnects.fetch_add(1, Ordering::SeqCst);
        let sleep_extra = self
            .teardown_sleep
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();

        let (tx, rx) = std::sync::mpsc::sync_channel::<()>(1);
        let worker = std::thread::Builder::new()
            .name("opsmate-ssh-disconnect".into())
            .spawn(move || {
                if let Some(d) = sleep_extra {
                    std::thread::sleep(d);
                }
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                if let Ok(rt) = rt {
                    rt.block_on(async {
                        let _ = tokio::time::timeout(TEARDOWN_BUDGET, async {
                            let _ = handle
                                .disconnect(russh::Disconnect::ByApplication, "", "en")
                                .await;
                        })
                        .await;
                    });
                }
                let _ = tx.send(());
            });

        match rx.recv_timeout(CLOSE_WAIT_BOUND) {
            Ok(()) => {
                // Completion arrived within bound — join for cleanliness.
                if let Ok(jh) = worker {
                    let _ = jh.join();
                }
            }
            Err(_) => {
                // Timeout: already fenced; do **not** join (would unbound the wait).
                // Worker retains only the fenced handle to finish disconnect/drop.
                drop(worker);
            }
        }
    }
}

impl SessionCloseHandle for EstablishedLocalSsh {
    fn on_close(&self) {
        self.disconnect_now();
    }
}

impl EstablishedLocalSsh {
    /// Fence without protocol disconnect — transfer handle into the 8B3b transport actor.
    /// Returns `None` if already closed/fenced.
    pub fn take_handle_for_transport(&self) -> Option<russh::client::Handle<HostKeyPolicyHandler>> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return None;
        }
        self.handle.lock().unwrap_or_else(|p| p.into_inner()).take()
    }
}

/// Successful handshake: secret-free authority retained for `complete_established`
/// plus a close handle that fences the live russh session.
pub struct HandshakeResult {
    pub authority: LocalSshConnectAuthority,
    pub connection: Arc<EstablishedLocalSsh>,
    /// Shared one-shot bearer gate (spent after host-key check). Not the transport.
    bearer: Arc<EphemeralBearer>,
    /// Overall setup deadline start (handshake); transport continues under the same budget.
    pub setup_started: std::time::Instant,
}

impl HandshakeResult {
    /// Convenience close handle; transport open prefers `into_transport_parts`.
    #[allow(dead_code)]
    pub fn close_handle(&self) -> Arc<dyn SessionCloseHandle> {
        self.connection.clone()
    }

    /// Bearer slot is empty after successful host-key check (pinned or TOFU).
    pub fn bearer_is_spent(&self) -> bool {
        self.bearer.is_spent()
    }

    /// Split for transport: authority (complete_established) + live handle (actor).
    /// Does **not** clone bearer or authority; drops spent bearer gate.
    /// Marks connection fenced so disconnect_now is a no-op (actor owns the handle).
    pub fn into_transport_parts(
        self,
    ) -> Result<
        (
            LocalSshConnectAuthority,
            russh::client::Handle<HostKeyPolicyHandler>,
            std::time::Instant,
        ),
        LocalSshError,
    > {
        let handle = self
            .connection
            .take_handle_for_transport()
            .ok_or(LocalSshError::Internal)?;
        let started = self.setup_started;
        drop(self.bearer);
        Ok((self.authority, handle, started))
    }
}

impl std::fmt::Debug for HandshakeResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HandshakeResult")
            .field("authority", &self.authority)
            .field("connection", &self.connection)
            .field("bearer_spent", &self.bearer.is_spent())
            .finish()
    }
}

// ─── Handshake ───────────────────────────────────────────────────────────────

/// Inputs for production/test handshake (adapters injected for determinism).
pub struct HandshakeDeps {
    pub auth: Arc<AuthStore>,
    pub cutoff: Arc<SecurityCutoff>,
    pub confirmer: Arc<dyn HostKeyConfirmer>,
    pub cloud: Arc<dyn CloudHostKeyWriter>,
    pub local_kh: Arc<dyn LocalKnownHosts>,
    /// Session manager + ticket barriers — **required** for production TOFU revalidation.
    pub session_manager: Arc<LocalSshSessionManager>,
    pub ticket_barriers: TicketBarrierSnapshot,
    /// Extra revalidation hooks (tests); always chained after auth/cutoff + ticket barriers.
    pub extra_revalidator: Option<Arc<dyn ConnectAuthorityRevalidator>>,
    pub overall_timeout: Duration,
}

/// Connect + publickey under one deadline. Drops lease after decode.
/// On any failure after TCP handle exists, disconnects once with bounded cleanup.
///
/// Returns secret-free `authority` (for `complete_established`) plus a close handle.
/// Bearer is one-shot inside the host-key handler and does not survive the handshake.
pub async fn establish_local_ssh_handshake(
    authority: LocalSshConnectAuthority,
    lease: VaultCredentialLease,
    deps: HandshakeDeps,
) -> Result<HandshakeResult, LocalSshError> {
    use russh::client;
    use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};

    let host = authority.target_host.clone();
    let port = authority.ssh_port;
    let username = authority.ssh_user.clone();
    let timeout = if deps.overall_timeout.is_zero() {
        HANDSHAKE_OVERALL_TIMEOUT
    } else {
        deps.overall_timeout
    };
    let setup_started = std::time::Instant::now();
    let deadline = tokio::time::Instant::now() + timeout;

    let expected = AuthBinding {
        principal: authority.principal.clone(),
        epoch: authority.epoch,
    };
    // Always: auth/cutoff + ticket/registry (production TOFU post-cloud revalidation).
    let mut revalidator = production_handshake_revalidator(
        deps.auth.clone(),
        deps.cutoff.clone(),
        expected.clone(),
        authority.ssh_generation,
        deps.session_manager.clone(),
        deps.ticket_barriers.clone(),
    );
    if let Some(extra) = deps.extra_revalidator {
        revalidator = Arc::new(ChainedRevalidator {
            first: revalidator,
            second: extra,
        });
    }
    revalidator.ensure_still_valid()?;

    let snap = deps
        .auth
        .native_auth_snapshot()
        .ok_or(LocalSshError::Unauthenticated)?;
    if snap.principal != authority.principal || snap.epoch != authority.epoch {
        return Err(LocalSshError::BindingMismatch);
    }
    let bearer_gate = EphemeralBearer::new(snap.bearer);

    let pass_ref = lease.passphrase.as_ref().map(|p| p.as_str());
    let key = match decode_secret_key(lease.pem.as_str(), pass_ref) {
        Ok(k) => k,
        Err(_) => {
            drop(lease);
            return Err(LocalSshError::AuthenticationFailed);
        }
    };
    // Exactly one lease consumed; zeroize via Drop.
    drop(lease);

    // Handler builds a minimal policy snapshot from borrowed authority fields.
    let handler = HostKeyPolicyHandler::new(
        &authority,
        deps.confirmer,
        deps.cloud,
        deps.local_kh,
        revalidator,
        Arc::clone(&bearer_gate),
    );
    let config = Arc::new(client::Config::default());

    let mut handle = match timeout_at(
        deadline,
        client::connect(config, (host.as_str(), port), handler),
    )
    .await
    {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            // Host-key typed errors from Handler must surface.
            return Err(e);
        }
        Err(_) => return Err(LocalSshError::ConnectFailed),
    };

    let hash_alg = match timeout_at(deadline, handle.best_supported_rsa_hash()).await {
        Ok(Ok(v)) => v.flatten(),
        Ok(Err(_)) | Err(_) => {
            disconnect_bounded(&mut handle, deadline).await;
            return Err(LocalSshError::AuthenticationFailed);
        }
    };
    let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);

    match timeout_at(deadline, handle.authenticate_publickey(username, key)).await {
        Ok(Ok(client::AuthResult::Success)) => {}
        Ok(Ok(_)) | Ok(Err(_)) | Err(_) => {
            disconnect_bounded(&mut handle, deadline).await;
            return Err(LocalSshError::AuthenticationFailed);
        }
    }

    debug_assert!(bearer_gate.is_spent());
    Ok(HandshakeResult {
        authority,
        connection: EstablishedLocalSsh::new(handle),
        bearer: bearer_gate,
        setup_started,
    })
}

/// Production cloud CAS writer via `CloudTransport::invoke_native` (not WebView IPC).
/// Awaits directly — no `block_in_place` / nested `block_on`.
pub struct NativeTransportHostKeyWriter<B, H>
where
    B: crate::cloud_transport::HttpBackend + 'static,
    H: crate::cloud_transport::SessionLifecycleHooks + 'static,
{
    transport: Arc<crate::cloud_transport::CloudTransport<B, H>>,
    auth_epoch: u64,
}

impl<B, H> NativeTransportHostKeyWriter<B, H>
where
    B: crate::cloud_transport::HttpBackend + 'static,
    H: crate::cloud_transport::SessionLifecycleHooks + 'static,
{
    pub fn new(
        transport: Arc<crate::cloud_transport::CloudTransport<B, H>>,
        auth_epoch: u64,
    ) -> Self {
        Self {
            transport,
            auth_epoch,
        }
    }
}

impl<B, H> CloudHostKeyWriter for NativeTransportHostKeyWriter<B, H>
where
    B: crate::cloud_transport::HttpBackend + 'static,
    H: crate::cloud_transport::SessionLifecycleHooks + 'static,
{
    fn write_host_key<'a>(
        &'a self,
        params: &'a CloudHostKeyParams,
        bearer: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), LocalSshError>> + Send + 'a>> {
        Box::pin(async move {
            let input = cloud_host_key_business_input(params);
            // Borrow one-shot bearer for the await only — never clone into plain String.
            map_host_key_transport_err(
                self.transport
                    .invoke_native(
                        "servers.host_key",
                        &input,
                        Some(bearer),
                        Some(self.auth_epoch),
                    )
                    .await,
            )
        })
    }
}

/// Production adapter on `CloudBridge::call_native` (same native-only gate).
/// Constructed when production open path attaches cloud host-key writes.
#[allow(dead_code)]
pub struct BridgeHostKeyWriter<B>
where
    B: crate::cloud_transport::HttpBackend + 'static,
{
    bridge: Arc<crate::cloud_bridge::CloudBridge<B>>,
}

impl<B> BridgeHostKeyWriter<B>
where
    B: crate::cloud_transport::HttpBackend + 'static,
{
    #[allow(dead_code)] // production CloudBridge wiring
    pub fn new(bridge: Arc<crate::cloud_bridge::CloudBridge<B>>) -> Self {
        Self { bridge }
    }
}

impl<B> CloudHostKeyWriter for BridgeHostKeyWriter<B>
where
    B: crate::cloud_transport::HttpBackend + 'static,
{
    fn write_host_key<'a>(
        &'a self,
        params: &'a CloudHostKeyParams,
        _bearer: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), LocalSshError>> + Send + 'a>> {
        // call_native snapshots bearer from AuthStore under its own lock.
        Box::pin(async move {
            let input = cloud_host_key_business_input(params);
            map_host_key_transport_err(self.bridge.call_native("servers.host_key", &input).await)
        })
    }
}

fn map_host_key_transport_err(
    result: Result<serde_json::Value, crate::cloud_transport::TransportError>,
) -> Result<(), LocalSshError> {
    match result {
        Ok(_) => Ok(()),
        Err(crate::cloud_transport::TransportError::Unauthenticated) => {
            Err(LocalSshError::Unauthenticated)
        }
        Err(crate::cloud_transport::TransportError::SessionInvalidated) => {
            Err(LocalSshError::BindingMismatch)
        }
        Err(crate::cloud_transport::TransportError::NativeOnly) => {
            // Should never surface from invoke_native/call_native for this op.
            Err(LocalSshError::Internal)
        }
        Err(_) => Err(LocalSshError::CloudHostKeyWriteFailed),
    }
}

struct ChainedRevalidator {
    first: Arc<dyn ConnectAuthorityRevalidator>,
    second: Arc<dyn ConnectAuthorityRevalidator>,
}

impl ConnectAuthorityRevalidator for ChainedRevalidator {
    fn ensure_still_valid(&self) -> Result<(), LocalSshError> {
        self.first.ensure_still_valid()?;
        self.second.ensure_still_valid()
    }
}

async fn timeout_at<F, T>(deadline: tokio::time::Instant, fut: F) -> Result<T, ()>
where
    F: std::future::Future<Output = T>,
{
    match tokio::time::timeout_at(deadline, fut).await {
        Ok(v) => Ok(v),
        Err(_) => Err(()),
    }
}

async fn disconnect_bounded(
    handle: &mut russh::client::Handle<HostKeyPolicyHandler>,
    setup_deadline: tokio::time::Instant,
) {
    let now = tokio::time::Instant::now();
    let dl = if setup_deadline > now {
        setup_deadline
    } else {
        now + TEARDOWN_BUDGET
    };
    let _ = tokio::time::timeout_at(dl, async {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    })
    .await;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::AuthStore;
    use crate::security_cutoff::SecurityCutoff;
    use crate::vault::VaultCredentialLease;
    use russh::keys::decode_secret_key;
    use russh::server::{self, Auth, Server as _};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AO};
    use std::time::Duration;
    use tokio::net::TcpListener;
    use zeroize::Zeroizing;

    // Unencrypted ed25519 fixtures (no new deps / no rand).
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

    fn host_public() -> russh::keys::PublicKey {
        decode_secret_key(HOST_PEM, None)
            .unwrap()
            .public_key()
            .clone()
    }

    fn host_presented() -> PresentedHostKey {
        presented_host_key_from_russh(&host_public())
    }

    fn host_fp() -> String {
        host_presented().fingerprint
    }

    fn authed() -> Arc<AuthStore> {
        let a = Arc::new(AuthStore::new());
        a.install_session_for_tests("ten-a", "alice", "admin", "sub-a");
        a
    }

    fn authority(auth: &AuthStore, pinned: Option<PreparedHostKey>) -> LocalSshConnectAuthority {
        let b = auth.auth_binding().unwrap();
        LocalSshConnectAuthority {
            server_id: "srv-1".into(),
            credential_id: "cred-1".into(),
            target_host: "127.0.0.1".into(),
            ssh_port: 22,
            ssh_user: "admin".into(),
            host_key: pinned,
            principal: b.principal.clone(),
            epoch: b.epoch,
            ssh_generation: 1,
        }
    }

    fn lease_user() -> VaultCredentialLease {
        VaultCredentialLease {
            credential_id: "cred-1".into(),
            fingerprint: "SHA256:user".into(),
            pem: Zeroizing::new(USER_PEM.into()),
            passphrase: None,
        }
    }

    #[derive(Default)]
    struct MockConfirm {
        allow: AtomicBool,
        calls: AtomicUsize,
        last: Mutex<Option<TofuPrompt>>,
    }
    impl HostKeyConfirmer for MockConfirm {
        fn confirm_tofu(&self, prompt: &TofuPrompt) -> Result<bool, LocalSshError> {
            self.calls.fetch_add(1, AO::SeqCst);
            *self.last.lock().unwrap() = Some(prompt.clone());
            Ok(self.allow.load(AO::SeqCst))
        }
    }

    #[derive(Default)]
    struct MockCloud {
        fail: AtomicBool,
        calls: AtomicUsize,
        events: Mutex<Vec<&'static str>>,
        last: Mutex<Option<CloudHostKeyParams>>,
        saw_bearer: Mutex<Option<String>>,
    }
    impl CloudHostKeyWriter for MockCloud {
        fn write_host_key<'a>(
            &'a self,
            params: &'a CloudHostKeyParams,
            bearer: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<(), LocalSshError>> + Send + 'a>> {
            Box::pin(async move {
                self.events.lock().unwrap().push("cloud");
                self.calls.fetch_add(1, AO::SeqCst);
                *self.last.lock().unwrap() = Some(params.clone());
                // Test recording only — production writers never clone bearer to String.
                *self.saw_bearer.lock().unwrap() = Some(bearer.to_string());
                if self.fail.load(AO::SeqCst) {
                    Err(LocalSshError::CloudHostKeyWriteFailed)
                } else {
                    Ok(())
                }
            })
        }
    }

    fn policy_of(a: &LocalSshConnectAuthority) -> HostKeyPolicySnapshot {
        HostKeyPolicySnapshot::from_authority(a)
    }

    #[derive(Default)]
    struct MockLocal {
        fail: AtomicBool,
        calls: AtomicUsize,
        events: Mutex<Vec<&'static str>>,
        writes: Mutex<Vec<(String, String, String)>>,
    }
    impl LocalKnownHosts for MockLocal {
        fn record_host_key(
            &self,
            namespace: &str,
            key_type: &str,
            fingerprint: &str,
        ) -> Result<(), LocalSshError> {
            self.events.lock().unwrap().push("local");
            self.calls.fetch_add(1, AO::SeqCst);
            if self.fail.load(AO::SeqCst) {
                return Err(LocalSshError::LocalKnownHostsFailed);
            }
            self.writes.lock().unwrap().push((
                namespace.into(),
                key_type.into(),
                fingerprint.into(),
            ));
            Ok(())
        }
    }

    struct OkRev;
    impl ConnectAuthorityRevalidator for OkRev {
        fn ensure_still_valid(&self) -> Result<(), LocalSshError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn pinned_exact_accept_writes_local_no_cloud() {
        let auth = authed();
        let presented = host_presented();
        let authy = authority(
            &auth,
            Some(PreparedHostKey {
                key_type: presented.key_type.clone(),
                fingerprint: presented.fingerprint.clone(),
            }),
        );
        let conf = MockConfirm::default();
        let cloud = MockCloud::default();
        let local = MockLocal::default();
        let mut pol = policy_of(&authy);
        verify_server_host_key(&mut pol, &presented, &conf, &cloud, &local, &OkRev, None)
            .await
            .unwrap();
        assert_eq!(conf.calls.load(AO::SeqCst), 0);
        assert_eq!(cloud.calls.load(AO::SeqCst), 0);
        assert_eq!(local.calls.load(AO::SeqCst), 1);
    }

    #[tokio::test]
    async fn pinned_type_mismatch_hard_rejects() {
        let auth = authed();
        let presented = host_presented();
        let authy = authority(
            &auth,
            Some(PreparedHostKey {
                key_type: "ssh-rsa".into(),
                fingerprint: presented.fingerprint.clone(),
            }),
        );
        let mut pol = policy_of(&authy);
        let err = verify_server_host_key(
            &mut pol,
            &presented,
            &MockConfirm::default(),
            &MockCloud::default(),
            &MockLocal::default(),
            &OkRev,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err, LocalSshError::HostKeyMismatch);
    }

    #[tokio::test]
    async fn pinned_fingerprint_mismatch_hard_rejects() {
        let auth = authed();
        let presented = host_presented();
        let authy = authority(
            &auth,
            Some(PreparedHostKey {
                key_type: presented.key_type.clone(),
                fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            }),
        );
        let mut pol = policy_of(&authy);
        let err = verify_server_host_key(
            &mut pol,
            &presented,
            &MockConfirm::default(),
            &MockCloud::default(),
            &MockLocal::default(),
            &OkRev,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err, LocalSshError::HostKeyMismatch);
    }

    #[tokio::test]
    async fn tofu_accept_exact_order_confirm_cloud_revalidate_local() {
        let auth = authed();
        let authy = authority(&auth, None);
        let presented = host_presented();
        let events: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));

        struct OrderConfirm {
            events: Arc<Mutex<Vec<&'static str>>>,
            inner: MockConfirm,
        }
        impl HostKeyConfirmer for OrderConfirm {
            fn confirm_tofu(&self, p: &TofuPrompt) -> Result<bool, LocalSshError> {
                self.events.lock().unwrap().push("confirm");
                self.inner.confirm_tofu(p)
            }
        }
        struct OrderCloud {
            events: Arc<Mutex<Vec<&'static str>>>,
            inner: MockCloud,
        }
        impl CloudHostKeyWriter for OrderCloud {
            fn write_host_key<'a>(
                &'a self,
                params: &'a CloudHostKeyParams,
                bearer: &'a str,
            ) -> Pin<Box<dyn Future<Output = Result<(), LocalSshError>> + Send + 'a>> {
                Box::pin(async move {
                    self.events.lock().unwrap().push("cloud");
                    self.inner.write_host_key(params, bearer).await
                })
            }
        }
        struct OrderLocal {
            events: Arc<Mutex<Vec<&'static str>>>,
            inner: MockLocal,
        }
        impl LocalKnownHosts for OrderLocal {
            fn record_host_key(&self, ns: &str, ty: &str, fp: &str) -> Result<(), LocalSshError> {
                self.events.lock().unwrap().push("local");
                self.inner.record_host_key(ns, ty, fp)
            }
        }
        struct OrderRev {
            events: Arc<Mutex<Vec<&'static str>>>,
            count: AtomicUsize,
        }
        impl ConnectAuthorityRevalidator for OrderRev {
            fn ensure_still_valid(&self) -> Result<(), LocalSshError> {
                let n = self.count.fetch_add(1, AO::SeqCst);
                if n >= 2 {
                    self.events.lock().unwrap().push("revalidate");
                }
                Ok(())
            }
        }

        let conf = OrderConfirm {
            events: Arc::clone(&events),
            inner: MockConfirm {
                allow: AtomicBool::new(true),
                ..Default::default()
            },
        };
        let cloud = OrderCloud {
            events: Arc::clone(&events),
            inner: MockCloud::default(),
        };
        let local = OrderLocal {
            events: Arc::clone(&events),
            inner: MockLocal::default(),
        };
        let rev = OrderRev {
            events: Arc::clone(&events),
            count: AtomicUsize::new(0),
        };
        let mut pol = policy_of(&authy);
        verify_server_host_key(
            &mut pol,
            &presented,
            &conf,
            &cloud,
            &local,
            &rev,
            Some("bearer-tok"),
        )
        .await
        .unwrap();
        // Rekey: policy now pinned to presented key.
        assert_eq!(
            pol.host_key.as_ref().map(|h| h.fingerprint.as_str()),
            Some(presented.fingerprint.as_str())
        );
        let ev = events.lock().unwrap().clone();
        let c = ev.iter().position(|e| *e == "confirm").unwrap();
        let cl = ev.iter().position(|e| *e == "cloud").unwrap();
        let l = ev.iter().position(|e| *e == "local").unwrap();
        assert!(c < cl && cl < l);
        assert!(ev[cl + 1..l].contains(&"revalidate"));
        let body = cloud_host_key_body(cloud.inner.last.lock().unwrap().as_ref().unwrap());
        assert_eq!(
            body.as_object().unwrap().keys().collect::<Vec<_>>().len(),
            3
        );
        assert!(body.get("expected_fingerprint").unwrap().is_null());
        assert!(body.get("host_key_type").is_some());
        assert!(body.get("fingerprint").is_some());
        assert!(body.get("host_key_fingerprint").is_none());
    }

    #[tokio::test]
    async fn tofu_user_reject_zero_writes() {
        let auth = authed();
        let authy = authority(&auth, None);
        let conf = MockConfirm::default(); // allow=false
        let cloud = MockCloud::default();
        let local = MockLocal::default();
        let mut pol = policy_of(&authy);
        let err = verify_server_host_key(
            &mut pol,
            &host_presented(),
            &conf,
            &cloud,
            &local,
            &OkRev,
            Some("tok"),
        )
        .await
        .unwrap_err();
        assert_eq!(err, LocalSshError::HostKeyRejectedByUser);
        assert_eq!(cloud.calls.load(AO::SeqCst), 0);
        assert_eq!(local.calls.load(AO::SeqCst), 0);
    }

    #[tokio::test]
    async fn tofu_cloud_failure_zero_local_write() {
        let auth = authed();
        let authy = authority(&auth, None);
        let conf = MockConfirm {
            allow: AtomicBool::new(true),
            ..Default::default()
        };
        let cloud = MockCloud {
            fail: AtomicBool::new(true),
            ..Default::default()
        };
        let local = MockLocal::default();
        let mut pol = policy_of(&authy);
        let err = verify_server_host_key(
            &mut pol,
            &host_presented(),
            &conf,
            &cloud,
            &local,
            &OkRev,
            Some("tok"),
        )
        .await
        .unwrap_err();
        assert_eq!(err, LocalSshError::CloudHostKeyWriteFailed);
        assert_eq!(local.calls.load(AO::SeqCst), 0);
    }

    #[tokio::test]
    async fn auth_cutoff_race_rejects_before_local() {
        let auth = authed();
        let authy = authority(&auth, None);
        let conf = MockConfirm {
            allow: AtomicBool::new(true),
            ..Default::default()
        };
        let cloud = MockCloud::default();
        let local = MockLocal::default();
        struct RaceRev {
            n: AtomicUsize,
        }
        impl ConnectAuthorityRevalidator for RaceRev {
            fn ensure_still_valid(&self) -> Result<(), LocalSshError> {
                let i = self.n.fetch_add(1, AO::SeqCst);
                if i >= 2 {
                    Err(LocalSshError::BindingMismatch)
                } else {
                    Ok(())
                }
            }
        }
        let mut pol = policy_of(&authy);
        let err = verify_server_host_key(
            &mut pol,
            &host_presented(),
            &conf,
            &cloud,
            &local,
            &RaceRev {
                n: AtomicUsize::new(0),
            },
            Some("tok"),
        )
        .await
        .unwrap_err();
        assert_eq!(err, LocalSshError::BindingMismatch);
        assert_eq!(cloud.calls.load(AO::SeqCst), 1);
        assert_eq!(local.calls.load(AO::SeqCst), 0);
    }

    #[test]
    fn split_prepared_secret_free_authority_and_one_lease() {
        use super::super::prepare::{split_prepared_for_connect, PreparedLocalSshOpen};
        let auth = authed();
        let b = auth.auth_binding().unwrap();
        let prepared = PreparedLocalSshOpen {
            server_id: "s".into(),
            credential_id: "c".into(),
            target_host: "10.0.0.1".into(),
            ssh_port: 22,
            ssh_user: "u".into(),
            host_key: None,
            principal: b.principal.clone(),
            epoch: b.epoch,
            ssh_generation: 3,
            lease: VaultCredentialLease {
                credential_id: "c".into(),
                fingerprint: "SHA256:x".into(),
                pem: Zeroizing::new("-----BEGIN SECRET PEM-----\n".into()),
                passphrase: Some(Zeroizing::new("pass-secret".into())),
            },
        };
        let (authy, lease) = split_prepared_for_connect(prepared);
        let d = format!("{authy:?}");
        assert!(!d.contains("SECRET PEM"));
        assert!(!d.contains("pass-secret"));
        assert!(!d.contains("10.0.0.1"));
        assert_eq!(lease.pem.as_str(), "-----BEGIN SECRET PEM-----\n");
        // complete_established type surface is authority-only (source assert).
        let session_src = include_str!("session.rs");
        let complete = session_src
            .split("pub fn complete_established(")
            .nth(1)
            .unwrap();
        let body = complete
            .split("fn complete_established_inner")
            .next()
            .unwrap();
        assert!(body.contains("LocalSshConnectAuthority"));
        assert!(!body.contains("PreparedLocalSshOpen"));
        assert!(!body.contains("VaultCredentialLease"));
    }

    #[test]
    fn known_hosts_namespace_uses_tenant_subject_hash() {
        let p = NativePrincipal {
            tenant_id: "tenant-secret".into(),
            user_id: "alice".into(),
            subject: "sub-secret".into(),
        };
        let ns = local_known_hosts_namespace(&p, "srv-1").unwrap();
        assert!(ns.starts_with("kh/v1/"));
        assert!(!ns.contains("tenant-secret"));
        assert!(!ns.contains("sub-secret"));
        assert!(ns.ends_with("/srv-1"));
    }

    #[test]
    fn cloud_host_key_body_has_only_three_fields() {
        let p = CloudHostKeyParams {
            server_id: "s".into(),
            host_key_type: "ssh-ed25519".into(),
            fingerprint: "SHA256:abc".into(),
            expected_fingerprint: None,
        };
        let v = cloud_host_key_body(&p);
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 3);
        assert!(obj.contains_key("expected_fingerprint"));
        assert!(obj.contains_key("host_key_type"));
        assert!(obj.contains_key("fingerprint"));
        assert!(!obj.contains_key("host_key_fingerprint"));
        assert!(!obj.contains_key("server_id"));
        assert!(!obj.contains_key("bearer"));
        let input = cloud_host_key_business_input(&p);
        let iobj = input.as_object().unwrap();
        assert_eq!(iobj.get("id").and_then(|v| v.as_str()), Some("s"));
        assert!(iobj.contains_key("fingerprint"));
    }

    #[test]
    fn host_key_contract_matches_backend_wire_schema() {
        use crate::cloud_transport::operations::{spec, Operation};
        let s = spec(Operation::ServersHostKey);
        assert_eq!(s.id, "servers.host_key");
        assert_eq!(s.path, "/api/servers/{id}/host-key");
        assert_eq!(
            s.body_fields,
            &["expected_fingerprint", "host_key_type", "fingerprint"]
        );
        assert!(!s.body_fields.contains(&"host_key_fingerprint"));
        assert!(matches!(
            s.invocation,
            crate::cloud_transport::Invocation::NativeOnly
        ));
        assert!(!crate::cloud_transport::is_ipc_callable(
            Operation::ServersHostKey
        ));
        // OpenAPI must not require expected_fingerprint.
        let openapi = include_str!("../../../contracts/openapi-v1.yaml");
        let host_key_section = openapi
            .split("/api/servers/{id}/host-key:")
            .nth(1)
            .expect("host-key path")
            .split("\n  /api/")
            .next()
            .expect("host-key section bound");
        assert!(host_key_section.contains("host_key_type"));
        assert!(host_key_section.contains("fingerprint"));
        assert!(host_key_section.contains("expected_fingerprint"));
        assert!(
            !host_key_section.contains("host_key_fingerprint"),
            "request must not use host_key_fingerprint"
        );
        // Schema required list (under requestBody) must omit expected_fingerprint.
        let schema = host_key_section
            .split("application/json:")
            .nth(1)
            .expect("json schema");
        let req_block = schema
            .split("required:\n")
            .nth(1)
            .and_then(|r| r.split("properties:").next())
            .unwrap_or("");
        assert!(req_block.contains("host_key_type"));
        assert!(req_block.contains("fingerprint"));
        assert!(!req_block.contains("expected_fingerprint"));
    }

    #[test]
    fn map_public_codes_stable_for_connect_errors() {
        use super::super::prepare::map_local_ssh_public;
        assert_eq!(
            map_local_ssh_public(LocalSshError::HostKeyMismatch),
            "local_ssh_host_key_mismatch"
        );
        assert_eq!(
            map_local_ssh_public(LocalSshError::ConnectFailed),
            "local_ssh_connect_failed"
        );
        assert_eq!(
            map_local_ssh_public(LocalSshError::AuthenticationFailed),
            "local_ssh_authentication_failed"
        );
    }

    #[test]
    fn operations_host_key_is_native_only_not_ipc() {
        use crate::cloud_transport::operations::{is_ipc_callable, Operation};
        assert!(!is_ipc_callable(Operation::ServersHostKey));
        let src = include_str!("../cloud_transport/operations.rs");
        assert!(src.contains("servers.host_key"));
        assert!(src.contains("/api/servers/{id}/host-key"));
    }

    // ─── Live russh handshake ────────────────────────────────────────────────

    #[derive(Clone)]
    struct TestServer {
        accept_pubkey: Arc<AtomicBool>,
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
            if self.accept_pubkey.load(AO::SeqCst) {
                Ok(Auth::Accept)
            } else {
                Ok(Auth::Reject {
                    proceed_with_methods: None,
                    partial_success: false,
                })
            }
        }
    }

    async fn spawn_test_ssh_server(
        accept: bool,
    ) -> (u16, Arc<AtomicBool>, tokio::task::JoinHandle<()>) {
        let host_key = decode_secret_key(HOST_PEM, None).unwrap();
        let accept_pubkey = Arc::new(AtomicBool::new(accept));
        let config = Arc::new(server::Config {
            keys: vec![host_key],
            ..Default::default()
        });
        let mut sh = TestServer {
            accept_pubkey: Arc::clone(&accept_pubkey),
        };
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let server = sh.run_on_socket(config, &listener);
            let _ = server.await;
        });
        // Brief yield for accept loop.
        tokio::task::yield_now().await;
        (port, accept_pubkey, handle)
    }

    /// Vault + manager for live handshake (ticket barriers required).
    fn live_session_ctx(
        auth: Arc<AuthStore>,
        cutoff: Arc<SecurityCutoff>,
    ) -> (
        Arc<LocalSshSessionManager>,
        Arc<crate::vault::VaultService>,
        std::path::PathBuf,
    ) {
        use crate::vault::VaultService;
        use std::time::Instant;
        use tauri_plugin_stronghold::stronghold::Stronghold;
        struct DetRng([u8; 32]);
        impl crate::auth::RandomSource for DetRng {
            fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), crate::auth::AuthError> {
                for (i, b) in dest.iter_mut().enumerate() {
                    *b = self.0[i % 32];
                }
                Ok(())
            }
        }
        let path = {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "opsmate-8b3a-live-{}-{}.hold",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            p
        };
        let sh = Stronghold::new(&path, vec![0x8Eu8; 32]).expect("sh");
        let binding = auth.auth_binding().unwrap();
        let vault = Arc::new(VaultService::new(path.clone()));
        vault.test_inject_unlocked(sh, binding, path.clone(), Instant::now());
        let mgr = LocalSshSessionManager::with_rng(
            auth,
            vault.clone(),
            cutoff,
            Arc::new(DetRng([9u8; 32])),
        );
        (mgr, vault, path)
    }

    fn barriers_for(
        mgr: &LocalSshSessionManager,
        server_id: &str,
        credential_id: &str,
    ) -> super::super::session::TicketBarrierSnapshot {
        let ticket = mgr
            .begin_establishment(&super::super::prepare::LocalSshOpenRequest {
                server_id: server_id.into(),
                credential_id: credential_id.into(),
            })
            .unwrap();
        ticket.barrier_snapshot()
    }

    // Test fixture builder mirrors production HandshakeDeps field set (8 deps + barriers).
    #[allow(clippy::too_many_arguments)]
    fn handshake_deps(
        auth: Arc<AuthStore>,
        cutoff: Arc<SecurityCutoff>,
        conf: Arc<dyn HostKeyConfirmer>,
        cloud: Arc<dyn CloudHostKeyWriter>,
        local: Arc<dyn LocalKnownHosts>,
        timeout: Duration,
        session_manager: Arc<LocalSshSessionManager>,
        ticket_barriers: super::super::session::TicketBarrierSnapshot,
    ) -> HandshakeDeps {
        HandshakeDeps {
            auth,
            cutoff,
            confirmer: conf,
            cloud,
            local_kh: local,
            session_manager,
            ticket_barriers,
            extra_revalidator: None,
            overall_timeout: timeout,
        }
    }

    #[tokio::test]
    async fn live_pinned_handshake_accepts_and_close_disconnects() {
        let (port, _, _jh) = spawn_test_ssh_server(true).await;
        let auth = authed();
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let (mgr, vault, path) = live_session_ctx(auth.clone(), cutoff.clone());
        let barriers = barriers_for(&mgr, "srv-1", "cred-1");
        let gen = cutoff.ssh_generation();
        let presented = host_presented();
        let mut authy = authority(
            &auth,
            Some(PreparedHostKey {
                key_type: presented.key_type.clone(),
                fingerprint: presented.fingerprint.clone(),
            }),
        );
        authy.ssh_port = port;
        authy.ssh_generation = gen;
        authy.target_host = "127.0.0.1".into();

        let conf = Arc::new(MockConfirm::default());
        let cloud = Arc::new(MockCloud::default());
        let local = Arc::new(MockLocal::default());
        let result = establish_local_ssh_handshake(
            authy,
            lease_user(),
            handshake_deps(
                auth,
                cutoff,
                conf,
                cloud.clone(),
                local.clone(),
                Duration::from_secs(10),
                mgr,
                barriers,
            ),
        )
        .await
        .expect("handshake");
        assert_eq!(cloud.calls.load(AO::SeqCst), 0);
        assert_eq!(local.calls.load(AO::SeqCst), 1);
        assert!(result.bearer_is_spent(), "pinned path must spend bearer");
        assert_eq!(result.authority.server_id, "srv-1");
        let start = std::time::Instant::now();
        result.connection.disconnect_now();
        let elapsed = start.elapsed();
        assert!(
            result.connection.is_fenced(),
            "on_close/disconnect must fence handle before return"
        );
        assert_eq!(result.connection.disconnect_count(), 1);
        assert!(
            elapsed < Duration::from_secs(4),
            "bounded sync teardown, took {elapsed:?}"
        );
        result.connection.disconnect_now();
        assert_eq!(result.connection.disconnect_count(), 1);
        let _ = vault.lock();
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn live_auth_reject_partial_cleanup() {
        let (port, _, _jh) = spawn_test_ssh_server(false).await;
        let auth = authed();
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let (mgr, vault, path) = live_session_ctx(auth.clone(), cutoff.clone());
        let barriers = barriers_for(&mgr, "srv-1", "cred-1");
        let gen = cutoff.ssh_generation();
        let presented = host_presented();
        let mut authy = authority(
            &auth,
            Some(PreparedHostKey {
                key_type: presented.key_type.clone(),
                fingerprint: presented.fingerprint.clone(),
            }),
        );
        authy.ssh_port = port;
        authy.ssh_generation = gen;

        let err = establish_local_ssh_handshake(
            authy,
            lease_user(),
            handshake_deps(
                auth,
                cutoff,
                Arc::new(MockConfirm::default()),
                Arc::new(MockCloud::default()),
                Arc::new(MockLocal::default()),
                Duration::from_secs(10),
                mgr,
                barriers,
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(err, LocalSshError::AuthenticationFailed);
        let _ = vault.lock();
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn live_host_key_mismatch_rejects_kex() {
        let (port, _, _jh) = spawn_test_ssh_server(true).await;
        let auth = authed();
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let (mgr, vault, path) = live_session_ctx(auth.clone(), cutoff.clone());
        let barriers = barriers_for(&mgr, "srv-1", "cred-1");
        let gen = cutoff.ssh_generation();
        let mut authy = authority(
            &auth,
            Some(PreparedHostKey {
                key_type: "ssh-ed25519".into(),
                fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            }),
        );
        authy.ssh_port = port;
        authy.ssh_generation = gen;
        let err = establish_local_ssh_handshake(
            authy,
            lease_user(),
            handshake_deps(
                auth,
                cutoff,
                Arc::new(MockConfirm::default()),
                Arc::new(MockCloud::default()),
                Arc::new(MockLocal::default()),
                Duration::from_secs(10),
                mgr,
                barriers,
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(err, LocalSshError::HostKeyMismatch);
        let _ = vault.lock();
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn live_timeout_connect_failed() {
        let auth = authed();
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let (mgr, vault, path) = live_session_ctx(auth.clone(), cutoff.clone());
        let barriers = barriers_for(&mgr, "srv-1", "cred-1");
        let gen = cutoff.ssh_generation();
        let mut authy = authority(&auth, None);
        authy.ssh_port = 1;
        authy.target_host = "127.0.0.1".into();
        authy.ssh_generation = gen;
        let conf = Arc::new(MockConfirm {
            allow: AtomicBool::new(true),
            ..Default::default()
        });
        authy.host_key = Some(PreparedHostKey {
            key_type: "ssh-ed25519".into(),
            fingerprint: host_fp(),
        });
        let err = establish_local_ssh_handshake(
            authy,
            lease_user(),
            handshake_deps(
                auth,
                cutoff,
                conf,
                Arc::new(MockCloud::default()),
                Arc::new(MockLocal::default()),
                Duration::from_millis(400),
                mgr,
                barriers,
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(err, LocalSshError::ConnectFailed);
        let _ = vault.lock();
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn live_tofu_accept_handshake() {
        let (port, _, _jh) = spawn_test_ssh_server(true).await;
        let auth = authed();
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let (mgr, vault, path) = live_session_ctx(auth.clone(), cutoff.clone());
        let barriers = barriers_for(&mgr, "srv-1", "cred-1");
        let gen = cutoff.ssh_generation();
        let mut authy = authority(&auth, None);
        authy.ssh_port = port;
        authy.ssh_generation = gen;
        let conf = Arc::new(MockConfirm {
            allow: AtomicBool::new(true),
            ..Default::default()
        });
        let cloud = Arc::new(MockCloud::default());
        let local = Arc::new(MockLocal::default());
        let result = establish_local_ssh_handshake(
            authy,
            lease_user(),
            handshake_deps(
                auth,
                cutoff,
                conf,
                cloud.clone(),
                local.clone(),
                Duration::from_secs(10),
                mgr,
                barriers,
            ),
        )
        .await
        .expect("tofu handshake");
        assert_eq!(cloud.calls.load(AO::SeqCst), 1);
        assert_eq!(local.calls.load(AO::SeqCst), 1);
        assert!(result.bearer_is_spent(), "TOFU path must spend bearer");
        let saw = cloud.saw_bearer.lock().unwrap().clone();
        assert!(
            saw.as_ref().map(|s| !s.is_empty()).unwrap_or(false),
            "cloud CAS must receive ephemeral bearer"
        );
        result.connection.disconnect_now();
        assert!(result.connection.is_fenced());
        let _ = vault.lock();
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn live_tofu_ticket_barrier_after_cloud_rejects_before_local() {
        let (port, _, _jh) = spawn_test_ssh_server(true).await;
        let auth = authed();
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let (mgr, vault, path) = live_session_ctx(auth.clone(), cutoff.clone());
        let barriers = barriers_for(&mgr, "srv-1", "cred-1");
        let gen = cutoff.ssh_generation();
        let mut authy = authority(&auth, None);
        authy.ssh_port = port;
        authy.ssh_generation = gen;

        // Cloud success then bump registry so post-cloud revalidate fails.
        struct CloudThenCloseAll {
            mgr: Arc<LocalSshSessionManager>,
            inner: MockCloud,
        }
        impl CloudHostKeyWriter for CloudThenCloseAll {
            fn write_host_key<'a>(
                &'a self,
                params: &'a CloudHostKeyParams,
                bearer: &'a str,
            ) -> Pin<Box<dyn Future<Output = Result<(), LocalSshError>> + Send + 'a>> {
                Box::pin(async move {
                    self.inner.write_host_key(params, bearer).await?;
                    use crate::vault::SessionLifecycleSink;
                    self.mgr.close_all_sessions();
                    Ok(())
                })
            }
        }
        let cloud = Arc::new(CloudThenCloseAll {
            mgr: mgr.clone(),
            inner: MockCloud::default(),
        });
        let local = Arc::new(MockLocal::default());
        let conf = Arc::new(MockConfirm {
            allow: AtomicBool::new(true),
            ..Default::default()
        });
        let err = establish_local_ssh_handshake(
            authy,
            lease_user(),
            handshake_deps(
                auth,
                cutoff,
                conf,
                cloud,
                local.clone(),
                Duration::from_secs(10),
                mgr,
                barriers,
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(err, LocalSshError::SshCutoff);
        assert_eq!(local.calls.load(AO::SeqCst), 0, "local KH must not write");
        let _ = vault.lock();
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn e2e_begin_split_handshake_complete_registers_close() {
        use super::super::prepare::split_prepared_for_connect;
        use super::super::prepare::{PreparedHostKey, PreparedLocalSshOpen};
        use super::super::session::{LocalSshSessionManager, SessionCloseHandle};
        use crate::auth::RandomSource;
        use crate::vault::VaultService;
        use std::time::Instant;
        use tauri_plugin_stronghold::stronghold::Stronghold;

        struct DetRng([u8; 32]);
        impl RandomSource for DetRng {
            fn fill_bytes(&self, dest: &mut [u8]) -> Result<(), crate::auth::AuthError> {
                for (i, b) in dest.iter_mut().enumerate() {
                    *b = self.0[i % 32];
                }
                Ok(())
            }
        }

        let (port, _, _jh) = spawn_test_ssh_server(true).await;
        let auth = authed();
        let path = {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "opsmate-8b3a-e2e-{}-{}.hold",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            p
        };
        let sh = Stronghold::new(&path, vec![0x8Du8; 32]).expect("sh");
        let binding = auth.auth_binding().unwrap();
        let vault = Arc::new(VaultService::new(path.clone()));
        vault.test_inject_unlocked(sh, binding.clone(), path.clone(), Instant::now());
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let gen = cutoff.ssh_generation();
        let mgr = LocalSshSessionManager::with_rng(
            auth.clone(),
            vault.clone(),
            cutoff.clone(),
            Arc::new(DetRng([7u8; 32])),
        );

        let ticket = mgr
            .begin_establishment(&super::super::prepare::LocalSshOpenRequest {
                server_id: "srv-1".into(),
                credential_id: "cred-1".into(),
            })
            .unwrap();
        let barriers = ticket.barrier_snapshot();

        let presented = host_presented();
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
            lease: lease_user(),
        };
        let (authority, lease) = split_prepared_for_connect(prepared);
        let result = establish_local_ssh_handshake(
            authority,
            lease,
            handshake_deps(
                auth.clone(),
                cutoff.clone(),
                Arc::new(MockConfirm::default()),
                Arc::new(MockCloud::default()),
                Arc::new(MockLocal::default()),
                Duration::from_secs(10),
                mgr.clone(),
                barriers,
            ),
        )
        .await
        .expect("handshake");
        assert!(result.bearer_is_spent());

        let close_count = Arc::new(AtomicUsize::new(0));
        struct SpyClose {
            inner: Arc<EstablishedLocalSsh>,
            count: Arc<AtomicUsize>,
        }
        impl SessionCloseHandle for SpyClose {
            fn on_close(&self) {
                self.count.fetch_add(1, AO::SeqCst);
                self.inner.disconnect_now();
            }
        }
        let spy = Arc::new(SpyClose {
            inner: result.connection.clone(),
            count: close_count.clone(),
        });
        let id = mgr
            .complete_established(ticket, result.authority, spy)
            .unwrap();
        assert!(mgr.authorize(id.as_str()).is_ok());
        mgr.close_session(id.as_str()).unwrap();
        assert_eq!(close_count.load(AO::SeqCst), 1);
        assert!(result.connection.is_fenced());
        let _ = vault.lock();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn oneshot_bearer_emptied_after_take() {
        let b = EphemeralBearer::new(Zeroizing::new("secret-bearer".into()));
        assert!(!b.is_spent());
        let t = b.take().unwrap();
        assert_eq!(t.as_str(), "secret-bearer");
        assert!(b.is_spent());
        assert!(b.take().is_none());
    }

    #[test]
    fn authority_is_not_clone_policy_snapshot_from_borrow() {
        // Structural: HostKeyPolicySnapshot builds from &LocalSshConnectAuthority
        // without requiring authority Clone (derive removed).
        let auth = authed();
        let authy = authority(&auth, None);
        let snap = HostKeyPolicySnapshot::from_authority(&authy);
        let dbg = format!("{snap:?}");
        assert!(!dbg.contains("ten-a"));
        assert!(!dbg.contains("sub-a"));
        assert!(!dbg.contains("127.0.0.1"));
        let auth_src = include_str!("prepare.rs");
        let auth_block = auth_src
            .split("pub struct LocalSshConnectAuthority")
            .nth(1)
            .unwrap();
        let header = auth_block.lines().take(3).collect::<Vec<_>>().join("\n");
        assert!(
            !header.contains("derive(Clone)") && !header.contains("#[derive(Clone)]"),
            "LocalSshConnectAuthority must not derive Clone"
        );
        // Preceding lines: ensure no Clone on the struct attribute.
        let before = auth_src
            .split("pub struct LocalSshConnectAuthority")
            .next()
            .unwrap();
        let tail = before.lines().rev().take(6).collect::<Vec<_>>();
        assert!(
            !tail.iter().any(|l| l.contains("derive(Clone)")),
            "no Clone derive immediately above LocalSshConnectAuthority"
        );
    }

    #[test]
    fn ticket_barrier_snapshot_debug_redacts_identity() {
        let snap = super::super::session::TicketBarrierSnapshot {
            principal: NativePrincipal {
                tenant_id: "tenant-secret".into(),
                user_id: "alice".into(),
                subject: "sub-secret".into(),
            },
            auth_epoch: 99,
            server_id: "srv-secret".into(),
            credential_id: "cred-secret".into(),
            prepared_ssh_generation: 1,
            registry_global_generation: 2,
            credential_invalidation_epoch: 0,
        };
        let d = format!("{snap:?}");
        assert!(!d.contains("tenant-secret"));
        assert!(!d.contains("sub-secret"));
        assert!(!d.contains("srv-secret"));
        assert!(!d.contains("cred-secret"));
        assert!(!d.contains("99"));
    }

    #[tokio::test]
    async fn rekey_after_tofu_same_key_no_prompt_cloud_bearer() {
        let auth = authed();
        let authy = authority(&auth, None);
        let presented = host_presented();
        let conf = Arc::new(MockConfirm {
            allow: AtomicBool::new(true),
            ..Default::default()
        });
        let cloud = Arc::new(MockCloud::default());
        let local = Arc::new(MockLocal::default());
        let bearer = EphemeralBearer::new(Zeroizing::new("tok-once".into()));
        let mut handler = HostKeyPolicyHandler::new(
            &authy,
            conf.clone(),
            cloud.clone(),
            local.clone(),
            Arc::new(OkRev),
            Arc::clone(&bearer),
        );
        // First: TOFU
        handler.check_presented_for_tests(&presented).await.unwrap();
        assert_eq!(conf.calls.load(AO::SeqCst), 1);
        assert_eq!(cloud.calls.load(AO::SeqCst), 1);
        assert!(bearer.is_spent());
        // Second: same key — zero prompt/cloud, no bearer needed
        handler.check_presented_for_tests(&presented).await.unwrap();
        assert_eq!(conf.calls.load(AO::SeqCst), 1);
        assert_eq!(cloud.calls.load(AO::SeqCst), 1);
        // Third: different key hard reject
        let mut other = presented.clone();
        other.fingerprint = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into();
        let err = handler.check_presented_for_tests(&other).await.unwrap_err();
        assert_eq!(err, LocalSshError::HostKeyMismatch);
        assert_eq!(conf.calls.load(AO::SeqCst), 1);
        assert_eq!(cloud.calls.load(AO::SeqCst), 1);
    }

    #[tokio::test]
    async fn pinned_repeat_without_bearer() {
        let auth = authed();
        let presented = host_presented();
        let authy = authority(
            &auth,
            Some(PreparedHostKey {
                key_type: presented.key_type.clone(),
                fingerprint: presented.fingerprint.clone(),
            }),
        );
        // Empty bearer gate — pinned must not require token.
        let bearer = EphemeralBearer::new(Zeroizing::new(String::new()));
        // Spend the empty slot first to simulate already-spent.
        let _ = bearer.take();
        assert!(bearer.is_spent());
        let conf = Arc::new(MockConfirm::default());
        let cloud = Arc::new(MockCloud::default());
        let local = Arc::new(MockLocal::default());
        let mut handler = HostKeyPolicyHandler::new(
            &authy,
            conf.clone(),
            cloud.clone(),
            local.clone(),
            Arc::new(OkRev),
            bearer,
        );
        handler.check_presented_for_tests(&presented).await.unwrap();
        handler.check_presented_for_tests(&presented).await.unwrap();
        assert_eq!(conf.calls.load(AO::SeqCst), 0);
        assert_eq!(cloud.calls.load(AO::SeqCst), 0);
        assert_eq!(local.calls.load(AO::SeqCst), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn native_writer_awaits_without_block_on_or_panic() {
        use crate::cloud_transport::client::MockHttpBackend;
        use crate::cloud_transport::lifecycle::NoopLifecycleHooks;
        use crate::cloud_transport::CloudTransport;
        let backend = MockHttpBackend::new(r#"{"ok":true}"#);
        let transport = Arc::new(CloudTransport::new(backend, NoopLifecycleHooks));
        let writer = NativeTransportHostKeyWriter::new(transport, 1);
        let params = CloudHostKeyParams {
            server_id: "srv-1".into(),
            host_key_type: "ssh-ed25519".into(),
            fingerprint: "SHA256:abc".into(),
            expected_fingerprint: None,
        };
        // Direct await on current-thread runtime — must not panic/deadlock.
        writer
            .write_host_key(&params, "bearer-borrow")
            .await
            .expect("native writer await");
        // Source assertion: no block_in_place / Handle::current().block_on in writers.
        let src = include_str!("connect.rs");
        let writer_src = src
            .split("pub struct NativeTransportHostKeyWriter")
            .nth(1)
            .and_then(|s| s.split("fn map_host_key_transport_err").next())
            .unwrap_or("");
        assert!(!writer_src.contains("block_in_place"));
        assert!(!writer_src.contains("Handle::current().block_on"));
        assert!(!writer_src.contains("bearer.to_string()"));
    }

    #[tokio::test]
    async fn on_close_returns_within_bound_when_teardown_slow() {
        let (port, _, _jh) = spawn_test_ssh_server(true).await;
        let auth = authed();
        let cutoff = Arc::new(SecurityCutoff::new());
        cutoff.unlock_vault_for_tests();
        let (mgr, vault, path) = live_session_ctx(auth.clone(), cutoff.clone());
        let barriers = barriers_for(&mgr, "srv-1", "cred-1");
        let gen = cutoff.ssh_generation();
        let presented = host_presented();
        let mut authy = authority(
            &auth,
            Some(PreparedHostKey {
                key_type: presented.key_type.clone(),
                fingerprint: presented.fingerprint.clone(),
            }),
        );
        authy.ssh_port = port;
        authy.ssh_generation = gen;
        let result = establish_local_ssh_handshake(
            authy,
            lease_user(),
            handshake_deps(
                auth,
                cutoff,
                Arc::new(MockConfirm::default()),
                Arc::new(MockCloud::default()),
                Arc::new(MockLocal::default()),
                Duration::from_secs(10),
                mgr,
                barriers,
            ),
        )
        .await
        .expect("handshake");
        // Deliberately hang protocol disconnect longer than CLOSE_WAIT_BOUND.
        result
            .connection
            .set_teardown_sleep_for_tests(Duration::from_secs(30));
        let start = std::time::Instant::now();
        result.connection.on_close();
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_secs(5),
            "on_close must return within hard bound, took {elapsed:?}"
        );
        assert!(
            result.connection.is_fenced(),
            "authority fence must be set on return"
        );
        assert_eq!(result.connection.disconnect_count(), 1);
        // Later close is idempotent — no double disconnect.
        result.connection.on_close();
        assert_eq!(result.connection.disconnect_count(), 1);
        let _ = vault.lock();
        let _ = std::fs::remove_file(&path);
    }
}
