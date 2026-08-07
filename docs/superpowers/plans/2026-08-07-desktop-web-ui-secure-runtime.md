# OpsMate Desktop Web UI Secure Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a signed and notarized macOS desktop client that renders the existing OpsMate Web Admin UI while Rust exclusively owns authentication tokens, cloud transport, Stronghold secrets, SSH sessions, and privileged external navigation.

**Architecture:** `vincent-lxc/opsmate` is the canonical product source: `apps/admin` supplies the unchanged Web UI and `apps/desktop` supplies the Tauri runtime. Browser builds retain fetch/WebSocket behavior; the local Tauri build selects a typed desktop adapter that calls allowlisted Rust commands. `vincent-lxc/opsmate-desktop` becomes the public release orchestrator and builds an exact locked commit of the canonical source.

**Tech Stack:** React 19, TypeScript 5, Ant Design 6, xterm 6, Tauri 2.11, Rust 1.92, reqwest/rustls, russh 0.62.5, Stronghold 2.3.1, Vitest 4, GitHub Actions, Apple Developer ID/notarytool.

---

## Repositories and ownership

- Product repo: `/Users/vincent/Documents/ClaudeCode/ops-ai/.worktrees/cloud-develop`
  - Web UI: `apps/admin`
  - Tauri runtime: `apps/desktop`
  - Backend tenant and subscription contracts: `apps/backend`
- Release repo: `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`
  - Design/plan/evidence documents
  - Source lock and GitHub release workflow
  - No product React UI after migration

Never stage the existing product-repo `README.md` modification. Every commit below stages only the listed paths.

## File structure

### Product repo

- Create `apps/desktop/contracts/desktop-api-routes.json`: audited desktop HTTP route families and allowed methods.
- Create `apps/desktop/scripts/generate-desktop-routes.mjs`: generate matching Rust and TypeScript route catalogs.
- Create `apps/desktop/src-tauri/src/cloud_proxy/{mod.rs,routes.rs,tests.rs}`: fixed-origin native HTTP broker and 401 cutoff.
- Create `apps/desktop/src-tauri/src/security_cutoff.rs`: one lifecycle authority for auth, vault, SSH, and cloud requests.
- Create `apps/desktop/src-tauri/src/cloud_terminal.rs`: native proxy for the cloud-only terminal fallback.
- Create `apps/admin/src/desktop/cloud-api.ts`: desktop `api()` transport.
- Create `apps/admin/src/desktop/native-auth.ts`: secret-free session status and logout bridge.
- Create `apps/admin/src/desktop/external-navigation.ts`: fixed route IDs for browser handoff.
- Modify `apps/admin/src/api/client.ts`: select browser or desktop transport centrally.
- Modify `apps/admin/src/services/auth/roles.ts`: never persist or read JWT in Tauri.
- Modify `apps/admin/src/hooks/useServerTerminal.ts`: use native local/cloud terminal handles only in Tauri.
- Modify `apps/admin/src/components/TerminalAiChat.tsx`: preserve existing three-round behavior and expose explicit round status.
- Modify `apps/admin/src/pages/Login.tsx`, `Account.tsx`, `components/AccountSubscriptionPanel.tsx`, and `pages/security/CredentialsPage.tsx`: route privileged desktop actions through Rust without changing their visual layout.
- Replace the weaker main-repo auth/vault/SSH lifecycle pieces with the audited implementations from release repo commit `18bfd6b`, adapting module paths but not relaxing invariants.
- Modify `apps/desktop/src-tauri/tauri.conf.json` and capability tests: local assets only, no WebView network, no global broad Tauri surface.

### Release repo

- Create `release/source-lock.json`: exact canonical product repository and commit.
- Modify `.github/workflows/desktop-ci.yml` and `.github/workflows/desktop-release.yml`: checkout and build the locked product source.
- Modify `scripts/check-release-config.mjs` and `tests/security/release-config.test.ts`: reject local placeholder UI builds and unlocked source refs.
- Modify `README.md`: describe the repository as release orchestration, not an independent React product.
- Create `docs/uat/2026-08-07-desktop-web-ui-macos-uat.md`: evidence table for the signed DMG.

## Task 1: Make the canonical-source rule fail closed

**Files:**
- Create: `release/source-lock.json`
- Create: `scripts/read-source-lock.mjs`
- Modify: `scripts/check-release-config.mjs`
- Test: `tests/security/release-config.test.ts`

- [ ] **Step 1: Write the failing source-lock tests**

Add tests that require the release repo to name only `vincent-lxc/opsmate`, require a lowercase 40-character commit, and reject branch/tag refs:

