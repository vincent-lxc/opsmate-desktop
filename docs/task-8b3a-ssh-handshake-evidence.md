# Task 8B3a Evidence — review-reject rework (async writer, fence, rekey)

**Date:** 2026-08-04  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Branch:** `feat/secure-desktop-foundation`  
**Task / dispatch:** `task_07a2f24696b7` / `ctx_f8614e99fd61`  
**Worker:** no commit / no push

## Review blockers closed

| ID | Fix |
|----|-----|
| **A** Async cloud writer | `CloudHostKeyWriter::write_host_key` → `Pin<Box<dyn Future + Send + 'a>>`; `verify`/`check_server_key` **await**; production writers await `invoke_native`/`call_native` directly; **no** `block_in_place` / `Handle::current().block_on`; bearer borrowed for await only |
| **B** Bounded close | Fence (take handle) **before** wait; on completion **join**; on timeout **return without join**; worker owns only fenced handle; slow-teardown test returns &lt;5s with `is_fenced` |
| **C** No authority Clone | `LocalSshConnectAuthority` not `Clone`; `HostKeyPolicySnapshot::from_authority(&…)` copies selected secret-free fields; Debug redacts |
| **D** Rekey safety | After successful TOFU, policy pins presented key; same-key recheck: zero prompt/cloud/bearer; different key: `HostKeyMismatch`; pinned repeat without bearer |
| **E** Barriers | `HandshakeDeps` requires `ticket_barriers` + manager; `TicketBarrierSnapshot` Debug redacts identity |

### Close semantics (honest)

- **`is_fenced` / immediate fence:** handle slot emptied under mutex — no further session use from this process after `on_close` returns.
- **Protocol disconnect:** best-effort on a background worker; may finish after return if hung; never unfences the slot.

## Verification

| Command | Result |
|---------|--------|
| `cargo +1.92.0 fmt -- --check` | ok |
| `cargo +1.92.0 test --lib local_ssh::connect` | **27** passed |
| `cargo +1.92.0 test --all-targets` | **270** passed, **1** ignored |
| `npm test` | **43** passed |
| `npm run contracts:check` | ok |
| `npm run build:web` | ok |
| `cargo +1.92.0 build --release` | ok |
| `git diff --check` | clean |

## Explicit non-claims

No PTY, shell actor, Tauri SSH IPC, React terminal, upload, AI. No new crate dependency.
