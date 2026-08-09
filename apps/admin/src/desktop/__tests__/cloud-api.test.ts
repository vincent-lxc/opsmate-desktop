/**
 * Task 5 — desktop cloud_request adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const isTauri = vi.fn(() => true);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isTauri: () => isTauri(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("../../i18n", () => ({
  default: { language: "zh-CN" },
}));

describe("desktopApi / cloud_request", () => {
  beforeEach(() => {
    invoke.mockReset();
    isTauri.mockReturnValue(true);
    localStorage.clear();
  });

  afterEach(() => {
    isTauri.mockReturnValue(false);
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("GET invokes cloud_request exactly and never fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    invoke.mockResolvedValue({
      status: 200,
      body: { items: [], total: 0 },
    });

    const { desktopApi } = await import("../cloud-api");
    const out = await desktopApi<{ items: unknown[]; total: number }>(
      "/api/servers?page=1",
    );

    expect(out).toEqual({ items: [], total: 0 });
    expect(invoke).toHaveBeenCalledWith("cloud_request", {
      req: {
        method: "GET",
        path: "/api/servers?page=1",
        body: null,
        locale: "zh-CN",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("JSON POST parses body and returns payload", async () => {
    invoke.mockResolvedValue({
      status: 200,
      body: { id: "s1" },
    });
    const { desktopApi } = await import("../cloud-api");
    const out = await desktopApi<{ id: string }>("/api/servers", {
      method: "POST",
      body: JSON.stringify({ name: "web-1" }),
    });
    expect(out).toEqual({ id: "s1" });
    expect(invoke).toHaveBeenCalledWith("cloud_request", {
      req: {
        method: "POST",
        path: "/api/servers",
        body: { name: "web-1" },
        locale: "zh-CN",
      },
    });
  });

  it("204 returns undefined", async () => {
    invoke.mockResolvedValue({ status: 204, body: null });
    const { desktopApi } = await import("../cloud-api");
    const out = await desktopApi<void>("/api/servers/s1", { method: "DELETE" });
    expect(out).toBeUndefined();
  });

  it("maps non-2xx CloudResponse to ApiError", async () => {
    invoke.mockResolvedValue({
      status: 400,
      body: { error: "bad_request" },
    });
    const { desktopApi } = await import("../cloud-api");
    const { ApiError } = await import("../../api/client");
    await expect(desktopApi("/api/servers")).rejects.toBeInstanceOf(ApiError);
    await expect(desktopApi("/api/servers")).rejects.toMatchObject({
      status: 400,
      message: "bad_request",
    });
  });

  it("session_invalidated / 401 navigates to login and clears session", async () => {
    localStorage.setItem("opsmate_desktop_authenticated", "1");
    localStorage.setItem("opsmate_role", "admin");
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        pathname: "/dashboard/overview",
        href: "https://app.itops.sh/dashboard/overview",
      },
    });
    invoke.mockRejectedValue("session_invalidated");
    const { desktopApi } = await import("../cloud-api");
    const { ApiError } = await import("../../api/client");

    await expect(desktopApi("/api/servers")).rejects.toBeInstanceOf(ApiError);
    expect(localStorage.getItem("opsmate_desktop_authenticated")).toBeNull();
    expect(window.location.href).toBe("/login");
  });

  it("rejects FormData and absolute paths", async () => {
    const { desktopApi } = await import("../cloud-api");
    const { ApiError } = await import("../../api/client");
    await expect(
      desktopApi("/api/servers", { method: "POST", body: new FormData() }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(invoke).not.toHaveBeenCalled();

    await expect(
      desktopApi("https://evil.example/api/servers"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("allowlist rejects smuggling/blocked/method mismatch before cloud_request invoke", async () => {
    const { desktopApi } = await import("../cloud-api");
    const { ApiError } = await import("../../api/client");
    const cases: Array<[string, string]> = [
      ["GET", "/api/servers/%00"],
      ["GET", "/api/servers/%252e%252e/x"],
      ["GET", "/api/servers/%2e%2e/auth/me"],
      ["POST", "/api/auth/logto/exchange"],
      ["GET", "/api/auth/status"],
      ["PUT", "/api/servers"],
      ["GET", "/api/servers/%1f"],
    ];
    for (const [method, path] of cases) {
      invoke.mockClear();
      await expect(desktopApi(path, { method })).rejects.toMatchObject({
        name: "ApiError",
        status: 403,
        message: "route_not_allowed",
      });
      expect(invoke, `${method} ${path}`).not.toHaveBeenCalled();
      void ApiError;
    }
  });

  it("preserves non-401 upstream status from CloudResponse (not generic 502)", async () => {
    invoke.mockResolvedValue({
      status: 404,
      body: { error: "not_found" },
    });
    const { desktopApi } = await import("../cloud-api");
    await expect(desktopApi("/api/servers/missing")).rejects.toMatchObject({
      status: 404,
      message: "not_found",
    });
    invoke.mockResolvedValue({
      status: 500,
      body: { error: "upstream_failed" },
    });
    await expect(desktopApi("/api/servers")).rejects.toMatchObject({
      status: 500,
      message: "upstream_failed",
    });
  });

  it("never passes Authorization/token/origin fields to native broker", async () => {
    invoke.mockResolvedValue({ status: 200, body: {} });
    const { desktopApi } = await import("../cloud-api");
    await desktopApi("/api/auth/me", {
      method: "GET",
      headers: {
        Authorization: "Bearer stolen",
        Origin: "https://evil.example",
      },
    });
    const args = invoke.mock.calls[0]?.[1] as {
      req: Record<string, unknown>;
    };
    expect(args.req).toEqual({
      method: "GET",
      path: "/api/auth/me",
      body: null,
      locale: "zh-CN",
    });
    expect(JSON.stringify(args)).not.toMatch(/Bearer|stolen|evil|token|Authorization/i);
  });
});
