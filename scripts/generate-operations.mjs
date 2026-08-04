#!/usr/bin/env node
/**
 * Deterministically generate Rust Operation allowlist + OpenAPI snapshot +
 * TypeScript IPC-callable operation allowlist from
 * contracts/desktop-operations.json (single source of truth).
 *
 * Usage:
 *   node scripts/generate-operations.mjs           # write rust + openapi + ts
 *   node scripts/generate-operations.mjs --check    # exit 1 on drift
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const opsPath = resolve(root, "contracts/desktop-operations.json");
const rustOutPath = resolve(root, "src-tauri/src/cloud_transport/operations.rs");
const openapiOutPath = resolve(root, "contracts/openapi-v1.yaml");
const tsOutPath = resolve(root, "src/cloud/generated-operations.ts");

const BASE_ORIGIN = "https://app.itops.sh";
const WS_ORIGIN = "wss://app.itops.sh";
const DESKTOP_REDIRECT_URI = "https://app.itops.sh/login/desktop/callback";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const AVAILABILITIES = new Set(["available", "blocked_pending_tenant_isolation"]);
const INVOCATIONS = new Set(["native_only", "ipc_via_rust"]);

/**
 * Fields that must never appear on IPC-callable (ipc_via_rust) request allowlists.
 * Native-only ops may use some of these as Rust-owned wire body fields (e.g. codeVerifier).
 */
const FORBIDDEN_IPC_FIELDS = new Set([
  "authorization",
  "bearer",
  "access_token",
  "refresh_token",
  "session_token",
  "opsmate_token",
  "url",
  "baseurl",
  "base_url",
  "origin",
  "host",
  "href",
  "uri",
  "redirecturi",
  "redirect_uri",
  "callbackurl",
  "callback_url",
  "code",
  "codeverifier",
  "code_verifier",
  "logto_admin_endpoint",
  "logtoadminendpoint",
]);

/** Always-forbidden on any wire allowlist as caller-shaped secrets / URL steering. */
const FORBIDDEN_WIRE_FIELDS = new Set([
  "authorization",
  "bearer",
  "access_token",
  "refresh_token",
  "session_token",
  "opsmate_token",
  "url",
  "baseurl",
  "base_url",
  "origin",
  "host",
  "href",
  "uri",
  "redirecturi",
  "redirect_uri",
  "callbackurl",
  "callback_url",
  "logto_admin_endpoint",
  "logtoadminendpoint",
]);

function die(msg) {
  console.error(`generate-operations: ${msg}`);
  process.exit(1);
}

function toPascalCase(id) {
  return id
    .split(/[.\-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function methodVariant(method) {
  // Idiomatic Rust enum variants (PascalCase), not SCREAMING_SNAKE.
  return method.charAt(0) + method.slice(1).toLowerCase();
}

function rustString(s) {
  return JSON.stringify(s);
}

function rustStrSlice(arr) {
  if (!arr.length) return "&[]";
  return `&[${arr.map((s) => rustString(s)).join(", ")}]`;
}

function rustFixedBody(obj) {
  const entries = Object.entries(obj ?? {});
  if (!entries.length) return "&[]";
  return `&[${entries
    .map(([k, v]) => `(${rustString(k)}, ${rustString(v)})`)
    .join(", ")}]`;
}

function availabilityVariant(a) {
  if (a === "available") return "Available";
  if (a === "blocked_pending_tenant_isolation") return "BlockedPendingTenantIsolation";
  die(`unknown availability ${a}`);
}

function invocationVariant(inv) {
  if (inv === "native_only") return "NativeOnly";
  if (inv === "ipc_via_rust") return "IpcViaRust";
  die(`unknown invocation ${inv}`);
}

function normalizeFixedBody(raw) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    die("fixedBodyFields must be an object map of string -> string");
  }
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== "string" || typeof v !== "string") {
      die(`fixedBodyFields entry must be string:string (${k})`);
    }
    out[k] = v;
  }
  return out;
}