```ts
it("requires an immutable opsmate source commit", () => {
  expect(validateSourceLock({
    repository: "vincent-lxc/opsmate",
    commit: "0123456789abcdef0123456789abcdef01234567",
  })).toEqual([]);
  expect(validateSourceLock({ repository: "vincent-lxc/opsmate", commit: "main" }))
    .toContain("release/source-lock.json commit must be a 40-character lowercase SHA");
  expect(validateSourceLock({
    repository: "attacker/fork",
    commit: "0123456789abcdef0123456789abcdef01234567",
  })).toContain("release/source-lock.json repository must be vincent-lxc/opsmate");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd /Users/vincent/Documents/ClaudeCode/opsmate-desktop && rtk npm test -- tests/security/release-config.test.ts`

Expected: FAIL because `validateSourceLock` and `release/source-lock.json` do not exist.

- [ ] **Step 3: Implement the validator and checked-in lock schema**

Add this public validator to `scripts/check-release-config.mjs`:

```js
export function validateSourceLock(lock) {
  const errors = [];
  if (lock?.repository !== "vincent-lxc/opsmate") {
    errors.push("release/source-lock.json repository must be vincent-lxc/opsmate");
  }
  if (!/^[0-9a-f]{40}$/.test(String(lock?.commit ?? ""))) {
    errors.push("release/source-lock.json commit must be a 40-character lowercase SHA");
  }
  return errors;
}
```

Create `release/source-lock.json` with the current verified product-repo commit at implementation time. Obtain it using `rtk git rev-parse HEAD` in the product repo and insert that exact output with `apply_patch`; do not use a branch name or an invented SHA.

Create `scripts/read-source-lock.mjs` to parse the file, call `validateSourceLock`, fail on any error, and print GitHub output lines `repository=<value>` and `commit=<value>`. Its tests must reject malformed JSON and additional top-level keys.

- [ ] **Step 4: Verify GREEN**

Run: `cd /Users/vincent/Documents/ClaudeCode/opsmate-desktop && rtk npm test -- tests/security/release-config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add release/source-lock.json scripts/read-source-lock.mjs scripts/check-release-config.mjs tests/security/release-config.test.ts
rtk git commit -m "feat(release): lock canonical desktop source"
```

## Task 2: Generate the desktop API route catalog

**Files:**
- Create: `apps/desktop/contracts/desktop-api-routes.json`
- Create: `apps/desktop/scripts/generate-desktop-routes.mjs`
- Create: `apps/desktop/src-tauri/src/cloud_proxy/routes.rs`
- Create: `apps/admin/src/desktop/generated-api-routes.ts`
- Test: `apps/admin/src/desktop/__tests__/generated-api-routes.test.ts`
- Test: `apps/desktop/src-tauri/src/cloud_proxy/tests.rs`

- [ ] **Step 1: Write failing route-catalog tests**

The TypeScript test must prove the catalog covers the Web UI families and rejects auth-secret routes:

```ts
expect(isDesktopApiRequestAllowed("GET", "/api/servers?page=1")).toBe(true);
expect(isDesktopApiRequestAllowed("POST", "/api/servers/srv_1/terminal/ai")).toBe(true);
expect(isDesktopApiRequestAllowed("GET", "/api/security/credentials")).toBe(true);
expect(isDesktopApiRequestAllowed("GET", "/api/monitoring/patrol-records?limit=20")).toBe(true);
expect(isDesktopApiRequestAllowed("POST", "/api/auth/logto/exchange")).toBe(false);
expect(isDesktopApiRequestAllowed("POST", "https://evil.example/api/servers")).toBe(false);
expect(isDesktopApiRequestAllowed("GET", "/api/servers/%2e%2e/auth/me")).toBe(false);
```

The Rust test must assert the same fixture corpus through `routes::match_request`.

- [ ] **Step 2: Verify RED**

Run:

```bash
cd /Users/vincent/Documents/ClaudeCode/ops-ai/.worktrees/cloud-develop/apps/admin
rtk npm test -- src/desktop/__tests__/generated-api-routes.test.ts
cd ../desktop
rtk rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml cloud_proxy::tests::route_catalog
```

Expected: both fail because the catalog and generated modules do not exist.

- [ ] **Step 3: Define route families**

The JSON catalog must contain these exact feature families and method sets:

