import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n";
import { EntitlementsProvider } from "../../providers/EntitlementsProvider";
import {
  FULL_FEATURES,
  type Entitlements,
  type FeatureMatrix,
} from "../../services/entitlements";
import { RequireFeature } from "../RequireFeature";
import { UpgradeNotice } from "../UpgradeNotice";

/**
 * U5 — enterprise contact prompt. When a free tenant deep-links a capability
 * that is not part of the public Free edition, the UI must not advertise the
 * removed Pro edition or a self-service pricing flow.
 */

const FREE_FEATURES: FeatureMatrix = {
  ...FULL_FEATURES,
  oncall_closure: false,
  telegram: true,
  external_risk: false,
  business_observability: false,
  team_governance: false,
  encrypted_credentials: true,
  pdf_postmortem: false,
  long_audit_retention: false,
  emergency_stoploss: false,
  sso: false,
  ha: false,
  private_ai: false,
  dedicated_bot: false,
};

function entitlementsFor(
  plan: "free" | "enterprise",
  features: FeatureMatrix,
): Entitlements {
  return {
    plan,
    status: "active",
    host_quota: plan === "free" ? 3 : null,
    ai_quota: plan === "free" ? 100 : null,
    trial_ends_at: null,
    features,
  };
}

let queryClient: QueryClient;

function renderWith(
  ui: React.ReactNode,
  entitlements: Entitlements,
  initialEntry = "/oncall/remediation-queue",
) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <EntitlementsProvider value={entitlements}>{ui}</EntitlementsProvider>
        </QueryClientProvider>
      </AntApp>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
  if (queryClient) queryClient.clear();
});

describe("UpgradeNotice — edition upgrade prompt (U5)", () => {
  it("free tenant hitting an oncall_closure page sees the upgrade prompt, not the page", () => {
    renderWith(
      <RequireFeature feature="oncall_closure">
        <div data-testid="gated-page">Remediation Queue</div>
      </RequireFeature>,
      entitlementsFor("free", FREE_FEATURES),
    );

    // The gated page content must NOT render.
    expect(screen.queryByTestId("gated-page")).not.toBeInTheDocument();
    // The prompt names Enterprise as the only available higher edition.
    expect(screen.getByText("当前套餐不支持此功能")).toBeInTheDocument();
    expect(screen.getByText(/此能力属于企业版/)).toBeInTheDocument();
    expect(screen.getByText("当前套餐：免费版")).toBeInTheDocument();
    expect(screen.queryByText(/专业版/)).not.toBeInTheDocument();
  });

  it("enterprise tenant with the feature enabled sees the page, not the upgrade prompt", () => {
    renderWith(
      <RequireFeature feature="oncall_closure">
        <div data-testid="gated-page">Remediation Queue</div>
      </RequireFeature>,
      entitlementsFor("enterprise", FULL_FEATURES),
    );
    expect(screen.getByTestId("gated-page")).toBeInTheDocument();
    expect(screen.queryByText("当前套餐不支持此功能")).not.toBeInTheDocument();
  });

  it("UpgradeNotice renders the Enterprise contact CTA without a pricing link", () => {
    renderWith(
      <UpgradeNotice feature="external_risk" />,
      entitlementsFor("free", FREE_FEATURES),
    );
    const cta = screen.getByRole("link", { name: "联系企业版" });
    expect(cta).toHaveAttribute("href", "https://www.itops.sh/#contact");
    expect(screen.queryByRole("link", { name: /价格|订阅|专业版/ })).not.toBeInTheDocument();
  });
});
