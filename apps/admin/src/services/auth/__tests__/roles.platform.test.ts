import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const isTauri = vi.fn(() => false);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isTauri: () => isTauri(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import {
  clearAuthSession,
  getToken,
  isPlatformAdmin,
  logout,
  setAuthSession,
} from "../roles";

/** Minimal JWT for tests: header.payload.sig with payload base64url JSON. */
function fakeJwt(payload: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `hdr.${body}.sig`;
}

describe("isPlatformAdmin", () => {
  beforeEach(() => {
    clearAuthSession();
  });

  it("is true only for default tenant + admin", () => {
    setAuthSession(
      fakeJwt({ username: "a", role: "admin", tenant_id: "default" }),
      "admin",
      "a",
    );
    expect(isPlatformAdmin()).toBe(true);
  });

  it("is false for tnt_* admin", () => {
    setAuthSession(
      fakeJwt({ username: "a", role: "admin", tenant_id: "tnt_x" }),
      "admin",
      "a",
    );
    expect(isPlatformAdmin()).toBe(false);
  });

  it("is false for default operator", () => {
    setAuthSession(
      fakeJwt({ username: "a", role: "operator", tenant_id: "default" }),
      "operator",
      "a",
    );
    expect(isPlatformAdmin()).toBe(false);
  });
});

describe("logout", () => {
  const assignMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    assignMock.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign: assignMock },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears OpsMate state and ends the Logto SSO session", async () => {
    setAuthSession(fakeJwt({ role: "workspace_owner" }), "workspace_owner", "free@example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          enabled: true,
          endpoint: "https://auth.example.com",
          appId: "app_test",
          redirectUri: "https://app.example.com/login/logto/callback",
          postLogoutRedirectUri: "https://app.example.com/login",
          scopes: ["openid"],
        }),
      }),
    );

    await logout();

    expect(localStorage.getItem("opsmate_token")).toBeNull();
    const url = new URL(String(assignMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://auth.example.com/oidc/session/end");
    expect(url.searchParams.get("client_id")).toBe("app_test");
  });

  it("falls back to the local login page when Logto config is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await logout();

    expect(assignMock).toHaveBeenCalledWith("/login");
  });
});

describe("getToken platform branch", () => {
  beforeEach(() => {
    localStorage.clear();
    isTauri.mockReturnValue(false);
    invoke.mockReset();
  });

  afterEach(() => {
    isTauri.mockReturnValue(false);
    localStorage.clear();
  });

  it("browser still reads localStorage opsmate_token", () => {
    localStorage.setItem("opsmate_token", "browser-jwt");
    expect(getToken()).toBe("browser-jwt");
  });

  it("Tauri getToken is always null even if localStorage has a token", () => {
    isTauri.mockReturnValue(true);
    localStorage.setItem("opsmate_token", "should-not-leak");
    expect(getToken()).toBeNull();
  });

  it("setAuthSession on desktop never writes opsmate_token", async () => {
    isTauri.mockReturnValue(true);
    setAuthSession("desktop-jwt-leak", "admin", "desk@ex.com");
    expect(localStorage.getItem("opsmate_token")).toBeNull();
    expect(localStorage.getItem("opsmate_role")).toBe("admin");
    expect(localStorage.getItem("opsmate_username")).toBe("desk@ex.com");
    expect(getToken()).toBeNull();
  });
});

describe("desktop logout invokes native auth_logout", () => {
  const assignMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    assignMock.mockReset();
    invoke.mockReset();
    isTauri.mockReturnValue(true);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign: assignMock, href: "https://app.itops.sh/dashboard" },
    });
    localStorage.setItem("opsmate_desktop_authenticated", "1");
    localStorage.setItem("opsmate_role", "admin");
    localStorage.setItem("opsmate_username", "desk@ex.com");
  });

  afterEach(() => {
    isTauri.mockReturnValue(false);
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("calls auth_logout before/with UI cleanup and does not use browser Logto fetch", async () => {
    invoke.mockResolvedValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await logout();

    expect(invoke).toHaveBeenCalledWith("auth_logout", {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("opsmate_desktop_authenticated")).toBeNull();
    expect(localStorage.getItem("opsmate_role")).toBeNull();
    expect(assignMock).toHaveBeenCalledWith("/login");
  });

  it("browser logout still clears storage and hits Logto config without auth_logout", async () => {
    isTauri.mockReturnValue(false);
    setAuthSession(fakeJwt({ role: "admin" }), "admin", "b@ex.com");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          enabled: true,
          endpoint: "https://auth.example.com",
          appId: "app_test",
          redirectUri: "https://app.example.com/login/logto/callback",
          postLogoutRedirectUri: "https://app.example.com/login",
          scopes: ["openid"],
        }),
      }),
    );

    await logout();

    expect(invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem("opsmate_token")).toBeNull();
    const url = new URL(String(assignMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://auth.example.com/oidc/session/end");
  });
});
