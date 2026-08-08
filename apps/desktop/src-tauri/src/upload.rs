//! D5 — native-confirmed cloud custody upload / delete.
//!
//! WebView supplies **only** `credentialId`. Confirmation is native-only (macOS
//! NSAlert + typed token [+ upload checkbox]). Secrets never return over IPC.
//!
//! Trust order (upload): preflight meta → native confirm → revalidate auth →
//! vault lease → normalize unencrypted OpenSSH PEM → intent → consume.
//! Same captured bearer on intent + consume. Epoch mismatch aborts.

use crate::auth::{AuthStore, NativeAuthSnapshot, NativePrincipal, API_BASE_URL};
use crate::vault::{VaultCredentialLease, VaultError, VaultService};
use russh::keys::{decode_secret_key, ssh_key, HashAlg};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const MAX_HTTP_BODY_BYTES: u64 = 1024 * 1024;
const HTTP_TIMEOUT_SECS: u64 = 30;

pub const UPLOAD_TOKEN: &str = "UPLOAD";
pub const DELETE_TOKEN: &str = "DELETE CLOUD";

/// Design-fixed native dialog titles / checkbox copy.
pub const UPLOAD_DIALOG_TITLE: &str = "确认上传私钥到云端";
pub const DELETE_DIALOG_TITLE: &str = "确认删除云端托管密钥";
/// Exact upload acknowledgement checkbox label (design-fixed).
pub const UPLOAD_CHECKBOX_LABEL: &str =
    "我理解私钥将离开本机，并授权云端在我的租户内用于自动化运维。";

// ─── WebView DTOs (strict) ───────────────────────────────────────────────────

/// WebView may supply only `credentialId`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CloudUploadRequest {
    pub credential_id: String,
}

/// WebView may supply only `credentialId`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CloudDeleteRequest {
    pub credential_id: String,
}

/// Non-secret operation result for WebView.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudCustodyResponse {
    pub credential_id: String,
    /// `uploaded` | `deleted` | `local_only` (etc.)
    pub custody_state: String,
    pub ok: bool,
}

// ─── Errors (secret-free) ────────────────────────────────────────────────────

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum CloudCustodyError {
    #[error("unauthenticated")]
    Unauthenticated,
    #[error("authorization failed")]
    AuthorizationFailed,
    #[error("confirmation cancelled")]
    ConfirmationCancelled,
    #[error("confirmation rejected")]
    ConfirmationRejected,
    #[error("confirmation failed")]
    ConfirmationFailed,
    #[error("invalid identity")]
    InvalidIdentity,
    #[error("credential metadata unavailable")]
    MetadataFailed,
    #[error("vault operation failed")]
    VaultFailed,
    #[error("invalid private key")]
    InvalidPrivateKey,
    #[error("network failed")]
    NetworkFailed,
    #[error("intent failed")]
    IntentFailed,
    #[error("consume failed")]
    ConsumeFailed,
    #[error("unsupported platform")]
    UnsupportedPlatform,
    /// Upload when cloud already holds a secret (replacement is a separate endpoint).
    #[error("cloud secret already present")]
    CloudSecretAlreadyPresent,
    /// Delete when no cloud secret exists.
    #[error("cloud secret absent")]
    CloudSecretAbsent,
    #[error("internal error")]
    Internal,
}

impl CloudCustodyError {
    pub fn user_message(&self) -> String {
        match self {
            CloudCustodyError::Unauthenticated => "需要先登录".into(),
            CloudCustodyError::AuthorizationFailed => "无权操作该凭据".into(),
            CloudCustodyError::ConfirmationCancelled => "已取消操作".into(),
            CloudCustodyError::ConfirmationRejected => "确认输入不正确，操作已取消".into(),
            CloudCustodyError::ConfirmationFailed => "无法显示本地确认对话框".into(),
            CloudCustodyError::InvalidIdentity => "凭据标识无效".into(),
            CloudCustodyError::MetadataFailed => "无法获取凭据元数据".into(),
            CloudCustodyError::VaultFailed => "本地保险库操作失败".into(),
            CloudCustodyError::InvalidPrivateKey => "私钥无效或无法解密".into(),
            CloudCustodyError::NetworkFailed => "网络请求失败".into(),
            CloudCustodyError::IntentFailed => "云端操作意图创建失败".into(),
            CloudCustodyError::ConsumeFailed => "云端托管操作失败".into(),
            CloudCustodyError::UnsupportedPlatform => "当前平台不支持本地确认对话框".into(),
            CloudCustodyError::CloudSecretAlreadyPresent => {
                "该凭据已在云端托管，请使用替换流程而非再次上传".into()
            }
            CloudCustodyError::CloudSecretAbsent => "云端无托管密钥，无需删除".into(),
            CloudCustodyError::Internal => "内部错误".into(),
        }
    }
}

