# Task 1A Evidence — strict clippy inherited baseline

**Date:** 2026-08-05  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Branch:** `feat/secure-desktop-foundation`  
**Base:** `79930a8` (clean) + uncommitted Task 1A only  
**Dispatch:** `task_3cd3bc918c6f` / `ctx_174a633b36e7`  
**Worker:** no commit / no push; no dependency or product-behavior redesign

## Goal

Close the inherited strict-clippy baseline:

```bash
cargo +1.92.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

**RED (before):** exit **101**  
**GREEN (after):** exit **0**, zero warnings

## RED diagnostics (exact paths)

### Library (`opsmate-desktop` lib) — 12 errors

| Lint | Path | Kind |
|------|------|------|
| `clippy::manual_div_ceil` | `src/auth/pkce.rs:50` | mechanical |
| `clippy::derivable_impls` | `src/auth/session.rs:138` | mechanical |
| `clippy::if_same_then_else` | `src/auth/mod.rs:153` | mechanical |
| `clippy::result_unit_err` | `src/cloud_transport/lifecycle.rs:23` | allow (contract) |
| `clippy::result_unit_err` | `src/cloud_transport/lifecycle.rs:24` | allow (contract) |
| `clippy::result_unit_err` | `src/cloud_transport/lifecycle.rs:25` | allow (contract) |
| `clippy::manual_contains` | `src/cloud_transport/sanitize.rs:48` | mechanical |
| `clippy::result_unit_err` | `src/cloud_transport/sanitize.rs:81` | allow (contract) |
| `clippy::let_unit_value` | `src/local_ssh/connect.rs:655` | mechanical |
| `clippy::large_enum_variant` | `src/vault/mod.rs:227` | allow (security shape) |
| `clippy::borrow_deref_ref` | `src/vault_os_sleep.rs:123` | mechanical |
| `clippy::borrow_deref_ref` | `src/vault_os_sleep.rs:129` | mechanical |

### Lib test — additional (22 total with lib overlap)

| Lint | Path | Kind |
|------|------|------|
| `dead_code` struct | `src/local_ssh/connect.rs:434` `NativeTofuConfirmer` | allow (native surface) |
| `dead_code` struct | `src/local_ssh/connect.rs:456` `FsLocalKnownHosts` | allow (native surface) |
| `dead_code` associated items | `src/local_ssh/connect.rs:461` | allow (native surface) |
| `dead_code` method | `src/local_ssh/connect.rs:712` `close_handle` | allow (API surface) |
| `dead_code` struct | `src/local_ssh/connect.rs:942` `BridgeHostKeyWriter` | allow (native surface) |
| `dead_code` associated fn | `src/local_ssh/connect.rs:953` `new` | allow (native surface) |
| `dead_code` fields | `src/local_ssh/session.rs:102` `auth_epoch`, `server_id` | allow (barrier snapshot) |
| `clippy::needless_borrow` | `src/auth/tests.rs:183` | mechanical |
| `clippy::too_many_arguments` | `src/local_ssh/connect.rs:1745` test `handshake_deps` | allow (test fixture) |
| `clippy::large_enum_variant` | `src/vault/mod.rs:227` (test crate) | same allow |
| `clippy::field_reassign_with_default` | `src/vault/mod.rs:1566` | mechanical |

## Fixes and allow rationale

### Mechanical

| Path | Fix |
|------|-----|
| `auth/pkce.rs` | `(len + 2) / 3 * 4` → `len.div_ceil(3) * 4` |
| `auth/session.rs` | Manual `Default` for `AuthMemory` → `#[derive(Default)]` |
| `auth/mod.rs` | Merged identical `if` / `else if` branches into one allowlist condition |
| `cloud_transport/sanitize.rs` | `.iter().any(...)` → `.contains(&normalized.as_str())` |
| `local_ssh/connect.rs` | Dropped `let _ =` around unit `block_on` |
| `vault_os_sleep.rs` | `Some(&*NS…)` → `Some(NS…)` (remove needless deref) |
| `auth/tests.rs` | Removed needless `&` before `extract_query_param` arg |
| `vault/mod.rs` `production_argon2_config` | Struct update `Config { …, ..Default::default() }` |