```json
{
  "version": 1,
  "families": [
    { "prefix": "/api/dashboard/overview", "methods": ["GET"] },
    { "prefix": "/api/auth/me", "methods": ["GET", "POST", "DELETE"] },
    { "prefix": "/api/auth/telegram-widget", "methods": ["GET"] },
    { "prefix": "/api/subscription/ai", "methods": ["GET", "POST"] },
    { "prefix": "/api/servers", "methods": ["GET", "POST", "PATCH", "DELETE"] },
    { "prefix": "/api/security/credentials", "methods": ["GET", "POST", "PATCH", "DELETE"] },
    { "prefix": "/api/monitoring", "methods": ["GET", "POST", "PATCH", "DELETE"] },
    { "prefix": "/api/problems", "methods": ["GET", "POST"] },
    { "prefix": "/api/oncall/remediation-queue", "methods": ["GET", "POST"] },
    { "prefix": "/api/incident-reports", "methods": ["GET", "POST"] }
  ],
  "blocked": [
    "/api/auth/logto/config",
    "/api/auth/logto/exchange",
    "/api/auth/login",
    "/api/auth/refresh"
  ]
}
```

The generator must normalize path matching identically in Rust and TypeScript: relative `/api/` path only, no backslash, no encoded slash/backslash/dot segment, no empty dynamic segment, query parsed separately, and blocked paths checked before prefix families.

- [ ] **Step 4: Generate and verify GREEN**

Run:

```bash
cd /Users/vincent/Documents/ClaudeCode/ops-ai/.worktrees/cloud-develop
rtk node apps/desktop/scripts/generate-desktop-routes.mjs
rtk npm --prefix apps/admin test -- src/desktop/__tests__/generated-api-routes.test.ts
rtk rustup run 1.92.0 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml cloud_proxy::tests::route_catalog
```

Expected: PASS and a second generator run produces no diff.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/desktop/contracts apps/desktop/scripts apps/desktop/src-tauri/src/cloud_proxy apps/admin/src/desktop/generated-api-routes.ts apps/admin/src/desktop/__tests__/generated-api-routes.test.ts
rtk git commit -m "feat(desktop): generate cloud route allowlist"
```

## Task 3: Install the Rust-owned cloud transport and security cutoff

**Files:**
- Create: `apps/desktop/src-tauri/src/cloud_proxy/mod.rs`
- Create: `apps/desktop/src-tauri/src/security_cutoff.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Test: `apps/desktop/src-tauri/src/cloud_proxy/tests.rs`
- Reference: `opsmate-desktop/src-tauri/src/cloud_transport/*`
- Reference: `opsmate-desktop/src-tauri/src/cloud_bridge.rs`

- [ ] **Step 1: Write failing transport tests**

Cover fixed origin, native Authorization injection, body/response caps, cancellation, secret-free errors, and 401 ordering. The 401 order assertion is exact:

```rust
assert_eq!(events, vec![
    "close_all_ssh",
    "lock_vault",
    "clear_auth",
    "emit_session_invalidated",
]);
assert_eq!(public_error, "session_invalidated");
assert!(!debug_output.contains("Bearer"));
assert!(!debug_output.contains("upstream-body"));
```

- [ ] **Step 2: Verify RED**

Run: `cd /Users/vincent/Documents/ClaudeCode/ops-ai/.worktrees/cloud-develop && rtk rustup run 1.92.0 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml cloud_proxy`

Expected: FAIL because `cloud_proxy` and the unified cutoff are absent.

- [ ] **Step 3: Implement the IPC envelope and fixed public response**

