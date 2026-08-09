//! D4A / D4B2a — local SSH open policy: two-phase host-key verification.
//!
//! **Phase 1** ([`prepare_local_ssh_open`]): capture auth principal+epoch, fetch
//! online metadata, authorize credential binding. No presented host key, no TOFU.
//! WebView supplies only serverId + credentialId.
//!
//! **Phase 2** ([`verify_server_host_key`]): evaluate the real server key from the
//! russh `check_server_key` callback (pinned match or native TOFU). TOFU order:
//! native confirm → cloud pin → revalidate principal+epoch → local known-hosts.
//!
//! Public IPC open response: only `{ sessionId }`. Prepared target is internal,
//! non-Serialize. Bearer is always ephemeral (`&str` / Zeroizing), never stored
//! on request structs.

use crate::auth::{AuthStore, NativeAuthSnapshot, NativePrincipal, API_BASE_URL};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const MAX_HTTP_BODY_BYTES: u64 = 1024 * 1024; // 1 MiB
const MAX_ID_LEN: usize = 128;

// ─── IPC DTOs ────────────────────────────────────────────────────────────────

/// WebView may supply only server_id + credential_id.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalSshOpenRequest {
    pub server_id: String,
    pub credential_id: String,
}

/// D4B public IPC open result: **sessionId only**. Not produced by D4A prepare.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSshOpenResponse {
    pub session_id: String,
}

// ─── Internal prepared target (never IPC / never Serialize) ──────────────────

/// Internal connect target after phase-1 policy. Bound to auth snapshot for revalidation.
/// Host-key decision is phase 2 ([`verify_server_host_key`]) with the russh callback key.
/// No session_id until D4B opens russh. Not Serialize.
#[derive(Clone, PartialEq, Eq)]
pub struct PreparedSshTarget {
    pub server_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub credential_id: String,
    /// Cloud host-key policy captured at prepare (pinned expects type+fingerprint).
    pub host_key_status: HostKeyStatus,
    pub host_key_type: Option<String>,
    pub host_key_fingerprint: Option<String>,
    /// Bound principal at prepare time (must revalidate before/after phase-2 side effects).
    pub principal: NativePrincipal,
    /// Auth session epoch at prepare time.
    pub session_epoch: u64,
}

impl std::fmt::Debug for PreparedSshTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedSshTarget")
            .field("server_id", &self.server_id)
            .field("name", &self.name)
            .field("host", &self.host)
            .field("port", &self.port)
            // Redact identity / binding fields — never print tenant/user/epoch/credential.
            .field("username", &"<redacted>")
            .field("credential_id", &"<redacted>")
            .field("host_key_status", &self.host_key_status)
            .field("host_key_type", &self.host_key_type)
            .field("host_key_fingerprint", &self.host_key_fingerprint)
            .field("principal", &"<redacted>")
            .field("session_epoch", &"<redacted>")
            .finish()
    }
}

// ─── Domain types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerMetadata {
    pub id: String,
    pub tenant_id: String,
    pub name: String,
    pub ip: String,
    pub ssh_user: String,
    pub ssh_port: u16,
    pub ssh_credential_id: String,
    pub host_key_type: Option<String>,
    pub host_key_fingerprint: Option<String>,
    pub host_key_status: HostKeyStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyStatus {
    Pinned,
    Unpinned,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresentedHostKey {
    pub key_type: String,
    pub fingerprint: String,
}

/// Native TOFU prompt — no secrets.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TofuPrompt {
    pub server_name: String,
    pub host: String,
    pub key_type: String,
    pub fingerprint: String,
}

/// Cloud host-key body params — **no bearer**, safe to Clone/Debug.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudHostKeyParams {
    pub server_id: String,
    pub host_key_type: String,
    pub fingerprint: String,
    /// Initial TOFU: `None` (JSON null / omitted).
    pub expected_fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyDecision {
    AcceptPinned,
    AcceptTofu {
        key_type: String,
        fingerprint: String,
    },
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Error)]
pub enum SshSessionError {
    #[error("unauthenticated")]
    Unauthenticated,
    #[error("online metadata required")]
    OnlineMetadataRequired,
    #[error("authorization failed")]
    AuthorizationFailed,
    #[error("invalid server metadata")]
    InvalidMetadata,
    #[error("invalid identity")]
    InvalidIdentity,
    #[error("host key mismatch")]
    HostKeyMismatch,
    #[error("host key rejected by user")]
    HostKeyRejectedByUser,
    #[error("cloud host-key write failed")]
    CloudHostKeyWriteFailed,
    #[error("local known-hosts write failed")]
    LocalKnownHostsFailed,
    /// SSH public-key authentication rejected (no secret detail).
    #[error("ssh authentication failed")]
    AuthenticationFailed,
    /// TCP/KEX/connect failed (no host/user/secret detail).
    #[error("ssh connect failed")]
    ConnectFailed,
    /// Session/channel/PTY/shell setup failed.
    #[error("ssh channel failed")]
    ChannelFailed,
    /// Transport closed or cancelled.
    #[error("ssh transport closed")]
    TransportClosed,
    /// Bounded command queue saturated (backpressure fail-closed).
    #[error("ssh command queue full")]
    CommandQueueFull,
    #[error("internal error")]
    Internal,
}

