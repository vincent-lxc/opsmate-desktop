# Task 6B1 Evidence — Async HTTPS + 401 lifecycle core

**Date:** 2026-08-04  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Start HEAD:** `5093f32` (`feat/secure-desktop-foundation`)  
**Task / dispatch:** `task_437252123bfe` / `ctx_ff27f4389c9c`  
**Worker:** no commit / no push / no network or interactive UAT

## Strict TDD — real product RED first

### Step 1: focused tests against then-current 6A-only tree

Three contract tests were added **before** any production 6B1 modules:

- `six_b1_error_codes_session_http_size_cancel_present`
- `six_b1_http_backend_is_async_owned_request`
- `six_b1_http_and_lifecycle_modules_exist`

### Step 2: captured RED (exact)

```text
rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture six_b1_
```

**Result: 0 passed; 3 failed**

| Test | Panic |
|------|--------|
| `six_b1_error_codes_session_http_size_cancel_present` | missing `SessionInvalidated` in `error.rs` |
| `six_b1_http_backend_is_async_owned_request` | still had `fn execute(&self, request: &BuiltRequest)` |
| `six_b1_http_and_lifecycle_modules_exist` | `src/cloud_transport/http.rs` did not exist |

Only after this RED log were production files authored.

## What landed (owned scope only) — historical first dispatch

> **Note:** The narrative below describes the **original 6B1 dispatch**. Subsequent
> coordinator-review reworks superseded parts of the implementation (e.g. cancellation
> is **not** Notify anymore; Cargo.toml and the operations generator **have** been
> modified in later reworks). Original RED evidence above is preserved.

| Path | Role |
|------|------|
| `src-tauri/src/cloud_transport/error.rs` | + `HttpStatus`, `ResponseTooLarge`, `Cancelled`, `SessionInvalidated` |
| `src-tauri/src/cloud_transport/client.rs` | Async RPITIT `HttpBackend` (owned `BuiltRequest`); `CloudTransport::invoke_ipc`; cancel race; 401 handle; test mock |
| `src-tauri/src/cloud_transport/http.rs` | `ReqwestBackend` rustls, redirects none, timeouts, origin revalidate, body size cap via `chunk()` |
| `src-tauri/src/cloud_transport/lifecycle.rs` | `SessionLifecycleHooks`, `InvalidationControl`, test `SpyLifecycleHooks` |
| `src-tauri/src/cloud_transport/mod.rs` | Module wiring + re-exports (no mock export) |
| `src-tauri/src/cloud_transport/tests.rs` | 6A suite async + 6B1 behavioral matrix |
| `docs/task-6b1-cloud-http-401-evidence.md` | This document |

**Original dispatch claimed not to modify** React, `lib.rs`, auth, capabilities,
contracts/generated operations, vault/SSH product modules, or add crates. Later
reworks **did** touch `Cargo.toml` (tokio `sync`) and the operations generator
(`rustfmt_skip`) as required for review fixes — see rework sections below.

## Security behavior — historical first dispatch (superseded in part)

1. **Async without async-trait** — `HttpBackend::execute` returns `impl Future + Send` (RPITIT); `BuiltRequest` moved into backend in production path.
2. **ReqwestBackend** — pinned rustls client, `redirect::Policy::none()`, connect 10s / request 30s, no caller URL/method/headers; status + raw body bytes; **no logging**.
3. **Origin guard** — `validate_fixed_origin_url` before send and on final `response.url()` (scheme https, host `app.itops.sh`, no explicit port, path `/api/...`).
4. **Size limit** — `MAX_RESPONSE_BYTES` = 2 MiB; Content-Length pre-check + chunked accumulate; oversize → `response_too_large`.
5. **Cancellation (first dispatch)** — used generation + **`Notify`** (superseded by **watch** in coordinator-review rework).
6. **401 lifecycle (once per session epoch)** order: cancel → `mark_reauth_required_and_clear_auth` → `close_all_ssh` → `lock_vault` → `emit_session_invalidated` → `session_invalidated`. Concurrent 401s dedupe; `begin_session_epoch` allows a new cycle. Hooks are spies (Task 8 not wired); **no claim of real SSH/vault closure**.
7. **Non-401 non-2xx** → fixed `http_status` (no status/body echo). Sanitize only after 2xx success.
8. **Reject / cancel** — zero start or zero completion as asserted; Debug redacts bearer/body.

## Verification (GREEN)

```bash
cd /Users/vincent/Documents/ClaudeCode/opsmate-desktop
rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml cloud_transport
rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml
npm run contracts:check
git diff --check
# secret scan excluding target/node_modules/locks
```

### Exact counts

| Command | Result |
|---------|--------|
| Focused RED (`six_b1_` pre-impl) | **0** passed; **3** failed |
| `cargo test … cloud_transport` | **47** passed; 0 failed |
| `cargo test …` (full lib) | **89** passed; 0 failed |
| `npm run contracts:check` | ok |
| `git diff --check` | clean |
| secret scan | fixture-only: `-----BEGIN PRIVATE KEY-----` string in sanitizer test (not real key material) |

## Explicit non-claims

- **No network / interactive UAT** against real `app.itops.sh`.
- **No WebView command / React adapter** (Task 6B2).
- **No real SSH close or vault lock** — hooks are interfaces + spies only.
- **No 401 → auth module wiring** yet (mark_reauth is a hook callback).
- **No commit/push** by worker.

---

## Coordinator-review rework (`task_c4371947a065` / `ctx_ddadc72cae44`)

**Strict TDD for this rework:** eight focused `review_*` tests were added against the
then-current 6B1 production code **before** fixes. Real product RED was captured,
then minimum fixes applied, then full verification.

