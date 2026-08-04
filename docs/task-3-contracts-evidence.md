# Task 3 Contracts Evidence (native-only auth boundary)

**Date:** 2026-08-04  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Dispatch ownership:** `ops-ai/.worktrees/feat/desktop-local-credentials`  
**Tasks:** 3 / 3 corrections / **3D native-only auth invocation**  
**Worker:** no commit/push

## 3D correction — invocation authority + PKCE ownership

Design (§1.5 independent desktop repo): `auth_begin_logto` is an empty IPC
command; Rust generates/stores PKCE verifier+state; OS deep-link delivers
`code` to Rust; Logto exchange has **no** IPC that hands code/verifier/token to
React.

### What was wrong before

Contract/tests/OpenAPI treated `code` and `codeVerifier` as if they were
caller-controlled WebView body fields for `auth.exchange`.

### What is true now

| Concern | Contract model |
|---------|----------------|
| Who initiates | Explicit `invocation: native_only \| ipc_via_rust` on **every** op |
| `auth.config` / `auth.exchange` | `native_only` → `is_ipc_callable() == false` |
| `auth.me` + business ops | `ipc_via_rust` (Rust still builds HTTP + injects auth) |
| Wire schema | `pathParams` / `queryFields` / `bodyFields` = HTTP allowlist, **not** auto WebView inputs |
| `auth.exchange` body | Wire lists `code`+`codeVerifier` as **Rust-owned** PKCE material |
| `redirectUri` | `fixedBodyFields` exact `https://app.itops.sh/login/desktop/callback` |
| IPC path | Must not accept codeVerifier, redirectUri, tokens, URL, Authorization |

### Generated helpers

```rust
pub enum Invocation { NativeOnly, IpcViaRust }
pub fn is_ipc_callable(op: Operation) -> bool // NativeOnly => false
```

Tests: `native_only_ops_are_rejected_by_ipc_callable_helper`,
`auth_exchange_native_owns_pkce_and_redirect`.

## Patrol still available (prior correction retained)

0082/0083 RLS + `registerTenantDatabasePlugin` — patrol ops remain
`availability: available`. Stale `routes/monitoring.ts` P0-3B comment is Task 4
backend docs debt.

## Verification

```bash
cd /Users/vincent/Documents/ClaudeCode/opsmate-desktop
npm run contracts:generate
npm run contracts:check
npm test
npm run build:web
rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

## Remaining risks

1. Transport/auth modules not yet implemented — contract surface and helpers only.
2. No commit/push by worker (per task instructions).

## Fresh final audit (this dispatch)

End-to-end review of the explicit invocation contract:

| Check | Result |
|-------|--------|
| Every op has `invocation: native_only \| ipc_via_rust` | Pass (generator + tests enforce) |
| `auth.config` / `auth.exchange` → `native_only` | Pass; `is_ipc_callable` false |
| `auth.me` + business + patrol → `ipc_via_rust` | Pass |
| PKCE `code`/`codeVerifier` wire-only; Rust-owned | Pass; not IPC inputs |
| `redirectUri` only via `fixedBodyFields` | Pass; exact desktop callback |
| Authorization / tokens / arbitrary URL never caller inputs | Pass (wire + IPC forbid lists) |
| Patrol tasks/records/rounds `available` under RLS 0082/0083 | Pass |
| OpenAPI `x-desktop-invocation` / `x-desktop-ipc-callable` / native ownership markers | Pass |
| Product evidence free of operational tooling notes | Pass (this doc cleaned) |

### Defect fixed this audit

Generated Rust unit tests for `ipc_via_rust` ops previously omitted an explicit ban on wire field `code` (and a few related redirect/token/URL names). Generator validation already rejected them at codegen time; the in-Rust assertions are now aligned.

## Files touched (Task 3 + this audit)

```
contracts/CHANGELOG.md
contracts/desktop-operations.json
contracts/openapi-v1.yaml
docs/task-3-contracts-evidence.md
package.json
scripts/generate-operations.mjs
src-tauri/src/cloud_transport/mod.rs
src-tauri/src/cloud_transport/operations.rs
src-tauri/src/lib.rs
tests/security/contracts.test.ts
vite.config.ts
```