impl SshSessionError {
    /// Stable user-facing copy. Never leaks secrets or existence details.
    pub fn user_message(&self) -> String {
        match self {
            SshSessionError::OnlineMetadataRequired => {
                "ONLINE_METADATA_REQUIRED: 需要在线获取服务器元数据后才能连接".into()
            }
            SshSessionError::Unauthenticated => "需要先登录".into(),
            // Cross-tenant / cross-credential / 401/403/404 share one message.
            SshSessionError::AuthorizationFailed | SshSessionError::InvalidIdentity => {
                "无权访问该服务器或凭据".into()
            }
            SshSessionError::InvalidMetadata => "服务器元数据无效".into(),
            SshSessionError::HostKeyMismatch => "主机密钥与云端固定值不匹配，连接已拒绝".into(),
            SshSessionError::HostKeyRejectedByUser => "用户拒绝了主机密钥确认".into(),
            SshSessionError::CloudHostKeyWriteFailed => "云端主机密钥登记失败".into(),
            SshSessionError::LocalKnownHostsFailed => "本机主机密钥记录失败".into(),
            SshSessionError::AuthenticationFailed => "SSH 身份验证失败".into(),
            SshSessionError::ConnectFailed => "无法建立 SSH 连接".into(),
            SshSessionError::ChannelFailed => "SSH 会话通道建立失败".into(),
            SshSessionError::TransportClosed => "SSH 会话已关闭".into(),
            SshSessionError::CommandQueueFull => "SSH 输入队列已满，请稍后重试".into(),
            SshSessionError::Internal => "内部错误".into(),
        }
    }
}

// ─── Injectable adapters ─────────────────────────────────────────────────────

pub trait ServerMetadataClient: Send + Sync {
    fn fetch_server_json(&self, url: &str, bearer: &str) -> Result<String, SshSessionError>;
}

pub trait HostKeyConfirmer: Send + Sync {
    fn confirm_tofu(&self, prompt: &TofuPrompt) -> Result<bool, SshSessionError>;
}

pub trait CloudHostKeyWriter: Send + Sync {
    fn write_host_key(
        &self,
        params: &CloudHostKeyParams,
        bearer: &str,
    ) -> Result<(), SshSessionError>;
}

pub trait LocalKnownHosts: Send + Sync {
    /// Persist host key under an **opaque validated namespace** from
    /// [`local_known_hosts_namespace`] — never raw principal or bare server_id.
    /// Implementers must treat `namespace` as the sole isolation key.
    fn record_host_key(
        &self,
        namespace: &str,
        key_type: &str,
        fingerprint: &str,
    ) -> Result<(), SshSessionError>;
}

/// Validate a principal identity component for known-hosts namespacing.
/// Must be nonempty, exact (no leading/trailing whitespace), and free of control chars.
fn validate_principal_ns_component(s: &str) -> Result<&str, SshSessionError> {
    if s.is_empty() {
        return Err(SshSessionError::InvalidIdentity);
    }
    // Exact match to trimmed form: reject leading/trailing whitespace without "fixing".
    if s != s.trim() {
        return Err(SshSessionError::InvalidIdentity);
    }
    if s.chars().any(|c| c.is_control()) {
        return Err(SshSessionError::InvalidIdentity);
    }
    Ok(s)
}

/// Versioned, opaque local known-hosts namespace.
///
/// Format: `kh/v1/{sha256_hex(tenant || 0x1f || user)}/{server_id}`.
/// Principal is **hashed** (not reversible base64). Domain separator `0x1f` keeps
/// (`"a/b"`,`"c"`) distinct from (`"a"`,`"b/c"`). Raw tenant/user never appear in path.
pub fn local_known_hosts_namespace(
    principal: &NativePrincipal,
    server_id: &str,
) -> Result<String, SshSessionError> {
    use sha2::{Digest, Sha256};
    let tenant = validate_principal_ns_component(&principal.tenant_id)?;
    let user = validate_principal_ns_component(&principal.user_id)?;
    validate_ssh_id(server_id)?;
    let mut h = Sha256::new();
    h.update(tenant.as_bytes());
    h.update([0x1f]);
    h.update(user.as_bytes());
    let hex = hex::encode(h.finalize());
    Ok(format!("kh/v1/{hex}/{server_id}"))
}

