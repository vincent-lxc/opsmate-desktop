//! Local SSH open preparation: metadata + vault lease (no connection).
//! Crate-internal; production wiring deferred to 8B2+.

// Until 8B2 registers callers, non-test builds see an unused prepare surface.
// Scoped to this module only — not a crate-wide allow.
#![cfg_attr(not(test), allow(dead_code))]

use crate::auth::{AuthBinding, AuthStore, NativePrincipal};
use crate::cloud_bridge::CloudBridge;
use crate::cloud_transport::{HttpBackend, TransportError};
use crate::security_cutoff::SecurityCutoff;
use crate::vault::{validate_id, VaultCredentialLease, VaultError, VaultService};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::str::FromStr;
use thiserror::Error;

// ─── WebView DTO (secret-free; no host/token/pem) ─────────────────────────────

/// WebView-shaped input for future `local_ssh_open` IPC.
/// Exactly `serverId` + `credentialId` (camelCase). No secrets, tenant, host, port.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalSshOpenRequest {
    pub server_id: String,
    pub credential_id: String,
}

// ─── Fixed errors (never raw HTTP/body/secret text) ──────────────────────────

/// Closed error set for local SSH prepare / connect. Display is fixed public codes only.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum LocalSshError {
    /// Request DTO / id validation failed.
    #[error("local_ssh_invalid_input")]
    InvalidInput,
    /// No native auth session / binding.
    #[error("local_ssh_unauthenticated")]
    Unauthenticated,
    /// Auth principal/epoch changed mid-prepare (or vault binding mismatch).
    #[error("local_ssh_binding_mismatch")]
    BindingMismatch,
    /// Real vault is locked (or cutoff vault gate locked before prepare).
    #[error("local_ssh_vault_locked")]
    VaultLocked,
    /// SecurityCutoff SSH generation advanced (or vault gate locked mid-prepare).
    #[error("local_ssh_ssh_cutoff")]
    SshCutoff,
    /// Cloud metadata unavailable, transport failure, or unusable response.
    #[error("local_ssh_online_metadata_required")]
    OnlineMetadataRequired,
    /// Server/tenant/credential identity mismatch (fail closed, A/B isolation).
    #[error("local_ssh_metadata_mismatch")]
    MetadataMismatch,
    /// Host/port/user/host-key fields present but invalid.
    #[error("local_ssh_invalid_metadata")]
    InvalidMetadata,
    /// Local vault has no matching credential for this principal.
    #[error("local_ssh_credential_not_found")]
    CredentialNotFound,
    /// Pinned host key type or fingerprint mismatch.
    #[error("local_ssh_host_key_mismatch")]
    HostKeyMismatch,
    /// User rejected native TOFU confirmation.
    #[error("local_ssh_host_key_rejected")]
    HostKeyRejectedByUser,
    /// Cloud host-key CAS pin failed.
    #[error("local_ssh_cloud_host_key_failed")]
    CloudHostKeyWriteFailed,
    /// Local known-hosts write failed.
    #[error("local_ssh_local_known_hosts_failed")]
    LocalKnownHostsFailed,
    /// SSH public-key authentication rejected (no secret detail).
    #[error("local_ssh_authentication_failed")]
    AuthenticationFailed,
    /// TCP/KEX/connect failed or overall handshake timeout (no host/user/secret).
    #[error("local_ssh_connect_failed")]
    ConnectFailed,
    /// Unexpected internal failure (no secret payload).
    #[error("local_ssh_internal")]
    Internal,
}

