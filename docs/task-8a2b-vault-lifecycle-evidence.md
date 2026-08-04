# Task 8A2B Evidence — Idle / sleep / exit vault lifecycle

**Date:** 2026-08-04
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`
**HEAD base:** `11b0a01` (`feat/secure-desktop-foundation`)
**Task / dispatch:** `task_0506b714ae6e` / `ctx_4db32d7837f5`
**Review rework 1:** `task_f5399f89a23d` / `ctx_ba181adb7c18`
**Review rework 2:** `task_f7631e7189c0` / `ctx_9e147c9dbca4`
**Review rework 3 (idle bypass):** `task_e2d20cbe8464` / `ctx_97fdb836ab2e`
**Review rework 4 (user lock SSH-before-seal):** `task_af95028fc41f` / `ctx_b05d9cd41313`
**Review rework 5 (Err gen-before, not bool):** `task_2fbafb5a7ce2` / `ctx_a649e9f20040`
**Worker:** no commit / no push

## Scope

| Path | Role |
|------|------|
| `src-tauri/src/vault/mod.rs` | status side-effect free; enter_op no direct idle seal; `"locked"` fixed reason; after-pre_seal test arm |
| `src-tauri/src/vault_lifecycle_coordinator.rs` | **Only** production idle/sleep/exit seal authority (cutoff before Stronghold) |
| `src-tauri/src/cloud_bridge.rs` | `perform_user_vault_lock` — SSH close + cutoff **before** Stronghold seal |
| `src-tauri/src/lib.rs` | `vault_lock` → `perform_user_vault_lock` (not lock-then-notify) |
| `src-tauri/src/vault_idle_watchdog.rs` | 30s poll → `on_idle_tick` |
| `src-tauri/src/vault_os_sleep.rs` | RAII WillSleep + DidWake |
| `docs/task-8a2b-vault-lifecycle-evidence.md` | This document |

## Review rework 4 — explicit user lock SSH-before-seal

| Issue | Fix |
|-------|-----|
| `vault_lock` called `vault.lock()` first, then `notify_vault_locked()` | `CloudBridge::perform_user_vault_lock` via `seal_if_unlocked_with_pre_seal("locked", …)` |
| `notify_vault_locked` only flips SecurityCutoff bool | Pre-seal: `close_all_ssh()` + `lock_vault()` **before** Stronghold seal |
| No generation advance on user lock | Exactly one SSH generation transition per sealing lock |
| Seal error after pre_seal | Cutoff remains closed; fixed `vault_storage_error` propagates; no second gen bump |
| Seal error before pre_seal | Fail-closed: close SSH + lock cutoff, then propagate |

**IPC:** `vault_lock(cloud)` — secret-free signature (no password/pem/path). Status `locked_reason: "locked"`.

### Behavioral tests (rework 4)

- `perform_user_vault_lock_ssh_before_stronghold_and_locked_reason` — unlocked real VaultService + unlocked cutoff; after-pre_seal fail proves gen/cutoff while Stronghold still unlocked; success asserts `locked` reason + one gen; idempotent NotNeeded zero extra gen; pre_seal callback observes unlocked; source wiring asserts helper + IPC
- `perform_user_vault_lock_error_before_pre_seal_fail_closed` — Storage before pre_seal → cutoff locked, gen=1, error propagates

## Review rework 5 — Err branch must not use vault-locked bool for SSH

| Issue | Fix |
|-------|-----|
| Err path used `is_vault_locked()` to skip `close_all_ssh` | Capture `gen_before`; on Err if gen unchanged → `close_all_ssh` once; always `lock_vault`; return original error |
| Locked bool can coexist with live old SSH generation | Deterministic test: bool starts locked, vault unlocked, error-before-pre_seal → gen +1, prior capture invalid |

### Tests (rework 5)

- `perform_user_vault_lock_err_before_pre_seal_when_cutoff_bool_already_locked` — sticky locked bool + error before pre_seal advances generation exactly once
- Existing after-pre_seal one-bump test preserved

## Review rework 3 — status/enter_op idle bypass

| Issue | Fix |
|-------|-----|
| `status()` called `maybe_idle_seal()` → Stronghold sealed without SecurityCutoff | `status()` is pure snapshot (`status_without_idle_seal`) |
| `enter_op` sealed on idle expiry (direct `seal_vault` / `maybe_idle_seal`) | Idle-expired ops return `Locked` without sealing or refreshing activity |
| Legacy `maybe_idle_seal` / `check_idle_and_seal` | **Removed** |
| Watchdog later saw locked → NotNeeded while SSH still open | No longer possible: only coordinator seals idle |

**Idle seal authority:** `VaultLifecycleCoordinator::on_idle_tick` → `seal_if_still_idle_with_pre_seal` (pre_seal = SSH close + cutoff lock). Production poll interval: **`DEFAULT_IDLE_POLL` = 30 seconds**. Inactivity policy: **`VAULT_IDLE_TIMEOUT` = 15 minutes**.

## Tests (rework 3)

- `status_and_enter_op_do_not_bypass_cutoff_on_idle_expiry` — status leaves vault unlocked + cutoff open; list/enter fails Locked; coordinator tick seals once with gen=1
- `production_idle_seal_only_via_coordinator_primitive` — no `maybe_idle_seal` / `check_idle_and_seal` in vault source; status/enter_op free of seal calls

## Prior behavior (still true)

- TOCTOU-safe idle seal under SEALING claim
- Fail-closed lifecycle Err → SSH + cutoff
- Wake enforces lock; exit dedupe; RAII macOS observers with unregister
- No Logto clear on local lifecycle seals

## Verification (post rework 5)

| Command | Result |
|---------|--------|
| `rustup run 1.92.0 cargo fmt -- --check` | ok |
| `rustup run 1.92.0 cargo test` | **178** passed, **1** ignored |
| `rustup run 1.92.0 cargo check` | Finished (no warnings) |
| `RUSTUP_TOOLCHAIN=1.92.0 npm run tauri build` | ok — `OpsMate.app` bundled |
| `npm test` | **43** passed |
| `npm run contracts:check` | ok |
| `npm run build:web` | ok |
| `git diff --check` | clean |

### Coordinator independent verification

- Focused explicit-lock suite: **3 passed**, including locked-cutoff/error-before-pre-seal generation invalidation.
- Full Rust suite: **178 passed, 1 ignored, 0 failed**.
- Frontend: **43 passed**; contracts and production Web build passed.
- macOS release bundle built at `src-tauri/target/release/bundle/macos/OpsMate.app` with Rust 1.92.0.
- Secret-pattern and Tauri capability scans found no added key/token material and no `stronghold:`, `shell:`, or `opener:` WebView capability.
- Running Tauri once without the pinned toolchain selected system Cargo 1.84.1 and failed on Edition 2024; rerunning with the repository-required Rust 1.92.0 succeeded. This was a toolchain-selection failure, not a code failure.

## Explicit non-claims

- No real SSH transport/sessions (cutoff generation only)
- No Stronghold plugin / WebView capability
- No new deps / upload / UI
- No commit/push by worker
