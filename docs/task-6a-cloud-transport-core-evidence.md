# Task 6A Evidence — Native cloud transport rejection core

**Date:** 2026-08-04  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Branch HEAD base:** `5943061` (`feat/secure-desktop-foundation` WIP)  
**Worker:** no commit / no push / no interactive or network UAT

## Honesty about TDD ordering

### Prior dispatch (`task_729578be78c6` / `ctx_93164dc6babd`) — implementation-first

**Strict separate RED cargo invocation was not preserved on the first Task 6A dispatch.**

Focused rejection tests and the minimal client/sanitize/error modules were authored
in the same implementation pass. That dispatch did **not** supply a real product RED
log for the rejection core.

### This security rework (`task_6abb8f78b26e` / `ctx_0eb5d94bae55`) — first real product RED

Coordinator security review findings were encoded as **focused tests against the
then-current implementation first**. Cargo was run **before** production code changes.
All six focused tests failed with real product assertions (not compile harness noise).
Only after capturing that RED log were production fixes applied to GREEN.

**This rework is the first real product RED for Task 6A security defects.**

## Captured RED (before production fixes)

Command (harness filter on the six new tests):

```text
rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture \
  built_request_debug_redacts invoke_operation_not_public mock_http_backend_is_test_only \
  sanitizer_strips_compound reject_blank_whitespace_control_bearer \
  unauthenticated_spec_never_receives
```

**Result: 0 passed; 6 failed** (exact panics):

| Test | Real failure |
|------|----------------|
| `built_request_debug_redacts_authorization_and_body` | Debug contained `Bearer SENTINEL_BEARER_SECRET_9f3a` and body password sentinel |
| `invoke_operation_not_public_bypass_surface` | `pub fn invoke_operation` present (NativeOnly bypass risk via `ipc_path=false`) |
| `mock_http_backend_is_test_only_not_production_export` | `MockHttpBackend` not `cfg(test)` |
| `sanitizer_strips_compound_camel_secrets_preserves_safe_fields` | Did not strip `logtoAdminEndpoint` (and other compound/camel variants) |
| `reject_blank_whitespace_control_bearer_zero_outbound` | Blank bearer `""` returned `Ok` (transport would proceed) |
| `unauthenticated_spec_never_receives_authorization_header` | `AuthConfig` built with `Authorization: Bearer SENTINEL_…` when bearer provided |

## Coordinator findings → fixes

1. **BuiltRequest Debug / Clone** — custom `Debug` redacts `Authorization` values and entire `body`; `Clone` only via `#[cfg_attr(test, derive(Clone))]`.
2. **NativeOnly bypass** — removed public `invoke_operation` and `ipc_path: bool`. Sole business entry is `invoke_ipc` (always Available + IpcViaRust). Auth native-only remains in the auth module.
3. **MockHttpBackend** — struct + impl gated `#[cfg(test)]`; not re-exported from `mod.rs`. Production keeps `HttpBackend` + `BuiltRequest` for Task 6B.
4. **Sanitizer** — exact match on separator-normalized lowercase keys; expanded set includes compound/camel secrets (`logtoAdminEndpoint`, `sshKeyPassphrase`, `privateKeyPem`, `accessToken`, `currentPassword`, …). Preserves `token_usage`, `password_policy`, `private_key_status`, ordinary `endpoint`.
5. **Bearer fail-closed** — authenticated ops require trimmed nonempty bearer with no surrounding/internal whitespace or control chars; reject → `Unauthenticated`, `request_count == 0`. Unauthenticated specs never attach `Authorization` even if a bearer is passed into `build_request`.

## Scope (owned files only)

| Path | Role |
|------|------|
| `src-tauri/src/cloud_transport/error.rs` | Fixed `TransportError` codes + `map_transport_public` |
| `src-tauri/src/cloud_transport/sanitize.rs` | Recursive secret/internal field strip |
| `src-tauri/src/cloud_transport/client.rs` | `invoke_ipc` / `build_request` / `HttpBackend` / test mock |
| `src-tauri/src/cloud_transport/tests.rs` | Rejection + security rework matrix |
| `src-tauri/src/cloud_transport/mod.rs` | Module wiring + production re-exports only |
| `docs/task-6a-cloud-transport-core-evidence.md` | This document |

**Not modified:** React, `lib.rs`, auth modules, capabilities, Cargo deps,
contracts JSON/OpenAPI/generated `operations.rs`, vault/SSH, 401 lifecycle.

## Security behavior (current)

1. **Operation gate** — `from_id` + `Available` + `IpcViaRust` via `invoke_ipc` only.
2. **Caller surface** — operation id + JSON business object only.
3. **URL build** — exact `BASE_ORIGIN` `https://app.itops.sh`; allowlisted path/query/body.
4. **Smuggling** — path rejects traversal/encoded variants before transport.
5. **Encoding** — path percent-encoded after validation; sorted query; fixed body Rust-owned.
6. **HTTP boundary** — sync `HttpBackend`; mock is test-only; rejects stay zero-outbound.
7. **Sanitizer** — recursive exact normalized secret keys; safe business fields kept.
8. **Public errors** — fixed codes only; no URL/path/body echo.
9. **No open proxy** — no arbitrary URL/method IPC.
10. **Debug safety** — `BuiltRequest` never prints bearer or body secrets.

## Verification (security rework GREEN)

```bash
cd /Users/vincent/Documents/ClaudeCode/opsmate-desktop
rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml cloud_transport
rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml
npm run contracts:check
git diff --check
# secret scan excluding target/node_modules/locks
```

### Exact counts (this rework final run)

| Command | Result |
|---------|--------|
| Focused RED (six tests, pre-fix) | **0** passed; **6** failed |
| `rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml cloud_transport` | **35** passed; 0 failed |
| `rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml` | **77** lib tests passed; 0 failed |
| `npm run contracts:check` | ok |
| `git diff --check` | clean |
| secret scan (excl. `target/`, `node_modules/`, locks) | one hit only: sanitizer **test fixture** string `-----BEGIN PRIVATE KEY-----` in `tests.rs` (not a real key material) |

## Explicit non-claims

- **No interactive / network UAT** against real `app.itops.sh`.
- **No production reqwest wiring** for business ops in this node (mock `HttpBackend` only).
- **No 401 lifecycle** / session reauth (later task).
- **No React IPC command** registration in `lib.rs` (out of scope).
- **No commit/push** by worker (coordinator owns commits).
- **Prior dispatch was implementation-first** (no product RED); **this rework supplied the first real product RED** then GREEN.