function validate(file) {
  if (file.version !== 1) die("version must be 1");
  if (file.baseOrigin !== BASE_ORIGIN) {
    die(`baseOrigin must be exactly ${BASE_ORIGIN}`);
  }
  if (file.wsOrigin !== WS_ORIGIN) {
    die(`wsOrigin must be exactly ${WS_ORIGIN}`);
  }
  if (file.desktopRedirectUri !== DESKTOP_REDIRECT_URI) {
    die(`desktopRedirectUri must be exactly ${DESKTOP_REDIRECT_URI}`);
  }
  if (!Array.isArray(file.operations) || file.operations.length === 0) {
    die("operations must be a non-empty array");
  }

  const ids = new Set();
  const variants = new Set();

  for (const op of file.operations) {
    if (!op.id || typeof op.id !== "string") die("operation missing id");
    if (ids.has(op.id)) die(`duplicate operation id: ${op.id}`);
    ids.add(op.id);

    const variant = toPascalCase(op.id);
    if (variants.has(variant)) {
      die(`${op.id}: Rust enum variant collision ${variant}`);
    }
    variants.add(variant);

    if (!METHODS.has(op.method)) die(`${op.id}: invalid method ${op.method}`);
    if (typeof op.path !== "string" || !op.path.startsWith("/api/")) {
      die(`${op.id}: path must start with /api/`);
    }
    if (op.url !== undefined) die(`${op.id}: arbitrary url field is forbidden`);
    if (/https?:\/\//i.test(op.path)) die(`${op.id}: path must not be absolute URL`);
    if (/[?#]/.test(op.path)) die(`${op.id}: path must not contain query/fragment`);
    if (op.path.includes("..")) die(`${op.id}: path must not contain traversal`);
    if (/logto-admin/i.test(JSON.stringify(op))) {
      die(`${op.id}: logto-admin endpoint is forbidden`);
    }
    if (typeof op.authenticated !== "boolean") {
      die(`${op.id}: authenticated must be boolean`);
    }
    if (!AVAILABILITIES.has(op.availability)) {
      die(`${op.id}: availability must be available|blocked_pending_tenant_isolation`);
    }
    if (!INVOCATIONS.has(op.invocation)) {
      die(`${op.id}: invocation must be native_only|ipc_via_rust`);
    }

    // All three allowlist arrays must be explicitly present (not undefined).
    if (!Array.isArray(op.pathParams)) die(`${op.id}: pathParams must be an array`);
    if (!Array.isArray(op.queryFields)) die(`${op.id}: queryFields must be an array`);
    if (!Array.isArray(op.bodyFields)) die(`${op.id}: bodyFields must be an array`);
    if (op.optionalBodyFields !== undefined && !Array.isArray(op.optionalBodyFields)) {
      die(`${op.id}: optionalBodyFields must be an array when present`);
    }
    const optionalBody = op.optionalBodyFields ?? [];
    for (const f of optionalBody) {
      if (!op.bodyFields.includes(f)) {
        die(`${op.id}: optionalBodyFields entry ${f} must also be in bodyFields`);
      }
    }
    op.optionalBodyFields = optionalBody;

    const fixed = normalizeFixedBody(op.fixedBodyFields);
    op.fixedBodyFields = fixed;

    const pathPlaceholders = [
      ...op.path.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g),
    ].map((m) => m[1]);
    const declaredSorted = [...op.pathParams].sort();
    const pathSorted = [...pathPlaceholders].sort();
    if (JSON.stringify(declaredSorted) !== JSON.stringify(pathSorted)) {
      die(
        `${op.id}: pathParams must exactly match path placeholders (declared=${JSON.stringify(
          op.pathParams,
        )} path=${JSON.stringify(pathPlaceholders)})`,
      );
    }

    const wireFields = [...op.pathParams, ...op.queryFields, ...op.bodyFields];
    if (new Set(wireFields).size !== wireFields.length) {
      die(`${op.id}: duplicate fields across pathParams/queryFields/bodyFields`);
    }
    for (const arr of [op.pathParams, op.queryFields, op.bodyFields]) {
      if (new Set(arr).size !== arr.length) {
        die(`${op.id}: duplicate entries within an allowlist array`);
      }
    }

    for (const f of wireFields) {
      if (typeof f !== "string" || !f) die(`${op.id}: empty field name`);
      const lower = f.toLowerCase();
      // Wire allowlists never carry auth headers / URL steering / tokens as fields.
      if (FORBIDDEN_WIRE_FIELDS.has(lower)) {
        die(`${op.id}: forbidden wire field ${f}`);
      }
      // IPC-callable ops may never accept PKCE secrets or redirect on the IPC path.
      if (op.invocation === "ipc_via_rust" && FORBIDDEN_IPC_FIELDS.has(lower)) {
        die(`${op.id}: ipc_via_rust forbids IPC field ${f}`);
      }
    }

    // Fixed body keys may include redirectUri (native-owned), but not Authorization tokens.
    for (const [k, v] of Object.entries(fixed)) {
      const lower = k.toLowerCase();
      if (
        lower === "authorization" ||
        lower === "bearer" ||
        lower === "access_token" ||
        lower === "refresh_token" ||
        lower === "session_token"
      ) {
        die(`${op.id}: forbidden fixedBodyFields key ${k}`);
      }
      if (typeof v !== "string" || !v) {
        die(`${op.id}: fixedBodyFields.${k} must be non-empty string`);
      }
      // Fixed body keys must not also be dynamic body fields.
      if (op.bodyFields.includes(k)) {
        die(`${op.id}: field ${k} cannot be both bodyFields and fixedBodyFields`);
      }
    }

    if (op.id === "auth.config" || op.id === "auth.exchange") {
      if (op.invocation !== "native_only") {
        die(`${op.id}: must be invocation native_only`);
      }
    }
    if (op.id === "auth.exchange") {
      // Wire schema: Rust-owned PKCE material (NOT WebView/IPC inputs).
      if (JSON.stringify(op.bodyFields) !== JSON.stringify(["code", "codeVerifier"])) {
        die(
          "auth.exchange bodyFields (native wire schema) must be exactly [code, codeVerifier]",
        );
      }
      if (fixed.redirectUri !== DESKTOP_REDIRECT_URI) {
        die(`auth.exchange fixedBodyFields.redirectUri must be ${DESKTOP_REDIRECT_URI}`);
      }
    }
  }
}

function contentHash(file) {
  const ops = [...file.operations].sort((a, b) => a.id.localeCompare(b.id));
  const canonical = {
    version: file.version,
    baseOrigin: file.baseOrigin,
    wsOrigin: file.wsOrigin,
    desktopRedirectUri: file.desktopRedirectUri,
    operations: ops.map((op) => ({
      id: op.id,
      method: op.method,
      path: op.path,
      authenticated: op.authenticated,
      availability: op.availability,
      invocation: op.invocation,
      pathParams: op.pathParams,
      queryFields: op.queryFields,
      bodyFields: op.bodyFields,
      optionalBodyFields: op.optionalBodyFields ?? [],
      fixedBodyFields: op.fixedBodyFields ?? {},
    })),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);
}

function generateRust(file) {
  const ops = [...file.operations].sort((a, b) => a.id.localeCompare(b.id));
  const hash = contentHash(file);

  const variants = ops.map((op) => `    ${toPascalCase(op.id)},`).join("\n");
  const allOps = ops
    .map((op) => `    Operation::${toPascalCase(op.id)},`)
    .join("\n");

  const matchArms = ops
    .map((op) => {
      const variant = toPascalCase(op.id);
      const method = methodVariant(op.method);
      const avail = availabilityVariant(op.availability);
      const inv = invocationVariant(op.invocation);
      return `        Operation::${variant} => OperationSpec {
            id: ${rustString(op.id)},
            method: Method::${method},
            path: ${rustString(op.path)},
            authenticated: ${op.authenticated},
            path_params: ${rustStrSlice(op.pathParams)},
            query_fields: ${rustStrSlice(op.queryFields)},
            body_fields: ${rustStrSlice(op.bodyFields)},
            fixed_body_fields: ${rustFixedBody(op.fixedBodyFields)},
            availability: Availability::${avail},
            invocation: Invocation::${inv},
        },`;
    })
    .join("\n");

  const fromIdArms = ops
    .map((op) => {
      const variant = toPascalCase(op.id);
      return `            ${rustString(op.id)} => Some(Operation::${variant}),`;
    })
    .join("\n");

  return `// @generated by scripts/generate-operations.mjs — DO NOT EDIT BY HAND
// source: contracts/desktop-operations.json
// content-hash: ${hash}
// regenerate: npm run contracts:generate

//! Desktop cloud_transport operation allowlist (generated).
//!
//! - Fixed origin is enforced by the transport layer (\`https://app.itops.sh\`).
//! - Authorization is injected only in Rust; never accept it from WebView.
//! - \`fixed_body_fields\` (e.g. desktop redirect URI) are native-owned constants.
//! - \`body_fields\` / path / query describe the **HTTP wire schema**, not automatic
//!   WebView inputs. For \`Invocation::NativeOnly\` (auth.config / auth.exchange),
//!   dynamic fields such as PKCE \`code\`/\`codeVerifier\` are Rust-owned only.
//! - \`is_ipc_callable\` is true only for \`Invocation::IpcViaRust\`.
//! - No arbitrary URL fields; path templates only.
//! - Operations with \`Availability::BlockedPendingTenantIsolation\` are
//!   fail-closed: present in the contract catalog but not callable.

#![allow(dead_code)]
// Generated allowlist; keep rustfmt from fighting the generator (contracts:check).
#![cfg_attr(rustfmt, rustfmt_skip)]

/// HTTP method for an allowlisted operation (idiomatic PascalCase variants).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
        }
    }
}

/// Whether the desktop client may invoke this operation today (backend readiness).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    /// Safe to call under current backend isolation guarantees.
    Available,
    /// Catalogued for v1 coverage but blocked: backend route is not tenant-isolated.
    BlockedPendingTenantIsolation,
}

/// Who may *initiate* this cloud operation on the desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invocation {
    /// Rust-only (e.g. auth_begin_logto / deep-link exchange). Never IPC-callable.
    NativeOnly,
    /// WebView may request via named business IPC; Rust still builds HTTP + injects auth.
    IpcViaRust,
}

/// Allowlisted desktop cloud operations (exhaustive).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Operation {
${variants}
}

/// Every known operation (for exhaustive iteration in transport/tests).
pub const ALL_OPERATIONS: &[Operation] = &[
${allOps}
];

/// Static specification for one operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OperationSpec {
    pub id: &'static str,
    pub method: Method,
    pub path: &'static str,
    pub authenticated: bool,
    /// HTTP path placeholder names (wire schema).
    pub path_params: &'static [&'static str],
    /// HTTP query allowlist (wire schema).
    pub query_fields: &'static [&'static str],
    /// HTTP body field names (wire schema). For NativeOnly ops these are Rust-owned.
    pub body_fields: &'static [&'static str],
    /// Native-owned body pairs merged by Rust (never WebView/IPC-controlled).
    pub fixed_body_fields: &'static [(&'static str, &'static str)],
    pub availability: Availability,
    pub invocation: Invocation,
}

/// Fixed HTTPS origin for all desktop cloud calls.
pub const BASE_ORIGIN: &str = ${rustString(BASE_ORIGIN)};

/// Fixed WSS origin (reserved for later transport tasks).
pub const WS_ORIGIN: &str = ${rustString(WS_ORIGIN)};

/// Exact desktop OAuth redirect URI owned by native code (not WebView).
pub const DESKTOP_REDIRECT_URI: &str = ${rustString(DESKTOP_REDIRECT_URI)};

/// Content hash of the generating operations JSON (truncated).
pub const OPERATIONS_CONTENT_HASH: &str = ${rustString(hash)};

/// Resolve the static spec for an operation.
pub fn spec(op: Operation) -> OperationSpec {
    match op {
${matchArms}
    }
}

/// True only when availability is Available (blocked ops are fail-closed).
pub fn is_callable(op: Operation) -> bool {
    matches!(spec(op).availability, Availability::Available)
}

/// True only when WebView/business IPC may request this operation.
/// Native-only ops (auth.config / auth.exchange) always return false.
pub fn is_ipc_callable(op: Operation) -> bool {
    matches!(spec(op).invocation, Invocation::IpcViaRust) && is_callable(op)
}

/// Parse operation id string into the enum (unknown → None).
pub fn from_id(id: &str) -> Option<Operation> {
    match id {
${fromIdArms}
            _ => None,
    }
}

#[cfg(test)]
mod operations_tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn base_origin_and_redirect_are_pinned() {
        assert_eq!(BASE_ORIGIN, "https://app.itops.sh");
        assert_eq!(WS_ORIGIN, "wss://app.itops.sh");
        assert_eq!(
            DESKTOP_REDIRECT_URI,
            "https://app.itops.sh/login/desktop/callback"
        );
    }

    #[test]
    fn all_operations_round_trip_and_have_allowlists() {
        assert_eq!(ALL_OPERATIONS.len(), ${ops.length});
        let mut seen = HashSet::new();
        for &op in ALL_OPERATIONS {
            let s = spec(op);
            assert!(seen.insert(s.id), "duplicate id {}", s.id);
            assert_eq!(from_id(s.id), Some(op));
            assert!(!s.path.is_empty());
            assert!(s.path.starts_with("/api/"));
            // path_params must match placeholders exactly
            let mut placeholders: Vec<&str> = s
                .path
                .split('{')
                .skip(1)
                .filter_map(|chunk| chunk.split('}').next())
                .collect();
            placeholders.sort();
            let mut declared = s.path_params.to_vec();
            declared.sort();
            assert_eq!(declared, placeholders, "path params for {}", s.id);
            // method string is uppercase HTTP
            assert!(matches!(
                s.method.as_str(),
                "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
            ));
        }
        assert_eq!(from_id("not.a.real.op"), None);
    }

    #[test]
    fn auth_exchange_native_owns_pkce_and_redirect() {
        let s = spec(Operation::AuthExchange);
        assert_eq!(s.method, Method::Post);
        assert_eq!(s.path, "/api/auth/logto/exchange");
        assert!(!s.authenticated);
        // Wire schema lists code/codeVerifier; they are Rust-owned, not IPC inputs.
        assert_eq!(s.body_fields, &["code", "codeVerifier"]);
        assert!(!s.body_fields.contains(&"redirectUri"));
        assert_eq!(
            s.fixed_body_fields,
            &[("redirectUri", DESKTOP_REDIRECT_URI)]
        );
        assert_eq!(s.invocation, Invocation::NativeOnly);
        assert!(is_callable(Operation::AuthExchange));
        assert!(
            !is_ipc_callable(Operation::AuthExchange),
            "auth.exchange must not be IPC-callable"
        );
    }

    #[test]
    fn auth_config_is_public_get_native_only() {
        let s = spec(Operation::AuthConfig);
        assert_eq!(s.method, Method::Get);
        assert_eq!(s.path, "/api/auth/logto/config");
        assert!(!s.authenticated);
        assert_eq!(s.invocation, Invocation::NativeOnly);
        assert!(is_callable(Operation::AuthConfig));
        assert!(!is_ipc_callable(Operation::AuthConfig));
    }

    #[test]
    fn native_only_ops_are_rejected_by_ipc_callable_helper() {
        for &op in ALL_OPERATIONS {
            let s = spec(op);
            match s.invocation {
                Invocation::NativeOnly => {
                    assert!(
                        !is_ipc_callable(op),
                        "{} is native_only and must not be IPC-callable",
                        s.id
                    );
                }
                Invocation::IpcViaRust => {
                    if is_callable(op) {
                        assert!(
                            is_ipc_callable(op),
                            "{} is ipc_via_rust + available => IPC-callable",
                            s.id
                        );
                    }
                    // IPC path must not accept PKCE / redirect / token fields.
                    for field in s
                        .path_params
                        .iter()
                        .chain(s.query_fields.iter())
                        .chain(s.body_fields.iter())
                    {
                        let lower = field.to_ascii_lowercase();
                        assert_ne!(lower, "code");
                        assert_ne!(lower, "codeverifier");
                        assert_ne!(lower, "code_verifier");
                        assert_ne!(lower, "redirecturi");
                        assert_ne!(lower, "redirect_uri");
                        assert_ne!(lower, "authorization");
                        assert_ne!(lower, "access_token");
                        assert_ne!(lower, "refresh_token");
                        assert_ne!(lower, "session_token");
                        assert_ne!(lower, "url");
                        assert_ne!(lower, "uri");
                    }
                }
            }
        }
        assert_eq!(spec(Operation::AuthMe).invocation, Invocation::IpcViaRust);
        assert!(is_ipc_callable(Operation::AuthMe));
    }

    #[test]
    fn availability_fail_closed_semantics() {
        // v1 may have zero blocked ops (patrol is tenant-isolated via RLS).
        // Still verify Available => callable and Blocked => not callable.
        let mut available = 0usize;
        let mut blocked = 0usize;
        for &op in ALL_OPERATIONS {
            let s = spec(op);
            match s.availability {
                Availability::Available => {
                    available += 1;
                    assert!(is_callable(op), "{} should be callable", s.id);
                }
                Availability::BlockedPendingTenantIsolation => {
                    blocked += 1;
                    assert!(!is_callable(op), "{} must not be callable", s.id);
                }
            }
        }
        assert!(available >= 1, "expected at least one available op");
        // Zero blocked ops is valid for current v1 catalog.
        let _ = blocked;
        // Enum variant remains for future fail-closed entries.
        let _keep: Availability = Availability::BlockedPendingTenantIsolation;
        assert!(!matches!(
            Availability::BlockedPendingTenantIsolation,
            Availability::Available
        ));
    }

    #[test]
    fn patrol_ops_are_callable() {
        for id in [
            "monitoring.patrolTasks.list",
            "monitoring.patrolTasks.get",
            "monitoring.patrolRecords.list",
            "monitoring.patrolRecords.get",
            "monitoring.patrolRounds.list",
            "monitoring.patrolRounds.get",
        ] {
            let op = from_id(id).expect(id);
            assert!(is_callable(op), "{id} must be callable under tenant RLS");
            assert_eq!(spec(op).availability, Availability::Available);
        }
    }

    #[test]
    fn no_operation_path_mentions_logto_admin() {
        let forbidden_host_token = format!("{}-{}", "logto", "admin");
        for &op in ALL_OPERATIONS {
            let s = spec(op);
            assert!(!s.path.to_ascii_lowercase().contains(&forbidden_host_token));
            assert!(!s.id.to_ascii_lowercase().contains("admin_endpoint"));
            for field in s
                .path_params
                .iter()
                .chain(s.query_fields.iter())
                .chain(s.body_fields.iter())
            {
                let lower = field.to_ascii_lowercase();
                assert_ne!(lower, "authorization");
                assert_ne!(lower, "redirecturi");
                assert_ne!(lower, "url");
            }
        }
    }

    #[test]
    fn servers_list_query_matches_backend() {
        let s = spec(Operation::ServersList);
        assert_eq!(
            s.query_fields,
            &[
                "page",
                "page_size",
                "name",
                "ip",
                "ssh_user",
                "description",
                "group_name",
                "q",
                "sort",
                "host_key_status",
            ]
        );
    }
}
`;
}

function yamlQuote(s) {
  // Prefer plain if safe; otherwise double-quote.
  if (/^[\w./-]+$/.test(s) && !s.includes("{")) return s;
  return JSON.stringify(s);
}

function generateOpenApi(file) {
  const ops = [...file.operations].sort((a, b) => a.id.localeCompare(b.id));
  const hash = contentHash(file);

  // Group by path
  /** @type {Map<string, typeof ops>} */
  const byPath = new Map();
  for (const op of ops) {
    if (!byPath.has(op.path)) byPath.set(op.path, []);
    byPath.get(op.path).push(op);
  }

  let pathsYaml = "";
  const sortedPaths = [...byPath.keys()].sort();
  for (const path of sortedPaths) {
    pathsYaml += `  ${path}:\n`;
    for (const op of byPath.get(path)) {
      const method = op.method.toLowerCase();
      pathsYaml += `    ${method}:\n`;
      pathsYaml += `      operationId: ${op.id}\n`;
      pathsYaml += `      x-desktop-availability: ${op.availability}\n`;
      pathsYaml += `      x-desktop-invocation: ${op.invocation}\n`;
      const ipcCallable =
        op.invocation === "ipc_via_rust" &&
        op.availability === "available";
      pathsYaml += `      x-desktop-ipc-callable: ${ipcCallable}\n`;
      if (op.availability === "blocked_pending_tenant_isolation") {
        pathsYaml += `      x-desktop-callable: false\n`;
        pathsYaml += `      description: >\n`;
        pathsYaml += `        Catalogued for desktop v1 coverage but FAIL-CLOSED on availability.\n`;
      } else if (op.invocation === "native_only") {
        pathsYaml += `      x-desktop-callable: true\n`;
        pathsYaml += `      description: >\n`;
        pathsYaml += `        Native-only operation. Rust initiates the call (not business IPC).\n`;
        pathsYaml += `        Request allowlists describe HTTP wire schema; fields are not WebView inputs.\n`;
      } else {
        pathsYaml += `      x-desktop-callable: true\n`;
      }
      if (op.authenticated) {
        pathsYaml += `      security:\n`;
        pathsYaml += `        - bearerAuth: []\n`;
      } else {
        pathsYaml += `      security: []\n`;
      }

      // Path parameters
      const params = [];
      for (const name of op.pathParams) {
        params.push({ in: "path", name, required: true });
      }
      for (const name of op.queryFields) {
        params.push({ in: "query", name, required: false });
      }
      if (params.length) {
        pathsYaml += `      parameters:\n`;
        for (const p of params) {
          pathsYaml += `        - in: ${p.in}\n`;
          pathsYaml += `          name: ${p.name}\n`;
          if (p.required) pathsYaml += `          required: true\n`;
          pathsYaml += `          schema:\n`;
          pathsYaml += `            type: string\n`;
        }
      }

      const fixedEntries = Object.entries(op.fixedBodyFields ?? {});
      const hasBody =
        op.bodyFields.length > 0 ||
        fixedEntries.length > 0 ||
        op.method === "POST" ||
        op.method === "PUT" ||
        op.method === "PATCH" ||
        op.method === "DELETE";

      if (op.bodyFields.length > 0 || fixedEntries.length > 0) {
        pathsYaml += `      requestBody:\n`;
        pathsYaml += `        required: true\n`;
        pathsYaml += `        content:\n`;
        pathsYaml += `          application/json:\n`;
        pathsYaml += `            schema:\n`;
        pathsYaml += `              type: object\n`;
        pathsYaml += `              additionalProperties: false\n`;
        const optionalBody = new Set(op.optionalBodyFields ?? []);
        const requiredBody = op.bodyFields.filter((f) => !optionalBody.has(f));
        if (requiredBody.length) {
          pathsYaml += `              required:\n`;
          for (const f of requiredBody) {
            pathsYaml += `                - ${f}\n`;
          }
        }
        pathsYaml += `              properties:\n`;
        for (const f of op.bodyFields) {
          const nativeOwned = op.invocation === "native_only";
          const isOptional = optionalBody.has(f);
          pathsYaml += `                ${f}:\n`;
          if (isOptional) {
            // Nullable optional wire field (e.g. expected_fingerprint on TOFU).
            pathsYaml += `                  type:\n`;
            pathsYaml += `                    - string\n`;
            pathsYaml += `                    - "null"\n`;
          } else {
            pathsYaml += `                  type: string\n`;
          }
          if (nativeOwned) {
            if (op.id === "auth.exchange") {
              pathsYaml += `                  description: Rust-owned native wire field (not WebView/IPC input; PKCE material for auth.exchange)\n`;
            } else {
              pathsYaml += `                  description: Rust-owned native wire field (not WebView/IPC input)\n`;
            }
            pathsYaml += `                  x-owned-by: native\n`;
            pathsYaml += `                  x-ipc-input: false\n`;
          } else {
            pathsYaml += `                  description: IPC-allowlisted body field (Rust still builds the HTTP request)\n`;
            pathsYaml += `                  x-owned-by: ipc_via_rust\n`;
          }
        }
        for (const [k, v] of fixedEntries) {
          pathsYaml += `                ${k}:\n`;
          pathsYaml += `                  type: string\n`;
          pathsYaml += `                  description: Native fixed body value (Rust-owned; not supplied by WebView or IPC)\n`;
          pathsYaml += `                  enum:\n`;
          pathsYaml += `                    - ${JSON.stringify(v)}\n`;
          pathsYaml += `                  x-fixed-body: true\n`;
          pathsYaml += `                  x-fixed-by: native\n`;
          pathsYaml += `                  x-ipc-input: false\n`;
        }
        if (fixedEntries.length) {
          pathsYaml += `            x-fixed-body:\n`;
          for (const [k, v] of fixedEntries) {
            pathsYaml += `              ${k}: ${JSON.stringify(v)}\n`;
          }
        }
      } else if (hasBody && op.method !== "GET") {
        // No body schema for empty POST like bindStart — omit requestBody
      }

      // Silence unused
      void hasBody;

      pathsYaml += `      responses:\n`;
      pathsYaml += `        "200":\n`;
      pathsYaml += `          description: Success (schema deferred; desktop maps operation ids only)\n`;
    }
  }

  return `# @generated by scripts/generate-operations.mjs — DO NOT EDIT BY HAND
# source: contracts/desktop-operations.json
# content-hash: ${hash}
# regenerate: npm run contracts:generate
#
# Snapshot of backend paths used by the independent OpsMate Desktop client.
# Single source of truth is desktop-operations.json; this file is generated
# for human review and OpenAPI tooling. Desktop never calls arbitrary URLs:
# Rust cloud_transport maps operation IDs to these paths and injects
# Authorization + fixed body fields only in native code.
#
# Field names were verified against ops-ai backend validators on
# feat/desktop-local-credentials (serversQuerySchema, patrolRecordsQuerySchema,
# problemsQuerySchema, remediation listQuerySchema, unbindTelegramSchema).
# Patrol-tasks/records/rounds are available: tenant_id + ENABLE/FORCE RLS in
# 0082_core_tenant_rls.sql / 0083_extended_tenant_rls.sql, with request tenant
# context from registerTenantDatabasePlugin. The stale P0-3B "global" comment in
# routes/monitoring.ts is backend documentation debt (clean in Task 4).

openapi: 3.0.3
info:
  title: OpsMate Desktop public API contract (v1)
  version: "1.0.0"
  description: |
    Generated desktop allowlist OpenAPI. Not a full backend OpenAPI export.
    auth.config and auth.exchange are x-desktop-invocation: native_only
    (not IPC-callable). PKCE code/codeVerifier and redirectUri
    (${DESKTOP_REDIRECT_URI}) are Rust-owned only — never WebView inputs.
servers:
  - url: ${BASE_ORIGIN}
    description: Production control plane (fixed origin)
paths:
${pathsYaml}components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: Injected only by Rust cloud_transport; never supplied by WebView.
`;
}

/**
 * TypeScript allowlist: available + ipc_via_rust operation ids only.
 * Deterministic sort; React may invoke only these via cloud_call.
 * Exported array is Object.freeze'd — membership checks stay private in adapter.
 */
function generateTypeScriptIpcAllowlist(file) {
  const hash = contentHash(file);
  const ids = file.operations
    .filter(
      (op) =>
        op.availability === "available" && op.invocation === "ipc_via_rust",
    )
    .map((op) => op.id)
    .sort((a, b) => a.localeCompare(b));

  const arr = ids.map((id) => `  ${JSON.stringify(id)},`).join("\n");

  return `// @generated by scripts/generate-operations.mjs — DO NOT EDIT BY HAND
// source: contracts/desktop-operations.json
// content-hash: ${hash}
// regenerate: npm run contracts:generate
//
// IPC-callable operations only: availability=available && invocation=ipc_via_rust.
// React may pass these ids to cloud_call; native_only / blocked ops are excluded.

/** Sorted, frozen allowlist of WebView/business IPC operation ids. */
export const IPC_CALLABLE_OPERATION_IDS = Object.freeze([
${arr}
] as const);

/** Union of contract operation ids that React may request via cloud_call. */
export type IpcCallableOperationId = (typeof IPC_CALLABLE_OPERATION_IDS)[number];
`;
}

function main() {
  const check = process.argv.includes("--check");
  let file;
  try {
    file = JSON.parse(readFileSync(opsPath, "utf8"));
  } catch (e) {
    die(`failed to read ${opsPath}: ${e.message}`);
  }
  validate(file);
  // Re-normalize fixedBodyFields after validate mutates
  for (const op of file.operations) {
    op.fixedBodyFields = normalizeFixedBody(op.fixedBodyFields);
  }

  const nextRust = generateRust(file);
  const nextOpenApi = generateOpenApi(file);
  const nextTs = generateTypeScriptIpcAllowlist(file);

  if (check) {
    let prevRust = "";
    let prevOpenApi = "";
    let prevTs = "";
    try {
      prevRust = readFileSync(rustOutPath, "utf8");
    } catch {
      die(`missing generated file ${rustOutPath}; run npm run contracts:generate`);
    }
    try {
      prevOpenApi = readFileSync(openapiOutPath, "utf8");
    } catch {
      die(`missing generated file ${openapiOutPath}; run npm run contracts:generate`);
    }
    try {
      prevTs = readFileSync(tsOutPath, "utf8");
    } catch {
      die(`missing generated file ${tsOutPath}; run npm run contracts:generate`);
    }
    const rustDrift = prevRust !== nextRust;
    const openapiDrift = prevOpenApi !== nextOpenApi;
    const tsDrift = prevTs !== nextTs;
    if (rustDrift || openapiDrift || tsDrift) {
      const parts = [];
      if (rustDrift) parts.push(rustOutPath);
      if (openapiDrift) parts.push(openapiOutPath);
      if (tsDrift) parts.push(tsOutPath);
      die(`drift detected in ${parts.join(" and ")}; run npm run contracts:generate`);
    }
    console.log(
      "contracts:check ok — operations.rs, openapi-v1.yaml, and generated-operations.ts match desktop-operations.json",
    );
    return;
  }

  mkdirSync(dirname(rustOutPath), { recursive: true });
  mkdirSync(dirname(tsOutPath), { recursive: true });
  writeFileSync(rustOutPath, nextRust, "utf8");
  writeFileSync(openapiOutPath, nextOpenApi, "utf8");
  writeFileSync(tsOutPath, nextTs, "utf8");
  console.log(`wrote ${rustOutPath}`);
  console.log(`wrote ${openapiOutPath}`);
  console.log(`wrote ${tsOutPath}`);
}

main();