impl From<VaultError> for CloudCustodyError {
    fn from(e: VaultError) -> Self {
        match e {
            VaultError::Unauthenticated | VaultError::InvalidIdentity => {
                CloudCustodyError::Unauthenticated
            }
            VaultError::Locked | VaultError::NotInitialized | VaultError::NotFound => {
                CloudCustodyError::VaultFailed
            }
            VaultError::InvalidPrivateKey => CloudCustodyError::InvalidPrivateKey,
            VaultError::PromptCancelled => CloudCustodyError::ConfirmationCancelled,
            _ => CloudCustodyError::VaultFailed,
        }
    }
}

// ─── Domain types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudCustodyAction {
    Upload,
    DeleteCloud,
}

impl CloudCustodyAction {
    pub fn as_api_str(self) -> &'static str {
        match self {
            CloudCustodyAction::Upload => "upload",
            CloudCustodyAction::DeleteCloud => "delete_cloud",
        }
    }
}

/// Allowed `environment_classification` values from production list API.
pub const ENV_TEST: &str = "test";
pub const ENV_STAGING: &str = "staging";
pub const ENV_PRODUCTION: &str = "production";
pub const ENV_UNKNOWN: &str = "unknown";

/// Public metadata from HTTPS credential list (no secrets).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialPublicMeta {
    pub credential_id: String,
    /// May be empty for newly created local-only credentials (`fingerprint: null`).
    /// Upload must use vault lease fingerprint instead; delete requires non-empty when
    /// `cloud_present` is true.
    pub fingerprint: String,
    /// Authoritative enum: test | staging | production | unknown.
    pub environment: String,
    pub storage_mode: String,
    /// Authoritative from `has_cloud_secret` only (never inferred).
    pub cloud_present: bool,
}

/// Native confirmation dialog inputs (no secrets).
#[derive(Debug, Clone)]
pub struct CloudConfirmPrompt {
    pub title: String,
    pub message: String,
    /// Exact token required (`UPLOAD` or `DELETE CLOUD`).
    pub required_token: String,
    /// Upload requires affirmative checkbox in addition to token.
    pub require_ack_checkbox: bool,
    /// Exact checkbox label when `require_ack_checkbox` (empty otherwise).
    pub checkbox_label: String,
}

// ─── Injectable adapters ─────────────────────────────────────────────────────

pub trait CloudCustodyConfirmer: Send + Sync {
    fn confirm(&self, prompt: &CloudConfirmPrompt) -> Result<(), CloudCustodyError>;
}

/// HTTPS cloud custody client (intent + consume + public list).
pub trait CloudCustodyHttp: Send + Sync {
    fn fetch_credential_meta(
        &self,
        credential_id: &str,
        bearer: &str,
    ) -> Result<CredentialPublicMeta, CloudCustodyError>;

    /// POST intents → intent_id
    fn create_intent(
        &self,
        credential_id: &str,
        action: CloudCustodyAction,
        fingerprint: &str,
        bearer: &str,
    ) -> Result<String, CloudCustodyError>;

    fn consume_upload(
        &self,
        credential_id: &str,
        intent_id: &str,
        ssh_private_key: &str,
        fingerprint: &str,
        bearer: &str,
    ) -> Result<(), CloudCustodyError>;

    fn consume_delete(
        &self,
        credential_id: &str,
        intent_id: &str,
        fingerprint: &str,
        bearer: &str,
    ) -> Result<(), CloudCustodyError>;
}

// ─── Warning copy (full design text) ─────────────────────────────────────────

