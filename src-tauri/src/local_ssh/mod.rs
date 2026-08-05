//! Local SSH preparation (8B1) + session authority (8B2) + handshake (8B3a)
//! + terminal transport actor (8B3b).
//!
//! Rust-internal only: prepare → ticket/authority registry → russh handshake →
//! PTY/shell transport actor. No public Tauri SSH IPC / React terminal.
//!
//! **Non-claims (honest):** no Tauri SSH IPC/events, React terminal UI, upload, AI.

mod connect;
mod prepare;
mod session;
mod transport;

#[cfg(test)]
mod tests;

#[allow(unused_imports)] // crate-internal surface for prepare + session + connect + transport
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
#[allow(unused_imports)]
pub use transport::{
    open_session_transport, ActorSshTransport, LocalSshTransport, NullTerminalSink,
    OpenTransportResult, TerminalOutput, TerminalSink, DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS,
    MAX_TRANSPORT_CMD_QUEUE, MAX_WRITE_BYTES,
};
