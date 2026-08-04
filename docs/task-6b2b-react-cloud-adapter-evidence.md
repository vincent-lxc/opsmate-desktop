# Task 6B2B Evidence — React allowlisted cloud adapter

**Date:** 2026-08-04
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`
**HEAD base:** `02c422b` (`feat/secure-desktop-foundation`)
**Task / dispatch:** `task_2b2775151c73` / `ctx_3c4babd64a33` (JSON-validation correctness cleanup)
**Prior:** review rework `task_3ace10df9b39` / `ctx_32500054e1a5`
**Worker:** no commit / no push / no business UI integration

## Scope (this cleanup)

| Path | Role |
|------|------|
| `src/cloud/invoke-operation.ts` | Recursion-stack cycle detection; try/catch on `isJsonObject` |
| `src/cloud/__tests__/invoke-operation.test.ts` | Shared-ref, cycles, throwing getter/proxy, `@ts-expect-error` guard |
| `docs/task-6b2b-react-cloud-adapter-evidence.md` | This document |

**Unchanged this pass:** `types.ts`, `generated-operations.ts`, generator, contract JSON, UI, Rust.

## Review findings (all closed)

### Prior rework
1. **Typed signature** — `invokeOperation(operationId: IpcCallableOperationId, input?: JsonObject)` only; runtime unknown uses explicit cast.
2. **Error code whitelist** — exact Rust public codes only; other strings → `transport` without echo.
3. **No public mutable Set** — private membership; exported `Object.freeze([... ] as const)`.
4. **JSON input** — recursive plain-object validation; no log/stringify of input.
5. **Single type source** — `typeof IPC_CALLABLE_OPERATION_IDS[number]`; no Union alias.
6. **Events** — `session-invalidated`, payload ignored, unlisten returned.

### JSON-validation correctness (this task)
1. **Recursion stack, not permanent WeakSet** — add before descending, `delete` in `finally` on all exit paths. Shared acyclic sibling references pass; true cycles fail.
2. **Exception-safe `isJsonObject`** — wraps validation in `try/catch`; throwing getters / `getPrototypeOf` proxies return `false` → `CloudInvokeError` `invalid_input`, zero invoke (never raw throw).
3. **Focused tests** — shared object accepted + one invoke; direct/indirect cycles rejected; throwing getter + throwing-proto proxy → `invalid_input` zero invoke.
4. **Compile-time guard** — unreachable block + `@ts-expect-error` on `invokeOperation("auth.config")` without cast.

## Behavior

1. Single Tauri command `cloud_call` with wire `{ args: { operationId, input } }`.
2. Compile-time + runtime allowlist (available + ipc_via_rust only).
3. Business input: plain JSON object (shared acyclic refs OK); default `{}`.
4. `CloudInvokeError` with opaque whitelisted/local codes only.
5. Source bans: no fetch/WebSocket/storage/token APIs; no console.log/debug of input.

## Verification (post-cleanup)

| Command | Result |
|---------|--------|
| `npm test` | **43** passed (15 adapter tests) |
| `npm run contracts:check` | ok |
| `npm run build:web` | ok (`tsc --noEmit` + vite; `@ts-expect-error` satisfied) |
| `rustup run 1.92.0 cargo fmt -- --check` | ok |
| `rustup run 1.92.0 cargo test` | **120** passed |
| `rustup run 1.92.0 cargo check` | Finished (no warnings) |
| `git diff --check` | clean |
| secret scan (`src/cloud/**`) | ban-list / fixture strings only |

## Explicit non-claims

- No AuthGate / session store implementation in React.
- No business page integration.
- No credentials / SSH / Stronghold UI.
- No new npm dependency.
- No commit/push by worker.
