import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnomalyRulesPage } from "../AnomalyRulesPage";
import "../../../i18n";

type Rule = {
  id: string;
  name: string;
  rule_type: string;
  source_id: string | null;
  source_name: string | null;
  query_text: string;
  threshold_json: Record<string, unknown>;
  risk_tier: "L1" | "L2" | "L3";
  enabled: boolean;
  last_evaluated_at: string | null;
  evaluation_interval_sec: number;
  target_kind: string | null;
  target_ref: string | null;
  evidence_plan: Record<string, unknown> | null;
  created_by: "ai_recommendation" | "rule_recommendation" | null;
  created_at: string;
  updated_at: string;
};

function makeDraft(overrides: Partial<Rule>): Rule {
  return {
    id: "rule-1",
    name: "redis_high_memory",
    rule_type: "threshold",
    source_id: "src-1",
    source_name: "prod-prometheus",
    query_text: "redis_memory_used_bytes / redis_memory_max_bytes",
    threshold_json: { value: 0.9, operator: "gt" },
    risk_tier: "L2",
    enabled: false,
    last_evaluated_at: null,
    evaluation_interval_sec: 300,
    target_kind: "redis",
    target_ref: "exporter-1",
    evidence_plan: { source: "prometheus", steps: ["query_range"] },
    created_by: "rule_recommendation",
    created_at: "2026-06-29T10:00:00.000Z",
    updated_at: "2026-06-29T10:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchHandler(routes: {
  byStatus?: Record<string, Rule[]>;
  rules?: Rule[];
  test?: (id: string) => unknown;
  patch?: (id: string, body: unknown) => unknown;
}) {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/anomaly-rules") && !url.includes("/test") && !url.includes("/versions") && method === "GET") {
      const statusMatch = url.match(/[?&]status=(draft|enabled|all)/);
      const status = statusMatch?.[1] ?? "all";
      const items =
        routes.byStatus?.[status] ??
        (status === "draft"
          ? (routes.rules ?? []).filter((r) => r.created_by !== null && !r.enabled)
          : status === "enabled"
            ? (routes.rules ?? []).filter((r) => r.enabled)
            : (routes.rules ?? []));
      return jsonResponse({ items, total: items.length });
    }
    const testMatch = url.match(/\/anomaly-rules\/([^/]+)\/test$/);
    if (testMatch && method === "POST" && routes.test) {
      return jsonResponse(routes.test(testMatch[1]));
    }
    const patchMatch = url.match(/\/anomaly-rules\/([^/]+)$/);
    if (patchMatch && method === "PATCH" && routes.patch) {
      return jsonResponse(routes.patch(patchMatch[1], init?.body ? JSON.parse(String(init.body)) : {}));
    }
    if (url.includes("/versions") && method === "GET") {
      return jsonResponse({ items: [], total: 0 });
    }
    return jsonResponse({ error: "not mocked", _url: url });
  });
  vi.stubGlobal("fetch", handler);
}

let queryClient: QueryClient;

function renderPage(initialPath = "/monitoring/anomaly-rules?tab=draft") {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/monitoring/anomaly-rules" element={<AnomalyRulesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
    { wrapper: ({ children }) => <AntApp>{children}</AntApp> },
  );
}

const FIND_OPTS = { timeout: 4000 };

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  if (queryClient) queryClient.clear();
  vi.unstubAllGlobals();
});

describe("AnomalyRulesPage — U8 merged tabs", () => {
  it("renders draft/enabled/all tabs and loads draft list", async () => {
    installFetchHandler({
      byStatus: {
        draft: [makeDraft({ id: "d1", name: "draft_rule_tab" })],
        enabled: [makeDraft({ id: "e1", name: "enabled_rule_tab", enabled: true, created_by: null })],
        all: [
          makeDraft({ id: "d1", name: "draft_rule_tab" }),
          makeDraft({ id: "e1", name: "enabled_rule_tab", enabled: true, created_by: null }),
        ],
      },
    });
    renderPage();

    const tabs = screen.getByTestId("anomaly-rules-tabs");
    expect(tabs).toBeInTheDocument();
    expect(tabs).toHaveTextContent("Pending review");
    expect(tabs).toHaveTextContent("Enabled");
    expect(tabs).toHaveTextContent("All");
    await screen.findByText("draft_rule_tab", {}, FIND_OPTS);
  });

  it("highlights deep-linked draft row and shows toast copy", async () => {
    installFetchHandler({
      byStatus: {
        draft: [makeDraft({ id: "hl-1", name: "highlighted_draft" })],
      },
    });
    renderPage("/monitoring/anomaly-rules?tab=draft&highlight=hl-1");

    await screen.findByText("highlighted_draft", {}, FIND_OPTS);
    await waitFor(
      () => expect(screen.getByText("Draft generated — pending review")).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });

  it("disables Enable until test-run passes and drawer shows verdict banner", async () => {
    installFetchHandler({
      byStatus: { draft: [makeDraft({ id: "g1", name: "gate_rule" })] },
      test: () => ({
        id: "run-1",
        rule_id: "g1",
        status: "completed",
        result_json: {
          matched: false,
          sample_value: 0.2,
          threshold: { value: 0.9, operator: "gt" },
          message: "ok",
          evaluation: "0.2 <= 0.9",
        },
        created_at: "2026-06-29T10:00:00.000Z",
      }),
      patch: (id, body) => ({ ...makeDraft({ id }), ...(body as object) }),
    });
    renderPage();

    await screen.findByText("gate_rule", {}, FIND_OPTS);
    const enableBtns = await screen.findAllByText("Enable", {}, FIND_OPTS);
    const enableBefore = enableBtns.find((el) => el.closest("button") instanceof HTMLButtonElement);
    expect(enableBefore?.closest("button")).toBeDisabled();

    const testBtns = await screen.findAllByText("Test", {}, FIND_OPTS);
    testBtns[0].closest("button")!.click();

    await waitFor(() => expect(screen.getByTestId("anomaly-rule-test-drawer")).toBeInTheDocument());
    expect(screen.getByTestId("anomaly-rule-test-verdict")).toBeInTheDocument();
    expect(screen.getByText("pass")).toBeInTheDocument();

    const drawerEnable = screen
      .getByTestId("anomaly-rule-test-drawer")
      .parentElement?.querySelector(".ant-drawer-footer button.ant-btn-primary");
    expect(drawerEnable).not.toBeDisabled();
  });
});