/// Map to fixed public IPC string codes (never raw transport/HTTP/body text).
pub fn map_local_ssh_public(err: LocalSshError) -> &'static str {
    match err {
        LocalSshError::InvalidInput => "local_ssh_invalid_input",
        LocalSshError::Unauthenticated => "local_ssh_unauthenticated",
        LocalSshError::BindingMismatch => "local_ssh_binding_mismatch",
        LocalSshError::VaultLocked => "local_ssh_vault_locked",
        LocalSshError::SshCutoff => "local_ssh_ssh_cutoff",
        LocalSshError::OnlineMetadataRequired => "local_ssh_online_metadata_required",
        LocalSshError::MetadataMismatch => "local_ssh_metadata_mismatch",
        LocalSshError::InvalidMetadata => "local_ssh_invalid_metadata",
        LocalSshError::CredentialNotFound => "local_ssh_credential_not_found",
        LocalSshError::HostKeyMismatch => "local_ssh_host_key_mismatch",
        LocalSshError::HostKeyRejectedByUser => "local_ssh_host_key_rejected",
        LocalSshError::CloudHostKeyWriteFailed => "local_ssh_cloud_host_key_failed",
        LocalSshError::LocalKnownHostsFailed => "local_ssh_local_known_hosts_failed",
        LocalSshError::AuthenticationFailed => "local_ssh_authentication_failed",
        LocalSshError::ConnectFailed => "local_ssh_connect_failed",
        LocalSshError::Internal => "local_ssh_internal",
    }
}

// ─── Prepared context (Rust-internal only) ───────────────────────────────────

/// Optional known host-key pair from online metadata (both present or both absent).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedHostKey {
    pub key_type: String,
    pub fingerprint: String,
}

/// Successful local SSH preparation — **not** Serialize, **not** Clone.
/// Holds target metadata, binding snapshot, SSH generation, and vault lease.
/// Debug is manually redacted: never dumps PEM, passphrase, tenant, subject, bearer.
///
/// Consume via [`split_prepared_for_connect`] before handshake / `complete_established`.
pub struct PreparedLocalSshOpen {
    pub server_id: String,
    pub credential_id: String,
    pub target_host: String,
    pub ssh_port: u16,
    pub ssh_user: String,
    pub host_key: Option<PreparedHostKey>,
    /// Captured principal (native-only; redacted in Debug).
    pub principal: NativePrincipal,
    pub epoch: u64,
    pub ssh_generation: u64,
    pub lease: VaultCredentialLease,
}

impl std::fmt::Debug for PreparedLocalSshOpen {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedLocalSshOpen")
            .field("server_id", &"<redacted>")
            .field("credential_id", &"<redacted>")
            .field("target_host", &"<redacted>")
            .field("ssh_port", &self.ssh_port)
            .field("ssh_user", &"<redacted>")
            .field("host_key", &self.host_key.as_ref().map(|_| "<present>"))
            .field("principal", &"<redacted>")
            .field("epoch", &"<redacted>")
            .field("ssh_generation", &self.ssh_generation)
            .field("lease", &"<redacted>")
            .finish()
    }
}

/// Secret-free immutable authority snapshot for connect + `complete_established`.
/// **Not** Clone, **not** Serialize. Never holds PEM/passphrase/bearer.
/// Handshake retains the single instance for `complete_established`; the handler
/// builds a separate minimal policy snapshot from borrowed fields.
pub struct LocalSshConnectAuthority {
    pub server_id: String,
    pub credential_id: String,
    pub target_host: String,
    pub ssh_port: u16,
    pub ssh_user: String,
    pub host_key: Option<PreparedHostKey>,
    pub principal: NativePrincipal,
    pub epoch: u64,
    pub ssh_generation: u64,
}

impl std::fmt::Debug for LocalSshConnectAuthority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalSshConnectAuthority")
            .field("server_id", &"<redacted>")
            .field("credential_id", &"<redacted>")
            .field("target_host", &"<redacted>")
            .field("ssh_port", &self.ssh_port)
            .field("ssh_user", &"<redacted>")
            .field("host_key", &self.host_key.as_ref().map(|_| "<present>"))
            .field("principal", &"<redacted>")
            .field("epoch", &"<redacted>")
            .field("ssh_generation", &self.ssh_generation)
            .finish()
    }
}

