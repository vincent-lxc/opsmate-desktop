/**
 * Task 5: React native-auth surface — secret-free IPC only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  beginLogin,
  sessionStatus,
  logout,
  type SessionStatus,
  type AuthBeginResult,
} from "../native-auth";

describe("native-auth", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("beginLogin invokes auth_begin_logto with no args and secret-free result", async () => {
    invoke.mockResolvedValue({ started: true });
    const result = await beginLogin();
    expect(invoke).toHaveBeenCalledWith("auth_begin_logto");
    expect(invoke.mock.calls[0]).toHaveLength(1);
    expect(result).toEqual({ started: true });
    const payload = JSON.stringify(result);
    expect(payload).not.toContain("token");
    expect(payload).not.toContain("verifier");
    expect(payload).not.toContain("state");
    expect(payload).not.toContain("codeVerifier");
  });

  it("sessionStatus type and invoke exclude secrets", async () => {
    const status: SessionStatus = {
      authenticated: true,
      username: "u@example.com",
      role: "admin",
      reauthRequired: false,
    };
    invoke.mockResolvedValue(status);
    const got = await sessionStatus();
    expect(invoke).toHaveBeenCalledWith("auth_session_status");
    expect(got.authenticated).toBe(true);
    expect(got.username).toBe("u@example.com");
    expect(got.role).toBe("admin");
    expect(got.reauthRequired).toBe(false);
    const keys = Object.keys(got);
    for (const forbidden of [
      "token",
      "verifier",
      "code",
      "state",
      "subject",
      "tenant_id",
      "tenantId",
      "workspace_id",
      "workspaceId",
      "codeVerifier",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    const wire = JSON.stringify(got);
    expect(wire).not.toMatch(/token|verifier|subject|tenant|workspace/);
  });

  it("logout invokes auth_logout only", async () => {
    invoke.mockResolvedValue(undefined);
    await logout();
    expect(invoke).toHaveBeenCalledWith("auth_logout");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("SessionStatus and AuthBeginResult only expose safe fields at type level", () => {
    // Compile-time contract exercised via assignment; runtime shape check.
    const status: SessionStatus = {
      authenticated: false,
      reauthRequired: true,
    };
    const begin: AuthBeginResult = { started: true };
    expect(Object.keys(status).sort()).toEqual(["authenticated", "reauthRequired"]);
    expect(Object.keys(begin)).toEqual(["started"]);
    // Optional fields when present remain username/role only
    const full: SessionStatus = {
      authenticated: true,
      username: "a",
      role: "r",
      reauthRequired: false,
    };
    expect(Object.keys(full).sort()).toEqual([
      "authenticated",
      "reauthRequired",
      "role",
      "username",
    ]);
  });

  it("only named auth commands are used (no generic URL/HTTP IPC)", async () => {
    invoke.mockResolvedValue({ started: true });
    await beginLogin();
    invoke.mockResolvedValue({
      authenticated: false,
      reauthRequired: false,
    });
    await sessionStatus();
    invoke.mockResolvedValue(undefined);
    await logout();

    const commands = invoke.mock.calls.map((c) => c[0] as string);
    expect(commands).toEqual([
      "auth_begin_logto",
      "auth_session_status",
      "auth_logout",
    ]);
    for (const banned of [
      "auth_on_unauthorized",
      "fetch_url",
      "open_url",
      "generic_http",
      "http_request",
    ]) {
      expect(commands).not.toContain(banned);
    }
  });
});
