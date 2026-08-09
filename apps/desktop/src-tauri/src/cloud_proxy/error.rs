//! Fixed public cloud proxy error codes (no secret/raw upstream payload).

use thiserror::Error;

/// Fail-closed proxy errors with fixed public codes.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum ProxyError {
    #[error("invalid_input")]
    InvalidInput,
    #[error("path_smuggling")]
    PathSmuggling,
    #[error("route_not_allowed")]
    RouteNotAllowed,
    #[error("unauthenticated")]
    Unauthenticated,
    #[error("transport")]
    Transport,
    #[error("invalid_response")]
    InvalidResponse,
    /// Reserved public code; non-401 HTTP errors now return `CloudResponse` status/body.
    #[error("http_status")]
    #[allow(dead_code)]
    HttpStatus,
    #[error("request_too_large")]
    RequestTooLarge,
    #[error("response_too_large")]
    ResponseTooLarge,
    #[error("cancelled")]
    Cancelled,
    #[error("session_invalidated")]
    SessionInvalidated,
}

impl ProxyError {
    pub fn public_code(self) -> &'static str {
        match self {
            ProxyError::InvalidInput => "invalid_input",
            ProxyError::PathSmuggling => "path_smuggling",
            ProxyError::RouteNotAllowed => "route_not_allowed",
            ProxyError::Unauthenticated => "unauthenticated",
            ProxyError::Transport => "transport",
            ProxyError::InvalidResponse => "invalid_response",
            ProxyError::HttpStatus => "http_status",
            ProxyError::RequestTooLarge => "request_too_large",
            ProxyError::ResponseTooLarge => "response_too_large",
            ProxyError::Cancelled => "cancelled",
            ProxyError::SessionInvalidated => "session_invalidated",
        }
    }
}