/// Consume lease-bearing prepared open into secret-free authority + exactly one lease.
/// Call once at the connector boundary; never store PEM long-lived after decode.
pub fn split_prepared_for_connect(
    prepared: PreparedLocalSshOpen,
) -> (LocalSshConnectAuthority, VaultCredentialLease) {
    let PreparedLocalSshOpen {
        server_id,
        credential_id,
        target_host,
        ssh_port,
        ssh_user,
        host_key,
        principal,
        epoch,
        ssh_generation,
        lease,
    } = prepared;
    (
        LocalSshConnectAuthority {
            server_id,
            credential_id,
            target_host,
            ssh_port,
            ssh_user,
            host_key,
            principal,
            epoch,
            ssh_generation,
        },
        lease,
    )
}

// ─── Bounds ──────────────────────────────────────────────────────────────────

const MAX_HOST_LEN: usize = 253;
const MAX_USER_LEN: usize = 64;
const MAX_HOST_KEY_TYPE_LEN: usize = 64;
const MAX_FINGERPRINT_LEN: usize = 128;

/// Exact trusted identity keys on `servers.get` responses (canonical snake_case only).
const TRUSTED_RESPONSE_KEYS: &[&str] = &[
    "id",
    "tenant_id",
    "ssh_credential_id",
    "ip",
    "ssh_port",
    "ssh_user",
    "host_key_type",
    "host_key_fingerprint",
];

/// Non-trusted secret/ambiguous aliases (fail closed even when they do not collide
/// with a trusted normalized name, e.g. `host` vs `ip`).
const FORBIDDEN_RESPONSE_ALIASES: &[&str] = &[
    "server_id",
    "serverId",
    "host",
    "hostname",
    "address",
    "endpoint",
    "url",
    "target",
    "port",
    "user",
    "username",
    "login",
    "tenant",
    "subject",
    "user_id",
    "userId",
    "credentialId",
    "credential_id",
    "sshCredentialId",
    "private_key",
    "privateKey",
    "pem",
    "passphrase",
    "token",
    "bearer",
    "password",
];

