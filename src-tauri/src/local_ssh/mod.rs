//! Local SSH preparation (8B1) + session authority registry (8B2).
//!
//! Rust-internal only: prepare validates online metadata + vault lease; session
//! manager owns secret-free records and close handles, wired as the vault
//! [`SessionLifecycleSink`](crate::vault::SessionLifecycleSink).
//!
//! **Non-claims (honest):** no SSH socket, no russh network connection, no host-key
//! confirmation UI, no Tauri SSH IPC/events, no terminal UI.

mod prepare;
mod session;

#[cfg(test)]
mod tests;

#[allow(unused_imports)] // crate-internal surface for prepare + session IPC later
pub use prepare::{
    map_local_ssh_public, prepare_local_ssh_open, LocalSshError, LocalSshOpenRequest,
    PreparedLocalSshOpen,
};
#[allow(unused_imports)]
pub use session::{
    attach_session_manager_to_vault, LocalSshRegistrationTicket, LocalSshSessionId,
    LocalSshSessionManager, LocalSshSessionMeta, SessionCloseHandle,
};
