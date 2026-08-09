import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import { EntitlementsProvider } from "../../../providers/EntitlementsProvider";
import {
  FULL_FEATURES,
  type Entitlements,
  type FeatureMatrix,
} from "../../../services/entitlements";
import { ApprovalChannelsPage } from "../ApprovalChannelsPage";

/**
 * U4i — edition-aware ApprovalChannelsPage. Telegram is gated by the
 * `telegram` feature flag; permanent Free enables the official shared bot.
 * Dedicated enterprise bot mode is gated by `dedicated_bot`.
 */

const FREE_FEATURES: FeatureMatrix = {
  ...FULL_FEATURES,
  telegram: true,
  dedicated_bot: false,
  long_audit_retention: false,
  sso: false,
  ha: false,
  private_ai: false,
};

function entitlementsFor(plan: "free" | "enterprise", features: FeatureMatrix): Entitlements {
  return {
    plan,
    status: "active",
    host_quota: plan === "free" ? 3 : null,
    ai_quota: plan === "free" ? 100 : null,
    trial_ends_at: null,
    features,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Shared fetch handler: empty channel list + enabled official-bot status. */
function installFetchHandler() {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/approval-channels/telegram/official/status") && method === "GET") {
      return jsonResponse({ enabled: true, bot_username: "OpsMateBot", bindings: [] });
    }
    if (url.includes("/approval-channels") && method === "GET") {
      return jsonResponse({ items: [] });
    }
    return jsonResponse({ error: "not mocked", _url: url });
  });
  vi.stubGlobal("fetch", handler);
}

let queryClient: QueryClient;

function renderPage(entitlements: Entitlements) {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <MemoryRouter>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <EntitlementsProvider value={entitlements}>
            <ApprovalChannelsPage />
          </EntitlementsProvider>
        </QueryClientProvider>
      </AntApp>
    </MemoryRouter>,
  );
}

const FIND_OPTS = { timeout: 5000 };

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
  if (queryClient) queryClient.clear();
  vi.unstubAllGlobals();
});

/**
 * The Telegram card. ModulePageShell wraps the whole page in its own titleless
 * Card, so `cards[0]` is the shell — not the Telegram card. The IM cards each
 * carry a head title (e.g. "Telegram"), so locate the Telegram card by its
 * head title text. IM_CHANNEL_TYPES[0] === "telegram" only orders the render,
 * it doesn't make the first `.ant-card` the Telegram card.
 */
function telegramCard(container: HTMLElement): HTMLElement {
  // .ant-card nodes are <div>s — narrow the NodeList to HTMLElement so the
  // return value satisfies within(...), which requires HTMLElement (not Element).
  const cards = Array.from(container.querySelectorAll<HTMLElement>(".ant-card"));
  expect(cards.length).toBeGreaterThan(0);
  // Match only the card's OWN head (direct child). ModulePageShell wraps the
  // page in a titleless Card, but querySelector(".ant-card-head") on that
  // shell would descend into the nested IM cards and match the Telegram head
  // inside it — falsely identifying the shell as the Telegram card.
  const tg = cards.find((c) => {
    const head = c.querySelector(":scope > .ant-card-head");
    return head && head.textContent?.includes("Telegram");
  });
  if (!tg) throw new Error("Telegram card did not render");
  return tg;
}

describe("ApprovalChannelsPage — edition-aware Telegram (U4i)", () => {
  it("permanent Free: Telegram configure is enabled through the official bot", async () => {
    installFetchHandler();
    const { container } = renderPage(entitlementsFor("free", FREE_FEATURES));

    await waitFor(() => expect(screen.queryByText("当前套餐不支持 Telegram")).not.toBeInTheDocument(), FIND_OPTS);
    const card = telegramCard(container);
    const configureBtn = within(card).getByRole("button", { name: /配置/ });
    expect(configureBtn).not.toBeDisabled();
  });

  it("Free drawer defaults to official bot, shows bind panel, and hides Bot Token", async () => {
    installFetchHandler();
    const { container } = renderPage(entitlementsFor("free", FREE_FEATURES));

    // Wait for cards to finish loading, then click Telegram's Configure.
    await waitFor(() => expect(screen.queryByText("当前套餐不支持 Telegram")).not.toBeInTheDocument(), FIND_OPTS);
    const card = telegramCard(container);
    const configureBtn = within(card).getByRole("button", { name: /配置/ });
    fireEvent.click(configureBtn);

    // bot_mode radio: official option visible, dedicated option absent.
    const officialRadio = await screen.findByText("官方机器人（一键绑定）", {}, FIND_OPTS);
    expect(officialRadio).toBeInTheDocument();
    expect(screen.queryByText("专属机器人（企业）")).not.toBeInTheDocument();

    // Official bind panel renders (title + bot username from mocked status).
    await screen.findByText("官方机器人一键绑定", {}, FIND_OPTS);
    // The @-prefixed bot username span renders; scope to it. The static hint
    // paragraph and the deep-link URL also contain "OpsMateBot", so match the
    // dynamic username span by its trailing " · " separator.
    await screen.findByText(/@OpsMateBot ·/, {}, FIND_OPTS);

    // Managed mode hides the Bot Token field.
    expect(screen.queryByText("Bot Token")).not.toBeInTheDocument();
  }, 30000);

  it("enterprise plan: bot_mode radio includes the dedicated option", async () => {
    installFetchHandler();
    const { container } = renderPage(entitlementsFor("enterprise", FULL_FEATURES));

    await waitFor(() => expect(screen.queryByText("当前套餐不支持 Telegram")).not.toBeInTheDocument(), FIND_OPTS);
    const card = telegramCard(container);
    const configureBtn = within(card).getByRole("button", { name: /配置/ });
    fireEvent.click(configureBtn);

    // The dedicated enterprise option is present on enterprise.
    const dedicatedRadio = await screen.findByText("专属机器人（企业）", {}, FIND_OPTS);
    expect(dedicatedRadio).toBeInTheDocument();
  });
});