/// Separator-insensitive ASCII lowercase (letters/digits only).
fn normalize_response_key(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

// ─── Public prepare entry ────────────────────────────────────────────────────

/// Capture auth + cutoff, fetch `servers.get`, validate metadata, lease local credential.
///
/// Order (fail closed at each step):
/// 1. Validate request IDs
/// 2. Capture AuthBinding + ssh_generation; require vault + cutoff unlocked
/// 3. Cloud `servers.get` with only `{ "id": server_id }`
/// 4. Strict parse + metadata checks (id/tenant/credential/host/port/user/host-key)
/// 5. Revalidate binding; require cutoff unlocked + generation current
/// 6. `VaultService::lease_for_ssh`
/// 7. Revalidate binding + cutoff/generation again
///
/// Never returns prepared context on any race/mismatch.
pub async fn prepare_local_ssh_open<B: HttpBackend>(
    bridge: &CloudBridge<B>,
    req: &LocalSshOpenRequest,
) -> Result<PreparedLocalSshOpen, LocalSshError> {
    validate_request_ids(req)?;

    let binding = bridge
        .auth
        .auth_binding()
        .ok_or(LocalSshError::Unauthenticated)?;
    let gen = bridge.cutoff.ssh_generation();

    require_vault_and_cutoff_unlocked(&bridge.vault, &bridge.cutoff)?;
    ensure_generation_current(&bridge.cutoff, gen)?;

    let cloud_body = bridge
        .call("servers.get", &json!({ "id": req.server_id }))
        .await
        .map_err(map_transport_err)?;

    let meta = parse_server_metadata(&cloud_body, req, &binding.principal)?;

    // After cloud response — binding + cutoff + generation must still hold.
    revalidate_binding(&bridge.auth, &binding)?;
    require_vault_and_cutoff_unlocked(&bridge.vault, &bridge.cutoff)?;
    ensure_generation_current(&bridge.cutoff, gen)?;

    let lease = bridge
        .vault
        .lease_for_ssh(
            bridge.auth.as_ref(),
            &binding.principal,
            binding.epoch,
            &req.credential_id,
        )
        .map_err(map_vault_err)?;

    // Immediately after lease — same checks (no race window for returned context).
    revalidate_binding(&bridge.auth, &binding)?;
    require_vault_and_cutoff_unlocked(&bridge.vault, &bridge.cutoff)?;
    ensure_generation_current(&bridge.cutoff, gen)?;

    Ok(PreparedLocalSshOpen {
        server_id: meta.server_id,
        credential_id: req.credential_id.clone(),
        target_host: meta.target_host,
        ssh_port: meta.ssh_port,
        ssh_user: meta.ssh_user,
        host_key: meta.host_key,
        principal: binding.principal.clone(),
        epoch: binding.epoch,
        ssh_generation: gen,
        lease,
    })
}

// ─── Internal helpers ────────────────────────────────────────────────────────

fn validate_request_ids(req: &LocalSshOpenRequest) -> Result<(), LocalSshError> {
    validate_id(&req.server_id).map_err(|_| LocalSshError::InvalidInput)?;
    validate_id(&req.credential_id).map_err(|_| LocalSshError::InvalidInput)?;
    Ok(())
}

fn require_vault_and_cutoff_unlocked(
    vault: &VaultService,
    cutoff: &SecurityCutoff,
) -> Result<(), LocalSshError> {
    if cutoff.is_vault_locked() {
        return Err(LocalSshError::VaultLocked);
    }
    let st = vault.status().map_err(|_| LocalSshError::Internal)?;
    if !st.unlocked {
        return Err(LocalSshError::VaultLocked);
    }
    Ok(())
}

fn ensure_generation_current(cutoff: &SecurityCutoff, captured: u64) -> Result<(), LocalSshError> {
    if !cutoff.ssh_session_still_valid(captured) {
        return Err(LocalSshError::SshCutoff);
    }
    Ok(())
}

fn revalidate_binding(auth: &AuthStore, expected: &AuthBinding) -> Result<(), LocalSshError> {
    if auth.auth_binding().is_none() {
        return Err(LocalSshError::Unauthenticated);
    }
    if !auth.binding_still_current(expected) {
        return Err(LocalSshError::BindingMismatch);
    }
    Ok(())
}

fn map_transport_err(e: TransportError) -> LocalSshError {
    match e {
        TransportError::Unauthenticated => LocalSshError::Unauthenticated,
        TransportError::SessionInvalidated => LocalSshError::BindingMismatch,
        TransportError::InvalidInput | TransportError::PathSmuggling => LocalSshError::InvalidInput,
        TransportError::UnknownOperation
        | TransportError::NativeOnly
        | TransportError::NotAvailable
        | TransportError::InvalidInvocation => LocalSshError::Internal,
        TransportError::Transport
        | TransportError::InvalidResponse
        | TransportError::HttpStatus
        | TransportError::ResponseTooLarge
        | TransportError::Cancelled => LocalSshError::OnlineMetadataRequired,
    }
}

fn map_vault_err(e: VaultError) -> LocalSshError {
    match e {
        VaultError::Locked => LocalSshError::VaultLocked,
        VaultError::Unauthenticated => LocalSshError::BindingMismatch,
        VaultError::NotFound => LocalSshError::CredentialNotFound,
        VaultError::InvalidIdentity => LocalSshError::InvalidInput,
        VaultError::Storage | VaultError::Internal => LocalSshError::Internal,
        _ => LocalSshError::Internal,
    }
}

struct ParsedServerMeta {
    server_id: String,
    target_host: String,
    ssh_port: u16,
    ssh_user: String,
    host_key: Option<PreparedHostKey>,
}

/// Strict parse of sanitized `servers.get` JSON object.
fn parse_server_metadata(
    value: &Value,
    req: &LocalSshOpenRequest,
    principal: &NativePrincipal,
) -> Result<ParsedServerMeta, LocalSshError> {
    let obj = match value {
        Value::Object(m) => m,
        Value::Array(_) => return Err(LocalSshError::InvalidMetadata),
        _ => return Err(LocalSshError::OnlineMetadataRequired),
    };

    reject_untrusted_or_alias_keys(obj)?;

    // Required identity fields — exact names only.
    let server_id = require_exact_string(obj, "id")?;
    if server_id != req.server_id {
        return Err(LocalSshError::MetadataMismatch);
    }

    let tenant_id = require_exact_string(obj, "tenant_id")?;
    if tenant_id != principal.tenant_id {
        return Err(LocalSshError::MetadataMismatch);
    }

    let ssh_credential_id = require_exact_string(obj, "ssh_credential_id")?;
    if ssh_credential_id != req.credential_id {
        return Err(LocalSshError::MetadataMismatch);
    }

    let target_host = require_exact_string(obj, "ip")?;
    validate_target_host(&target_host)?;

    let ssh_port = require_exact_port(obj, "ssh_port")?;
    let ssh_user = require_exact_string(obj, "ssh_user")?;
    validate_ssh_user(&ssh_user)?;

    let host_key = parse_host_key_pair(obj)?;

    Ok(ParsedServerMeta {
        server_id,
        target_host,
        ssh_port,
        ssh_user,
        host_key,
    })
}

fn require_exact_string(obj: &Map<String, Value>, key: &str) -> Result<String, LocalSshError> {
    match obj.get(key) {
        Some(Value::String(s)) => {
            if s.is_empty() {
                return Err(LocalSshError::InvalidMetadata);
            }
            Ok(s.clone())
        }
        Some(Value::Null) | None => Err(LocalSshError::InvalidMetadata),
        // Numbers/bools/arrays/objects coerced — reject.
        Some(_) => Err(LocalSshError::InvalidMetadata),
    }
}

fn require_exact_port(obj: &Map<String, Value>, key: &str) -> Result<u16, LocalSshError> {
    match obj.get(key) {
        Some(Value::Number(n)) => {
            // Integers only via as_u64 — rejects floats and negatives.
            match n.as_u64() {
                Some(p) if (1..=65535).contains(&p) => Ok(p as u16),
                _ => Err(LocalSshError::InvalidMetadata),
            }
        }
        // String "22" is coercion — reject.
        Some(Value::String(_)) | Some(Value::Null) | None | Some(_) => {
            Err(LocalSshError::InvalidMetadata)
        }
    }
}

fn parse_host_key_pair(obj: &Map<String, Value>) -> Result<Option<PreparedHostKey>, LocalSshError> {
    let ty = obj.get("host_key_type");
    let fp = obj.get("host_key_fingerprint");

    let ty_absent = matches!(ty, None | Some(Value::Null));
    let fp_absent = matches!(fp, None | Some(Value::Null));

    if ty_absent && fp_absent {
        return Ok(None);
    }
    if ty_absent != fp_absent {
        // One present, one absent — reject.
        return Err(LocalSshError::InvalidMetadata);
    }

    let key_type = match ty {
        Some(Value::String(s)) => s.clone(),
        _ => return Err(LocalSshError::InvalidMetadata),
    };
    let fingerprint = match fp {
        Some(Value::String(s)) => s.clone(),
        _ => return Err(LocalSshError::InvalidMetadata),
    };

    validate_host_key_type(&key_type)?;
    validate_host_key_fingerprint(&fingerprint)?;

    Ok(Some(PreparedHostKey {
        key_type,
        fingerprint,
    }))
}

fn validate_target_host(host: &str) -> Result<(), LocalSshError> {
    if host.is_empty() || host.len() > MAX_HOST_LEN {
        return Err(LocalSshError::InvalidMetadata);
    }
    if host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(LocalSshError::InvalidMetadata);
    }
    // No URL / path / authority syntax.
    for bad in [
        "://", "/", "\\", "?", "#", "@", "%", "\"", "'", "<", ">", " ", "\t",
    ] {
        if host.contains(bad) {
            return Err(LocalSshError::InvalidMetadata);
        }
    }
    // Conservative charset: IPv4 / hostname / IPv6 (hex + colon).
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':' || c == '_')
    {
        return Err(LocalSshError::InvalidMetadata);
    }
    Ok(())
}

