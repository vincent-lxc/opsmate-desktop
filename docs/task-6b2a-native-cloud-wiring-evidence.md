# Task 6B2A Evidence — Native cloud bridge + epoch-safe 401

**Date:** 2026-08-04  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Start HEAD:** `aaf882e` (`feat/secure-desktop-foundation`)  
**Task / dispatch:** `task_f4a7313747b3` / `ctx_bbfebc28fe43`  
**Worker:** no commit / no push / no React / no network UAT

## Strict TDD

Implementation followed focused product-behavior tests for:

- `cloud_call` / bridge bearer-from-snapshot + sanitize
- unauthenticated fail-closed before outbound
- current-epoch 401 ordered cutoffs + single emit
- concurrent same-epoch 401 dedupe
- delayed old-epoch 401 after new session (no clear / no emit / new epoch not cancelled)
- `mark_reauth_required_if_epoch` current vs stale
- logout SSH/vault cutoffs
- source surface: `cloud_call` in `generate_handler`, deny_unknown IPC args

Prior 6B1 suite was migrated to auth-epoch cancel tokens and kept green.

## What landed

| Path | Role |
|------|------|
| `src-tauri/src/security_cutoff.rs` | Real SSH generation + vault-locked gates (no Task 8 product yet) |
| `src-tauri/src/cloud_bridge.rs` | `CloudBridge`, `CloudCallArgs`, `ProductionLifecycleHooks`, `call()` |
| `src-tauri/src/cloud_transport/lifecycle.rs` | Auth-epoch cancel + `run_401_for_auth_epoch` (conditional clear) |
| `src-tauri/src/cloud_transport/client.rs` | `invoke_ipc(..., auth_epoch)` epoch-scoped cancel race |
| `src-tauri/src/auth/session.rs` | `mark_reauth_required_if_epoch` |
| `src-tauri/src/lib.rs` | Manage `CloudBridge`, `cloud_call` command, logout cutoffs |
| tests across auth / cloud_bridge / cloud_transport / security_cutoff | coverage |

## Security behavior

1. **IPC** — `cloud_call({ operationId, input })` only (`deny_unknown_fields`). Bearer from `AuthStore::native_auth_snapshot()` under one lock; never from WebView. Snapshot not held across await.
2. **Errors** — `map_cloud_public` fixed codes only (no URL/body/status/token).
3. **401 epoch safety** — cancel only waiters for that auth epoch; lifecycle dedupe per epoch; `mark_reauth_required_if_epoch` clears only if store still on that epoch; SSH/vault/emit only when clear succeeded.
4. **SecurityCutoff** — `close_all_ssh` increments generation; `lock_vault` sets sticky gate. Documented: **no real SSH sessions or Stronghold vault yet**.
5. **Logout** — cancel all cloud, SSH cutoff, vault lock, then `perform_logout` (session clear + reauth flag).
6. **CSP** — still `connect-src 'self'` (WebView has no network). No opener/deep-link/shell/stronghold WebView caps.

## Verification (GREEN)

| Command | Result |
|---------|--------|
| `cargo fmt -- --check` | ok |
| `cargo test` (full lib) | **110** passed; 0 failed |
| `cargo check` | ok |
| `npm test` | **28** passed |
| `npm run contracts:check` | ok |
| `npm run build:web` | ok |
| `git diff --check` | clean |
| secret scan | fixture-only PEM string in existing sanitizer tests |

## Explicit non-claims

- No React / UI wiring of `cloud_call` (later node).
- No network/interactive UAT against real `app.itops.sh`.
- No real SSH session manager or Stronghold vault (cutoffs are fail-closed gates only).
- No commit/push by worker.

---

## Coordinator-rejection rework (`task_25cc3ee6ef8f` / `ctx_f60e1bf58cf7`)

Prior 6B2A delivery was rejected despite green counts. This rework fixed fail-closed
startup, required emitters, session transitions, bounded epoch watermarks, strong
stale-401 tests, redacted IPC Debug, and lifecycle order.

### Fixes

