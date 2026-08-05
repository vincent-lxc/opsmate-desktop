# Task 8B3b Evidence — native russh terminal transport actor (review-fix)

**Date:** 2026-08-05  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Branch:** `feat/secure-desktop-foundation`  
**Base:** `e904935` + uncommitted 8B3b  
**Prior dispatches:** `task_414996384c9b` → `task_a04987369ca6` (review-fix)  
**This dispatch (docs-only clippy evidence correction):** `task_256bd3ea325a` / `ctx_167308156a66`  
**Worker:** no commit / no push; product/tests/Cargo untouched in this dispatch

## Scope

| Path | Role |
|------|------|
| `src-tauri/src/local_ssh/transport.rs` | Actor transport, production fail-closed, faithful tests |
| `src-tauri/src/local_ssh/connect.rs` | `into_transport_parts`, `take_handle_for_transport`, `setup_started` |
| `src-tauri/src/local_ssh/prepare.rs` | `ChannelFailed` / `TransportClosed` / `CommandQueueFull` |
| `src-tauri/src/local_ssh/mod.rs` | exports |
| `src-tauri/src/local_ssh/tests.rs` | public error list includes transport codes |
| `docs/task-8b3b-ssh-transport-evidence.md` | this file |

## Design (unchanged architecture)

- **Dedicated OS thread** + current-thread Tokio runtime owns the russh client for the **entire** lifetime (handshake + channel + PTY + shell + I/O).
- `open_session_transport` runs 8B3a handshake on the actor, then channel / `request_pty(true, xterm-256color, 80×24)` / `request_shell(true)` under the **same overall setup deadline**.
- Returns `OpenTransportResult { authority, transport }` — authority is never cloned; spent bearer never leaves the actor.
- Write/resize: oneshot ack after backend result; cancel via stateful `watch<bool>`; fair select (`FAIR_IO_MAX_BURST=8`).
- **Fail-closed (review-fix):** peer EOF/Close/ExitStatus/ExitSignal drains queued cmds with `TransportClosed`, bounded channel-close + disconnect, `Closed` exactly once. Backend write/resize error replies fixed public `TransportClosed`, drains queue, cleanup, `Closed` once.

### Setup failure cleanup (production + faithful I/O)

| Stage | Channel close | Disconnect |
|-------|---------------|------------|
| Before handle (`Connect`) | no | no |
| Handle, no channel | no | once |
| After channel (PTY/shell) | once | once |

All cleanup I/O deadline-bounded via `run_cleanup_io` / `bounded_await`.

## Review-fix proofs (exact gates)

| # | Reject | Proof (test name) | What is asserted |
|---|--------|-------------------|------------------|
| 1 | ExtendedData + peer Close/ExitStatus | `peer_extended_data_emitted`, `peer_close_emits_closed_once`, `peer_exit_status_emits_closed_once` | Actor emits `TerminalOutput::ExtendedData { ext, len-only Debug }`; Close and ExitStatus each emit **Closed once** and reject further write/resize; ExitStatus code observed in actor completed log |
| 2 | Actor fairness under continuous load | `actor_fairness_cmd_not_starved_by_continuous_peer`, `actor_fairness_peer_eof_not_starved_by_continuous_cmds` | Real actor select (not only `FairIoScheduler` getters): write acks under 64 peer flood with branch log showing cmd wins after ≤ burst+2 peers; peer EOF under queued cmds emits Closed once and fail-closes queued resizes |
| 3 | Faithful PTY/shell setup fail/timeout cleanup | `faithful_setup_connect_fail_no_cleanup_io`, `faithful_setup_channel_fail_disconnect_once_no_channel_close`, `faithful_setup_pty_fail_*`, `faithful_setup_shell_fail_*`, `faithful_setup_pty_timeout_bounded_cleanup` | Async stage runner with **counted** channel-close / disconnect I/O; exact counts per stage; timeout completes under 1.5s bound |
| 4 | Real A/B isolation | `ab_authority_isolation_separate_transports` | Two principals, two loopback transports, two managers (distinct session-id RNGs); cross `authorize` → fixed `Internal`; foreign `close_session` is no-op (no Closed); owner close only tears own transport |
| 5 | Peer EOF / local close + in-flight drain | `peer_eof_drains_queued_cmds_and_closed_once`, `local_close_drains_inflight_and_closed_once` | In-flight write + queued resizes → `TransportClosed` replies; **Closed exactly once** |
| 6 | Write/resize backend failure fail-closed | `write_backend_failure_public_error_and_fail_closed`, `resize_backend_failure_public_error_and_fail_closed` | Fixed public `local_ssh_transport_closed`; subsequent ops fail-closed; Closed once; Debug/error free of secrets/host |
| 7 | Dead test fields | RecordingSink.errors removed; ExitStatus code used; unused imports cleaned | No new unused 8B3b test fields |

