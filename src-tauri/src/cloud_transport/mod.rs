//! Constrained native cloud transport (foundation: operations allowlist only).
//!
//! Full HTTPS client + Authorization injection lands in a later task.
//! This module currently exposes the generated operation allowlist.

pub mod operations;

pub use operations::{
    from_id, is_callable, is_ipc_callable, spec, ALL_OPERATIONS, Availability, Invocation,
    Method, Operation, OperationSpec, BASE_ORIGIN, DESKTOP_REDIRECT_URI, OPERATIONS_CONTENT_HASH,
    WS_ORIGIN,
};
