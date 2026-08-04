# Task 5 Evidence — Rust-only Logto session

**Date:** 2026-08-04  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Branch:** `feat/secure-desktop-foundation`  
**Dispatch ownership:** `ops-ai/.worktrees/feat/desktop-local-credentials`  
**Worker:** no commit / no push / no interactive Logto UAT

## Honesty about TDD ordering (first dispatch)

**Strict RED-first ordering was not preserved on the first Task 5 dispatch.**

The first worker wrote production implementation modules and tests in the same
pass (implementation-shaped code landed before an isolated RED suite was
recorded). Intermediate failures observed on that dispatch were mostly
**test harness false positives**, not intentional RED-before-GREEN product
gaps:

| Failure | Cause |
|---------|--------|
| `auth_public_command_allowlist_only_three_named_commands` | banned substring `open_url` matched `BrowserOpener::open_url` |
| `auth_source_forbids_spa_token_sync_eval_and_storage` | tests.rs / module docs contained forbid names under assertion |
| `npm run build:web` TS2307 | native-auth tests used `node:fs` without `@types/node` |

That first `worker_done` was **rejected by the coordinator** for security review items below. This document covers the **security rework dispatch** that fixed those items with tests.

## Product contract (after rework)

| Rule | Implementation |
|------|----------------|
| Rust owns PKCE verifier, state, code, bearer, subject/tenant/workspace | `AuthStore` + `PendingPkce` + `NativeSession` |
| **Exact Logto IdP origin** | **only** exact `https://auth.itops.sh` or `https://auth.itops.sh/` after surrounding whitespace trim. Rejects multi-slash (`//`/`///`), other hosts, userinfo, port, query, fragment, non-root path |
| Authorize URL host | always `https://auth.itops.sh/oidc/auth?...` |
| Backend origin | fixed `https://app.itops.sh` |
| Logto `redirect_uri` | exact `https://app.itops.sh/login/desktop/callback` |
| Deep link | OS → Rust `opsmate://auth/callback` (never Logto redirect_uri); **never logged raw** |
| System browser | `tauri-plugin-opener` from Rust only |
| Token / verifier storage | `Zeroizing<String>` on session token and pending verifier |
| Exchange boundary | `ExchangeRequest` + `post_exchange`; no `serde_json::Value` owning verifier; MockHttp records lengths only |
| IPC errors | fixed codes via `map_auth_public` — never raw HTTP/IdP/callback/token text |
| Pending timeout | wall-clock `expires_at` + generation-guarded timer (`arm_pending_timeout`) |
| Principal | required nonempty `subject` + `tenant_id` + token/username/role before install; invalid principal ⇒ `authenticated: false` |
| React surface | `SessionStatus`: `authenticated`, `username?`, `role?`, `reauthRequired` |
| Public IPC | only `auth_begin_logto`, `auth_session_status`, `auth_logout` |
| No SPA sync | no SpaSessionSync / eval / browser token storage |
| `auth.config` / `auth.exchange` | remain `native_only` |

## Coordinator security rework (this dispatch)

1. **Exact IdP origin** — `validate_logto_endpoint` + authorize always on `auth.itops.sh`.
2. **IPC error sanitization** — unit `AuthError` variants; `map_auth` → `map_auth_public` fixed codes; secret-bearing mapping test.
3. **PKCE temporary copies** — `ExchangeRequest` with `Zeroizing` fields; manual JSON bytes; MockHttp does not retain verifier; Debug redacts.
4. **Real wall-clock timeout** — `PendingPkce.expires_at` + `expire_due_pending` + generation-guarded `clear_pending_if_generation` / `arm_pending_timeout`; deterministic tests without long sleeps.
5. **Principal validation** — required `tenant_id: String`; reject blank fields; SessionStatus not authenticated if principal invalid.
6. **Honest evidence** — this section (no claim of strict RED-first on first dispatch).
7. **Capability / IPC review** — WebView still `core:default` only; three named auth commands.

### Transient TLS serialization (honest)

Wire JSON for exchange is built into a `Zeroizing<Vec<u8>>` then moved into reqwest as an ordinary `Vec` for the async send. That Vec is not retained after the request returns. **We cannot wipe TLS stack / kernel buffers or reqwest internal copies** of the request body; that residual is an accepted OS-level limitation and is not logged.

## Dependency rationale (minimum set)

| Crate | Version | Why |
|-------|---------|-----|
| `tauri-plugin-opener` | 2.5.4 | System browser; **not** granted to WebView |
| `tauri-plugin-deep-link` | 2.4.9 | `opsmate://` delivery to Rust; **not** granted to WebView |
| `sha2` | 0.10.8 | PKCE S256 |
| `zeroize` | 1.9.0 | Wipe token / verifier buffers |
| `reqwest` | 0.12.15 (`rustls-tls`, `json` off for exchange body path) | Config GET + exchange POST |
| `tokio` | 1.44.2 | Blocking wrapper for reqwest |
| `thiserror` | 1.0.69 | Fixed-code AuthError |

Forbidden: direct `open` crate; WebView `opener:` / `deep-link:` / `shell:` capabilities.

## Files

