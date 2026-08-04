//! Constrained native cloud transport.
//!
//! - Operation allowlist is generated (`operations.rs`).
//! - Task 6A: reject-before-transport client, fixed error codes, response sanitizer.
//! - Method, origin, URL, headers, Authorization, and Content-Type are Rust-owned.
//! - Sole business IPC entry: `invoke_ipc` (always Available + IpcViaRust).
//! - No generic open-proxy / arbitrary-URL IPC primitive.
//! - Full production HTTPS + 401 lifecycle land in a later task; tests use `HttpBackend`.

pub mod client;
pub mod error;
pub mod operations;
pub mod sanitize;

#[cfg(test)]
mod tests;

pub use client::{
    build_request, invoke_ipc, require_available, require_ipc_invocation, BuiltRequest,
    HttpBackend,
};
pub use error::{map_transport_public, TransportError};
pub use operations::{
    from_id, is_callable, is_ipc_callable, spec, ALL_OPERATIONS, Availability, Invocation,
    Method, Operation, OperationSpec, BASE_ORIGIN, DESKTOP_REDIRECT_URI, OPERATIONS_CONTENT_HASH,
    WS_ORIGIN,
};
pub use sanitize::{sanitize_response_json, sanitize_value};
