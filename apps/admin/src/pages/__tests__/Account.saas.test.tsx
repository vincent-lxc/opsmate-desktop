import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../i18n";
import { EntitlementsProvider } from "../../providers/EntitlementsProvider";
import { FULL_ENTITLEMENTS } from "../../services/entitlements";
import { AccountPage } from "../Account";
import { api } from "../../api/client";
import { isDesktopRuntime } from "../../desktop/tauri-bridge";
import { openExternalRoute } from "../../desktop/external-navigation";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
vi.mock("../../desktop/tauri-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../desktop/tauri-bridge")>();
  return { ...actual, isDesktopRuntime: vi.fn(() => false) };
});
vi.mock("../../desktop/external-navigation", () => ({
  openExternalRoute: vi.fn(async () => undefined),
}));

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === "/api/auth/me") {
      return {
        username: "free@example.com",
        role: "admin",
        has_password: false,
      } as never;
    }
    throw new Error(`Unexpected API call: ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AccountPage permanent Free SaaS", () => {
  it("renders My Subscription and refreshes status after Checkout success", async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/auth/me") {
        return { username: "free@example.com", role: "admin", has_password: false } as never;
      }
      if (path === "/api/subscription/ai") {
        return {
          period: "2026-08",
          usage: { used: 0, base_quota: 500, paid_quota: 0, total_quota: 500, remaining: 500 },
          subscription: {
            status: null,
            interval: null,
            quantity: 0,
            current_period_end: null,
            cancel_at_period_end: false,
            can_checkout: true,
            can_manage: false,
          },
          billing_configured: true,
        } as never;
      }
      throw new Error(`Unexpected API call: ${path}`);
    });
    render(
      <MemoryRouter initialEntries={["/account?tab=subscription&checkout=success"]}>
        <AntApp>
          <EntitlementsProvider
            value={{ ...FULL_ENTITLEMENTS, plan: "free", trial_ends_at: null }}
          >
            <AccountPage />
          </EntitlementsProvider>
        </AntApp>
      </MemoryRouter>,
    );

    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/auth/me"));
    expect(await screen.findByText("我的订阅")).toBeInTheDocument();
    await waitFor(() => expect(
      vi.mocked(api).mock.calls.filter(([path]) => path === "/api/subscription/ai").length,
    ).toBeGreaterThanOrEqual(2));
    expect(vi.mocked(api).mock.calls.some(([path]) => String(path).startsWith("/api/billing"))).toBe(false);
  });

  it("desktop Telegram bind copies command with explicit zh/en labels and never opens qr_url", async () => {
    // Locale strings must be explicit copy labels (not "open Telegram").
    expect(i18n.getFixedT("zh-CN")("account.copyTelegramBindCommand")).toBe(
      "复制 Telegram 绑定口令",
    );
    expect(i18n.getFixedT("zh-CN")("account.copyTelegramBindSuccess")).toBe(
      "绑定口令已复制，请在 Telegram 中粘贴发送给机器人",
    );
    expect(i18n.getFixedT("zh-CN")("account.copyTelegramBindUnavailable")).toBe(
      "暂无绑定口令，请先刷新绑定链接",
    );
    expect(i18n.getFixedT("en-US")("account.copyTelegramBindCommand")).toBe(
      "Copy Telegram bind command",
    );
    expect(i18n.getFixedT("en-US")("account.copyTelegramBindSuccess")).toBe(
      "Bind command copied — paste it to the bot in Telegram",
    );
    expect(i18n.getFixedT("en-US")("account.copyTelegramBindUnavailable")).toBe(
      "No bind command yet — refresh the bind link first",
    );

    await i18n.changeLanguage("zh-CN");
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const bindPayload = {
      session_id: "sess-1",
      qr_url: "https://evil.example/open?token=secret-qr",
      bot_username: "OpsMateBot",
      bot_chat_url: "https://t.me/OpsMateBot?start=bind_abc",
      bind_command: "/start bind_abc",
      webhook_ready: true,
    };
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/auth/me") {
        return {
          username: "free@example.com",
          role: "admin",
          has_password: true,
        } as never;
      }
      if (path === "/api/auth/me/telegram/bind") {
        return bindPayload as never;
      }
      if (path.startsWith("/api/auth/me/telegram/bind/")) {
        return { status: "pending" } as never;
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    render(
      <MemoryRouter initialEntries={["/account?tab=binding"]}>
        <AntApp>
          <EntitlementsProvider
            value={{
              ...FULL_ENTITLEMENTS,
              plan: "free",
              trial_ends_at: null,
              features: { ...FULL_ENTITLEMENTS.features, telegram: true },
            }}
          >
            <AccountPage />
          </EntitlementsProvider>
        </AntApp>
      </MemoryRouter>,
    );

    expect(await screen.findByText("绑定 Telegram", {}, { timeout: 8000 })).toBeInTheDocument();
    const copyBtn = await screen.findByRole(
      "button",
      { name: "复制 Telegram 绑定口令" },
      { timeout: 8000 },
    );
    expect(copyBtn).not.toHaveAttribute("href");
    expect(screen.queryByRole("button", { name: "在 Telegram 中打开绑定" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /evil\.example|secret-qr/i })).not.toBeInTheDocument();
    fireEvent.click(copyBtn);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/start bind_abc"), {
      timeout: 8000,
    });
    expect(openExternalRoute).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(openExternalRoute).mock.calls)).not.toMatch(
      /evil\.example|secret-qr|qr_url|t\.me/i,
    );
  }, 20000);
});