// ─── ID validation (before URL / network) ────────────────────────────────────

/// Strict conservative id: `[A-Za-z0-9._-]+`, nonempty, ≤128, no `.`/`..` segments,
/// no `/ ? # %` or other path/injection characters.
pub fn validate_ssh_id(id: &str) -> Result<(), SshSessionError> {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return Err(SshSessionError::InvalidIdentity);
    }
    if id == "." || id == ".." || id.contains("..") {
        return Err(SshSessionError::InvalidIdentity);
    }
    if id.starts_with('.') || id.ends_with('.') {
        return Err(SshSessionError::InvalidIdentity);
    }
    if id.contains('/')
        || id.contains('\\')
        || id.contains('?')
        || id.contains('#')
        || id.contains('%')
        || id.contains('\0')
    {
        return Err(SshSessionError::InvalidIdentity);
    }
    if id.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(SshSessionError::InvalidIdentity);
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(SshSessionError::InvalidIdentity);
    }
    Ok(())
}

// ─── URL / body helpers ──────────────────────────────────────────────────────

pub fn server_metadata_url(server_id: &str) -> Result<String, SshSessionError> {
    validate_ssh_id(server_id)?;
    Ok(format!("{API_BASE_URL}/api/servers/{server_id}"))
}

pub fn cloud_host_key_url(server_id: &str) -> Result<String, SshSessionError> {
    validate_ssh_id(server_id)?;
    Ok(format!("{API_BASE_URL}/api/servers/{server_id}/host-key"))
}

/// JSON body for POST /host-key (no bearer).
pub fn cloud_host_key_body(params: &CloudHostKeyParams) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert(
        "host_key_type".into(),
        serde_json::Value::String(params.host_key_type.clone()),
    );
    map.insert(
        "fingerprint".into(),
        serde_json::Value::String(params.fingerprint.clone()),
    );
    // Initial TOFU: null; rotate: string.
    map.insert(
        "expected_fingerprint".into(),
        match &params.expected_fingerprint {
            Some(e) => serde_json::Value::String(e.clone()),
            None => serde_json::Value::Null,
        },
    );
    serde_json::Value::Object(map)
}

// ─── Parse / authorize ───────────────────────────────────────────────────────

pub fn parse_server_metadata(
    raw: &str,
    expected_id: &str,
) -> Result<ServerMetadata, SshSessionError> {
    #[derive(Debug, Deserialize)]
    struct Wire {
        id: String,
        tenant_id: String,
        name: String,
        ip: String,
        ssh_user: String,
        ssh_port: u64,
        ssh_credential_id: Option<String>,
        host_key_type: Option<String>,
        host_key_fingerprint: Option<String>,
        host_key_status: String,
    }

    let w: Wire = serde_json::from_str(raw).map_err(|_| SshSessionError::InvalidMetadata)?;
    if w.id.trim() != expected_id.trim() {
        return Err(SshSessionError::AuthorizationFailed);
    }
    let id = require_nonempty(&w.id)?;
    let tenant_id = require_nonempty(&w.tenant_id)?;
    let name = require_nonempty(&w.name)?;
    let ip = require_nonempty(&w.ip)?;
    let ssh_user = require_nonempty(&w.ssh_user)?;
    if w.ssh_port == 0 || w.ssh_port > u16::MAX as u64 {
        return Err(SshSessionError::InvalidMetadata);
    }
    let ssh_port = w.ssh_port as u16;
    let ssh_credential_id = w
        .ssh_credential_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(SshSessionError::InvalidMetadata)?
        .to_string();

    let host_key_status = match w.host_key_status.trim() {
        "pinned" => HostKeyStatus::Pinned,
        "unpinned" => HostKeyStatus::Unpinned,
        _ => return Err(SshSessionError::InvalidMetadata),
    };

    let host_key_type = w
        .host_key_type
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let host_key_fingerprint = w
        .host_key_fingerprint
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    match host_key_status {
        HostKeyStatus::Pinned => {
            if host_key_type.is_none() || host_key_fingerprint.is_none() {
                return Err(SshSessionError::InvalidMetadata);
            }
        }
        HostKeyStatus::Unpinned => {
            // Reject contradictory partial host-key fields on unpinned metadata.
            if host_key_type.is_some() || host_key_fingerprint.is_some() {
                return Err(SshSessionError::InvalidMetadata);
            }
        }
    }

    Ok(ServerMetadata {
        id,
        tenant_id,
        name,
        ip,
        ssh_user,
        ssh_port,
        ssh_credential_id,
        host_key_type,
        host_key_fingerprint,
        host_key_status,
    })
}

