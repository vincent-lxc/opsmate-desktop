import { describe, expect, it } from "vitest";
import { isDesktopApiRequestAllowed } from "../generated-api-routes";

/**
 * Shared fixture corpus for desktop API route catalog (TS + Rust must agree).
 * Covers allowed UI families and reject paths for auth secrets, absolute URLs,
 * backslashes, encoded slash/backslash/dot segments, malformed paths, method mismatch.
 */
const ALLOWED: Array<[string, string]> = [
  ["GET", "/api/servers?page=1"],
  ["POST", "/api/servers/srv_1/terminal/ai"],
  ["GET", "/api/security/credentials"],
  ["GET", "/api/monitoring/patrol-records?limit=20"],
  ["GET", "/api/dashboard/overview"],
  ["GET", "/api/auth/me"],
  ["POST", "/api/auth/me"],
  ["DELETE", "/api/auth/me"],
  ["GET", "/api/auth/telegram-widget"],
  ["GET", "/api/subscription/ai"],
  ["POST", "/api/subscription/ai"],
  ["PATCH", "/api/servers/srv_1"],
  ["DELETE", "/api/servers/srv_1"],
  ["POST", "/api/security/credentials"],
  ["PATCH", "/api/security/credentials/cred_1"],
  ["DELETE", "/api/security/credentials/cred_1"],
  ["POST", "/api/monitoring/patrol-records"],
  ["GET", "/api/problems"],
  ["POST", "/api/problems"],
  ["GET", "/api/oncall/remediation-queue"],
  ["POST", "/api/oncall/remediation-queue"],
  ["GET", "/api/incident-reports"],
  ["POST", "/api/incident-reports"],
  // ordinary query strings may contain percent-encoding (not part of path match)
  ["GET", "/api/servers?page=1&q=100%25"],
  ["GET", "/api/monitoring/patrol-records?limit=20&label=a%20b"],
];

const REJECTED: Array<[string, string, string]> = [
  // auth-secret routes (blocked list)
  ["POST", "/api/auth/logto/exchange", "blocked auth secret"],
  ["GET", "/api/auth/logto/config", "blocked auth secret"],
  ["POST", "/api/auth/login", "blocked auth secret"],
  ["POST", "/api/auth/refresh", "blocked auth secret"],
  // absolute URLs
  ["POST", "https://evil.example/api/servers", "absolute URL"],
  ["GET", "http://evil.example/api/servers", "absolute URL"],
  ["GET", "//evil.example/api/servers", "protocol-relative URL"],
  // backslashes
  ["GET", "/api/servers\\evil", "backslash"],
  ["GET", "\\api\\servers", "backslash"],
  // encoded slash / backslash / dot segments
  ["GET", "/api/servers/%2e%2e/auth/me", "encoded dot segment"],
  ["GET", "/api/servers/%2E%2E/auth/me", "encoded dot segment upper"],
  ["GET", "/api/servers/%2fadmin", "encoded slash"],
  ["GET", "/api/servers/%2Fadmin", "encoded slash upper"],
  ["GET", "/api/servers/%5cadmin", "encoded backslash"],
  ["GET", "/api/servers/%5Cadmin", "encoded backslash upper"],
  ["GET", "/api/servers/%2e%2e%2fauth/me", "encoded traversal"],
  // double-encoded separators / dot traversal (%25…) and mixed case
  ["GET", "/api/servers/%252e%252e/x", "double-encoded dot"],
  ["GET", "/api/servers/%252E%252E/x", "double-encoded dot upper"],
  ["GET", "/api/servers/%252f", "double-encoded slash"],
  ["GET", "/api/servers/%252F", "double-encoded slash upper"],
  ["GET", "/api/servers/%255c", "double-encoded backslash"],
  ["GET", "/api/servers/%255C", "double-encoded backslash upper"],
  ["GET", "/api/servers/%25", "encoded percent"],
  // percent-encoded ASCII controls in descendant segments
  ["GET", "/api/servers/%00", "encoded NUL"],
  ["GET", "/api/servers/%01", "encoded SOH"],
  ["GET", "/api/servers/%1f", "encoded US"],
  ["GET", "/api/servers/%1F", "encoded US upper"],
  ["GET", "/api/servers/%7f", "encoded DEL"],
  ["GET", "/api/servers/%7F", "encoded DEL upper"],
  ["GET", "/api/servers/srv_%00/terminal", "encoded NUL mid-segment"],
  // raw path traversal / empty segments (malformed)
  ["GET", "/api/servers/../auth/me", "raw dotdot"],
  ["GET", "/api/servers/./auth", "raw dot segment"],
  ["GET", "/api/servers//terminal", "empty segment"],
  ["GET", "/api//servers", "empty segment after api"],
  ["GET", "", "empty path"],
  ["GET", "api/servers", "missing leading slash"],
  ["GET", "/servers", "not under /api/"],
  ["GET", "/api", "api root only"],
  ["GET", "/api/", "api root trailing"],
  ["GET", "/api/servers?page=1#frag", "fragment not allowed"],
  // method mismatches
  ["PUT", "/api/servers", "method not allowlisted"],
  ["DELETE", "/api/dashboard/overview", "method not allowlisted"],
  ["POST", "/api/auth/telegram-widget", "method not allowlisted"],
  ["PATCH", "/api/problems", "method not allowlisted"],
  ["DELETE", "/api/incident-reports", "method not allowlisted"],
  // prefix boundary: must not treat longer sibling as match
  ["GET", "/api/servers_evil", "prefix boundary"],
  ["GET", "/api/monitoringX", "prefix boundary"],
];

