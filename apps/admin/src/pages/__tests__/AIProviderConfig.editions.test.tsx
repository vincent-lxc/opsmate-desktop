import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import AIProviderConfig from "../AIProviderConfig";
import { EntitlementsProvider } from "../../providers/EntitlementsProvider";
import {
  FULL_FEATURES,
  type Entitlements,
  type FeatureMatrix,
} from "../../services/entitlements";
import i18n from "../../i18n";

/**
 * U3 — edition-aware AI provider config UI. Free tenants must see the
 * managed-platform notice and NO key configuration form; Enterprise tenants
 * with a customer provider see the "custom provider enabled" banner.
 */

const FREE_FEATURES: FeatureMatrix = {
  ...FULL_FEATURES,
  oncall_closure: false,
  telegram: false,
  external_risk: false,
  business_observability: false,
  team_governance: false,
  encrypted_credentials: false,
  pdf_postmortem: false,
  long_audit_retention: false,
  emergency_stoploss: false,
  sso: false,
  ha: false,
  private_ai: false,
  dedicated_bot: false,
};

function freeEntitlements(): Entitlements {
  return {
    plan: "free",
    status: "active",
    host_quota: 3,
    ai_quota: 100,
    trial_ends_at: null,
    features: FREE_FEATURES,
  };
}

function enterpriseEntitlements(): Entitlements {
  return {
    plan: "enterprise",
    status: "active",
    host_quota: null,
    ai_quota: null,
    trial_ends_at: null,
    features: FULL_FEATURES,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

let queryClient: QueryClient;
let aiConfigResponse: Record<string, unknown> | null = null;

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem("opsmate_role", "admin");
  // Pin Chinese locale so the zh-CN strings the assertions look for are rendered
  // regardless of jsdom's navigator.language default at i18n init.
  localStorage.setItem("opsmate-locale", "zh-CN");
  await i18n.changeLanguage("zh-CN");
  aiConfigResponse = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/config/ai")) {
        return jsonResponse(
          aiConfigResponse ?? {
            mode: "managed_platform",
            plan: "free",
            provider: "openai",
            endpoint: "https://api.openai.com/v1",
            model_name: "gpt-4o-mini",
            similarity_threshold: 0.75,
            temperature: 0.1,
            configured: true,
            api_key_masked: "",
            api_key_configured: false,
            can_configure_key: false,
          },
        );
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  if (queryClient) queryClient.clear();
  vi.unstubAllGlobals();
});

function renderPage(ent: Entitlements) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AntApp>
          <EntitlementsProvider value={ent}>
            <AIProviderConfig />
          </EntitlementsProvider>
        </AntApp>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AIProviderConfig — edition-aware (U3)", () => {
  it("free tenant sees the managed-platform notice and no key config form", async () => {
    aiConfigResponse = {
      mode: "managed_platform",
      plan: "free",
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model_name: "gpt-4o-mini",
      similarity_threshold: 0.75,
      temperature: 0.1,
      configured: true,
      api_key_masked: "",
      api_key_configured: false,
      can_configure_key: false,
    };
    renderPage(freeEntitlements());

    // Free notice is rendered in the Alert description paragraph.
    expect(
      await screen.findByText("免费版默认使用 OpsMate 平台托管 AI", { exact: false }),
    ).toBeInTheDocument();

    // No API Key field, no Save button — free cannot configure a key.
    expect(screen.queryByText("API 密钥")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存配置" })).not.toBeInTheDocument();
  });

  it("enterprise tenant with a customer provider sees the custom-provider banner", async () => {
    aiConfigResponse = {
      mode: "customer",
      plan: "enterprise",
      provider: "custom",
      endpoint: "https://ai.internal.corp/v1",
      model_name: "internal-llm-1",
      similarity_threshold: 0.75,
      temperature: 0.1,
      configured: true,
      api_key_masked: "sk-i****corp",
      api_key_configured: true,
      can_configure_key: true,
    };
    renderPage(enterpriseEntitlements());

    // Enterprise with a customer provider shows the custom-provider banner.
    expect(
      await screen.findByText("已启用自有 AI 提供商", { exact: false }),
    ).toBeInTheDocument();

    expect(await screen.findByText("API 密钥")).toBeInTheDocument();
  });
});
