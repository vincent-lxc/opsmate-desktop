/**
 * Task 3 / 3D — desktop cloud operations contract security tests.
 *
 * HTTP wire allowlists are NOT automatically WebView inputs. Each operation has
 * explicit invocation: native_only | ipc_via_rust. PKCE code/codeVerifier and
 * redirectUri are Rust-owned; auth.exchange is not IPC-callable.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const opsPath = resolve(root, "contracts/desktop-operations.json");
const openapiPath = resolve(root, "contracts/openapi-v1.yaml");
const changelogPath = resolve(root, "contracts/CHANGELOG.md");
const generatedRustPath = resolve(
  root,
  "src-tauri/src/cloud_transport/operations.rs",
);

type Operation = {
  id: string;
  method: string;
  path: string;
  authenticated: boolean;
  pathParams: string[];
  queryFields: string[];
  bodyFields: string[];
  fixedBodyFields?: Record<string, string>;
  availability: "available" | "blocked_pending_tenant_isolation";
  invocation: "native_only" | "ipc_via_rust";
  url?: string;
};

type OperationsFile = {
  version: number;
  baseOrigin: string;
  wsOrigin?: string;
  desktopRedirectUri?: string;
  operations: Operation[];
};

const REQUIRED_ID_PREFIXES = [
  "auth.config",
  "auth.exchange",
  "auth.me",
  "servers.",
  "monitoring.foundation.",
  "monitoring.applications.",
  "monitoring.patrolTasks.",
  "monitoring.patrolRecords.",
  "problems.",
  "remediation.",
  "subscription.",
  "account.telegram.",
] as const;

const FORBIDDEN_WIRE_FIELDS = [
  "authorization",
  "bearer",
  "access_token",
  "refresh_token",
  "session_token",
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
];

/** Must never appear on IPC-callable operation allowlists. */
const FORBIDDEN_IPC_FIELDS = [
  ...FORBIDDEN_WIRE_FIELDS,
  "code",
  "codeverifier",
  "code_verifier",
];

const DESKTOP_REDIRECT_URI = "https://app.itops.sh/login/desktop/callback";

function loadOperations(): OperationsFile {
  expect(existsSync(opsPath), "contracts/desktop-operations.json must exist").toBe(
    true,
  );
  return JSON.parse(readFileSync(opsPath, "utf8")) as OperationsFile;
}

function wireFields(op: Operation): string[] {
  return [...op.pathParams, ...op.queryFields, ...op.bodyFields];
}