describe("desktop generated API route catalog", () => {
  it("allows Web UI route families used by the admin client", () => {
    for (const [method, path] of ALLOWED) {
      expect(isDesktopApiRequestAllowed(method, path), `${method} ${path}`).toBe(true);
    }
  });

  it("rejects auth-secret, absolute, smuggling, malformed, and method-mismatch routes", () => {
    for (const [method, path, reason] of REJECTED) {
      expect(isDesktopApiRequestAllowed(method, path), `${reason}: ${method} ${path}`).toBe(
        false,
      );
    }
  });

  it("plan fixture corpus (explicit)", () => {
    expect(isDesktopApiRequestAllowed("GET", "/api/servers?page=1")).toBe(true);
    expect(isDesktopApiRequestAllowed("POST", "/api/servers/srv_1/terminal/ai")).toBe(true);
    expect(isDesktopApiRequestAllowed("GET", "/api/security/credentials")).toBe(true);
    expect(isDesktopApiRequestAllowed("GET", "/api/monitoring/patrol-records?limit=20")).toBe(
      true,
    );
    expect(isDesktopApiRequestAllowed("POST", "/api/auth/logto/exchange")).toBe(false);
    expect(isDesktopApiRequestAllowed("POST", "https://evil.example/api/servers")).toBe(false);
    expect(isDesktopApiRequestAllowed("GET", "/api/servers/%2e%2e/auth/me")).toBe(false);
  });

  it("P2 rejects double-encoded separators/dot and encoded controls; keeps query encoding", () => {
    expect(isDesktopApiRequestAllowed("GET", "/api/servers/%252e%252e/x")).toBe(false);
    expect(isDesktopApiRequestAllowed("GET", "/api/servers/%252f")).toBe(false);
    expect(isDesktopApiRequestAllowed("GET", "/api/servers/%255c")).toBe(false);
    expect(isDesktopApiRequestAllowed("GET", "/api/servers/%252E%252E/x")).toBe(false);
    expect(isDesktopApiRequestAllowed("GET", "/api/servers/%252F")).toBe(false);
    expect(isDesktopApiRequestAllowed("GET", "/api/servers/%255C")).toBe(false);
    expect(isDesktopApiRequestAllowed("GET", "/api/servers/%00")).toBe(false);
    expect(isDesktopApiRequestAllowed("GET", "/api/servers/%01")).toBe(false);
    expect(isDesktopApiRequestAllowed("GET", "/api/servers/%1f")).toBe(false);
    expect(isDesktopApiRequestAllowed("GET", "/api/servers/%7f")).toBe(false);
    expect(isDesktopApiRequestAllowed("GET", "/api/servers?page=1&q=100%25")).toBe(true);
  });
});
