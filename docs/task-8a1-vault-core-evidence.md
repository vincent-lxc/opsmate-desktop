# Task 8A1 Evidence — Stronghold vault core + native secure input

**Date:** 2026-08-04
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`
**HEAD base:** `96e9dbe` (`feat/secure-desktop-foundation`)
**Task / dispatch (rework):** `task_073d4c05896f` / `ctx_d88d67c1dbc1`
**Prompt-switch test fix:** `task_34716c5137f5` / `ctx_5ae86cfa8a8d`
**Prior delivery:** `task_df806f5c1283`
**Worker:** no commit / no push

## Scope (owned)

| Path | Role |
|------|------|
| `src-tauri/src/secure_prompt.rs` | Native secure password/PEM prompt; non-macOS fails closed |
| `src-tauri/src/vault/mod.rs` | Stronghold vault core + **AuthBinding** epoch binding |
| `src-tauri/src/vault/tests.rs` | Focused tests incl. epoch/prompt-race |
| `src-tauri/src/auth/session.rs` | `AuthBinding`, `auth_binding()`, `binding_still_current` |
| `src-tauri/src/auth/mod.rs` | Export `AuthBinding` |
| `src-tauri/src/lib.rs` | Modules only — **no** vault IPC |
| `src-tauri/Cargo.toml` + `Cargo.lock` | Approved deps |
| `docs/task-8a1-vault-core-evidence.md` | This document |

**Not in 8A1:** vault IPC, OS sleep/watchdog, SSH connect, Stronghold **plugin** registration/capability, cloud UI.

## Security contract

1. **Namespace** = `base64url(tenant_id)/base64url(subject)/credential_id` only (never username).
2. **WebView DTOs:** only `credentialId`; `deny_unknown_fields`.
3. **Vault starts locked.** Init/unlock/import secrets only via native prompts. Non-macOS fails closed.
4. **AuthBinding (principal + epoch, no bearer)** from one AuthStore lock. `UnlockedState` stores binding, not principal alone.
5. **Any missing/poisoned/different epoch or principal** seals fail closed (`principal_changed` or `logout`) before access.
6. **import_begin_native:** capture binding **before** prompts; revalidate after prompts, after op gate, before write, before success. Mid-prompt session switch → zero write.
7. **unlock_with_password_for_binding:** expected binding for 8A2 password-prompt wrappers; revalidate before Stronghold work and before install.
8. **list_meta / delete_local / import / lease:** one captured binding; compare vault binding; revalidate after gate and before external success. delete closes sessions only after binding confirmed. lease compares vault-bound epoch.
9. **No secret Auth snapshot / bearer copy** just for epoch (`auth_binding()` only).

## Review findings closed

| # | Finding | Fix |
|---|---------|-----|
| 1 | Unlock bound principal only | `AuthBinding` + `UnlockedState.binding` |
| 2 | Prompt race re-captures new session | Capture before prompt; `import_pem_with_binding` |
| 3 | Unlock needs expected-binding path | `unlock_with_password_for_binding` |
| 4 | list/delete/import/lease epoch | `ensure_binding_live` + vault epoch compare |
| 5 | No bearer for epoch | `auth_binding()` |
| 6–7 | Tests + side-effect order | See tests below |

## Tests (selected)

- Same principal reinstalled at newer epoch seals old unlock; list fails closed
- SecurePrompt double switches AuthStore after PEM selection → no success; **`test_credential_store_write_count()` stays 0** on the **same** `VaultService` (cfg(test) counter at secret insert/delete boundary; no unrelated path2 vault)
- Stale expected binding cannot install UnlockedState (`test_try_install_unlocked_for_binding` seam)
- list/lease under stale epoch return no data
- Subject/tenant namespace isolation remains green
- DTO unknown fields, lease redaction, Stronghold store smoke, production Argon2 reopen `#[ignore]`

## Dependencies (exact)

tauri-plugin-stronghold **2.3.1** (library only), russh **0.62.5**, rfd **0.17.2**, rust-argon2 **2.1.0**, hex **0.4.3**, anyhow **1.0.97**, objc2 **0.6.4** / app-kit & foundation **0.3.2**. No `ssh2`. `open` only transitive via pre-existing opener plugin.

## Verification (post-rework, coordinator rerun)

| Command | Result |
|---------|--------|
| `rustup run 1.92.0 cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | ok |
| `rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml` | **149** passed, **1** ignored (post write-observer test fix) |
| `rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml --lib vault_init_save_reopen_wrong_password_and_ops -- --ignored --test-threads=1` | **1** passed; real production Argon2 + Stronghold save/reopen/wrong-password flow |
| `rustup run 1.92.0 cargo check --manifest-path src-tauri/Cargo.toml` | Finished (no warnings) |
| `npm test` | **43** passed |
| `npm run contracts:check` | ok |
| `npm run build:web` | ok |
| `rustup run 1.92.0 npm run build` | release binary + `OpsMate.app` bundle built |
| cargo tree pins | stronghold 2.3.1, russh 0.62.5; no ssh2 |
| `git diff --check` | clean |
| secret scan | test PEM/fixtures + redaction asserts only |

## Explicit non-claims

- No vault Tauri commands or React wiring
- No Stronghold plugin / WebView capability
- No SSH sessions / upload / idle watchdog runtime
- SecurityCutoff remains a separate stub gate
- No commit/push by worker
