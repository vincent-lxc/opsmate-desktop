/**
 * Task 4: secret-free desktop session surface — no JWT in WebView.
 * Task 10: official @tauri-apps/api (no window.__TAURI__).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listen = vi.fn();
const isTauri = vi.fn(() => true);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isTauri: () => isTauri(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

describe("native-auth DesktopSessionStatus", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
    isTauri.mockReturnValue(true);
    localStorage.clear();
    listen.mockResolvedValue(() => {});
  });

  afterEach(() => {
    isTauri.mockReturnValue(false);
    localStorage.clear();
  });

  it("DesktopSessionStatus only allows secret-free fields", async () => {
    const { normalizeDesktopSessionStatus } = await import("../native-auth");
    const status = normalizeDesktopSessionStatus({
      authenticated: true,
      username: "u@example.com",
      role: "admin",
      mustChangePassword: false,
      expiresAtUnix: 123,
      reauthRequired: false,
      token: "leak",
      subject: "sub",
      tenantId: "t",
    });
    const keys = Object.keys(status).sort();
    expect(keys).toEqual(
      [
        "authenticated",
        "expiresAtUnix",
        "mustChangePassword",
        "reauthRequired",
        "role",
        "username",
      ].sort(),
    );
    for (const forbidden of [
      "token",
      "subject",
      "tenantId",
      "tenant_id",
      "workspaceId",
      "workspace_id",
      "codeVerifier",
      "state",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("refreshSessionStatus invokes auth_session_status and never stores opsmate_token", async () => {
    const { refreshSessionStatus } = await import("../native-auth");
    invoke.mockResolvedValue({
      authenticated: true,
      username: "u@example.com",
      role: "admin",
      mustChangePassword: false,
      expiresAtUnix: null,
      reauthRequired: false,
    });
    const got = await refreshSessionStatus();
    expect(invoke).toHaveBeenCalledWith("auth_session_status", {});
    expect(got.authenticated).toBe(true);
    expect(localStorage.getItem("opsmate_token")).toBeNull();
    expect(localStorage.getItem("opsmate_role")).toBe("admin");
    expect(localStorage.getItem("opsmate_username")).toBe("u@example.com");
    const wire = JSON.stringify(got);
    expect(wire).not.toMatch(/token|subject|tenant|workspace|verifier/i);
  });

  it("initNativeAuth subscribes to opsmate:auth-session and refreshes on startup", async () => {
    const { initNativeAuth, AUTH_SESSION_TAURI_EVENT } = await import("../native-auth");
    invoke.mockResolvedValue({
      authenticated: false,
      username: null,
      role: null,
      mustChangePassword: false,
      expiresAtUnix: null,
      reauthRequired: false,
    });
    await initNativeAuth();
    expect(invoke).toHaveBeenCalledWith("auth_session_status", {});
    expect(listen).toHaveBeenCalled();
    const eventName = listen.mock.calls[0]?.[0];
    expect(eventName).toBe(AUTH_SESSION_TAURI_EVENT);
    expect(eventName).toBe("opsmate:auth-session");
  });
});
