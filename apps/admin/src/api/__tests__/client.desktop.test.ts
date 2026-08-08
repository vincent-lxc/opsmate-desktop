/**
 * Task 5 — api() top-level desktop branch.
 * Task 10 — uses official @tauri-apps/api (no window.__TAURI__).
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

describe("api() desktop broker branch", () => {
  beforeEach(() => {
    invoke.mockReset();
    isTauri.mockReturnValue(true);
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("desktop GET uses cloud_request and never fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    invoke.mockResolvedValue({
      status: 200,
      body: { ok: true },
    });

    const { api } = await import("../client");
    const out = await api<{ ok: boolean }>("/api/servers?page=1");
    expect(out).toEqual({ ok: true });
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

  it("browser still uses fetch and does not invoke cloud_request", async () => {
    isTauri.mockReturnValue(false);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ browser: true }),
      json: async () => ({ browser: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("../client");
    const out = await api<{ browser: boolean }>("/api/servers?page=1");
    expect(out).toEqual({ browser: true });
    expect(fetchMock).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
