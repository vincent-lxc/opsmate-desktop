/**
 * Task 5 audit P1 — desktop AuthGate uses real api/desktop transport (no api mock).
 * Must never call blocked /api/auth/status; never fail-open.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

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

describe("AuthGate desktop integration (real api + native transport)", () => {
  beforeEach(() => {
    invoke.mockReset();
    isTauri.mockReturnValue(true);
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    isTauri.mockReturnValue(false);
    vi.resetModules();
  });

  async function renderGate() {
    const { AuthGate } = await import("../AuthGate");
    return render(
      <MemoryRouter initialEntries={["/dashboard/overview"]}>
        <Routes>
          <Route
            path="/dashboard/overview"
            element={
              <AuthGate>
                <div>protected-shell</div>
              </AuthGate>
            }
          />
          <Route path="/login" element={<div>login-page</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("unauthenticated native status redirects to login and never cloud_request /api/auth/status", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "auth_session_status") {
        return {
          authenticated: false,
          username: null,
          role: null,
          mustChangePassword: false,
          expiresAtUnix: null,
          reauthRequired: false,
        };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    await renderGate();
    await waitFor(() => {
      expect(screen.getByText("login-page")).toBeTruthy();
    });
    expect(screen.queryByText("protected-shell")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("auth_session_status", {});
    const cmds = invoke.mock.calls.map((c) => c[0] as string);
    expect(cmds).not.toContain("cloud_request");
    expect(
      invoke.mock.calls.some(
        (c) =>
          c[0] === "cloud_request" &&
          JSON.stringify(c[1] ?? {}).includes("/api/auth/status"),
      ),
    ).toBe(false);
  });

  it("authenticated secret-free native status renders protected shell without JWT", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "auth_session_status") {
        return {
          authenticated: true,
          username: "desk@ex.com",
          role: "admin",
          mustChangePassword: false,
          expiresAtUnix: null,
          reauthRequired: false,
        };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    await renderGate();
    expect(await screen.findByText("protected-shell")).toBeTruthy();
    expect(screen.queryByText("login-page")).toBeNull();
    expect(localStorage.getItem("opsmate_token")).toBeNull();
    expect(localStorage.getItem("opsmate_desktop_authenticated")).toBe("1");
    expect(localStorage.getItem("opsmate_role")).toBe("admin");
    expect(invoke).toHaveBeenCalledWith("auth_session_status", {});
    expect(invoke.mock.calls.some((c) => c[0] === "cloud_request")).toBe(false);
  });
});