### Captured RED (pre-fix)

```text
rtk rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture review_
```

**Result: 2 passed; 6 failed**

| Test | Failure (current production behavior) |
|------|----------------------------------------|
| `review_cancel_before_waiter_polling_is_observed` | ok (initial is_cancelled check) |
| `review_concurrent_wait_cancel_cycles_bounded` | ok (not always flaky) |
| `review_cancellation_uses_durable_watch_not_notify_race` | used `Notify` / no watch / no tokio `sync` feature |
| `review_begin_session_epoch_serialized_with_lifecycle` | `begin_session_epoch` completed while old 401 held hooks |
| `review_status_body_read_policy_2xx_only` | missing `should_read_response_body` |
| `review_non_2xx_skips_body_so_oversize_401_cannot_bypass` | always `read_body_limited` after status |
| `review_validate_fixed_origin_rejects_fragments` | `#frag` accepted |
| `review_noop_lifecycle_is_test_only_not_production_default` | `H = NoopLifecycleHooks` production default |

### Fixes applied

1. **Cancellation** — `InvalidationControl` uses `tokio::sync::watch` generation channel (durable observed state). Cargo.toml enables tokio `sync`. No `Notify` / `notify_waiters` / `notified()`.
2. **Epoch vs lifecycle** — `begin_session_epoch` and `run_401_lifecycle_once` share `lifecycle_lock`; deterministic blocking-hook concurrency test.
3. **Body policy** — `should_read_response_body` (2xx only); non-2xx returns empty body without buffering (401 cannot become `response_too_large`).
4. **Fragments** — `validate_fixed_origin_url` rejects `#` / parsed fragment.
5. **No silent no-op 401** — `NoopLifecycleHooks` + `with_backend` are `cfg(test)` only; production `CloudTransport<B, H>` requires explicit hooks; not re-exported from `mod.rs` in production.
6. **fmt** — generator emits `#![cfg_attr(rustfmt, rustfmt_skip)]` so generated `operations.rs` does not fight `cargo fmt --check` / `contracts:check`.

### GREEN counts (this rework)

| Command | Result |
|---------|--------|
| Focused RED (`review_`) | **2** passed; **6** failed |
| `cargo fmt -- --check` | ok |
| `cargo test … cloud_transport` | **55** passed; 0 failed |
| `cargo test …` (full lib) | **97** passed; 0 failed |
| `npm run contracts:check` | ok |
| `git diff --check` | clean |
| secret scan (excl. target/node_modules/locks) | fixture-only PEM string in tests |

### Files touched (rework)

- `src-tauri/src/cloud_transport/lifecycle.rs`
- `src-tauri/src/cloud_transport/http.rs`
- `src-tauri/src/cloud_transport/client.rs`
- `src-tauri/src/cloud_transport/mod.rs`
- `src-tauri/src/cloud_transport/tests.rs`
- `src-tauri/Cargo.toml` (tokio `sync`)
- `scripts/generate-operations.mjs` + regenerated `operations.rs` / openapi (rustfmt skip only)
- `docs/task-6b1-cloud-http-401-evidence.md` (this section)

### Remaining non-claims (unchanged)

- No network/interactive UAT; no React/`lib.rs`/real vault/SSH; no commit/push; hooks remain spies until Task 8 / 6B2.

---

## Final coordinator rework (`task_0fb88502fad9` / `ctx_971cfe694fb2`)

**Strict TDD:** three focused `final_*` tests against then-current code, then minimal fix.

### Captured RED (pre-fix)

```text
rtk rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture final_
```

**Result: 0 passed; 3 failed**

| Test | Failure |
|------|---------|
| `final_check_content_length_no_u64_truncation` | compared via `len as usize` (truncation hazard) |
| `final_reqwest_backend_no_panicking_default` | `impl Default for ReqwestBackend` with `.expect(...)` |
| `final_should_read_response_body_not_public_reexport` | re-exported from `mod.rs`; was unrestricted `pub fn` |

### Fixes

1. **`check_content_length`** — compare `len: u64` to `max as u64` (widening only); never cast Content-Length to `usize` first. Tests: exact max ok, max+1 reject, `u64::MAX` reject.
2. **Removed `Default` for `ReqwestBackend`** — only fallible `new() -> Result<_, TransportError>`.
3. **`should_read_response_body`** — `pub(super)` only; removed from `mod.rs` public re-exports; behavioral matrix kept via sibling tests.
4. **Docs** — labeled original pre-review narrative as historical/superseded (Notify → watch; later Cargo.toml/generator edits) without erasing original RED tables.

### Current cancellation (post all reworks)

Uses **`tokio::sync::watch`** generation channel (not Notify). `Cargo.toml` enables tokio feature `sync`.

### GREEN counts (this final rework)

| Command | Result |
|---------|--------|
| Focused RED (`final_`) | **0** passed; **3** failed |
| `cargo fmt -- --check` | ok |
| `cargo test … final_` | **3** passed |
| `cargo test … cloud_transport` | **58** passed; 0 failed |
| `cargo test …` (full lib) | **100** passed; 0 failed |
| `cargo check` | ok |
| `npm test` | **28** passed |
| `npm run contracts:check` | ok |
| `npm run build:web` | ok |
| `git diff --check` | clean |
| secret scan | fixture-only PEM string in tests/docs |

### Files touched (final rework only)

- `src-tauri/src/cloud_transport/http.rs`
- `src-tauri/src/cloud_transport/mod.rs`
- `src-tauri/src/cloud_transport/tests.rs`
- `docs/task-6b1-cloud-http-401-evidence.md`
