import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const apiMock = vi.fn();
const invoke = vi.fn();
const isTauri = vi.fn(() => false);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isTauri: () => isTauri(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

import { AuthGate } from "../AuthGate";

describe("AuthGate desktop authenticated status", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.mockReset();
    apiMock.mockResolvedValue({ enabled: true });
    invoke.mockReset();
    isTauri.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    isTauri.mockReturnValue(false);
  });

  function renderGate() {
    return render(
      <MemoryRouter initialEntries={["/dashboard/overview"]}>
        <Routes>
          <Route
            path="/dashboard/overview"
            element={
              <AuthGate>
                <div>protected-content</div>
              </AuthGate>
            }
          />
          <Route path="/login" element={<div>login-page</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("desktop with native session flag allows protected content without JWT", async () => {
    isTauri.mockReturnValue(true);
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
      throw new Error(`unexpected ${cmd}`);
    });
    // Pre-seed flag; refreshSessionStatus will re-apply from native status.
    localStorage.setItem("opsmate_desktop_authenticated", "1");
    localStorage.setItem("opsmate_role", "admin");
    localStorage.setItem("opsmate_username", "desk@ex.com");
    expect(localStorage.getItem("opsmate_token")).toBeNull();

    renderGate();
    // Desktop must not use mocked browser api(/api/auth/status).
    expect(apiMock).not.toHaveBeenCalled();
    expect(await screen.findByText("protected-content")).toBeTruthy();
    expect(screen.queryByText("login-page")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("auth_session_status", {});
  });

  it("desktop without native session flag redirects to login", async () => {
    isTauri.mockReturnValue(true);
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
      throw new Error(`unexpected ${cmd}`);
    });

    renderGate();
    expect(apiMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText("login-page")).toBeTruthy();
    });
    expect(screen.queryByText("protected-content")).toBeNull();
  });

  it("browser still requires opsmate_token for protected content", async () => {
    // no Tauri
    renderGate();
    await waitFor(() => {
      expect(screen.getByText("login-page")).toBeTruthy();
    });

    cleanup();
    localStorage.setItem("opsmate_token", "browser-jwt");
    localStorage.setItem("opsmate_role", "admin");
    renderGate();
    expect(await screen.findByText("protected-content")).toBeTruthy();
  });
});