Scheduler unit tests remain as micro-checks only; fairness claims are backed by actor tests above.

## Explicit non-claims

- No Tauri SSH IPC commands/events  
- No React terminal UI  
- No upload / AI / schema / Compose  
- No new crate dependency  
- Faithful setup runner is actor-shaped async I/O with real cancel/timeout and counted cleanup — **not** a full russh server that refuses PTY (loopback covers happy-path PTY/shell; fail-path is the faithful stage actor)  
- **Not claimed:** “all gates green,” “clippy clean,” or zero-warning CI. This node is accepted **only** under the documented inherited-baseline clippy exception below.  

## Verification (independent coordinator results preserved)

| Command | Result |
|---------|--------|
| `cargo +1.92.0 test --manifest-path src-tauri/Cargo.toml local_ssh -- --nocapture` | **105** passed |
| `cargo +1.92.0 test --manifest-path src-tauri/Cargo.toml --all-targets` | **297** passed, **1** ignored (**141.96s**) |
| `npm test` | **43** passed |
| `npm run contracts:check` | **ok** |
| `npm run build:web` | **ok** |
| `cargo +1.92.0 build --manifest-path src-tauri/Cargo.toml --release` | **ok** |
| `git diff --check` | **clean** |

### Clippy — exact commands and results (do not collapse these)

| Command | Exit | Result |
|---------|------|--------|
| `cargo +1.92.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets` | **0** | Completes with **warnings** (not zero-warning). |
| `cargo +1.92.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | **101** | Fails on **inherited** diagnostics elsewhere in the crate; **no `transport.rs` diagnostic** in that failure set. |

#### Inherited-baseline exception (acceptance of this node)

- **8B3b is accepted only by this documented inherited-baseline exception:** the permissive clippy invocation exits 0 with warnings; the strict `-D warnings` invocation exits 101 solely because of pre-existing/inherited diagnostics outside `src-tauri/src/local_ssh/transport.rs` (strict mode shows **no** `transport.rs` diagnostic).
- **Immediate next node:** strict clippy cleanup of the inherited baseline (drive `clippy … --all-targets --all-features -- -D warnings` to exit 0). That work is **not** claimed done here.
- **Do not interpret this evidence as “all gates green.”** Functional/test/build/diff gates above are recorded as passed; clippy remains an open baseline debt except for the transport-path non-contribution under strict deny.

### Secret / literal scan

- Intentional OpenSSH PEMs only in transport/connect **test fixtures**.  
- `TerminalOutput` / `CmdKind` Debug show **length only** (no payload).  
- Public errors: `local_ssh_channel_failed`, `local_ssh_transport_closed`, `local_ssh_command_queue_full` — no host/user/tenant/subject/fingerprint.  
- A/B test uses loopback `127.0.0.1` only inside test prepared open (not in Debug/events).  

## Status / files modified (uncommitted)

- `src-tauri/src/local_ssh/transport.rs` (new)
- `src-tauri/src/local_ssh/connect.rs`
- `src-tauri/src/local_ssh/prepare.rs`
- `src-tauri/src/local_ssh/mod.rs`
- `src-tauri/src/local_ssh/tests.rs`
- `docs/task-8b3b-ssh-transport-evidence.md`
