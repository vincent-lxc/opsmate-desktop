//! Local SSH preparation (8B1) + session authority (8B2) + handshake (8B3a).
//!
//! Rust-internal only: prepare validates online metadata + vault lease; session
//! manager owns secret-free records and close handles; connect performs russh
//! KEX + publickey + host-key policy.
//!
//! **Non-claims (honest):** no PTY, shell actor, Tauri SSH IPC/events, React
//! terminal UI, upload, or AI.

mod connect;
mod prepare;
mod session;

#[cfg(test)]
mod tests;

#[allow(unused_imports)] // crate-internal surface for prepare + session + connect
pub use connect::{
    cloud_host_key_body, cloud_host_key_business_input, establish_local_ssh_handshake,
    BridgeHostKeyWriter, CloudHostKeyParams, CloudHostKeyWriter, EstablishedLocalSsh,
    HandshakeDeps, HandshakeResult, HostKeyConfirmer, LocalKnownHosts, NativeTofuConfirmer,
    NativeTransportHostKeyWriter,
};
#[allow(unused_imports)]
pub use prepare::{
    map_local_ssh_public, prepare_local_ssh_open, split_prepared_for_connect,
    LocalSshConnectAuthority, LocalSshError, LocalSshOpenRequest, PreparedLocalSshOpen,
};
#[allow(unused_imports)]
pub use session::{
    attach_session_manager_to_vault, LocalSshRegistrationTicket, LocalSshSessionId,
    LocalSshSessionManager, LocalSshSessionMeta, SessionCloseHandle, TicketBarrierSnapshot,
};
