# Desktop API contracts changelog

## v1 — 2026-08-04 (native-only auth invocation)

Desktop cloud_transport allowlist for OpsMate Desktop independent repository.

**Authority:** field names and paths verified against ops-ai backend on
`feat/desktop-local-credentials`. This is a desktop allowlist snapshot, not a
full backend OpenAPI export.

### Invocation authority (explicit)

| Value | Meaning |
|-------|---------|
| `native_only` | Rust initiates the cloud call. **Not** business-IPC-callable. |
| `ipc_via_rust` | WebView may request via named business IPC; Rust builds HTTP and injects Authorization. |

- **`auth.config`**, **`auth.exchange`** → `native_only`
- **`auth.me`** and all business ops → `ipc_via_rust`
- Generated Rust: `Invocation::{NativeOnly, IpcViaRust}`, `is_ipc_callable()`
- HTTP `pathParams` / `queryFields` / `bodyFields` describe **wire schema**, not
  automatic WebView inputs

### Auth / PKCE (native-owned)

- `auth.exchange` wire body schema: `code`, `codeVerifier` — **generated and held
  only in Rust** (PKCE via `auth_begin_logto` + OS deep-link). **Not** WebView or
  IPC request fields.
- `fixedBodyFields.redirectUri` =
  `https://app.itops.sh/login/desktop/callback` (exact native constant)
- No IPC path may accept `codeVerifier`, `redirectUri`, access/refresh/session
  tokens, arbitrary URL, or Authorization

### Operation families

- `auth.config` / `auth.exchange` (native_only) / `auth.me` (ipc_via_rust)
- `servers.*`, `monitoring.foundation.*` / `applications.*`
- `monitoring.patrolTasks.*` / `patrolRecords.*` / `patrolRounds.*`
  (**available** under RLS 0082/0083 + `registerTenantDatabasePlugin`)
- `problems.*`, `remediation.*`, `subscription.*`, `account.telegram.*`

### Security pins

- Fixed origin: `https://app.itops.sh`
- No Logto admin endpoint in contract surface
- `Availability` fail-closed retained (v1 has zero blocked ops)
- `contracts:check` fails on Rust **or** OpenAPI drift

### Artifacts

- `contracts/desktop-operations.json` — source of truth
- `contracts/openapi-v1.yaml` — generated (`x-desktop-invocation`, `x-desktop-ipc-callable`)
- `src-tauri/src/cloud_transport/operations.rs` — generated
- `npm run contracts:generate` / `npm run contracts:check`