1. **Vault fail-closed** — `SecurityCutoff::new`/`Default` start `vault_locked=true`; only Task8 unlock.
2. **Required emitter** — `SessionInvalidatedEmitter` trait; no optional `set_emit`. `CloudBridge` built in Tauri `setup` after `AppHandle` with `TauriSessionEmitter`; fail setup with fixed `cloud_setup_failed` (no panic).
3. **Login/logout** — successful deep-link → `on_successful_session_install` (cancel older epochs via watermark, SSH cutoff, vault lock). Logout via `perform_secure_logout`: cancel → `perform_logout` → SSH → vault.
4. **Bounded epochs** — `cancelled_through` + `lifecycle_done_through` atomics (no HashSet). Out-of-order E3 then E2 dedupes; newer epochs unaffected.
5. **Strong stale-401 test** — pending hanging new-epoch call + old-epoch 401; new session stays auth; pending not cancelled until teardown `cancel_all`.
6. **IPC** — `CloudCallArgs` redacted Debug; `deny_unknown_fields`; test-only `with_backend` is `cfg(test)`.
7. **Lifecycle order** — assert `try_clear → ssh → vault → emit`; concurrent same epoch one emit; peer cancel maps to `session_invalidated` when watermark covers epoch.

### GREEN (this rework)

| Command | Result |
|---------|--------|
| `cargo fmt -- --check` | ok |
| `cargo test` | **116** passed |
| `cargo check` | ok |
| `npm test` | **28** passed |
| `contracts:check` | ok |
| `build:web` | ok |
| `git diff --check` | clean |
| secret scan | fixture-only PEM in sanitizer tests |

### Corrected non-claims

- Still **no** real SSH sessions or Stronghold vault — only generation/lock gates.
- Still **no** React `cloud_call` adapter, no network UAT, no commit/push.
- Production **does** require emitter and builds CloudBridge in setup (not optional).

---

## Final fail-closed rework (`task_e358e9affc0b` / `ctx_c11e0ab3d7e7`)

### Fixes

1. **`mark_reauth_required_if_epoch` → `Result<bool, AuthError>`**  
   - `Ok(true)` current cleared → SSH + vault + emit  
   - `Ok(false)` stale → no cutoffs/emit  
   - `Err` lock/internal → fail closed: still SSH + vault + emit  
   Tests: poison helper returns `Err(Internal)` (not treated as stale).

2. **`perform_secure_logout`** always advances SSH + locks vault even if `perform_logout` returns `Err`. Order: cancel → attempt auth clear → SSH → vault → return auth result. Poison-path test covers cutoffs on Err.

3. **Removed** unused `SessionInvalidatedEmitter` from `cloud_transport/lifecycle.rs` (canonical trait only in `cloud_bridge.rs`).

4. **`CancelWaitToken`** simplified to `auth_epoch` + `start_global` only.

5. **Stale-401 test** cleaned of unused second backend and outdated cancel_all comments; keeps hanging new-epoch pending assertion.

6. **`unlock_vault_for_task8`** is `pub(crate)` (+ `#[allow(dead_code)]` until Task 8); test unlock remains `cfg(test)`.

### GREEN

| Command | Result |
|---------|--------|
| `cargo fmt -- --check` | ok |
| `cargo test` | **120** passed |
| `cargo check` | ok (no warnings after allow) |
| `npm test` | **28** passed |
| `contracts:check` | ok |
| `build:web` | ok |
| `git diff --check` | clean |
| secret scan | fixture-only PEM in sanitizer tests |

### Non-claims (unchanged)

- No real SSH/Stronghold product; no React cloud adapter; no network UAT; no commit/push.

---

## Warning cleanup (`task_8e06d4c15ee9` / `ctx_6d898e295665`)

Coordinator found `unused import: SessionLifecycleHooks` in `cloud_bridge.rs` test module.

**Change:** removed unused import only (smallest patch).

### GREEN (warning-free)

| Command | Result |
|---------|--------|
| `cargo fmt -- --check` | ok |
| `cargo test` (1.92.0) | **120** passed; **no warnings** in output |
| `cargo check` (1.92.0) | **Finished**; **no warnings** |
| `npm test` | **28** passed |
| `contracts:check` | ok |
| `build:web` | ok |
| `git diff --check` | clean |