/// Fixed-meaning advisory by authoritative environment_classification.
pub fn environment_severity_block(environment: &str) -> String {
    match environment {
        ENV_TEST | ENV_STAGING => {
            "建议：测试/预发环境可上传非生产密钥以验证云端托管与自动化流程。".into()
        }
        ENV_PRODUCTION | ENV_UNKNOWN => {
            "建议：生产或未知环境优先保持仅本机。上传将使租户内云端自动化可使用该私钥。".into()
        }
        _ => "建议：环境分类异常，按保守策略优先保持仅本机。".into(),
    }
}

pub fn upload_warning_body(environment: &str) -> String {
    format!(
        "{}\n\n\
上传到云端后：\n\
• 云端自动化 / Telegram / 无人值守作业可在租户内使用该凭据；\n\
• 服务端可能在内存中解密私钥以执行任务；\n\
• 凭据将失去「仅本机」状态。\n\n\
请在下方输入框精确输入大写 UPLOAD（不允许首尾空格或换行），并勾选确认复选框。",
        environment_severity_block(environment)
    )
}

pub fn delete_warning_body(environment: &str) -> String {
    format!(
        "{}\n\n\
从云端删除托管密钥后：\n\
• 新的云端作业将被阻止使用该密钥；\n\
• 正在运行的作业不保证被立即终止；\n\
• 备份/日志保留策略可能仍含历史材料；\n\
• 本机副本仍然保留；\n\
• 紧急吊销请轮换服务器上的授权公钥。\n\n\
请在下方输入框精确输入 DELETE CLOUD（全大写，含空格；不允许首尾空格或换行）。",
        environment_severity_block(environment)
    )
}

// ─── Production list JSON parse (strict, bounded) ────────────────────────────

fn json_str_field<'a>(item: &'a serde_json::Value, snake: &str, camel: &str) -> Option<&'a str> {
    item.get(snake)
        .or_else(|| item.get(camel))
        .and_then(|v| v.as_str())
}

fn json_bool_field(item: &serde_json::Value, snake: &str, camel: &str) -> Option<bool> {
    item.get(snake)
        .or_else(|| item.get(camel))
        .and_then(|v| v.as_bool())
}

/// Validate environment_classification enum (exact production values).
pub fn parse_environment_classification(raw: &str) -> Result<&'static str, CloudCustodyError> {
    match raw {
        "test" => Ok(ENV_TEST),
        "staging" => Ok(ENV_STAGING),
        "production" => Ok(ENV_PRODUCTION),
        "unknown" => Ok(ENV_UNKNOWN),
        _ => Err(CloudCustodyError::MetadataFailed),
    }
}

/// Parse one production-shaped list item. Returns `Ok(None)` if id does not match.
/// Exact snake_case fields; camelCase only as intentional contract fallback.
pub fn parse_credential_list_item(
    item: &serde_json::Value,
    want_id: &str,
) -> Result<Option<CredentialPublicMeta>, CloudCustodyError> {
    let id = json_str_field(item, "id", "credentialId").unwrap_or("");
    if id != want_id {
        return Ok(None);
    }
    if id.is_empty() || id.len() > 128 {
        return Err(CloudCustodyError::MetadataFailed);
    }
    // fingerprint may be null/empty for local-only (pre-upload) credentials.
    // Non-string non-null is fail-closed.
    let fingerprint = match item.get("fingerprint") {
        None => String::new(),
        Some(v) if v.is_null() => String::new(),
        Some(v) => {
            let s = v
                .as_str()
                .ok_or(CloudCustodyError::MetadataFailed)?
                .to_string();
            if s.len() > 256 {
                return Err(CloudCustodyError::MetadataFailed);
            }
            s
        }
    };
    let env_raw = json_str_field(
        item,
        "environment_classification",
        "environmentClassification",
    )
    .ok_or(CloudCustodyError::MetadataFailed)?;
    let environment = parse_environment_classification(env_raw)?.to_string();
    let has_cloud = json_bool_field(item, "has_cloud_secret", "hasCloudSecret")
        .ok_or(CloudCustodyError::MetadataFailed)?;
    let storage_mode = json_str_field(item, "storage_mode", "storageMode")
        .unwrap_or("")
        .to_string();
    Ok(Some(CredentialPublicMeta {
        credential_id: id.to_string(),
        fingerprint,
        environment,
        storage_mode,
        cloud_present: has_cloud,
    }))
}