Use this WebView-facing shape; do not expose upstream headers or URLs:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<serde_json::Value>,
    #[serde(default)]
    pub locale: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudResponse {
    pub status: u16,
    pub body: Option<serde_json::Value>,
}
```

Port the audited reqwest client, sanitization, lifecycle hooks, and epoch revalidation from release repo commit `18bfd6b`. Bind the new cutoff to the real main-repo vault and `LocalSshSessionManager`; remove comments or code paths that describe hollow/future SSH behavior.

- [ ] **Step 4: Register only the named command**

Add `cloud_request` to `generate_handler!` and make it call `CloudProxy::call`. It must reject unauthenticated requests before transport and must revalidate the auth epoch after the await before returning a response.

- [ ] **Step 5: Verify GREEN and full Rust regression**

Run:

```bash
rtk rustup run 1.92.0 cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
rtk rustup run 1.92.0 cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
rtk rustup run 1.92.0 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/desktop/src-tauri
rtk git commit -m "feat(desktop): proxy cloud API through Rust"
```

## Task 4: Keep the desktop JWT out of WebView storage

**Files:**
- Modify: `apps/desktop/src-tauri/src/auth.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/admin/src/desktop/native-auth.ts`
- Modify: `apps/admin/src/desktop/tauri-bridge.ts`
- Modify: `apps/admin/src/services/auth/roles.ts`
- Modify: `apps/admin/src/pages/Login.tsx`
- Test: `apps/desktop/src-tauri/src/auth_tests.rs`
- Test: `apps/admin/src/desktop/__tests__/native-auth.test.ts`
- Test: `apps/admin/src/services/auth/__tests__/roles.platform.test.ts`

- [ ] **Step 1: Write failing tests**

Rust source tests must reject `spa_write_session_script`, `opsmate_token`, and token-bearing events in production code. Admin tests must prove desktop auth status contains only:

```ts
type DesktopSessionStatus = {
  authenticated: boolean;
  username: string | null;
  role: AdminRole | null;
  mustChangePassword: boolean;
  expiresAtUnix: number | null;
  reauthRequired: boolean;
};
```

Also assert `getToken()` returns `null` in Tauri and browser behavior still reads `localStorage`.

- [ ] **Step 2: Verify RED**

Run:

```bash
rtk rustup run 1.92.0 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml auth
rtk npm --prefix apps/admin test -- src/desktop/__tests__/native-auth.test.ts src/services/auth/__tests__/roles.platform.test.ts
```

Expected: FAIL because native auth currently evaluates JavaScript that writes `opsmate_token`.

- [ ] **Step 3: Replace SPA token synchronization with secret-free state**

Port the subject-based native session from `opsmate-desktop/src-tauri/src/auth/session.rs`: require nonempty backend-verified `tenant_id` and `subject`, preserve `workspace_id` natively, and never serialize those identifiers or the bearer to WebView IPC.

Delete `TauriSpaBridge`, `spa_write_session_script`, and token localStorage writes. Emit `opsmate:auth-session` with `DesktopSessionStatus` after successful deep-link exchange; `native-auth.ts` must subscribe and call `auth_session_status` on startup.

- [ ] **Step 4: Preserve browser login unchanged**

In `roles.ts`, centralize the runtime branch:

```ts
export function getToken(): string | null {
  if (isDesktopRuntime()) return null;
  return localStorage.getItem(TOKEN_KEY);
}
```

Only role, username, locale, theme, and non-secret UI preferences may remain in desktop localStorage.

- [ ] **Step 5: Verify GREEN**

Run the focused tests above, then `rtk npm --prefix apps/admin test` and the complete Desktop Rust suite.

Expected: PASS; `rg -n "opsmate_token|spa_write_session_script" apps/desktop/src-tauri/src` returns no production matches.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/admin/src/desktop apps/admin/src/services/auth apps/admin/src/pages/Login.tsx apps/desktop/src-tauri/src/auth.rs apps/desktop/src-tauri/src/auth_tests.rs apps/desktop/src-tauri/src/lib.rs
rtk git commit -m "fix(desktop): keep session secrets native"
```

## Task 5: Switch the existing Admin `api()` to the desktop broker

**Files:**
- Create: `apps/admin/src/desktop/cloud-api.ts`
- Modify: `apps/admin/src/api/client.ts`
- Modify: `apps/admin/src/desktop/tauri-bridge.ts`
- Test: `apps/admin/src/desktop/__tests__/cloud-api.test.ts`
- Test: `apps/admin/src/api/__tests__/client.desktop.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Assert that a desktop GET invokes exactly:

```ts
expect(invoke).toHaveBeenCalledWith("cloud_request", {
  req: { method: "GET", path: "/api/servers?page=1", body: null, locale: "zh-CN" },
});
expect(fetch).not.toHaveBeenCalled();
```

Assert JSON POST parsing, 204 handling, `ApiError` mapping, 401 navigation to login, invalid `FormData` rejection, and browser fetch regression.

- [ ] **Step 2: Verify RED**

Run: `cd /Users/vincent/Documents/ClaudeCode/ops-ai/.worktrees/cloud-develop && rtk npm --prefix apps/admin test -- src/desktop/__tests__/cloud-api.test.ts src/api/__tests__/client.desktop.test.ts`

Expected: FAIL because `api()` always calls fetch.

- [ ] **Step 3: Implement the desktop transport**

```ts
export async function desktopApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = String(init.method ?? "GET").toUpperCase();
  const body = init.body == null || init.body === "" ? null : JSON.parse(String(init.body));
  const result = await desktopInvoke<CloudResponse>("cloud_request", {
    req: { method, path, body, locale: i18n.language || null },
  });
  if (result.status < 200 || result.status >= 300) {
    throw apiErrorFromDesktopResponse(result);
  }
  return result.body as T;
}
```

`api()` must branch once at its top: desktop calls `desktopApi`; browser executes the existing implementation unchanged. No page-level API rewrites are allowed.

- [ ] **Step 4: Verify GREEN and build**

Run:

```bash
rtk npm --prefix apps/admin test -- src/desktop/__tests__/cloud-api.test.ts src/api/__tests__/client.desktop.test.ts
rtk npm --prefix apps/admin test
rtk npm --prefix apps/admin run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/admin/src/api apps/admin/src/desktop
rtk git commit -m "feat(desktop): route Admin API through native broker"
```

## Task 6: Merge the Stronghold and lifecycle hardening into the canonical runtime

**Files:**
- Modify: `apps/desktop/src-tauri/src/vault.rs`
- Modify: `apps/desktop/src-tauri/src/vault_tests.rs`
- Modify: `apps/desktop/src-tauri/src/vault_idle_watchdog.rs`
- Modify: `apps/desktop/src-tauri/src/vault_lifecycle.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Reference: `opsmate-desktop/src-tauri/src/vault/*`
- Reference: `opsmate-desktop/src-tauri/src/vault_lifecycle_coordinator.rs`
- Reference: `opsmate-desktop/src-tauri/src/vault_os_sleep.rs`

