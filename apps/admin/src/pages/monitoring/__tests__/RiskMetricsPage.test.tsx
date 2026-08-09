import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../i18n";
import { RiskMetricsPage } from "../RiskMetricsPage";

type Profile = {
  id: string;
  source_id: string;
  source_name: string | null;
  name: string;
  query_text: string;
  unit: string | null;
  enabled: boolean;
  risk_tier: "L1" | "L2" | "L3";
  panel_type: string | null;
  target_kind: string | null;
  metric_name: string | null;
  is_curated: boolean;
  last_synced_at: string | null;
  created_at: string;
};

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "profile-1",
    source_id: "src-1",
    source_name: "prod-prom",
    name: "Redis memory",
    query_text: "redis_memory_used_bytes",
    unit: "bytes",
    enabled: true,
    risk_tier: "L2",
    panel_type: "gauge",
    target_kind: "redis",
    metric_name: "redis_memory",
    is_curated: true,
    last_synced_at: "2026-07-03T10:00:00.000Z",
    created_at: "2026-07-03T09:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchHandler() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/business-metrics/profiles") && method === "GET") {
      return jsonResponse({ items: [makeProfile()], total: 1 });
    }
    if (url.includes("/profiles/profile-1/draft-rules") && method === "POST") {
      return jsonResponse({
        run_id: "run-1",
        created: true,
        items: [{ id: "rule-1", name: "redis_high_memory" }],
        total: 1,
      });
    }
    return jsonResponse({ error: "not mocked", url, method }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

let queryClient: QueryClient;

function renderPage() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AntApp>
          <RiskMetricsPage />
        </AntApp>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const FIND_OPTS = { timeout: 8000 };

describe("RiskMetricsPage", () => {
  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem("opsmate_role", "operator");
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    cleanup();
    queryClient?.clear();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it(
    "lists curated profiles with tier edit and draft actions",
    async () => {
      installFetchHandler();
      renderPage();

      await screen.findByText("Redis memory", {}, FIND_OPTS);
      expect((await screen.findAllByText("改等级", {}, FIND_OPTS)).length).toBeGreaterThan(0);
      expect((await screen.findAllByText("生成规则草稿", {}, FIND_OPTS)).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByRole("link", { name: "查看规则草稿" })).toHaveAttribute(
        "href",
        "/monitoring/anomaly-rules?tab=draft",
      );
    },
    15_000,
  );

  it(
    "generates rule drafts for a profile",
    async () => {
      const fetchMock = installFetchHandler();
      renderPage();
      await screen.findByText("Redis memory", {}, FIND_OPTS);

      const draftLabels = await screen.findAllByText("生成规则草稿", {}, FIND_OPTS);
      const rowButton = draftLabels
        .map((label) => label.closest("button"))
        .find((button) => button && !button.disabled);
      expect(rowButton).toBeTruthy();
      fireEvent.click(rowButton!);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/profiles/profile-1/draft-rules"),
          expect.objectContaining({ method: "POST" }),
        );
      });
    },
    15_000,
  );
});