fn require_nonempty(s: &str) -> Result<String, SshSessionError> {
    let t = s.trim();
    if t.is_empty() {
        return Err(SshSessionError::InvalidMetadata);
    }
    Ok(t.to_string())
}

/// Authorize metadata against a bound principal (from auth snapshot), not a fresh store read.
pub fn authorize_server_for_principal(
    principal: &NativePrincipal,
    meta: &ServerMetadata,
    request_credential_id: &str,
) -> Result<(), SshSessionError> {
    if principal.tenant_id != meta.tenant_id {
        return Err(SshSessionError::AuthorizationFailed);
    }
    if meta.ssh_credential_id != request_credential_id.trim() {
        return Err(SshSessionError::AuthorizationFailed);
    }
    Ok(())
}

pub fn authorize_server_for_open(
    auth: &AuthStore,
    meta: &ServerMetadata,
    request_credential_id: &str,
) -> Result<(), SshSessionError> {
    let principal = auth
        .native_principal()
        .ok_or(SshSessionError::Unauthenticated)?;
    authorize_server_for_principal(&principal, meta, request_credential_id)
}

fn require_snapshot_current(
    auth: &AuthStore,
    snap: &NativeAuthSnapshot,
) -> Result<(), SshSessionError> {
    if auth.snapshot_still_current(snap) {
        Ok(())
    } else {
        Err(SshSessionError::AuthorizationFailed)
    }
}

// ─── Host-key decision ───────────────────────────────────────────────────────

pub fn evaluate_host_key(
    meta: &ServerMetadata,
    presented: &PresentedHostKey,
    confirmer: &dyn HostKeyConfirmer,
) -> Result<HostKeyDecision, SshSessionError> {
    let p_type = presented.key_type.trim();
    let p_fp = presented.fingerprint.trim();
    if p_type.is_empty() || p_fp.is_empty() {
        return Err(SshSessionError::InvalidMetadata);
    }

    match meta.host_key_status {
        HostKeyStatus::Pinned => {
            let m_type = meta
                .host_key_type
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or(SshSessionError::InvalidMetadata)?;
            let m_fp = meta
                .host_key_fingerprint
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or(SshSessionError::InvalidMetadata)?;
            if m_type == p_type && m_fp == p_fp {
                Ok(HostKeyDecision::AcceptPinned)
            } else {
                Err(SshSessionError::HostKeyMismatch)
            }
        }
        HostKeyStatus::Unpinned => {
            let prompt = TofuPrompt {
                server_name: meta.name.clone(),
                host: meta.ip.clone(),
                key_type: p_type.to_string(),
                fingerprint: p_fp.to_string(),
            };
            if confirmer.confirm_tofu(&prompt)? {
                Ok(HostKeyDecision::AcceptTofu {
                    key_type: p_type.to_string(),
                    fingerprint: p_fp.to_string(),
                })
            } else {
                Err(SshSessionError::HostKeyRejectedByUser)
            }
        }
    }
}

// ─── Orchestration (D4B2a two-phase) ─────────────────────────────────────────

/// **Phase 1** — authorize online metadata + credential binding before connect.
/// Does **not** accept a presented host key (WebView never supplies keys).
/// Does **not** run TOFU or write cloud/local pins.
pub fn prepare_local_ssh_open(
    auth: &AuthStore,
    req: &LocalSshOpenRequest,
    meta_client: &dyn ServerMetadataClient,
) -> Result<PreparedSshTarget, SshSessionError> {
    validate_ssh_id(&req.server_id)?;
    validate_ssh_id(&req.credential_id)?;

    // Atomic principal + bearer + epoch before any network.
    let snap = auth
        .native_auth_snapshot()
        .ok_or(SshSessionError::Unauthenticated)?;

    let url = server_metadata_url(&req.server_id)?;
    let raw = meta_client.fetch_server_json(&url, snap.bearer.as_str())?;
    require_snapshot_current(auth, &snap)?;

    let meta = parse_server_metadata(&raw, &req.server_id)?;
    authorize_server_for_principal(&snap.principal, &meta, &req.credential_id)?;
    require_snapshot_current(auth, &snap)?;

    Ok(PreparedSshTarget {
        server_id: meta.id,
        name: meta.name,
        host: meta.ip,
        port: meta.ssh_port,
        username: meta.ssh_user,
        credential_id: req.credential_id.clone(),
        host_key_status: meta.host_key_status,
        host_key_type: meta.host_key_type,
        host_key_fingerprint: meta.host_key_fingerprint,
        principal: snap.principal.clone(),
        session_epoch: snap.epoch,
    })
}

