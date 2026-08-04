//! Local SSH preparation boundary (Task 8B1).
//!
//! Rust-internal only: validates WebView-shaped request fields, fetches online
//! server metadata via CloudBridge `servers.get`, revalidates auth + SecurityCutoff
//! generation, and leases a local vault credential.
//!
//! **Non-claims (honest):** no SSH socket, no russh connection, no host-key UI,
//! no session registry, no Tauri IPC registration in this module.
//!
//! Production callers land in 8B2+; unit tests exercise the prepare path today.

mod prepare;

#[cfg(test)]
mod tests;

// Crate-visible surface for later sibling integration (session registry / IPC wiring).
#[allow(unused_imports)]
pub use prepare::{
    map_local_ssh_public, prepare_local_ssh_open, LocalSshError, LocalSshOpenRequest,
    PreparedLocalSshOpen,
};
