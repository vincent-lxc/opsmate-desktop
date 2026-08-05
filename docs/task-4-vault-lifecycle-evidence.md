# Task 4 Evidence — Cross-platform vault OS sleep / lock lifecycle

**Date:** 2026-08-05  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Branch:** `feat/secure-desktop-foundation`  
**Base HEAD:** `2bb43f7`  
**Dispatch (rework):** `task_6dff365454f5` / `ctx_1072fc3b4ff7`  
**Worker:** no commit / no push  

## Fresh re-verification note

Earlier host/Docker suites that overlapped the **health mutex / `run_if_healthy` TOCTOU fix** are **invalidated**.  
This document records gates re-run on the **final tree** after that change (warm Docker caches allowed).

## Scope

| Path | Role |
|------|------|
| `src-tauri/src/vault_os_sleep.rs` | Dispatch + **`ObserverHealth`** (`run_if_healthy` / `mark_unhealthy_then`) |
| `src-tauri/src/vault_os_sleep/{macos,windows,linux}.rs` | Platform observers; unexpected death → mark then seal |
| `src-tauri/src/cloud_bridge.rs` | Shared `observer_health`; `notify_vault_unlocked` via `run_if_healthy` |
| `src-tauri/src/lib.rs` | Unlock fail-closed gates + reseal on observer loss |
| `src-tauri/src/vault/mod.rs` | `VaultError::ObserverUnavailable` → `vault_observer_unavailable` |
| `docs/task-4-vault-lifecycle-evidence.md` | This document |

## Behavior summary

- Sleep/lock → `on_system_sleep` (SSH before Stronghold seal); resume → `on_resume` (enforce locked).
- **Observer health latch** (sticky): unexpected post-handshake listener death marks unhealthy; explicit unregister/cancel does **not**.
- **Unlock fail-closed:** pre/post-prompt `is_healthy` snapshots; final cutoff unlock only via `notify_vault_unlocked` → `run_if_healthy` (health check + `unlock_vault_for_task8` one CS — no TOCTOU). On refuse: `fail_closed_after_observer_loss` reseals + keeps SecurityCutoff locked.
- Fixed public IPC only: `vault_observer_unavailable`.
- Windows: single Box ownership, WTS exact-once before DestroyWindow, `WTS_SESSION_UNLOCK`.
- Linux: `GetSessionByPID`, setup cancel-select, zbus export Stream (no direct futures-core).

## Dependencies (final tree)

| Item | Status |
|------|--------|
| Linux `zbus = "=5.18.0"` (tokio, default-features=false) | present (plan-approved) |
| Windows `Win32_System_RemoteDesktop` on existing `windows 0.62.2` | feature only |
| Direct `futures-core` / `futures-util` | **absent** |
| Permanent `src-tauri/icons/icon.ico` | **absent** (only `icon.png`) |

## Fresh host verification (macOS, rustc 1.92.0)

| Command | Result |
|---------|--------|
| `rustup run 1.92.0 cargo fmt -- --check` | **ok** (exit 0) |
| `cargo test --lib vault_os_sleep` | **11 passed** |
| `cargo test --lib interleaving` | **1 passed** |
| `cargo test --lib finalize_observer` | **1 passed** |
| `cargo test --lib notify_` | **4 matched, all pass** (incl. interleave + run_if_healthy contract) |
| `cargo clippy --all-targets --all-features -- -D warnings` | **exit 0** |
| `cargo test --all-targets` | **318 passed**, **1 ignored**, ~146.76s |
| `git diff --check` | **clean** |
| Permanent `icon.ico` | **absent** |

## Fresh Docker (warm target volumes)

### Linux x64

```text
docker --platform linux/amd64 rust:1.92-bookworm
  + CARGO_TARGET_DIR=/target volume opsmate-linux-target
  + registry cache opsmate-linux-cargo-cache
  cargo check --all-features --lib
→ Finished ~1.32s; LINUX_CHECK_EXIT:0
```

### Windows GNU

```text
docker --platform linux/amd64
  + volume opsmate-windows-gnu-target
  + temp icons/icon.ico only inside container
  cargo check --target x86_64-pc-windows-gnu --lib
→ Finished ~1.51s; WIN_CHECK_EXIT:0; HOST_ICON_ABSENT_OK
  host icons/ still only icon.png
```

## Behavioral tests (core race not source-string-only)

| Test | Covers |
|------|--------|
| `observer_health_interleaving_unlock_and_failure_ends_locked` | A/B/C/D interleavings end locked |
| `finalize_observer_death_after_unlock_reseals_and_keeps_cutoff_locked` | mid-unlock death reseals Stronghold |
| `notify_unlock_interleaved_with_mark_unhealthy_ends_locked` | CloudBridge notify + concurrent failure |
| `notify_vault_unlocked_refuses_when_observer_unhealthy` | cannot unlock cutoff when unhealthy |
| `registration_unregister…` | explicit unregister stays healthy |

## Explicit non-claims

- No commit / push  
- No permanent packaging `icon.ico`  
- No MSVC native compile (GNU Docker only)  
- No hardware GUI sleep/lock E2E  
- No WebView health surface beyond fixed error code  

## Uncommitted files

- `src-tauri/src/vault_os_sleep.rs`  
- `src-tauri/src/vault_os_sleep/{macos,windows,linux}.rs`  
- `src-tauri/src/cloud_bridge.rs`  
- `src-tauri/src/lib.rs`  
- `src-tauri/src/vault/mod.rs`  
- `src-tauri/Cargo.toml` / `Cargo.lock`  
- `docs/task-4-vault-lifecycle-evidence.md`  