fn validate_ssh_user(user: &str) -> Result<(), LocalSshError> {
    if user.is_empty() || user.len() > MAX_USER_LEN {
        return Err(LocalSshError::InvalidMetadata);
    }
    if user.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(LocalSshError::InvalidMetadata);
    }
    if !user
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == '$')
    {
        return Err(LocalSshError::InvalidMetadata);
    }
    Ok(())
}

fn validate_host_key_type(ty: &str) -> Result<(), LocalSshError> {
    if ty.is_empty() || ty.len() > MAX_HOST_KEY_TYPE_LEN {
        return Err(LocalSshError::InvalidMetadata);
    }
    const ALLOWED: &[&str] = &[
        "ssh-ed25519",
        "ssh-rsa",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "rsa-sha2-256",
        "rsa-sha2-512",
    ];
    if !ALLOWED.contains(&ty) {
        return Err(LocalSshError::InvalidMetadata);
    }
    Ok(())
}

/// Canonical OpenSSH SHA-256 fingerprint via russh/ssh-key.
///
/// Parse full input with [`russh::keys::ssh_key::Fingerprint`], require SHA-256,
/// 32 digest bytes, and exact `to_string() == input` (unpadded only).
fn validate_host_key_fingerprint(fp: &str) -> Result<(), LocalSshError> {
    if fp.is_empty() || fp.len() > MAX_FINGERPRINT_LEN {
        return Err(LocalSshError::InvalidMetadata);
    }
    if fp.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(LocalSshError::InvalidMetadata);
    }
    use russh::keys::ssh_key::Fingerprint;
    let parsed = Fingerprint::from_str(fp).map_err(|_| LocalSshError::InvalidMetadata)?;
    if !parsed.is_sha256() {
        return Err(LocalSshError::InvalidMetadata);
    }
    if parsed.as_bytes().len() != 32 {
        return Err(LocalSshError::InvalidMetadata);
    }
    // Reject padded / noncanonical encodings (Display is unpadded standard base64).
    if parsed.to_string() != fp {
        return Err(LocalSshError::InvalidMetadata);
    }
    Ok(())
}

/// Fail closed on non-canonical trusted-key spellings and common aliases.
fn reject_untrusted_or_alias_keys(obj: &Map<String, Value>) -> Result<(), LocalSshError> {
    let trusted_norm: Vec<String> = TRUSTED_RESPONSE_KEYS
        .iter()
        .map(|k| normalize_response_key(k))
        .collect();
    for key in obj.keys() {
        // Exact trusted spelling is allowed once (Map keys are unique).
        if TRUSTED_RESPONSE_KEYS.contains(&key.as_str()) {
            continue;
        }
        let norm = normalize_response_key(key);
        // Collides with a trusted key under separator-insensitive lowercase.
        if trusted_norm.iter().any(|t| t == &norm) {
            return Err(LocalSshError::InvalidMetadata);
        }
        // Explicit ambiguous/secret aliases (host vs ip, port vs ssh_port, …).
        if FORBIDDEN_RESPONSE_ALIASES
            .iter()
            .any(|f| f.eq_ignore_ascii_case(key) || normalize_response_key(f) == norm)
        {
            return Err(LocalSshError::InvalidMetadata);
        }
    }
    Ok(())
}