/// Bounded parse of GET /api/security/credentials body for one credential id.
pub fn parse_credentials_list_body(
    body: &[u8],
    want_id: &str,
) -> Result<CredentialPublicMeta, CloudCustodyError> {
    if body.len() > MAX_HTTP_BODY_BYTES as usize {
        return Err(CloudCustodyError::MetadataFailed);
    }
    let v: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| CloudCustodyError::MetadataFailed)?;
    let items = v
        .get("items")
        .and_then(|i| i.as_array())
        .ok_or(CloudCustodyError::MetadataFailed)?;
    for item in items {
        if let Some(meta) = parse_credential_list_item(item, want_id)? {
            return Ok(meta);
        }
    }
    Err(CloudCustodyError::AuthorizationFailed)
}

// ─── PEM normalization (unencrypted OpenSSH for backend v2) ──────────────────

/// Decode (optional passphrase) then re-encode **unencrypted** OpenSSH PEM.
/// Backend stores `ssh_key_passphrase=NULL` — never send passphrase.
pub fn normalize_pem_for_cloud_upload(
    pem: &str,
    passphrase: Option<&str>,
) -> Result<Zeroizing<String>, CloudCustodyError> {
    let key =
        decode_secret_key(pem, passphrase).map_err(|_| CloudCustodyError::InvalidPrivateKey)?;
    let openssh = key
        .to_openssh(ssh_key::LineEnding::LF)
        .map_err(|_| CloudCustodyError::InvalidPrivateKey)?;
    // Usable without passphrase.
    let _check = decode_secret_key(openssh.as_str(), None)
        .map_err(|_| CloudCustodyError::InvalidPrivateKey)?;
    Ok(openssh)
}

pub fn fingerprint_from_lease(lease: &VaultCredentialLease) -> Result<String, CloudCustodyError> {
    if !lease.fingerprint.trim().is_empty() {
        return Ok(lease.fingerprint.clone());
    }
    let pass = lease.passphrase.as_ref().map(|p| p.as_str());
    let key = decode_secret_key(lease.pem.as_str(), pass)
        .map_err(|_| CloudCustodyError::InvalidPrivateKey)?;
    Ok(key.fingerprint(HashAlg::Sha256).to_string())
}

// ─── Validation ──────────────────────────────────────────────────────────────

fn validate_credential_id(id: &str) -> Result<(), CloudCustodyError> {
    let t = id.trim();
    if t.is_empty() || t.len() > 128 {
        return Err(CloudCustodyError::InvalidIdentity);
    }
    if t.contains("..") || t.contains('/') || t.contains('\\') || t.contains('\0') {
        return Err(CloudCustodyError::InvalidIdentity);
    }
    Ok(())
}

fn require_snapshot_current(
    auth: &AuthStore,
    snap: &NativeAuthSnapshot,
) -> Result<(), CloudCustodyError> {
    if auth.session_binding_current(&snap.principal, snap.epoch) {
        Ok(())
    } else {
        Err(CloudCustodyError::Unauthenticated)
    }
}

// ─── Orchestration ───────────────────────────────────────────────────────────

/// Steps recorded for order proofs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudUploadStep {
    PreflightMeta,
    Confirm,
    Lease,
    NormalizePem,
    Intent,
    Consume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudDeleteStep {
    PreflightMeta,
    Confirm,
    Intent,
    Consume,
}

/// Pure confirmation gate used by production dialogs and tests.
pub fn evaluate_confirmation(
    required_token: &str,
    typed: &str,
    require_checkbox: bool,
    checkbox_checked: bool,
) -> Result<(), CloudCustodyError> {
    if typed != required_token {
        return Err(CloudCustodyError::ConfirmationRejected);
    }
    if require_checkbox && !checkbox_checked {
        return Err(CloudCustodyError::ConfirmationRejected);
    }
    Ok(())
}

/// Source of SSH leases for upload (production: [`VaultService`]).
pub trait CloudLeaseSource: Send + Sync {
    fn lease_for_upload(
        &self,
        auth: &AuthStore,
        principal: &NativePrincipal,
        epoch: u64,
        credential_id: &str,
    ) -> Result<VaultCredentialLease, CloudCustodyError>;
}

impl CloudLeaseSource for VaultService {
    fn lease_for_upload(
        &self,
        auth: &AuthStore,
        principal: &NativePrincipal,
        epoch: u64,
        credential_id: &str,
    ) -> Result<VaultCredentialLease, CloudCustodyError> {
        self.lease_for_ssh(auth, principal, epoch, credential_id)
            .map_err(Into::into)
    }
}

