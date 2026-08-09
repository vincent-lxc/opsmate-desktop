import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { api } from "../../api/client";
import { isDesktopRuntime } from "../../desktop/tauri-bridge";
import { openExternalRoute } from "../../desktop/external-navigation";
import { AccountSubscriptionPanel } from "../AccountSubscriptionPanel";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
vi.mock("../../desktop/tauri-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../desktop/tauri-bridge")>();
  return { ...actual, isDesktopRuntime: vi.fn(() => false) };
});
vi.mock("../../desktop/external-navigation", () => ({
  openExternalRoute: vi.fn(async () => undefined),
}));

const unsubscribed = {
  period: "2026-08",
  usage: {
    used: 125,
    base_quota: 500,
    paid_quota: 0,
    total_quota: 500,
    remaining: 375,
  },
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
};

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.mocked(api).mockResolvedValue(unsubscribed as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPanel(role = "workspace_owner") {
  return render(
    <AntApp>
      <AccountSubscriptionPanel role={role} />
    </AntApp>,
  );
}

describe("AccountSubscriptionPanel", () => {
  it("shows combined Free and paid quota usage", async () => {
    vi.mocked(api).mockResolvedValue({
      ...unsubscribed,
      usage: {
        used: 125,
        base_quota: 500,
        paid_quota: 500,
        total_quota: 1000,
        remaining: 875,
      },
      subscription: {
        ...unsubscribed.subscription,
        status: "active",
        interval: "month",
        quantity: 1,
        can_checkout: false,
        can_manage: true,
      },
    } as never);

    renderPanel();

    expect(await screen.findByText("125 / 1,000")).toBeInTheDocument();
    expect(screen.getByText("Free 基础额度：500 次")).toBeInTheDocument();
    expect(screen.getByText("付费额度：500 次")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "管理订阅" })).toBeInTheDocument();
  });

  it("accepts any safe positive quantity and recalculates monthly and annual price", async () => {
    renderPanel();
    expect(await screen.findByRole("spinbutton", { name: "额度单位" })).toHaveValue("1");

    fireEvent.change(screen.getByRole("spinbutton", { name: "额度单位" }), {
      target: { value: "7" },
    });
    expect(screen.getByText("每月增加 3,500 次")).toBeInTheDocument();
    expect(screen.getByText("$70 / 月")).toBeInTheDocument();

    await userEvent.click(screen.getByText("年度"));
    expect(screen.getByText("$700 / 年")).toBeInTheDocument();
  });

  it("submits the selected interval and quantity to Checkout", async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/subscription/ai") return unsubscribed as never;
      if (path === "/api/subscription/ai/checkout") {
        return { url: "https://checkout.stripe.com/c/pay/cs_test" } as never;
      }
      throw new Error(`Unexpected API call: ${path}`);
    });
    renderPanel();
    await screen.findByRole("spinbutton", { name: "额度单位" });
    fireEvent.change(screen.getByRole("spinbutton", { name: "额度单位" }), {
      target: { value: "4" },
    });
    await userEvent.click(screen.getByText("年度"));
    await userEvent.click(screen.getByRole("button", { name: "订阅 AI 额度" }));

    await waitFor(() => expect(api).toHaveBeenCalledWith(
      "/api/subscription/ai/checkout",
      {
        method: "POST",
        body: JSON.stringify({ interval: "year", quantity: 4 }),
      },
    ));
  });

  it("offers to continue an incomplete Checkout without showing Portal management", async () => {
    vi.mocked(api).mockResolvedValue({
      ...unsubscribed,
      subscription: {
        ...unsubscribed.subscription,
        status: "incomplete",
        interval: "month",
        can_checkout: true,
        can_manage: false,
      },
    } as never);

    renderPanel();

    expect(await screen.findByText("你有一笔未完成的支付，将继续此前的 Stripe 支付流程。"))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续支付" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理订阅" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "额度单位" })).not.toBeInTheDocument();
  });

  it("shows both management and re-subscription for a canceled real subscription", async () => {
    vi.mocked(api).mockResolvedValue({
      ...unsubscribed,
      subscription: {
        ...unsubscribed.subscription,
        status: "canceled",
        interval: "month",
        can_checkout: true,
        can_manage: true,
      },
    } as never);

    renderPanel();

    expect(await screen.findByRole("button", { name: "管理订阅" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新订阅 AI 额度" })).toBeInTheDocument();
  });

  it("shows usage to operators without subscription action buttons", async () => {
    renderPanel("operator");
    expect(await screen.findByText("125 / 500")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "订阅 AI 额度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理订阅" })).not.toBeInTheDocument();
  });

  it("explains when billing is unavailable without hiding Free usage", async () => {
    vi.mocked(api).mockResolvedValue({
      ...unsubscribed,
      billing_configured: false,
      subscription: { ...unsubscribed.subscription, can_checkout: false },
    } as never);

    renderPanel();

    expect(await screen.findByText("AI 额度订阅暂不可用，Free 额度和其他功能不受影响。")).toBeInTheDocument();
    expect(screen.getByText("125 / 500")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "订阅 AI 额度" })).not.toBeInTheDocument();
  });

  it("incomplete first checkout still shows continue-payment when backend flags are inconsistent", async () => {
    // Backend may set can_manage=true for any real subscription id while incomplete
    // still blocks checkout — UI must not collapse to manage-only.
    vi.mocked(api).mockResolvedValue({
      ...unsubscribed,
      subscription: {
        ...unsubscribed.subscription,
        status: "incomplete",
        interval: "month",
        quantity: 1,
        can_checkout: false,
        can_manage: true,
      },
    } as never);

    renderPanel();

    expect(await screen.findByRole("button", { name: "继续支付" })).toBeInTheDocument();
    expect(screen.getByText("你有一笔未完成的支付，将继续此前的 Stripe 支付流程。"))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理订阅" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "额度单位" })).not.toBeInTheDocument();
  });

  it("active subscribers retain manage action only", async () => {
    vi.mocked(api).mockResolvedValue({
      ...unsubscribed,
      subscription: {
        ...unsubscribed.subscription,
        status: "active",
        interval: "month",
        quantity: 1,
        can_checkout: false,
        can_manage: true,
      },
    } as never);

    renderPanel();

    expect(await screen.findByRole("button", { name: "管理订阅" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "订阅 AI 额度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续支付" })).not.toBeInTheDocument();
  });

  it("desktop subscribe never location.assign Stripe URLs; opens fixed checkout route only", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign },
    });
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/subscription/ai") return unsubscribed as never;
      if (path === "/api/subscription/ai/checkout") {
        return { url: "https://checkout.stripe.com/c/pay/cs_desktop" } as never;
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    renderPanel();
    await screen.findByRole("spinbutton", { name: "额度单位" });
    await userEvent.click(screen.getByRole("button", { name: "订阅 AI 额度" }));

    await waitFor(() => expect(openExternalRoute).toHaveBeenCalledWith("checkout"));
    expect(assign).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalledWith(
      "/api/subscription/ai/checkout",
      expect.anything(),
    );
    expect(vi.mocked(openExternalRoute).mock.calls.flat().join(" ")).not.toMatch(
      /stripe\.com|https?:\/\//i,
    );
  });

  it("desktop manage opens fixed account_subscription route without Stripe assign", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign },
    });
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/subscription/ai") {
        return {
          ...unsubscribed,
          subscription: {
            ...unsubscribed.subscription,
            status: "active",
            interval: "month",
            quantity: 1,
            can_checkout: false,
            can_manage: true,
          },
        } as never;
      }
      if (path === "/api/subscription/ai/portal") {
        return { url: "https://billing.stripe.com/p/session_test" } as never;
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "管理订阅" }));

    await waitFor(() => expect(openExternalRoute).toHaveBeenCalledWith("account_subscription"));
    expect(assign).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalledWith(
      "/api/subscription/ai/portal",
      expect.anything(),
    );
  });

  it("browser still redirects to validated Stripe HTTPS checkout URLs", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(false);
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign },
    });
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/subscription/ai") return unsubscribed as never;
      if (path === "/api/subscription/ai/checkout") {
        return { url: "https://checkout.stripe.com/c/pay/cs_browser" } as never;
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    renderPanel();
    await screen.findByRole("spinbutton", { name: "额度单位" });
    await userEvent.click(screen.getByRole("button", { name: "订阅 AI 额度" }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_browser"),
    );
    expect(openExternalRoute).not.toHaveBeenCalled();
  });
});