```
src-tauri/src/auth/mod.rs
src-tauri/src/auth/pkce.rs
src-tauri/src/auth/session.rs
src-tauri/src/auth/http.rs
src-tauri/src/auth/tests.rs
src-tauri/src/lib.rs
src-tauri/Cargo.toml
src-tauri/Cargo.lock
src-tauri/tauri.conf.json
src-tauri/capabilities/default.json
src/auth/native-auth.ts
src/auth/__tests__/native-auth.test.ts
docs/task-5-rust-only-logto-evidence.md
```

## Pending cleanup matrix

| Event | Pending cleared? |
|-------|------------------|
| Success exchange | yes (consumed) |
| Valid-state OAuth error | yes |
| Exchange HTTP/parse error | yes (consumed before POST) |
| Wrong-state callback | **no** (preserved) |
| Logout | yes |
| New login | yes (replaced) |
| Wall-clock expiry / timer | yes (generation-guarded) |

## Verification (security rework)

```bash
cd /Users/vincent/Documents/ClaudeCode/opsmate-desktop
rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml auth
rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml
npm test -- native-auth
npm test
npm run build:web
npm run contracts:check
git diff --check
```

### Exact counts (security rework final run)

| Command | Result |
|---------|--------|
| `rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml auth` | **36** passed (superseded by timer rework) |
| `rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml` | **48** lib tests passed (superseded) |

### Timer rework dispatch (`task_b65b695788a3` / `ctx_79eae5dfa056`)

Coordinator rejected the security rework timer path because:

1. Tests only called `expire_due_pending` / `clear_pending_if_generation` — did not prove production timer fires.
2. `arm_pending_timeout` used one blocking OS thread per login (`std::thread` + sleep), ignored spawn failure, and accumulated threads under repeated `auth_begin_logto`.
3. Exact origin tests omitted explicit `:443` (Url hides default ports).
4. `map_auth` test used over-broad exception OR logic.

**Fixes:**

- Tokio async timer via ambient handle or a **single shared** 1-worker timer runtime (no OS thread per login); generation guard unchanged.
- Real short-duration `#[tokio::test]` cases: `auth_real_async_timer_clears_pending`, `auth_real_async_timer_old_generation_does_not_clear_replacement` — arm production `arm_pending_timeout`, await, assert without helper clear.
- Strict endpoint equality rejects `https://auth.itops.sh:443`.
- IPC error test = exact allowlist + forbidden substrings only.
- Exchange installs session by **moving** `token` into `Zeroizing` (no clone on success path).
- `tokio` feature `time` added.

### Exact counts (timer rework final run)

| Command | Result |
|---------|--------|
| `rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml auth` | **37** passed |
| `rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml` | **49** lib tests passed |
| `npm test -- native-auth` | **5** passed |
| `npm test` | **28** passed |
| `npm run build:web` | exit 0 |
| `npm run contracts:check` | ok |
| `git diff --check` | clean |

### Coordinator final review rejection (`task_d9e3e0df79d8` / `ctx_e26799aaa5d1`)

Coordinator independently re-ran tests and rejected two remaining correctness/evidence defects:

1. **`validate_logto_endpoint` over-accepted multi-slash paths** — `trim_end_matches('/')` made `https://auth.itops.sh///` (and `//`, etc.) pass. Required: after surrounding-whitespace trim only, accept **exactly** `https://auth.itops.sh` and `https://auth.itops.sh/`; reject all other variants including multi-slash.
2. **`perform_handle_deep_link` cloned PKCE verifier** — comment claimed a move of `PendingPkce.code_verifier`, but implementation used `as_str().to_string()` into a new `Zeroizing`. Required: move the `Zeroizing<String>` wrapper without cloning/copying secret text (e.g. `mem::take` before pending drops), preserve zeroization.

**Fixes (this dispatch, scope-limited):**

- Endpoint: exact two-string allowlist after `trim()` (no multi-slash strip). Test: `auth_logto_endpoint_rejects_multiple_trailing_slashes`.
- Deep link: `let mut pending = …take()` then `std::mem::take(&mut pending.code_verifier)` so the original `Zeroizing` moves; Drop still zeroizes the empty residual + state. Source evidence: `auth_deep_link_moves_code_verifier_without_secret_clone`.
- Async timer path **unchanged** (not required by these edits).

### Exact counts (final review fix run — current)

| Command | Result |
|---------|--------|
| `rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml auth` | **39** passed; 0 failed; 12 filtered out (lib) |
| `rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml` | **51** lib tests passed; 0 failed |
| `npm test -- native-auth` | **5** passed |
| `npm test` | **28** passed |
| `npm run build:web` | exit 0 |
| `npm run contracts:check` | ok |
| `git diff --check` | clean |
| secret scan (excl. `target/`, `node_modules/`, locks) | no matches |

## Explicit non-claims

- **No interactive Logto UAT** (system browser + IdP) — remains later.
- **No Stronghold session persistence** — in-memory `AuthStore`.
- **No cloud_transport HTTPS client** for business ops yet (Task 6).
- **No commit/push** by worker.
- **Did not claim strict RED-first** for the first Task 5 dispatch (see above).
- **No interactive UAT claim** for this final-review fix dispatch either.