/// Build [`PresentedHostKey`] from the russh `check_server_key` public key.
/// Fingerprint is OpenSSH-style `SHA256:…`. Never logs key material.
pub fn presented_host_key_from_russh(
    server_public_key: &russh::keys::PublicKey,
) -> PresentedHostKey {
    use russh::keys::HashAlg;
    PresentedHostKey {
        key_type: server_public_key.algorithm().as_str().to_string(),
        fingerprint: server_public_key.fingerprint(HashAlg::Sha256).to_string(),
    }
}

/// **Phase 2** — evaluate the real server host key from russh `check_server_key`.
/// Requires the same principal+epoch binding as phase 1. Pinned: exact match or
/// hard-block. Unpinned: native confirm → cloud → revalidate → local KH.
pub fn verify_server_host_key(
    auth: &AuthStore,
    target: &PreparedSshTarget,
    presented: &PresentedHostKey,
    confirmer: &dyn HostKeyConfirmer,
    cloud: &dyn CloudHostKeyWriter,
    local_kh: &dyn LocalKnownHosts,
) -> Result<(), SshSessionError> {
    if !auth.session_binding_current(&target.principal, target.session_epoch) {
        return Err(SshSessionError::AuthorizationFailed);
    }
    let snap = auth
        .native_auth_snapshot()
        .ok_or(SshSessionError::Unauthenticated)?;
    if snap.principal != target.principal || snap.epoch != target.session_epoch {
        return Err(SshSessionError::AuthorizationFailed);
    }

    let meta = ServerMetadata {
        id: target.server_id.clone(),
        tenant_id: target.principal.tenant_id.clone(),
        name: target.name.clone(),
        ip: target.host.clone(),
        ssh_user: target.username.clone(),
        ssh_port: target.port,
        ssh_credential_id: target.credential_id.clone(),
        host_key_type: target.host_key_type.clone(),
        host_key_fingerprint: target.host_key_fingerprint.clone(),
        host_key_status: target.host_key_status,
    };
    let kh_namespace = local_known_hosts_namespace(&target.principal, &target.server_id)?;

    require_snapshot_current(auth, &snap)?;
    let decision = evaluate_host_key(&meta, presented, confirmer)?;
    require_snapshot_current(auth, &snap)?;

    match decision {
        HostKeyDecision::AcceptPinned => {
            // Reconcile matching cloud pin into local known-hosts (no cloud write).
            // Local write failure fails closed so a later retry can still pin.
            let key_type = presented.key_type.trim();
            let fingerprint = presented.fingerprint.trim();
            if key_type.is_empty() || fingerprint.is_empty() {
                return Err(SshSessionError::InvalidMetadata);
            }
            require_snapshot_current(auth, &snap)?;
            local_kh.record_host_key(&kh_namespace, key_type, fingerprint)?;
            require_snapshot_current(auth, &snap)?;
            Ok(())
        }
        HostKeyDecision::AcceptTofu {
            key_type,
            fingerprint,
        } => {
            require_snapshot_current(auth, &snap)?;
            let params = CloudHostKeyParams {
                server_id: target.server_id.clone(),
                host_key_type: key_type.clone(),
                fingerprint: fingerprint.clone(),
                expected_fingerprint: None,
            };
            cloud.write_host_key(&params, snap.bearer.as_str())?;
            require_snapshot_current(auth, &snap)?;
            local_kh.record_host_key(&kh_namespace, &key_type, &fingerprint)?;
            require_snapshot_current(auth, &snap)?;
            Ok(())
        }
    }
}

// ─── russh client Handler (phase-2 host key at check_server_key) ─────────────

/// Owned, `'static` russh client handler for `client::connect`.
///
/// Private fields; construct with [`HostKeyPolicyHandler::new`]. Holds `Arc`
/// auth + adapters and an owned [`PreparedSshTarget`] so the type is
/// `Handler + Send + 'static` (required by russh connect).
pub struct HostKeyPolicyHandler {
    auth: std::sync::Arc<AuthStore>,
    target: PreparedSshTarget,
    confirmer: std::sync::Arc<dyn HostKeyConfirmer>,
    cloud: std::sync::Arc<dyn CloudHostKeyWriter>,
    local_kh: std::sync::Arc<dyn LocalKnownHosts>,
}