/// Upload orchestration (blocking — call from spawn_blocking except native dialog).
pub fn perform_cloud_upload(
    auth: &AuthStore,
    lease_src: &dyn CloudLeaseSource,
    http: &dyn CloudCustodyHttp,
    confirmer: &dyn CloudCustodyConfirmer,
    credential_id: &str,
    steps: &mut Vec<CloudUploadStep>,
) -> Result<CloudCustodyResponse, CloudCustodyError> {
    validate_credential_id(credential_id)?;
    let snap = auth
        .native_auth_snapshot()
        .ok_or(CloudCustodyError::Unauthenticated)?;

    steps.push(CloudUploadStep::PreflightMeta);
    let meta = http.fetch_credential_meta(credential_id, snap.bearer.as_str())?;
    require_snapshot_current(auth, &snap)?;
    if meta.cloud_present {
        return Err(CloudCustodyError::CloudSecretAlreadyPresent);
    }

    let prompt = CloudConfirmPrompt {
        title: UPLOAD_DIALOG_TITLE.into(),
        message: upload_warning_body(&meta.environment),
        required_token: UPLOAD_TOKEN.into(),
        require_ack_checkbox: true,
        checkbox_label: UPLOAD_CHECKBOX_LABEL.into(),
    };
    steps.push(CloudUploadStep::Confirm);
    confirmer.confirm(&prompt)?;
    require_snapshot_current(auth, &snap)?;

    steps.push(CloudUploadStep::Lease);
    let lease = lease_src.lease_for_upload(auth, &snap.principal, snap.epoch, credential_id)?;
    require_snapshot_current(auth, &snap)?;

    let fingerprint = fingerprint_from_lease(&lease)?;
    steps.push(CloudUploadStep::NormalizePem);
    let pass = lease.passphrase.as_ref().map(|p| p.as_str());
    let mut normalized = normalize_pem_for_cloud_upload(lease.pem.as_str(), pass)?;
    // Drop lease ASAP (zeroizes on drop).
    drop(lease);
    require_snapshot_current(auth, &snap)?;

    steps.push(CloudUploadStep::Intent);
    let intent_id = http.create_intent(
        credential_id,
        CloudCustodyAction::Upload,
        &fingerprint,
        snap.bearer.as_str(),
    )?;
    require_snapshot_current(auth, &snap)?;

    steps.push(CloudUploadStep::Consume);
    let consume = http.consume_upload(
        credential_id,
        &intent_id,
        normalized.as_str(),
        &fingerprint,
        snap.bearer.as_str(),
    );
    normalized.zeroize();
    consume?;

    Ok(CloudCustodyResponse {
        credential_id: credential_id.to_string(),
        custody_state: "uploaded".into(),
        ok: true,
    })
}

