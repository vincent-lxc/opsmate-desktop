//! Constrained native cloud transport.
//!
//! - Operation allowlist is generated (`operations.rs`).
//! - Task 6A: reject-before-transport planner, fixed error codes, sanitizer.
//! - Task 6B1: async `HttpBackend`, production reqwest HTTPS, cancellation,
//!   401 lifecycle hooks (spies until Task 8 / 6B2 wiring).
//! - Sole business IPC entry: `CloudTransport::invoke_ipc` (Available + IpcViaRust).
//! - No generic open-proxy / arbitrary-URL IPC primitive.
//! - Production requires explicit lifecycle hooks (no silent no-op default).

pub mod client;
pub mod error;
pub mod http;
pub mod lifecycle;
pub mod operations;
pub mod sanitize;

#[cfg(test)]
mod tests;

pub use client::{
    build_request, require_available, require_ipc_invocation, BackendResponse, BuiltRequest,
    CloudTransport, HttpBackend,
};
pub use error::{map_transport_public, TransportError};
pub use http::{
    accumulate_chunks_limited, check_content_length, validate_fixed_origin_url, ReqwestBackend,
    MAX_RESPONSE_BYTES,
};
pub use lifecycle::{InvalidationControl, SessionLifecycleHooks};
pub use operations::{
    from_id, is_callable, is_ipc_callable, spec, Availability, Invocation, Method, Operation,
    OperationSpec, ALL_OPERATIONS, BASE_ORIGIN, DESKTOP_REDIRECT_URI, OPERATIONS_CONTENT_HASH,
    WS_ORIGIN,
};
pub use sanitize::{sanitize_response_json, sanitize_value};