impl HostKeyPolicyHandler {
    pub fn new(
        auth: std::sync::Arc<AuthStore>,
        target: PreparedSshTarget,
        confirmer: std::sync::Arc<dyn HostKeyConfirmer>,
        cloud: std::sync::Arc<dyn CloudHostKeyWriter>,
        local_kh: std::sync::Arc<dyn LocalKnownHosts>,
    ) -> Self {
        Self {
            auth,
            target,
            confirmer,
            cloud,
            local_kh,
        }
    }
}

impl From<russh::Error> for SshSessionError {
    fn from(_: russh::Error) -> Self {
        SshSessionError::Internal
    }
}

impl russh::client::Handler for HostKeyPolicyHandler {
    type Error = SshSessionError;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let presented = presented_host_key_from_russh(server_public_key);
        // Propagate HostKeyMismatch / HostKeyRejectedByUser as exact Err so
        // russh does not collapse them into UnknownKey / Internal via Ok(false).
        verify_server_host_key(
            self.auth.as_ref(),
            &self.target,
            &presented,
            self.confirmer.as_ref(),
            self.cloud.as_ref(),
            self.local_kh.as_ref(),
        )?;
        Ok(true)
    }
}

/// Compile-time: handler is usable with `russh::client::connect` (Handler + Send + 'static).
const _: () = {
    fn _assert_handler_bounds<T: russh::client::Handler + Send + 'static>() {}
    fn _check() {
        _assert_handler_bounds::<HostKeyPolicyHandler>();
    }
};

// ─── Production native TOFU confirmer (existing rfd dependency only) ──────────

/// Native host-key confirmation via **`rfd::MessageDialog::show` only**.
///
/// Do **not** call AppKit/`MainThreadMarker` or GCD/`dispatch2` here. In rfd 0.17.2
/// the macOS backend already hops to the main thread inside `show()` (`run_on_main`)
/// and returns `MessageDialogResult` synchronously — safe from the russh
/// `check_server_key` worker thread. No new dependencies.
#[derive(Debug, Default, Clone, Copy)]
pub struct NativeTofuConfirmer;

impl HostKeyConfirmer for NativeTofuConfirmer {
    fn confirm_tofu(&self, prompt: &TofuPrompt) -> Result<bool, SshSessionError> {
        use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
        // Only non-secret connection + key identity fields (no bearer/principal).
        let description = format!(
            "Server: {}\nHost: {}\nKey type: {}\nFingerprint: {}\n\nAccept this host key?",
            prompt.server_name, prompt.host, prompt.key_type, prompt.fingerprint
        );
        let result = MessageDialog::new()
            .set_level(MessageLevel::Warning)
            .set_title("Confirm SSH host key")
            .set_description(&description)
            .set_buttons(MessageButtons::OkCancel)
            .show(); // rfd macOS: run_on_main + sync return
                     // OkCancel: accept **only** Ok (not Yes).
        Ok(matches!(result, MessageDialogResult::Ok))
    }
}

// ─── Production tenant-isolated local known-hosts ────────────────────────────

/// Filesystem known-hosts under opaque [`local_known_hosts_namespace`].
/// Atomic write (unique create_new temp → write → sync → rename), fail-closed
/// permissions, reject symlink leaf; no new dependencies.
#[derive(Debug, Clone)]
pub struct FsLocalKnownHosts {
    root: std::path::PathBuf,
}

impl FsLocalKnownHosts {
    pub fn new(root: impl Into<std::path::PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn under_app_data(app_data: impl AsRef<std::path::Path>) -> Self {
        Self {
            root: app_data.as_ref().join("ssh-known-hosts"),
        }
    }

    fn path_for_namespace(&self, namespace: &str) -> Result<std::path::PathBuf, SshSessionError> {
        if namespace.is_empty()
            || namespace.starts_with('/')
            || namespace.contains('\0')
            || namespace
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == "..")
        {
            return Err(SshSessionError::LocalKnownHostsFailed);
        }
        let mut path = self.root.clone();
        for seg in namespace.split('/') {
            path.push(seg);
        }
        if !path.starts_with(&self.root) {
            return Err(SshSessionError::LocalKnownHostsFailed);
        }
        Ok(path)
    }

