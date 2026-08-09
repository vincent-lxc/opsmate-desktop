import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnomalyRuleDraftsPage } from "../AnomalyRuleDrafts";
import "../../../i18n";

/**
 * U8 admin rule-draft review surface — visible-unit gate.
 *
 * The page lists recommender-generated drafts (created_by set), lets an
 * operator trial-run a draft (POST /:id/test → current value + verdict in a
 * table), edit it (PATCH /:id), and explicitly enable it. We mock global fetch
 * and assert: the list renders with Test/Edit/Enable actions; a trial-run shows
 * the sample value + verdict; enabling is an explicit click (no auto-enable on
 * load); and a viewer sees the actions disabled (read-only).
 *
 * Each test gets its own QueryClient, cleared in afterEach so no query timers
 * leak across tests (leaks made earlier iterations hang under jsdom).
 */

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

type Call = { url: string; method: string; body?: string };

function installFetchHandler(routes: {
  rules: Rule[];
  test?: (id: string) => unknown;
  patch?: (id: string, body: unknown) => unknown;
}) {
  const calls: Call[] = [];
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });

    if (url.includes("/anomaly-rules") && !url.includes("/test") && method === "GET") {
      return jsonResponse({ items: routes.rules, total: routes.rules.length });
    }
    const testMatch = url.match(/\/anomaly-rules\/([^/]+)\/test$/);
    if (testMatch && method === "POST" && routes.test) {
      return jsonResponse(routes.test(testMatch[1]));
    }
    const patchMatch = url.match(/\/anomaly-rules\/([^/]+)$/);
    if (patchMatch && method === "PATCH" && routes.patch) {
      return jsonResponse(routes.patch(patchMatch[1], init?.body ? JSON.parse(String(init.body)) : {}));
    }
    return jsonResponse({ error: "not mocked", _url: url });
  });
  vi.stubGlobal("fetch", handler);
  return { calls };
}

let queryClient: QueryClient;

function renderPage() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <AnomalyRuleDraftsPage />
      </AntApp>
    </QueryClientProvider>,
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

