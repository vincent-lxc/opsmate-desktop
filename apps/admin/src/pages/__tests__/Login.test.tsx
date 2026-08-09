import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../i18n";
import { api } from "../../api/client";
import { AppProvider } from "../../providers/AppProvider";
import { LoginPage } from "../Login";

vi.mock("../../api/client", () => ({ api: vi.fn() }));

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === "/api/auth/logto/config") {
      return {
        enabled: false,
        endpoint: null,
        appId: null,
        redirectUri: "",
        postLogoutRedirectUri: "",
        scopes: [],
      } as never;
    }
    if (path === "/api/auth/telegram-widget") {
      return { enabled: false, configured: false } as never;
    }
    throw new Error(`Unexpected API call: ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LoginPage desktop entry", () => {
  it("links to the canonical download page and shows current availability", async () => {
    render(
      <MemoryRouter>
        <AppProvider>
          <AntApp>
            <LoginPage />
          </AntApp>
        </AppProvider>
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", { name: "下载 OpsMate Desktop" });
    expect(link).toHaveAttribute("href", "http://127.0.0.1:5173/download/");
    expect(screen.getByText("macOS、Linux 已推出 · Windows 即将推出")).toBeInTheDocument();
    expect(screen.getByText("永久免费：无限主机与每月 500 次 AI 调用")).toBeInTheDocument();
  });
});