/// Delete cloud custody (no local vault required).
pub fn perform_cloud_delete(
    auth: &AuthStore,
    http: &dyn CloudCustodyHttp,
    confirmer: &dyn CloudCustodyConfirmer,
    credential_id: &str,
    steps: &mut Vec<CloudDeleteStep>,
) -> Result<CloudCustodyResponse, CloudCustodyError> {
    validate_credential_id(credential_id)?;
    let snap = auth
        .native_auth_snapshot()
        .ok_or(CloudCustodyError::Unauthenticated)?;

    steps.push(CloudDeleteStep::PreflightMeta);
    let meta = http.fetch_credential_meta(credential_id, snap.bearer.as_str())?;
    require_snapshot_current(auth, &snap)?;
    if !meta.cloud_present {
        return Err(CloudCustodyError::CloudSecretAbsent);
    }
    // Cloud-present delete requires an authoritative public fingerprint.
    if meta.fingerprint.trim().is_empty() {
        return Err(CloudCustodyError::MetadataFailed);
    }

    let prompt = CloudConfirmPrompt {
        title: DELETE_DIALOG_TITLE.into(),
        message: delete_warning_body(&meta.environment),
        required_token: DELETE_TOKEN.into(),
        require_ack_checkbox: false,
        checkbox_label: String::new(),
    };
    steps.push(CloudDeleteStep::Confirm);
    confirmer.confirm(&prompt)?;
    require_snapshot_current(auth, &snap)?;

    steps.push(CloudDeleteStep::Intent);
    let intent_id = http.create_intent(
        credential_id,
        CloudCustodyAction::DeleteCloud,
        &meta.fingerprint,
        snap.bearer.as_str(),
    )?;
    require_snapshot_current(auth, &snap)?;

    steps.push(CloudDeleteStep::Consume);
    http.consume_delete(
        credential_id,
        &intent_id,
        &meta.fingerprint,
        snap.bearer.as_str(),
    )?;

    Ok(CloudCustodyResponse {
        credential_id: credential_id.to_string(),
        custody_state: "deleted".into(),
        ok: true,
    })
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

pub fn intents_url(credential_id: &str) -> Result<String, CloudCustodyError> {
    validate_credential_id(credential_id)?;
    Ok(format!(
        "{API_BASE_URL}/api/security/credentials/{credential_id}/intents"
    ))
}

pub fn cloud_secret_url(credential_id: &str) -> Result<String, CloudCustodyError> {
    validate_credential_id(credential_id)?;
    Ok(format!(
        "{API_BASE_URL}/api/security/credentials/{credential_id}/cloud-secret"
    ))
}

pub fn credentials_list_url() -> String {
    format!("{API_BASE_URL}/api/security/credentials")
}

// ─── Production HTTP ─────────────────────────────────────────────────────────

fn block_on_http<F, T>(fut: F) -> Result<T, CloudCustodyError>
where
    F: std::future::Future<Output = Result<T, CloudCustodyError>> + Send + 'static,
    T: Send + 'static,
{
    // Never Handle::block_on on a current runtime — use a dedicated thread/runtime.
    if tokio::runtime::Handle::try_current().is_ok() {
        return std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| CloudCustodyError::NetworkFailed)?;
            rt.block_on(fut)
        })
        .join()
        .map_err(|_| CloudCustodyError::NetworkFailed)?;
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| CloudCustodyError::NetworkFailed)?;
    rt.block_on(fut)
}

fn https_client() -> Result<reqwest::Client, CloudCustodyError> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|_| CloudCustodyError::NetworkFailed)
}

fn bearer_header(bearer: &str) -> Result<reqwest::header::HeaderValue, CloudCustodyError> {
    let mut raw = Zeroizing::new(format!("Bearer {bearer}"));
    let mut hv = reqwest::header::HeaderValue::from_str(raw.as_str())
        .map_err(|_| CloudCustodyError::NetworkFailed)?;
    hv.set_sensitive(true);
    raw.zeroize();
    Ok(hv)
}

async fn read_body_bounded(resp: reqwest::Response) -> Result<Vec<u8>, CloudCustodyError> {
    if let Some(cl) = resp.content_length() {
        if cl > MAX_HTTP_BODY_BYTES {
            return Err(CloudCustodyError::NetworkFailed);
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
                    return Err(CloudCustodyError::NetworkFailed);
                }
                out.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return Err(CloudCustodyError::NetworkFailed),
        }
    }
    Ok(out)
}

fn map_status(status: reqwest::StatusCode) -> Result<(), CloudCustodyError> {
    if status.is_success() {
        return Ok(());
    }
    match status.as_u16() {
        401 | 403 | 404 => Err(CloudCustodyError::AuthorizationFailed),
        _ => Err(CloudCustodyError::NetworkFailed),
    }
}

/// Production consume-upload JSON: borrows PEM from caller-owned Zeroizing buffer.
/// No Debug — must never log private key material.
/// Note: reqwest will own an internal serialized request body copy for the HTTP
/// stack; that buffer is dropped with the request and is not application-logged.
#[derive(Serialize)]
pub(crate) struct CloudUploadConsumeBody<'a> {
    pub(crate) intent_id: &'a str,
    pub(crate) ssh_private_key: &'a str,
    pub(crate) fingerprint: &'a str,
}

pub struct ReqwestCloudCustodyHttp;

impl Default for ReqwestCloudCustodyHttp {
    fn default() -> Self {
        Self
    }
}

impl ReqwestCloudCustodyHttp {
    pub fn new() -> Self {
        Self
    }
}