    fn reject_symlink(path: &std::path::Path) -> Result<(), SshSessionError> {
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                Err(SshSessionError::LocalKnownHostsFailed)
            }
            _ => Ok(()),
        }
    }

    fn ensure_dir_0700(path: &std::path::Path) -> Result<(), SshSessionError> {
        if !path.exists() {
            std::fs::create_dir_all(path).map_err(|_| SshSessionError::LocalKnownHostsFailed)?;
        }
        let meta =
            std::fs::symlink_metadata(path).map_err(|_| SshSessionError::LocalKnownHostsFailed)?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(SshSessionError::LocalKnownHostsFailed);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| SshSessionError::LocalKnownHostsFailed)?;
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
    ) -> Result<(), SshSessionError> {
        use std::io::Write;

        let path = self.path_for_namespace(namespace)?;
        Self::reject_symlink(&path)?;
        Self::ensure_dir_0700(&self.root)?;
        if let Some(parent) = path.parent() {
            let rel = parent
                .strip_prefix(&self.root)
                .map_err(|_| SshSessionError::LocalKnownHostsFailed)?;
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
        let cleanup = |t: &std::path::Path| {
            let _ = std::fs::remove_file(t);
        };

        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        let mut file = match opts.open(&tmp) {
            Ok(f) => f,
            Err(_) => {
                cleanup(&tmp);
                return Err(SshSessionError::LocalKnownHostsFailed);
            }
        };
        if file.write_all(body.as_bytes()).is_err() || file.sync_all().is_err() {
            drop(file);
            cleanup(&tmp);
            return Err(SshSessionError::LocalKnownHostsFailed);
        }
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).is_err() {
                cleanup(&tmp);
                return Err(SshSessionError::LocalKnownHostsFailed);
            }
        }
        Self::reject_symlink(&path)?;
        if std::fs::rename(&tmp, &path).is_err() {
            cleanup(&tmp);
            return Err(SshSessionError::LocalKnownHostsFailed);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| SshSessionError::LocalKnownHostsFailed)?;
        }
        Ok(())
    }
}

// ─── Bounded body accumulation (unit-testable) ───────────────────────────────

/// Accumulate chunks with a hard max. Pure helper for streaming reads.
pub fn accumulate_chunks_bounded(
    chunks: impl IntoIterator<Item = Vec<u8>>,
    max_bytes: usize,
) -> Result<Vec<u8>, SshSessionError> {
    let mut out = Vec::new();
    for chunk in chunks {
        let next = out.len().saturating_add(chunk.len());
        if next > max_bytes {
            return Err(SshSessionError::OnlineMetadataRequired);
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Early Content-Length reject + streaming chunk read with max 1 MiB.
pub async fn read_response_body_bounded(
    resp: reqwest::Response,
    transport_err: SshSessionError,
) -> Result<Vec<u8>, SshSessionError> {
    if let Some(cl) = resp.content_length() {
        if cl > MAX_HTTP_BODY_BYTES {
            return Err(transport_err);
        }
    }
    let max = MAX_HTTP_BODY_BYTES as usize;
    let mut out = Vec::new();
    let mut stream = resp;
    loop {
        match stream.chunk().await {
            Ok(Some(chunk)) => {
                let next = out.len().saturating_add(chunk.len());
                if next > max {
                    return Err(transport_err);
                }
                out.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return Err(transport_err),
        }
    }
    Ok(out)
}

// ─── Production HTTPS adapters ───────────────────────────────────────────────

fn https_client_get(timeout_secs: u64) -> Result<reqwest::Client, SshSessionError> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|_| SshSessionError::OnlineMetadataRequired)
}

fn https_client_post(timeout_secs: u64) -> Result<reqwest::Client, SshSessionError> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|_| SshSessionError::CloudHostKeyWriteFailed)
}

fn block_on_http_get<F, T>(fut: F) -> Result<T, SshSessionError>
where
    F: std::future::Future<Output = Result<T, SshSessionError>> + Send + 'static,
    T: Send + 'static,
{
    if tokio::runtime::Handle::try_current().is_ok() {
        return std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| SshSessionError::OnlineMetadataRequired)?;
            rt.block_on(fut)
        })
        .join()
        .map_err(|_| SshSessionError::OnlineMetadataRequired)?;
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| SshSessionError::OnlineMetadataRequired)?;
    rt.block_on(fut)
}

fn block_on_http_post<F, T>(fut: F) -> Result<T, SshSessionError>
where
    F: std::future::Future<Output = Result<T, SshSessionError>> + Send + 'static,
    T: Send + 'static,
{
    if tokio::runtime::Handle::try_current().is_ok() {
        return std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| SshSessionError::CloudHostKeyWriteFailed)?;
            rt.block_on(fut)
        })
        .join()
        .map_err(|_| SshSessionError::CloudHostKeyWriteFailed)?;
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| SshSessionError::CloudHostKeyWriteFailed)?;
    rt.block_on(fut)
}

