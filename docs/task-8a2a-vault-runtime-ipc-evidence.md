# Task 8A2A Evidence — Vault runtime + named IPC + real 401/logout seal

**Date:** 2026-08-04
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`
**HEAD base:** `41d834a` (`feat/secure-desktop-foundation`)
**Task / dispatch:** `task_1eee60e208ce` / `ctx_a3d7aff127b5`
**Review rework:** `task_1e307bc3c4c6` / `ctx_cfb40cbf4922`
**Logout seal proof rework:** `task_cc66a0981bef` / `ctx_0c7ddf30e06a`
**Worker:** no commit / no push

## Scope

| Path | Role |
|------|------|
| `src-tauri/src/lib.rs` | Manage `Arc<VaultService>` from app data dir; named vault_* IPC; wire CloudBridge |
| `src-tauri/src/cloud_bridge.rs` | `ProductionLifecycleHooks` holds real vault; 401/logout/new-session seal Stronghold |
| `src-tauri/src/vault/mod.rs` | `map_vault_public`, `seal_for_principal_change`, `is_unlocked` |
| `src-tauri/src/vault/tests.rs` | Named-IPC allowlist / no Stronghold plugin assertions updated |
| `src-tauri/src/security_cutoff.rs` | Comment: Task 8 unlock path |
| `docs/task-8a2a-vault-runtime-ipc-evidence.md` | This document |

**Not in this node:** idle watchdog / sleep-wake / exit (8A2B), SSH, upload, React UI, cloud pages, Stronghold plugin/capability.

## Behavior

1. **Runtime vault** — `VaultService::new(default_snapshot_path(app_data_dir))` in setup; path fixed by Rust; never WebView.
   **`app_data_dir` fail-closed:** `map_err(|_| "app_data_dir_unavailable")` — **no** ephemeral insecure path fallback in production setup.
2. **Named IPC only** — `vault_status`, `vault_init`, `vault_unlock`, `vault_lock`, `vault_import`, `vault_list_meta`, `vault_delete_local`.
   WebView args: `VaultImportRequest` / `VaultDeleteLocalRequest` = `credentialId` only (`deny_unknown_fields`).
   Passwords/PEM via `NativeSecurePrompt` only.
3. **AuthBinding** — `vault_init` / `vault_unlock` capture binding before prompt; revalidate after prompt (unlock uses `unlock_with_password_for_binding`).
   **`finalize_vault_unlock`:** after Stronghold unlock, **fresh** `binding_still_current` before `notify_vault_unlocked`; on mismatch → real vault seal (`on_logout`), cutoff stays locked, `vault_unauthenticated`.
4. **Lifecycle** — `ProductionLifecycleHooks::lock_vault` → SecurityCutoff + real `vault.on_logout()`.
   `perform_secure_logout` always seals real vault after SSH cutoff even if auth clear fails.
   `on_successful_session_install` → cancel older cloud epochs, SSH cutoff, `seal_for_principal_change`.
   Cutoff bool ≠ Stronghold truth.
5. **Errors** — `map_vault_public` → fixed `vault_*` codes only; setup path uses fixed `app_data_dir_unavailable` / `cloud_setup_failed`.
6. **No** Stronghold plugin registration; capability remains `core:default` only.

## Tests (new / updated)

- `current_epoch_401_seals_real_managed_vault`
- `logout_seals_real_managed_vault`
- `new_session_seals_real_vault_principal_changed`
- `stale_epoch_401_does_not_seal_newer_session_vault`
- **`secure_logout_applies_cutoffs_even_when_auth_clear_fails`** — inject_unlocked_vault precondition; poison auth clear; assert auth Err **and** SSH gen + SecurityCutoff locked **and** same VaultService sealed with `locked_reason=logout` (not cutoff-only)
- `map_vault_errors_are_fixed_public_codes_secret_free`
- `vault_ipc_handler_allowlist_and_secret_free_signatures`
- `production_vault_path_fail_closed_no_temp_fallback` (source: no temp/unwrap_or_else; fixed `app_data_dir_unavailable`)
- `vault_unlock_revalidates_binding_before_cutoff_unlock` (source order proof)
- `finalize_vault_unlock_mismatch_seals_and_keeps_cutoff_locked` (behavioral)
- Prior vault core + cloud transport suites remain green

## Verification (post logout-seal proof rework, coordinator rerun)

| Command | Result |
|---------|--------|
| `rustup run 1.92.0 cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | ok |
| `rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml` | **158** passed, **1** ignored |
| `rustup run 1.92.0 cargo check --manifest-path src-tauri/Cargo.toml` | Finished (no warnings) |
| `npm test` | **43** passed |
| `npm run contracts:check` | ok |
| `npm run build:web` | ok |
| `rustup run 1.92.0 npm run build` | release binary + `OpsMate.app` bundle built |
| `git diff --check` | clean |

## Explicit non-claims

- No idle/sleep/exit watchdog (8A2B)
- No SSH / upload / React vault UI
- No Stronghold plugin or WebView capability
- No commit/push by worker