### Narrow item-level allows (contracts / security / staged surface)

| Item | Allow | Reason (concise) |
|------|-------|------------------|
| `SessionLifecycleHooks` unit-err methods | `clippy::result_unit_err` | Secret-free fail-closed; callers map to fixed public codes |
| `sanitize_response_json` / parse | `clippy::result_unit_err` | Unit err maps to `InvalidResponse`; no body leakage |
| `VaultInner` | `clippy::large_enum_variant` | Do not box secret-bearing unlocked state |
| `NativeTofuConfirmer`, `FsLocalKnownHosts`, methods, `BridgeHostKeyWriter::new` | `dead_code` | Committed native integration surface not yet fully wired |
| `HandshakeResult::close_handle` | `dead_code` | Public convenience; transport uses `into_transport_parts` |
| `TicketBarrierSnapshot::{auth_epoch,server_id}` | `dead_code` | Snapshot fields for barrier completeness; revalidation uses gen epochs today |
| test `handshake_deps` | `clippy::too_many_arguments` | Mirrors production `HandshakeDeps` field set |

**Not done:** dependency changes; boxing vault unlocked state; redesigning unit-error lifecycle/sanitize contracts; removing production-ready native adapters.

## GREEN evidence

```text
$ cargo +1.92.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in ~3–10s
exit: 0
(zero warnings under -D warnings)
```

### Coordinator independent verification

| Command | Result |
|---------|--------|
| `cargo +1.92.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | **exit 0**, zero warnings |
| `cargo +1.92.0 test --manifest-path src-tauri/Cargo.toml --all-targets` | **297** passed, **1** ignored, **143.57s** |
| `cargo +1.92.0 build --manifest-path src-tauri/Cargo.toml --release` | **exit 0**, **20.74s** |
| `git diff --check` | **clean** |

## Required gates (fresh this dispatch)

| Command | Result |
|---------|--------|
| `cargo +1.92.0 fmt --manifest-path src-tauri/Cargo.toml -- --check` | **ok** |
| `cargo +1.92.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | **exit 0**, zero warnings |
| `cargo +1.92.0 test --manifest-path src-tauri/Cargo.toml --all-targets` | **297** passed, **1** ignored, **147.53s** |
| `npm test` | **43** passed (7 files) |
| `npm run contracts:check` | **ok** |
| `npm run build:web` | **ok** |
| `cargo +1.92.0 build --manifest-path src-tauri/Cargo.toml --release` | **ok** (~19.5s) |
| `git diff --check` | **clean** |

### Status (path summary)

```
 M src-tauri/src/auth/{mod,pkce,session,tests}.rs
 M src-tauri/src/cloud_transport/{lifecycle,sanitize}.rs
 M src-tauri/src/local_ssh/{connect,session}.rs
 M src-tauri/src/vault/mod.rs
 M src-tauri/src/vault_os_sleep.rs
?? docs/task-clippy-baseline-evidence.md
```

### Secret / literal scan

Diff is mechanical allows + style only. No new secrets, PEMs, host fingerprints, or credentials introduced. Pre-existing auth/vault secret-handling comments/fields unchanged in meaning.

## Explicit non-claims

- No dependency adds/removes/upgrades  
- No product behavior or security redesign  
- No website / workflows / licensing / bundle / schema / Compose changes  
- No commit / push  
- Dead-code allows retain intentional staged native surfaces (not claimed “all dead code deleted”)  

## Files modified

- `src-tauri/src/auth/pkce.rs`
- `src-tauri/src/auth/session.rs`
- `src-tauri/src/auth/mod.rs`
- `src-tauri/src/auth/tests.rs`
- `src-tauri/src/cloud_transport/lifecycle.rs`
- `src-tauri/src/cloud_transport/sanitize.rs`
- `src-tauri/src/local_ssh/connect.rs`
- `src-tauri/src/local_ssh/session.rs`
- `src-tauri/src/vault/mod.rs`
- `src-tauri/src/vault_os_sleep.rs`
- `docs/task-clippy-baseline-evidence.md`