impl CloudCustodyHttp for ReqwestCloudCustodyHttp {
    fn fetch_credential_meta(
        &self,
        credential_id: &str,
        bearer: &str,
    ) -> Result<CredentialPublicMeta, CloudCustodyError> {
        validate_credential_id(credential_id)?;
        let url = credentials_list_url();
        if !url.starts_with("https://") {
            return Err(CloudCustodyError::NetworkFailed);
        }
        let client = https_client()?;
        let auth_hv = bearer_header(bearer)?;
        let want = credential_id.to_string();
        block_on_http(async move {
            let resp = client
                .get(&url)
                .header(reqwest::header::AUTHORIZATION, auth_hv)
                .send()
                .await
                .map_err(|_| CloudCustodyError::MetadataFailed)?;
            map_status(resp.status()).map_err(|_| CloudCustodyError::MetadataFailed)?;
            let body = read_body_bounded(resp).await?;
            parse_credentials_list_body(&body, &want)
        })
    }

    fn create_intent(
        &self,
        credential_id: &str,
        action: CloudCustodyAction,
        fingerprint: &str,
        bearer: &str,
    ) -> Result<String, CloudCustodyError> {
        let url = intents_url(credential_id)?;
        if !url.starts_with("https://") {
            return Err(CloudCustodyError::NetworkFailed);
        }
        let client = https_client()?;
        let auth_hv = bearer_header(bearer)?;
        let body = serde_json::json!({
            "action": action.as_api_str(),
            "fingerprint": fingerprint,
        });
        block_on_http(async move {
            let resp = client
                .post(&url)
                .header(reqwest::header::AUTHORIZATION, auth_hv)
                .json(&body)
                .send()
                .await
                .map_err(|_| CloudCustodyError::IntentFailed)?;
            map_status(resp.status()).map_err(|_| CloudCustodyError::IntentFailed)?;
            let bytes = read_body_bounded(resp).await?;
            let v: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| CloudCustodyError::IntentFailed)?;
            let intent_id = v
                .get("intent_id")
                .or_else(|| v.get("intentId"))
                .or_else(|| v.get("id"))
                .and_then(|x| x.as_str())
                .ok_or(CloudCustodyError::IntentFailed)?;
            Ok(intent_id.to_string())
        })
    }

    fn consume_upload(
        &self,
        credential_id: &str,
        intent_id: &str,
        ssh_private_key: &str,
        fingerprint: &str,
        bearer: &str,
    ) -> Result<(), CloudCustodyError> {
        let url = cloud_secret_url(credential_id)?;
        if !url.starts_with("https://") {
            return Err(CloudCustodyError::NetworkFailed);
        }
        let client = https_client()?;
        let auth_hv = bearer_header(bearer)?;
        // Borrow PEM from caller-owned Zeroizing (perform_cloud_upload). No
        // serde_json::Value and no extra String clone of the key — only the
        // serialized wire buffer (required for 'static HTTP) plus reqwest's
        // internal body ownership (unavoidable; not logged).
        let intent_id = intent_id.to_string();
        let fingerprint = fingerprint.to_string();
        let body = CloudUploadConsumeBody {
            intent_id: &intent_id,
            ssh_private_key,
            fingerprint: &fingerprint,
        };
        let body_bytes = serde_json::to_vec(&body).map_err(|_| CloudCustodyError::ConsumeFailed)?;
        block_on_http(async move {
            let resp = client
                .post(&url)
                .header(reqwest::header::AUTHORIZATION, auth_hv)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body_bytes)
                .send()
                .await
                .map_err(|_| CloudCustodyError::ConsumeFailed)?;
            // Status only — never read/log response body (may echo secrets).
            map_status(resp.status()).map_err(|_| CloudCustodyError::ConsumeFailed)?;
            drop(resp);
            Ok(())
        })
    }

    fn consume_delete(
        &self,
        credential_id: &str,
        intent_id: &str,
        fingerprint: &str,
        bearer: &str,
    ) -> Result<(), CloudCustodyError> {
        let url = cloud_secret_url(credential_id)?;
        if !url.starts_with("https://") {
            return Err(CloudCustodyError::NetworkFailed);
        }
        let client = https_client()?;
        let auth_hv = bearer_header(bearer)?;
        let body = serde_json::json!({
            "intent_id": intent_id,
            "fingerprint": fingerprint,
        });
        block_on_http(async move {
            let resp = client
                .delete(&url)
                .header(reqwest::header::AUTHORIZATION, auth_hv)
                .json(&body)
                .send()
                .await
                .map_err(|_| CloudCustodyError::ConsumeFailed)?;
            map_status(resp.status()).map_err(|_| CloudCustodyError::ConsumeFailed)?;
            let _ = read_body_bounded(resp).await;
            Ok(())
        })
    }
}

