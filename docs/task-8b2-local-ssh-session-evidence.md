# Task 8B2 Evidence — Local SSH session authority / registry

**Date:** 2026-08-04  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Branch:** `feat/secure-desktop-foundation`  
**Base:** `a39935a` + uncommitted 8B2 (attach-path repair)  
**Task / dispatch:** `task_cfef42f69b0a` / `ctx_5c28c0c812a5`  
**Worker:** no commit / no push

## Scope

| Path | Role |
|------|------|
| `src-tauri/src/local_ssh/session.rs` | Two-phase ticket registry + sink + tests |
| `src-tauri/src/local_ssh/mod.rs` | Crate-internal exports |
| `src-tauri/src/lib.rs` | `attach_session_manager_to_vault` + manage |
| `docs/task-8b2-local-ssh-session-evidence.md` | This document |

## Design (final repair)

### Required order (no lease before ticket)

1. **`begin_establishment(&LocalSshOpenRequest)`** — secret-free `serverId`+`credentialId` only; validates IDs; captures current AuthBinding, SecurityCutoff ssh_generation, vault/cutoff unlocked, registry global generation, tenant+subject+credential epoch. **No** `PreparedLocalSshOpen` accept path.
2. **`prepare_local_ssh_open(request)`** (8B1) — may create vault lease after ticket.
3. Connector (8B3 future) → **`complete_established(ticket, prepared, close)`**.

### Post-insert validation

After insert: auth/vault/cutoff live **and** ticket global generation + credential epoch still match **and** exact session record still present (principal/epoch/server/credential/ssh_gen). Lifecycle that already closed the handle does not double-close on Err.

### Credential ownership namespace

`close_sessions_for_credential` drains by **tenant_id + Logto subject + credential_id** (not username/`user_id`). AuthBinding for ops remains exact principal+epoch.

### Production attach (single sink-wiring site)

Shared `attach_session_manager_to_vault_inner(manager, vault)` **only** performs
`vault.set_session_lifecycle_sink(manager.clone())` and returns that Arc.

- **Production** `attach_session_manager_to_vault`: `LocalSshSessionManager::new` (SecRandomSource) → shared inner.
- **Test** `attach_session_manager_to_vault_with_rng`: `with_rng` → same shared inner.
- Behavioral seal-close test uses the test wrapper (not manual sink set).
- Source assertion `production_attach_helper_calls_shared_inner` proves production calls inner and that `set_session_lifecycle_sink` appears once outside tests.

### `complete_established` close-on-err

Err path invokes `on_close` when ownership was not transferred. Dropping the Arc alone does **not** call `on_close`; a panic inside the inner does **not** close. No panic catching in this node.

## Explicit non-claims

No SSH socket / russh connect / TOFU / SSH IPC / terminal UI / upload / AI. No PEM retention after complete.

## Session tests (**26**)

| Test | Proves |
|------|--------|
| `two_phase_register_generates_32byte_opaque_id` | begin(request)→complete |
| `begin_then_close_all_then_complete_no_insert_closes_once` | Global barrier |
| `begin_then_credential_close_then_complete_no_insert_closes_once` | Cred barrier |
| `complete_post_insert_close_all_err_no_double_close` | Post-insert close_all |
| `complete_post_insert_credential_close_err_no_double_close` | Post-insert cred close |
| `complete_post_insert_auth_clear_closes_once_no_leak` | Post-insert auth clear |
| `same_tenant_subject_username_change_credential_close_invalidates` | Namespace ≠ username |
| `different_subject_same_credential_id_isolated` | Subject isolation |
| `ab_same_credential_isolation_same_manager` | Same manager A/B |
| `attach_helper_wires_vault_sink_closes_on_seal` | Test attach wrapper + vault.lock closes handle |
| `production_attach_helper_calls_shared_inner` | Production calls shared inner; sink wiring once |
| `authorize_unknown_and_foreign_same_error` | Non-disclosure |
| (+ collision, close-all reentrancy, ticket mismatch, RNG fail, etc.) | |

Honest: `later_authorize_after_cutoff_bump_purges_stale_session` is **later-authorize** purge, not mid-complete race.

## Verification

| Command | Result |
|---------|--------|
| fmt --check (1.92) | ok |
| cargo test --all-targets (1.92) | **240** passed, **1** ignored |
| cargo test --lib local_ssh::session | **26** passed |
| npm test | **43** passed |
| contracts:check / build:web | ok |
| git diff --check | clean |
| clippy -D warnings (1.92) | **exit 101 — pre-existing only; zero `local_ssh`** |

### Clippy (honest — no crate-root allow)

| Location | Lint |
|----------|------|
| `auth/pkce.rs` | `manual_div_ceil` |
| `auth/session.rs` | `derivable_impls` |
| `auth/mod.rs` | `if_same_then_else` |
| `cloud_transport/lifecycle.rs` | `result_unit_err` (×3) |
| `cloud_transport/sanitize.rs` | `manual_contains`, `result_unit_err` |
| `vault/mod.rs` | `large_enum_variant`, `field_reassign_with_default` |
| `vault_os_sleep.rs` | `borrow_deref_ref` (×2) |
| `auth/tests.rs` | `needless_borrow` |

Module lint: only `#![cfg_attr(not(test), allow(dead_code))]` for 8B3-reserved APIs.