describe("AnomalyRuleDraftsPage — U8 visible unit", () => {
  it("renders drafts with Test/Edit/Enable actions", async () => {
    installFetchHandler({ rules: [makeDraft({ id: "d1", name: "redis_mem_draft" })] });
    renderPage();

    await screen.findByText("redis_mem_draft", {}, FIND_OPTS);
    // pro-table renders the fixed-right actions column twice (overlay mirrors
    // the body), so query by label text rather than role (see DataSourceCandidates
    // test note). All three actions are present for an operator.
    expect((await screen.findAllByText("Test", {}, FIND_OPTS)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Edit", {}, FIND_OPTS)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Enable", {}, FIND_OPTS)).length).toBeGreaterThan(0);
  });

  it("trial-run shows the current value + verdict in a table", async () => {
    installFetchHandler({
      rules: [makeDraft({ id: "d2", name: "redis_breach_draft" })],
      test: () => ({
        id: "run-1",
        rule_id: "d2",
        status: "completed",
        result_json: {
          matched: true,
          sample_value: 0.95,
          threshold: { value: 0.9, operator: "gt" },
          message: "ok",
          evaluation: "0.95 > 0.9",
        },
        created_at: "2026-06-29T10:00:00.000Z",
      }),
    });
    renderPage();

    await screen.findByText("redis_breach_draft", {}, FIND_OPTS);
    const testBtns = await screen.findAllByText("Test", {}, FIND_OPTS);
    const enabled = testBtns.find((el) => {
      const btn = el.closest("button");
      return btn instanceof HTMLButtonElement && !btn.disabled;
    });
    expect(enabled).toBeDefined();
    enabled!.closest("button")!.click();

    // The verdict table renders the sample value and a breach verdict.
    await waitFor(() => expect(screen.getByText("0.95")).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByText("breach")).toBeInTheDocument();
    expect(screen.getByText("Current value")).toBeInTheDocument();
    expect(screen.getByText("Verdict")).toBeInTheDocument();
  });

  it("enabling is an explicit click — no PATCH fires on load, only after Enable", async () => {
    const { calls } = installFetchHandler({
      rules: [makeDraft({ id: "d3", name: "enable_explicit_draft", enabled: false })],
      patch: (id, body) => ({ ...makeDraft({ id }), ...(body as object) }),
    });
    renderPage();

    await screen.findByText("enable_explicit_draft", {}, FIND_OPTS);
    // No PATCH on initial load — drafts are never auto-enabled.
    await waitFor(
      () => expect(calls.some((c) => c.method === "PATCH")).toBe(false),
      { timeout: 1500 },
    );

    const enableBtns = await screen.findAllByText("Enable", {}, FIND_OPTS);
    const enabled = enableBtns.find((el) => {
      const btn = el.closest("button");
      return btn instanceof HTMLButtonElement && !btn.disabled;
    });
    expect(enabled).toBeDefined();
    enabled!.closest("button")!.click();

    // The explicit Enable click fires PATCH /:id with enabled:true.
    await waitFor(
      () =>
        expect(
          calls.some(
            (c) =>
              c.method === "PATCH" &&
              c.url.includes("/anomaly-rules/d3") &&
              c.body?.includes('"enabled":true'),
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
  });

  it("disables Test/Edit/Enable for a viewer (read-only)", async () => {
    localStorage.setItem("opsmate_role", "viewer");
    installFetchHandler({ rules: [makeDraft({ id: "v1", name: "viewer_draft" })] });
    renderPage();

    await screen.findByText("viewer_draft", {}, FIND_OPTS);
    const enableBtns = await screen.findAllByText("Enable", {}, FIND_OPTS);
    const enableDisabled = enableBtns.some((el) => {
      const btn = el.closest("button");
      return btn instanceof HTMLButtonElement && btn.disabled;
    });
    expect(enableDisabled).toBe(true);

    const testBtns = screen.getAllByText("Test");
    const testDisabled = testBtns.some((el) => {
      const btn = el.closest("button");
      return btn instanceof HTMLButtonElement && btn.disabled;
    });
    expect(testDisabled).toBe(true);

    const editBtns = screen.getAllByText("Edit");
    const editDisabled = editBtns.some((el) => {
      const btn = el.closest("button");
      return btn instanceof HTMLButtonElement && btn.disabled;
    });
    expect(editDisabled).toBe(true);
  });

  it("trial-run renders a pass verdict (matched=false) in green", async () => {
    // Coverage for the pass branch — the breach case is covered above; without
    // this, a regression flipping the verdict ternary to always-breach passes.
    installFetchHandler({
      rules: [makeDraft({ id: "p1", name: "pass_draft" })],
      test: () => ({
        id: "run-pass",
        rule_id: "p1",
        status: "completed",
        result_json: {
          matched: false,
          sample_value: 0.4,
          threshold: { value: 0.9, operator: "gt" },
          message: "ok",
          evaluation: "0.4 <= 0.9",
        },
        created_at: "2026-06-29T10:00:00.000Z",
      }),
    });
    renderPage();

    await screen.findByText("pass_draft", {}, FIND_OPTS);
    const testBtns = await screen.findAllByText("Test", {}, FIND_OPTS);
    const enabled = testBtns.find((el) => {
      const btn = el.closest("button");
      return btn instanceof HTMLButtonElement && !btn.disabled;
    });
    enabled!.closest("button")!.click();

    await waitFor(() => expect(screen.getByText("0.4")).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByText("pass")).toBeInTheDocument();
    expect(screen.getByText("Verdict")).toBeInTheDocument();
  });

  it("disabling an enabled draft fires PATCH /:id with enabled:false", async () => {
    const { calls } = installFetchHandler({
      rules: [makeDraft({ id: "d4", name: "disable_draft", enabled: true })],
      patch: (id, body) => ({ ...makeDraft({ id, enabled: true }), ...(body as object) }),
    });
    renderPage();

    await screen.findByText("disable_draft", {}, FIND_OPTS);
    const disableBtns = await screen.findAllByText("Disable", {}, FIND_OPTS);
    const enabled = disableBtns.find((el) => {
      const btn = el.closest("button");
      return btn instanceof HTMLButtonElement && !btn.disabled;
    });
    expect(enabled).toBeDefined();
    enabled!.closest("button")!.click();

    await waitFor(
      () =>
        expect(
          calls.some(
            (c) =>
              c.method === "PATCH" &&
              c.url.includes("/anomaly-rules/d4") &&
              c.body?.includes('"enabled":false'),
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
  });

  it("edit flow opens the drawer prefilled and PATCHes the constructed body", async () => {
    const { calls } = installFetchHandler({
      rules: [makeDraft({ id: "e1", name: "edit_draft", enabled: false })],
      patch: (id, body) => ({ ...makeDraft({ id }), ...(body as object) }),
    });
    renderPage();

    await screen.findByText("edit_draft", {}, FIND_OPTS);
    const editBtns = await screen.findAllByText("Edit", {}, FIND_OPTS);
    const enabled = editBtns.find((el) => {
      const btn = el.closest("button");
      return btn instanceof HTMLButtonElement && !btn.disabled;
    });
    enabled!.closest("button")!.click();

    // The drawer opens with the rule name prefilled in the edit form.
    const nameInput = await screen.findByDisplayValue("edit_draft", {}, FIND_OPTS);
    expect(nameInput).toBeInTheDocument();

    // Submit the edit form (values are prefilled) -> PATCH /:id carries the
    // constructed body incl. the JSON-parsed threshold.
    const saveBtns = await screen.findAllByText("Save", {}, FIND_OPTS);
    const saveBtn = saveBtns.find((el) => {
      const btn = el.closest("button");
      return btn instanceof HTMLButtonElement && !btn.disabled;
    });
    saveBtn!.closest("button")!.click();

    await waitFor(
      () =>
        expect(
          calls.some(
            (c) =>
              c.method === "PATCH" &&
              c.url.includes("/anomaly-rules/e1") &&
              c.body?.includes('"name":"edit_draft"') &&
              c.body?.includes('"threshold_json"'),
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
  });
});