// ─── Native confirmation (macOS) ─────────────────────────────────────────────

/// Production confirmer: macOS NSAlert only; non-macOS fail-closed.
#[derive(Debug, Default, Clone, Copy)]
pub struct NativeCloudCustodyConfirmer;

impl CloudCustodyConfirmer for NativeCloudCustodyConfirmer {
    fn confirm(&self, prompt: &CloudConfirmPrompt) -> Result<(), CloudCustodyError> {
        #[cfg(target_os = "macos")]
        {
            macos_confirm(prompt)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = prompt;
            Err(CloudCustodyError::UnsupportedPlatform)
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_confirm(prompt: &CloudConfirmPrompt) -> Result<(), CloudCustodyError> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSButton, NSButtonType,
        NSControlStateValueOff, NSControlStateValueOn, NSTextField, NSView,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    let mtm = MainThreadMarker::new().ok_or(CloudCustodyError::ConfirmationFailed)?;
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Critical);
    alert.setMessageText(&NSString::from_str(&prompt.title));
    alert.setInformativeText(&NSString::from_str(&prompt.message));
    alert.addButtonWithTitle(&NSString::from_str("确认"));
    alert.addButtonWithTitle(&NSString::from_str("取消"));

    let height = if prompt.require_ack_checkbox {
        72.0
    } else {
        36.0
    };
    let container = NSView::new(mtm);
    container.setFrame(NSRect {
        origin: NSPoint { x: 0.0, y: 0.0 },
        size: NSSize {
            width: 360.0,
            height,
        },
    });

    let field = NSTextField::new(mtm);
    field.setFrame(NSRect {
        origin: NSPoint {
            x: 0.0,
            y: if prompt.require_ack_checkbox {
                36.0
            } else {
                6.0
            },
        },
        size: NSSize {
            width: 340.0,
            height: 24.0,
        },
    });
    let field_view: &NSView = field.as_ref();
    container.addSubview(field_view);

    let checkbox = if prompt.require_ack_checkbox {
        let cb = NSButton::new(mtm);
        cb.setButtonType(NSButtonType::Switch);
        cb.setTitle(&NSString::from_str(if prompt.checkbox_label.is_empty() {
            UPLOAD_CHECKBOX_LABEL
        } else {
            prompt.checkbox_label.as_str()
        }));
        cb.setState(NSControlStateValueOff);
        cb.setFrame(NSRect {
            origin: NSPoint { x: 0.0, y: 4.0 },
            size: NSSize {
                width: 340.0,
                height: 24.0,
            },
        });
        let cb_view: &NSView = cb.as_ref();
        container.addSubview(cb_view);
        Some(cb)
    } else {
        None
    };

    let cont_view: &NSView = container.as_ref();
    alert.setAccessoryView(Some(cont_view));

    let response = alert.runModal();
    if response != NSAlertFirstButtonReturn {
        return Err(CloudCustodyError::ConfirmationCancelled);
    }
    let typed = field.stringValue().to_string();
    let checked = checkbox
        .as_ref()
        .map(|c| c.state() == NSControlStateValueOn)
        .unwrap_or(true);
    // Exact match — do not trim (surrounding whitespace must fail closed).
    evaluate_confirmation(
        &prompt.required_token,
        &typed,
        prompt.require_ack_checkbox,
        checked,
    )
}

/// Run confirmer on the App main thread (modal NSAlert). Blocks until done.
pub fn confirm_on_app_main_thread(
    app: &tauri::AppHandle,
    confirmer: Arc<dyn CloudCustodyConfirmer>,
    prompt: CloudConfirmPrompt,
) -> Result<(), CloudCustodyError> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let r = confirmer.confirm(&prompt);
        let _ = tx.send(r);
    })
    .map_err(|_| CloudCustodyError::ConfirmationFailed)?;
    rx.recv()
        .map_err(|_| CloudCustodyError::ConfirmationFailed)?
}

#[cfg(test)]
#[path = "upload_tests.rs"]
mod tests;