- [ ] **Step 1: Add failing lifecycle and identity tests**

Require namespace `tenant_id + Logto subject + credential_id`, reject username namespaces, require app-data path without temp fallback, and assert the order `close SSH -> seal Stronghold` on logout, sleep, lock, credential deletion, and exit.

- [ ] **Step 2: Verify RED**

Run: `rtk rustup run 1.92.0 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml vault`

Expected: FAIL because the main runtime currently uses username identity and falls back to `std::env::temp_dir()`.

- [ ] **Step 3: Port audited invariants**

Use the release-repo implementations as the source of truth. Preserve these WebView DTOs exactly:

```rust
pub struct VaultImportRequest { pub credential_id: String }
pub struct VaultDeleteLocalRequest { pub credential_id: String }
pub struct VaultMetaItem {
    pub credential_id: String,
    pub fingerprint: String,
    pub device_present: bool,
}
```

Fail application setup if `app_data_dir()` or OS sleep observer registration fails. Never use a temporary vault snapshot.

- [ ] **Step 4: Verify GREEN**

Run focused vault tests, complete Rust tests, clippy, and `apps/admin/src/pages/security/__tests__/CredentialsPage.test.tsx`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/desktop/src-tauri/src/vault.rs apps/desktop/src-tauri/src/vault_tests.rs apps/desktop/src-tauri/src/vault_idle_watchdog.rs apps/desktop/src-tauri/src/vault_lifecycle.rs apps/desktop/src-tauri/src/lib.rs apps/admin/src/pages/security/CredentialsPage.tsx apps/admin/src/pages/security/__tests__/CredentialsPage.test.tsx
rtk git commit -m "fix(desktop): enforce native vault lifecycle"
```

## Task 7: Consolidate local and cloud SSH behind one desktop terminal interface

**Files:**
- Modify: `apps/desktop/src-tauri/src/ssh_ipc.rs`
- Modify: `apps/desktop/src-tauri/src/ssh_registry.rs`
- Modify: `apps/desktop/src-tauri/src/ssh_session.rs`
- Modify: `apps/desktop/src-tauri/src/ssh_transport.rs`
- Create: `apps/desktop/src-tauri/src/cloud_terminal.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/admin/src/desktop/local-ssh-bridge.ts`
- Modify: `apps/admin/src/hooks/useServerTerminal.ts`
- Test: existing Rust SSH tests and `apps/admin/src/hooks/__tests__/useServerTerminal.test.tsx`
- Reference: `opsmate-desktop/src-tauri/src/local_ssh/*`

- [ ] **Step 1: Write failing unified-terminal tests**

Cover local preference, cloud fallback only when `hasCloudSecret=true`, no WebView WebSocket in Tauri, host/port/user rejection, output-before-open buffering, session ID filtering, resize bounds, remote close, vault cutoff, and closed-session write rejection.

- [ ] **Step 2: Verify RED**

Run the focused Rust SSH tests and Admin terminal hook tests.

Expected: FAIL because desktop cloud fallback currently creates a WebSocket in WebView.

- [ ] **Step 3: Port the audited local SSH actor**

Reconcile main and release implementations in favor of release commit `18bfd6b` for ticket barriers, auth epoch revalidation, host-key confirmation, bounded actor queues, and exact-once close. Keep the existing Admin event contract:

```ts
type LocalSshOutputEvent = {
  sessionId: string;
  stream: "stdout" | "stderr" | "closed";
  data: string;
};
```

- [ ] **Step 4: Add native cloud-terminal proxy**

Expose `cloud_terminal_open/write/resize/close` with the same opaque-handle interface as local SSH. Rust obtains the short-lived WS token via native cloud transport and owns the WSS connection; WebView receives only terminal output events.

- [ ] **Step 5: Remove Tauri WebSocket use**

In `useServerTerminal`, browser retains `new WebSocket`; desktop chooses `openLocalSshSession` or `openCloudSshSession`. Add a source assertion that the Tauri branch never evaluates `new WebSocket`.

- [ ] **Step 6: Verify GREEN**

Run complete Admin tests/build and Desktop Rust fmt/clippy/tests.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add apps/desktop/src-tauri apps/admin/src/desktop apps/admin/src/hooks
rtk git commit -m "feat(desktop): unify secure terminal transports"
```

## Task 8: Preserve the Web AI workflow with native redaction and cutoffs

**Files:**
- Modify: `apps/admin/src/components/TerminalAiChat.tsx`
- Modify: `apps/admin/src/components/__tests__/TerminalAiChat.test.tsx`
- Modify: `apps/desktop/src-tauri/src/cloud_proxy/mod.rs`
- Test: `apps/desktop/src-tauri/src/cloud_proxy/tests.rs`

- [ ] **Step 1: Write failing behavior tests**

Admin tests must prove: commands auto-run, output is analyzed, maximum is three rounds, first failure stops, closed session stops, quota error leaves terminal usable, and UI displays `第 N/3 轮` with the current command.

Rust tests must prove the `/terminal/ai` body redactor removes PEM blocks, bearer-like tokens, and configured password patterns and caps `terminal_output` before transport.

- [ ] **Step 2: Verify RED**

Run focused Terminal AI and cloud proxy tests.

Expected: FAIL because round display and Rust-side redaction are absent.

- [ ] **Step 3: Implement minimal UI and native sanitizer**

Keep `MAX_COMMAND_ROUNDS = 3`. Add only execution-state text to the existing Web component; do not redesign chat. In Rust, sanitize only the copied outbound JSON value, never mutate UI state or log the original.

- [ ] **Step 4: Verify GREEN**

Run focused tests, full Admin tests/build, and full Rust suite.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/admin/src/components/TerminalAiChat.tsx apps/admin/src/components/__tests__/TerminalAiChat.test.tsx apps/desktop/src-tauri/src/cloud_proxy
rtk git commit -m "fix(desktop): secure terminal AI execution loop"
```

## Task 9: Route account, Telegram, and subscription actions safely

**Files:**
- Create: `apps/admin/src/desktop/external-navigation.ts`
- Modify: `apps/admin/src/desktop/tauri-bridge.ts`
- Modify: `apps/admin/src/components/AccountSubscriptionPanel.tsx`
- Modify: `apps/admin/src/pages/Account.tsx`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `apps/admin/src/components/__tests__/AccountSubscriptionPanel.test.tsx`
- Test: `apps/admin/src/pages/__tests__/Account.saas.test.tsx`
- Test: `apps/desktop/src-tauri/src/lib.rs` unit tests

- [ ] **Step 1: Write failing safe-navigation tests**

Require these route IDs only:

```ts
export type ExternalRouteId = "account_subscription" | "checkout" | "terms" | "privacy";
```

Assert Desktop never calls `window.location.assign` with a Stripe URL and Rust rejects arbitrary URLs, schemes, hosts, and path input.

- [ ] **Step 2: Add subscription-state regression tests**

For `status !== "active"` and no successful subscription, assert the panel shows subscribe/continue-payment rather than only manage-subscription. Preserve the active subscriber management action.

- [ ] **Step 3: Verify RED**

Run the focused account tests and Rust external-navigation test.

Expected: FAIL because Desktop currently uses page URLs directly.

- [ ] **Step 4: Implement fixed native navigation**

Rust maps route IDs to fixed `https://app.itops.sh` or `https://itops.sh` URLs. `checkout` opens the account subscription page, which then creates checkout in the normal browser context; Rust never accepts the Stripe URL returned to WebView.

- [ ] **Step 5: Verify GREEN and commit**

Run focused and full Admin/Rust suites, then:

```bash
rtk git add apps/admin/src/desktop apps/admin/src/components/AccountSubscriptionPanel.tsx apps/admin/src/pages/Account.tsx apps/admin/src/components/__tests__/AccountSubscriptionPanel.test.tsx apps/admin/src/pages/__tests__/Account.saas.test.tsx apps/desktop/src-tauri/src/lib.rs
rtk git commit -m "fix(desktop): secure account and subscription actions"
```

## Task 10: Lock down the Tauri WebView and prove Web UI parity

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`
- Modify: `apps/desktop/src-tauri/tests/capabilities_boundary.rs`
- Modify: `apps/desktop/src-tauri/tests/conf_paths.rs`
- Create: `apps/admin/src/desktop/__tests__/web-ui-parity.test.tsx`

- [ ] **Step 1: Write failing security/parity tests**

Require `frontendDist` to remain `../../admin/dist`, reject `withGlobalTauri: true`, require `connect-src 'self'`, and assert the built Admin route table still includes Web server management/detail, monitoring, credentials, and account pages. Reject all placeholder strings from the independent shell.

- [ ] **Step 2: Verify RED**

Run capability tests and the parity test.

Expected: FAIL because current config enables global Tauri and direct `https://app.itops.sh` / `wss://app.itops.sh` connections.

- [ ] **Step 3: Restrict capability and import official Tauri APIs**

Remove `withGlobalTauri`. Add `@tauri-apps/api` to `apps/admin` and let only `apps/admin/src/desktop/*` import it. Capability JSON must list only the main local window and named commands; opener/deep-link/Stronghold plugins remain unavailable to WebView.

- [ ] **Step 4: Verify GREEN**

Run Admin tests/build, Rust tests, and:

```bash
rtk rg -n "Monitoring overview placeholder|My Servers placeholder|Credentials vault placeholder|My Account placeholder" apps/admin apps/desktop
```

Expected: no matches and all tests pass.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/admin/package.json apps/admin/package-lock.json apps/admin/src/desktop apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/capabilities/default.json apps/desktop/src-tauri/tests/capabilities_boundary.rs apps/desktop/src-tauri/tests/conf_paths.rs
rtk git commit -m "fix(desktop): embed Web UI behind narrow IPC"
```

## Task 11: Re-run backend tenant and secret contracts

**Files:**
- Test only: `apps/backend/src/__tests__/desktop-contract.test.ts`
- Test only: `apps/backend/src/__tests__/routes/servers-tenant-isolation.test.ts`
- Test only: `apps/backend/src/__tests__/terminal-ai-no-ssh-secret.test.ts`
- Test only: subscription and credential route suites selected by `rg`

- [ ] **Step 1: Run the focused real-database tests**

```bash
cd /Users/vincent/Documents/ClaudeCode/ops-ai/.worktrees/cloud-develop/apps/backend
rtk npm run db:agent:prepare
rtk npm run test:agent -- src/__tests__/desktop-contract.test.ts src/__tests__/routes/servers-tenant-isolation.test.ts src/__tests__/terminal-ai-no-ssh-secret.test.ts
```

Expected: PASS with real tenant A/B rows; forged cross-tenant server and credential IDs return 404-equivalent responses and AI never loads SSH secrets.

- [ ] **Step 2: Run subscription regression tests**

Select the existing subscription route tests with `rtk rg -l "subscription.*active|checkout" src/__tests__` and run them through `npm run test:agent --`; do not call Vitest directly.

Expected: PASS, including first-payment retry when no active subscription exists.

- [ ] **Step 3: Record evidence without changing backend behavior**

If all tests pass, add their exact counts and commands to the implementation handoff. If any contract fails, stop and create a separate backend fix commit using TDD before proceeding.

## Task 12: Make the public release workflow build the canonical product

**Files:**
- Modify: `.github/workflows/desktop-ci.yml`
- Modify: `.github/workflows/desktop-release.yml`
- Modify: `scripts/check-release-config.mjs`
- Modify: `tests/security/release-config.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing workflow lineage tests**

Require: read `release/source-lock.json`; checkout `vincent-lxc/opsmate` at its exact commit with `secrets.OPSMATE_SOURCE_TOKEN`; run Admin and main Desktop tests; build from `source/apps/desktop`; reject root `npm run build`, root `src/`, and root `src-tauri/` product inputs.

- [ ] **Step 2: Verify RED**

Run: `rtk npm test -- tests/security/release-config.test.ts`

Expected: FAIL because the workflow still builds the independent placeholder UI.

- [ ] **Step 3: Implement canonical checkout and build paths**

The workflow sequence must be:

```yaml
- name: Read canonical source lock
  id: source
  shell: bash
  run: node scripts/read-source-lock.mjs >> "$GITHUB_OUTPUT"
- name: Checkout canonical OpsMate source
  uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
  with:
    repository: vincent-lxc/opsmate
    ref: ${{ steps.source.outputs.commit }}
    token: ${{ secrets.OPSMATE_SOURCE_TOKEN }}
    path: source
    persist-credentials: false
```

Use the workflow's already reviewed full action SHAs; do not replace them with floating tags. All npm/cargo/build paths point under `source/apps/admin` and `source/apps/desktop`.

- [ ] **Step 4: Preserve macOS signing and Windows-disabled policy**

Keep Developer ID import, explicit notary submission/wait, staple, codesign, Gatekeeper, stapler validation, artifact whitelist, checksums, and `if: ${{ false }}` for Windows. Add canonical source commit to `GITHUB_STEP_SUMMARY` and release notes.

- [ ] **Step 5: Verify GREEN and commit**

Run full release-repo npm tests, contracts check, dependency audit, and workflow validator, then:

```bash
rtk git add .github/workflows scripts tests/security README.md
rtk git commit -m "feat(release): build canonical OpsMate desktop"
```

## Task 13: Build and functionally verify the unsigned macOS candidate

**Files:**
- Create: `docs/uat/2026-08-07-desktop-web-ui-macos-uat.md`
- Modify: `release/source-lock.json` after the final product commit

- [ ] **Step 1: Update the source lock to the final product commit**

Run `rtk git rev-parse HEAD` in the product repo. Replace only `release/source-lock.json.commit` with that exact SHA using `apply_patch`, run release-config tests, and commit `chore(release): lock desktop candidate source`.

- [ ] **Step 2: Run the complete local gates**

Product repo:

```bash
rtk npm --prefix apps/admin test
rtk npm --prefix apps/admin run build
rtk rustup run 1.92.0 cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
rtk rustup run 1.92.0 cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
rtk rustup run 1.92.0 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets
```

Release repo:

```bash
rtk npm test
rtk npm run contracts:check
```

Expected: all PASS.

- [ ] **Step 3: Build the local macOS app/DMG candidate**

Run from `apps/desktop` with Rust 1.92.0 and the production Admin build. Verify the app launches the Web UI rather than placeholder pages. Do not call this signed or releasable.

- [ ] **Step 4: Record local evidence**

Create the UAT document with commit SHAs, commands, test counts, build artifact path, and `PASS(local)` labels. Leave signing and interactive production rows `NOT RUN` until performed.

## Task 14: Publish and execute signed macOS UAT

**Files:**
- Modify: `docs/uat/2026-08-07-desktop-web-ui-macos-uat.md`
- Website update only after every gate passes.

- [ ] **Step 1: Configure the least-privileged source token**

Create `OPSMATE_SOURCE_TOKEN` in the `desktop-release` GitHub Environment as a fine-grained token with read-only Contents access to `vincent-lxc/opsmate`. Do not grant write, Actions, Administration, or organization-wide repository access.

- [ ] **Step 2: Push the verified release commit and tag**

Use `desktop-v0.1.4` after verifying the tag points to the release-repo commit containing the final source lock. Windows remains disabled.

- [ ] **Step 3: Approve and monitor the protected release**

Approve only the macOS and final release environment gates. Require notarization `Accepted`, successful staple, codesign, Gatekeeper, stapler validation, and checksum publication.

- [ ] **Step 4: Run the signed-DMG functional UAT**

Record concrete evidence for all ten design gates: fresh install, Logto login, tenant-isolated servers, Web UI pages, Stronghold import, real SSH I/O/resize/close, AI automatic command loop, sleep/lock cutoff, subscription/Telegram state, and no JWT in WebView storage.

Expected: every row PASS. NOT RUN, BLOCKED, or FAIL keeps the release at No-Go.

- [ ] **Step 5: Update the website only after Go**

Point the macOS download to `desktop-v0.1.4`, retain “Windows 即将推出”, and remove preview warnings only after the signed-DMG UAT is fully green.

## Final verification checklist

- [ ] Product repo status contains no unintended files and still preserves the user's `README.md` change.
- [ ] Release repo contains no `.superpowers/` artifacts or placeholder React product source in the build lineage.
- [ ] Browser Admin tests prove existing Web behavior is unchanged.
- [ ] Desktop WebView has no JWT storage and no direct network access.
- [ ] Rust owns all cloud, credential, SSH, AI-output sanitization, and privileged navigation paths.
- [ ] Backend A/B tenant tests and secret non-disclosure tests pass.
- [ ] Release artifact identifies the exact canonical product commit.
- [ ] Signed/notarized macOS DMG passes interactive functional UAT before website promotion.