describe("desktop cloud operations contract", () => {
  it("pins openapi, operations json, changelog, and generated rust artifacts", () => {
    expect(existsSync(openapiPath)).toBe(true);
    expect(existsSync(opsPath)).toBe(true);
    expect(existsSync(changelogPath)).toBe(true);
    expect(existsSync(generatedRustPath)).toBe(true);
  });

  it("locks base origin, desktop redirect, and version 1", () => {
    const file = loadOperations();
    expect(file.version).toBe(1);
    expect(file.baseOrigin).toBe("https://app.itops.sh");
    expect(file.wsOrigin).toBe("wss://app.itops.sh");
    expect(file.desktopRedirectUri).toBe(DESKTOP_REDIRECT_URI);
    expect(file.operations.length).toBeGreaterThanOrEqual(12);
  });

  it("covers required product operation families", () => {
    const file = loadOperations();
    const ids = file.operations.map((o) => o.id);

    for (const prefix of REQUIRED_ID_PREFIXES) {
      const hit = ids.some(
        (id) => id === prefix || id.startsWith(prefix) || id === prefix.replace(/\.$/, ""),
      );
      expect(hit, `missing operation family: ${prefix}`).toBe(true);
    }

    expect(ids).toContain("auth.config");
    expect(ids).toContain("auth.exchange");
    expect(ids).toContain("auth.me");
  });

  it("requires explicit allowlists, availability, and invocation on every operation", () => {
    const file = loadOperations();
    for (const op of file.operations) {
      expect(Array.isArray(op.pathParams), `${op.id} pathParams`).toBe(true);
      expect(Array.isArray(op.queryFields), `${op.id} queryFields`).toBe(true);
      expect(Array.isArray(op.bodyFields), `${op.id} bodyFields`).toBe(true);
      expect(
        op.availability === "available" ||
          op.availability === "blocked_pending_tenant_isolation",
        `${op.id} availability`,
      ).toBe(true);
      expect(
        op.invocation === "native_only" || op.invocation === "ipc_via_rust",
        `${op.id} invocation must be explicit`,
      ).toBe(true);
      expect(typeof op.authenticated).toBe("boolean");

      const pathParamNames = [
        ...op.path.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g),
      ].map((m) => m[1]!);
      expect([...op.pathParams].sort()).toEqual([...pathParamNames].sort());

      const all = wireFields(op);
      expect(new Set(all).size, `${op.id} duplicate fields`).toBe(all.length);
    }
  });

  it("contains no arbitrary URL or authorization wire fields", () => {
    const file = loadOperations();
    for (const op of file.operations) {
      expect(op, op.id).not.toHaveProperty("url");
      expect(op.method).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/);
      expect(op.path.startsWith("/api/")).toBe(true);
      expect(op.path).not.toMatch(/^https?:/i);
      expect(op.path).not.toMatch(/[?#]/);
      expect(op.path).not.toMatch(/\.\./);
      expect(op.path).not.toContain("logto-admin");
      expect(JSON.stringify(op)).not.toMatch(/logto-admin\.itops\.sh/i);

      for (const field of wireFields(op)) {
        const lower = field.toLowerCase();
        expect(FORBIDDEN_WIRE_FIELDS, `${op.id} wire field ${field}`).not.toContain(
          lower,
        );
      }

      expect(op.path).not.toMatch(/\{url\}/i);
      expect(op.path).not.toMatch(/\{redirect/i);
    }
  });

  it("auth.config and auth.exchange are native_only; PKCE is Rust-owned wire schema", () => {
    const file = loadOperations();
    const byId = Object.fromEntries(file.operations.map((o) => [o.id, o]));

    expect(byId["auth.config"]?.invocation).toBe("native_only");
    expect(byId["auth.config"]?.authenticated).toBe(false);

    const exchange = byId["auth.exchange"];
    expect(exchange).toBeDefined();
    expect(exchange!.invocation).toBe("native_only");
    expect(exchange!.method).toBe("POST");
    expect(exchange!.path).toBe("/api/auth/logto/exchange");
    expect(exchange!.authenticated).toBe(false);
    // Wire schema only — not WebView/IPC inputs
    expect(exchange!.bodyFields).toEqual(["code", "codeVerifier"]);
    expect(exchange!.bodyFields).not.toContain("redirectUri");
    expect(exchange!.fixedBodyFields).toEqual({
      redirectUri: DESKTOP_REDIRECT_URI,
    });

    expect(byId["auth.me"]?.invocation).toBe("ipc_via_rust");
    expect(byId["auth.me"]?.authenticated).toBe(true);
  });

  it("IPC-callable ops never accept PKCE secrets, redirectUri, tokens, or URL fields", () => {
    const file = loadOperations();
    for (const op of file.operations) {
      if (op.invocation !== "ipc_via_rust") continue;
      for (const field of wireFields(op)) {
        const lower = field.toLowerCase();
        expect(
          FORBIDDEN_IPC_FIELDS,
          `${op.id} must not expose IPC field ${field}`,
        ).not.toContain(lower);
      }
    }
  });

  it("matches backend query/body field names for list/unbind operations", () => {
    const file = loadOperations();
    const byId = Object.fromEntries(file.operations.map((o) => [o.id, o]));

    expect(byId["servers.list"]?.queryFields).toEqual([
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
    ]);

    expect(byId["monitoring.patrolRecords.list"]?.queryFields).toEqual([
      "task_id",
      "server_group_name",
      "server_id",
      "verdict",
      "limit",
      "offset",
    ]);

    expect(byId["problems.list"]?.queryFields).toEqual([
      "server_id",
      "server_name",
      "server_ip",
      "root_cause_signature",
      "problem_state",
      "binding_title",
      "event_id",
      "filter_preset",
      "page",
      "page_size",
    ]);

    expect(byId["remediation.list"]?.queryFields).toEqual([
      "exit_status",
      "page",
      "page_size",
    ]);

    expect(byId["account.telegram.unbind"]?.bodyFields).toEqual([
      "current_password",
    ]);
  });

  it("marks patrol ops available under tenant RLS (Monitoring Center)", () => {
    const file = loadOperations();
    const patrol = file.operations.filter(
      (o) =>
        o.id.startsWith("monitoring.patrolTasks.") ||
        o.id.startsWith("monitoring.patrolRecords.") ||
        o.id.startsWith("monitoring.patrolRounds."),
    );
    expect(patrol.length).toBeGreaterThanOrEqual(4);
    for (const op of patrol) {
      expect(op.availability).toBe("available");
      expect(op.invocation).toBe("ipc_via_rust");
    }
    const blocked = file.operations.filter(
      (o) => o.availability === "blocked_pending_tenant_isolation",
    );
    expect(blocked.length).toBe(0);
  });

  it("generated Rust exposes Invocation, is_ipc_callable, and rejects native-only via IPC", () => {
    const rust = readFileSync(generatedRustPath, "utf8");
    const file = loadOperations();

    expect(rust).toMatch(/pub enum Operation/);
    expect(rust).toMatch(/pub struct OperationSpec/);
    expect(rust).toMatch(/pub enum Invocation/);
    expect(rust).toMatch(/NativeOnly/);
    expect(rust).toMatch(/IpcViaRust/);
    expect(rust).toMatch(/pub fn is_ipc_callable/);
    expect(rust).toMatch(/pub fn is_callable/);
    expect(rust).toMatch(/pub const ALL_OPERATIONS/);
    expect(rust).toMatch(/BlockedPendingTenantIsolation/);
    expect(rust).toContain(DESKTOP_REDIRECT_URI);
    expect(rust).not.toMatch(/logto-admin/i);
    expect(rust).not.toMatch(/Authorization:\s*Bearer/i);

    for (const op of file.operations) {
      expect(rust, op.id).toContain(op.id);
    }

    expect(rust).toMatch(/auth\.exchange[\s\S]*Invocation::NativeOnly|Invocation::NativeOnly[\s\S]*auth\.exchange/);
    expect(rust).toMatch(/fn native_only_ops_are_rejected_by_ipc_callable_helper|is_ipc_callable/);
    expect(rust).toMatch(/!is_ipc_callable\(Operation::AuthExchange\)|auth\.exchange must not be IPC/);
  });

  it("OpenAPI documents invocation and does not claim WebView owns auth.exchange fields", () => {
    const file = loadOperations();
    const openapi = readFileSync(openapiPath, "utf8");

    for (const op of file.operations) {
      expect(openapi, `operationId ${op.id}`).toContain(`operationId: ${op.id}`);
      expect(openapi).toContain(`x-desktop-invocation: ${op.invocation}`);
    }

    expect(openapi).toContain("x-desktop-ipc-callable: false");
    expect(openapi).toContain("redirectUri");
    expect(openapi).toContain(DESKTOP_REDIRECT_URI);
    expect(openapi).toMatch(/x-fixed-body|Rust-owned|x-owned-by: native/i);
    // Must not claim exchange body fields are WebView-controlled
    expect(openapi).not.toMatch(
      /operationId: auth\.exchange[\s\S]{0,800}Caller-controlled WebView/,
    );
    expect(openapi).toMatch(/native_only/);
    expect(changelogMentionsNativeOnly()).toBe(true);
  });
});

function changelogMentionsNativeOnly(): boolean {
  const text = readFileSync(changelogPath, "utf8");
  return /native_only|native-only|Rust-owned/i.test(text);
}