/// Build sensitive Authorization header; temp buffer is Zeroizing.
fn sensitive_bearer_header_get(
    bearer: &str,
) -> Result<reqwest::header::HeaderValue, SshSessionError> {
    let mut raw = Zeroizing::new(format!("Bearer {bearer}"));
    let mut hv = reqwest::header::HeaderValue::from_str(raw.as_str())
        .map_err(|_| SshSessionError::OnlineMetadataRequired)?;
    hv.set_sensitive(true);
    raw.zeroize();
    Ok(hv)
}

fn sensitive_bearer_header_post(
    bearer: &str,
) -> Result<reqwest::header::HeaderValue, SshSessionError> {
    let mut raw = Zeroizing::new(format!("Bearer {bearer}"));
    let mut hv = reqwest::header::HeaderValue::from_str(raw.as_str())
        .map_err(|_| SshSessionError::CloudHostKeyWriteFailed)?;
    hv.set_sensitive(true);
    raw.zeroize();
    Ok(hv)
}

/// Map GET response status: 401/403/404 → AuthorizationFailed; 5xx/other fail → online.
pub fn map_get_status(status: reqwest::StatusCode) -> Result<(), SshSessionError> {
    if status.is_success() {
        return Ok(());
    }
    match status.as_u16() {
        401 | 403 | 404 => Err(SshSessionError::AuthorizationFailed),
        s if s >= 500 => Err(SshSessionError::OnlineMetadataRequired),
        _ if status.is_client_error() => Err(SshSessionError::AuthorizationFailed),
        _ => Err(SshSessionError::OnlineMetadataRequired),
    }
}

/// Map POST response status: any non-success → CloudHostKeyWriteFailed.
pub fn map_post_status(status: reqwest::StatusCode) -> Result<(), SshSessionError> {
    if status.is_success() {
        Ok(())
    } else {
        Err(SshSessionError::CloudHostKeyWriteFailed)
    }
}

/// Production GET metadata: HTTPS, ephemeral bearer, timeout, status mapping, streaming body bound.
pub struct ReqwestServerMetadataClient {
    timeout_secs: u64,
}

impl Default for ReqwestServerMetadataClient {
    fn default() -> Self {
        Self { timeout_secs: 15 }
    }
}

impl ReqwestServerMetadataClient {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ServerMetadataClient for ReqwestServerMetadataClient {
    fn fetch_server_json(&self, url: &str, bearer: &str) -> Result<String, SshSessionError> {
        if !url.starts_with("https://") {
            return Err(SshSessionError::OnlineMetadataRequired);
        }
        let client = https_client_get(self.timeout_secs)?;
        let url = url.to_string();
        let auth_hv = sensitive_bearer_header_get(bearer)?;
        block_on_http_get(async move {
            let resp = client
                .get(&url)
                .header(reqwest::header::AUTHORIZATION, auth_hv)
                .send()
                .await
                .map_err(|_| SshSessionError::OnlineMetadataRequired)?;
            map_get_status(resp.status())?;
            let body =
                read_response_body_bounded(resp, SshSessionError::OnlineMetadataRequired).await?;
            String::from_utf8(body).map_err(|_| SshSessionError::InvalidMetadata)
        })
    }
}

/// Production POST host-key: HTTPS, ephemeral bearer, timeout; success drops body unread.
pub struct ReqwestCloudHostKeyWriter {
    timeout_secs: u64,
}

impl Default for ReqwestCloudHostKeyWriter {
    fn default() -> Self {
        Self { timeout_secs: 15 }
    }
}

impl ReqwestCloudHostKeyWriter {
    pub fn new() -> Self {
        Self::default()
    }
}

impl CloudHostKeyWriter for ReqwestCloudHostKeyWriter {
    fn write_host_key(
        &self,
        params: &CloudHostKeyParams,
        bearer: &str,
    ) -> Result<(), SshSessionError> {
        let url = cloud_host_key_url(&params.server_id)?;
        if !url.starts_with("https://") {
            return Err(SshSessionError::CloudHostKeyWriteFailed);
        }
        let client = https_client_post(self.timeout_secs)?;
        let body = cloud_host_key_body(params);
        let auth_hv = sensitive_bearer_header_post(bearer)?;
        block_on_http_post(async move {
            let resp = client
                .post(&url)
                .header(reqwest::header::AUTHORIZATION, auth_hv)
                .json(&body)
                .send()
                .await
                .map_err(|_| SshSessionError::CloudHostKeyWriteFailed)?;
            map_post_status(resp.status())?;
            // Success: do not accumulate body — drop Response.
            drop(resp);
            Ok(())
        })
    }
}

#[cfg(test)]
#[path = "ssh_session_tests.rs"]
mod tests;
