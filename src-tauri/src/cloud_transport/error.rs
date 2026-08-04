//! Fixed public transport error codes.
//!
//! Never embed raw URL, path, header, body, token, or HTTP status text in
//! variants or Display — IPC maps only these codes.

use thiserror::Error;

/// Fail-closed transport errors with fixed public codes.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    /// Operation id is not in the generated allowlist.
    #[error("unknown_operation")]
    UnknownOperation,
    /// Operation is Rust-only (`Invocation::NativeOnly`); not IPC-callable.
    #[error("native_only")]
    NativeOnly,
    /// Operation is catalogued but not Available (e.g. blocked pending isolation).
    #[error("not_available")]
    NotAvailable,
    /// Invocation mode is not IpcViaRust for a WebView-requested business call.
    #[error("invalid_invocation")]
    InvalidInvocation,
    /// Missing/extra/forbidden business fields, duplicates, or control keys.
    #[error("invalid_input")]
    InvalidInput,
    /// Path/query smuggling or traversal rejected before transport.
    #[error("path_smuggling")]
    PathSmuggling,
    /// Authenticated operation without a native-owned bearer (not caller-supplied).
    #[error("unauthenticated")]
    Unauthenticated,
    /// Backend transport failure (no raw status/body attached).
    #[error("transport")]
    Transport,
    /// Response was not usable JSON (no raw body attached).
    #[error("invalid_response")]
    InvalidResponse,
    /// Non-401 non-2xx HTTP status (no status number or body text).
    #[error("http_status")]
    HttpStatus,
    /// Response body exceeded the fixed size cap.
    #[error("response_too_large")]
    ResponseTooLarge,
    /// In-flight or queued call aborted by cancellation / invalidation.
    #[error("cancelled")]
    Cancelled,
    /// 401 security lifecycle completed (or concurrent duplicate); session invalid.
    #[error("session_invalidated")]
    SessionInvalidated,
}

/// Map to fixed public IPC string codes (never Display of secret-bearing data).
pub fn map_transport_public(err: TransportError) -> &'static str {
    match err {
        TransportError::UnknownOperation => "unknown_operation",
        TransportError::NativeOnly => "native_only",
        TransportError::NotAvailable => "not_available",
        TransportError::InvalidInvocation => "invalid_invocation",
        TransportError::InvalidInput => "invalid_input",
        TransportError::PathSmuggling => "path_smuggling",
        TransportError::Unauthenticated => "unauthenticated",
        TransportError::Transport => "transport",
        TransportError::InvalidResponse => "invalid_response",
        TransportError::HttpStatus => "http_status",
        TransportError::ResponseTooLarge => "response_too_large",
        TransportError::Cancelled => "cancelled",
        TransportError::SessionInvalidated => "session_invalidated",
    }
}
