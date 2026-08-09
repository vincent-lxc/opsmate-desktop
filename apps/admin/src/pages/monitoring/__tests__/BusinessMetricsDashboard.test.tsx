import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BusinessMetricsDashboardPage } from "../BusinessMetricsDashboard";
import { RuleTestRunChart } from "../RuleTestRunChart";
import "../../../i18n";

/**
 * U10 — F5 four-view business-metrics dashboard + rule test-run chart.
 *
 * The dashboard renders the U9 layout as four distinct views (Tabs) and runs
 * `POST /dashboards/business-metrics/query` per queryable widget; the rule
 * test-run chart reuses the same /query with `widget_id = "rule:<id>"` to draw
 * the curve + threshold + breach band + verdict + Problem cross-link.
 *
 * @ant-design/charts renders on <canvas>; src/test/setup.ts stubs getContext
 * so charts MOUNT under jsdom (the real U6/U10/U11 compatibility gate) but
 * series/axes/legends are canvas pixels, not DOM text. We therefore assert on
 * wrapper testids, canvas counts, and the DOM-rendered verdict/threshold/
 * breach captions + Problem link — not on canvas legend text.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

type View = {
  key: "fleet" | "infra" | "hostcontainer" | "appservice" | "rule" | "problem";
  title: string;
  widgets: unknown[];
};

type Layout = { views: View[]; generated_at: string };

function fleetWidgets(): unknown[] {
  return [
    { id: "summary:enabled_sources", kind: "summary", title: "数据源健康", value: 2 },
    { id: "summary:confirmed_profiles", kind: "summary", title: "已确认指标", value: 2 },
    { id: "summary:enabled_rules", kind: "summary", title: "启用规则数", value: 1 },
    { id: "summary:recent_breaches", kind: "summary", title: "最近命中数", value: 1 },
  ];
}

function profileWidget(id: string, name: string): unknown {
  return {
    id: `profile:${id}`,
    kind: "profile",
    title: name,
    source_id: "src-1",
    source_name: "docker-futures-prom",
    query: "rate(container_cpu_usage_seconds_total[5m])",
    unit: "cores",
    risk_tier: "L2",
    target_kind: "container",
    target_ref: null,
    threshold: null,
    recent_breach_interval: null,
    rule_id: null,
    profile_id: id,
    value: null,
    panel_type: "timeseries",
    problem_event_id: null,
    problem_group_id: null,
    problem_severity: null,
    problem_title: null,
  };
}

function ruleWidget(id: string, name: string, withBreach = false): unknown {
  return {
    id: `rule:${id}`,
    kind: "rule",
    title: name,
    source_id: "src-1",
    source_name: "docker-futures-prom",
    query: "redis_memory_used_bytes / redis_memory_max_bytes",
    unit: null,
    risk_tier: "L2",
    target_kind: "redis",
    target_ref: 'job="redis-exporter"',
    threshold: { value: 0.9, operator: "gt" },
    recent_breach_interval: withBreach
      ? { start: "2026-06-29T11:50:00.000Z", end: "2026-06-29T11:55:00.000Z", matched_count: 2 }
      : null,
    rule_id: id,
    profile_id: null,
    value: null,
    panel_type: "timeseries",
    problem_event_id: null,
    problem_group_id: null,
    problem_severity: null,
    problem_title: null,
  };
}

/** A rule widget seeded for the Problem 关联视角 — carries a breach interval
 * AND a linked open Problem (problem_event_id) so it passes both gates and the
 * forward cross-jump link renders with an event_id target. */
function problemRuleWidget(
  ruleId: string,
  eventId: string,
  opts: { breach?: boolean; title?: string } = {},
): unknown {
  const breach = opts.breach ?? true;
  return {
    id: `rule:${ruleId}`,
    kind: "rule",
    title: "redis-memory",
    source_id: "src-1",
    source_name: "docker-futures-prom",
    query: "redis_memory_used_bytes / redis_memory_max_bytes",
    unit: null,
    risk_tier: "L2",
    target_kind: "redis",
    target_ref: 'job="redis-exporter"',
    threshold: { value: 0.9, operator: "gt" },
    recent_breach_interval: breach
      ? { start: "2026-06-29T11:50:00.000Z", end: "2026-06-29T11:55:00.000Z", matched_count: 2 }
      : null,
    rule_id: ruleId,
    profile_id: null,
    value: null,
    panel_type: "timeseries",
    problem_event_id: eventId,
    problem_group_id: `platform:rc:${ruleId}`,
    problem_severity: "P2",
    problem_title: opts.title ?? "redis-memory-pressure",
  };
}

function defaultSeries() {
  const now = Date.UTC(2026, 5, 29, 12, 0, 0);
  return {
    ok: true,
    status: "ok" as const,
    reason: null,
    series: [
      {
        name: "10.0.0.50:9090",
        points: [
          { timestamp: now, value: 0.4 },
          { timestamp: now + 60_000, value: 0.5 },
          { timestamp: now + 120_000, value: 0.6 },
        ],
      },
    ],
    current_value: 0.6,
    threshold: null,
    breach_intervals: [] as unknown[],
    window_seconds: 3600,
    step_seconds: 60,
  };
}

/** A /query response whose current_value (0.95) breaches the threshold (0.9)
 * and carries one breach interval — the conditions that gate the Problem
 * forward cross-jump link. */
function breachQuery() {
  return {
    ok: true,
    status: "ok" as const,
    reason: null,
    series: defaultSeries().series,
    current_value: 0.95,
    threshold: { value: 0.9, operator: "gt" },
    breach_intervals: [
      { start: "2026-06-29T11:50:00.000Z", end: "2026-06-29T11:55:00.000Z", matched_count: 2 },
    ],
    window_seconds: 3600,
    step_seconds: 60,
  };
}

interface HandlerOpts {
  layout: Layout;
  /** Per-widget-id /query response. Falls back to defaultSeries(). */
  queryByWidget?: (widgetId: string) => unknown;
}

function installFetchHandler(opts: HandlerOpts) {
  const calls: { url: string; method: string }[] = [];
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });

    if (url.includes("/dashboards/business-metrics/query")) {
      let body: { widget_id?: string } = {};
      try {
        body = init?.body ? (JSON.parse(String(init.body)) as { widget_id?: string }) : {};
      } catch {
        body = {};
      }
      const wid = body.widget_id ?? "";
      return jsonResponse(opts.queryByWidget ? opts.queryByWidget(wid) : defaultSeries());
    }
    if (url.endsWith("/dashboards/business-metrics")) {
      return jsonResponse(opts.layout);
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
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <BusinessMetricsDashboardPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function renderRuleChart(ruleId: string, problemEventId?: string) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <RuleTestRunChart
          ruleId={ruleId}
          ruleName="redis-memory"
          problemEventId={problemEventId}
        />
      </QueryClientProvider>
    </MemoryRouter>,
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

describe("BusinessMetricsDashboardPage — U10 six-view dashboard", () => {
  it("renders the six views as distinct tabs (not a flat chart list)", async () => {
    installFetchHandler({
      layout: {
        views: [
          { key: "fleet", title: "Fleet 概览", widgets: fleetWidgets() },
          { key: "infra", title: "基础设施", widgets: [] },
          { key: "hostcontainer", title: "宿主机与容器", widgets: [] },
          { key: "appservice", title: "应用服务", widgets: [] },
          { key: "rule", title: "规则视角", widgets: [] },
          { key: "problem", title: "Problem 关联视角", widgets: [] },
        ],
        generated_at: "2026-06-29T12:00:00.000Z",
      },
    });
    renderPage();

    // All six view titles render in the Tabs tab bar (not a single list).
    await screen.findByText("Fleet 概览", {}, FIND_OPTS);
    expect(screen.getByText("基础设施")).toBeInTheDocument();
    expect(screen.getByText("宿主机与容器")).toBeInTheDocument();
    expect(screen.getByText("应用服务")).toBeInTheDocument();
    expect(screen.getByText("规则视角")).toBeInTheDocument();
    expect(screen.getByText("Problem 关联视角")).toBeInTheDocument();
    // The four Fleet summary cards render in the default-active Fleet pane.
    expect(screen.getAllByTestId("fleet-summary-card").length).toBe(4);
  });

  it("shows ≥2 metric trends in the 应用服务 view (timeseries panel_type)", async () => {
    const user = userEvent.setup();
    const { container } = renderWith({
      appservice: [
        profileWidget("p1", "container restart count"),
        profileWidget("p2", "container cpu usage"),
      ],
    });
    await user.click(await screen.findByTestId("dashboard-view-tab-appservice", {}, FIND_OPTS));
    // Two confirmed-profile widgets each run /query inside a TimeseriesPanel card.
    await waitFor(
      () => expect(container.querySelectorAll('[data-testid="timeseries-panel"]').length).toBeGreaterThanOrEqual(2),
      { timeout: 5000 },
    );
    expect(container.querySelectorAll('[data-testid="metric-chart-container"]').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll("canvas").length).toBeGreaterThanOrEqual(2);
  });

  it("dispatches a stat widget to StatCard and a gauge widget to GaugePanel by panel_type", async () => {
    const user = userEvent.setup();
    const statWidget = {
      ...(profileWidget("s1", "active connections") as Record<string, unknown>),
      panel_type: "stat" as const,
    };
    const gaugeWidget = {
      ...(profileWidget("g1", "cpu utilisation") as Record<string, unknown>),
      panel_type: "gauge" as const,
      unit: "%",
    };
    renderWith({ appservice: [statWidget, gaugeWidget] });
    await user.click(await screen.findByTestId("dashboard-view-tab-appservice", {}, FIND_OPTS));
    // StatCard + GaugePanel both mount (panel_type drives the dispatch, not the
    // default timeseries MetricChart).
    await waitFor(() => expect(screen.getByTestId("stat-card")).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(screen.getByTestId("gauge-panel")).toBeInTheDocument();
    // No timeseries chart mounted for the stat/gauge widgets.
    expect(screen.queryByTestId("metric-chart-container")).not.toBeInTheDocument();
  });

  it("degrades to an UnavailableCard (no blank) when query_range is unavailable", async () => {
    const user = userEvent.setup();
    const { container } = renderWith({
      appservice: [profileWidget("p1", "down metric")],
      queryByWidget: () => ({
        ok: false,
        status: "unavailable",
        reason: "Prometheus query_range HTTP 503",
        series: [],
        current_value: 7,
        threshold: null,
        breach_intervals: [],
        window_seconds: 3600,
        step_seconds: 60,
      }),
    });
    await user.click(await screen.findByTestId("dashboard-view-tab-appservice", {}, FIND_OPTS));
    await waitFor(
      () => expect(container.querySelectorAll('[data-testid="unavailable-card"]').length).toBeGreaterThanOrEqual(1),
      { timeout: 5000 },
    );
    // No chart canvas rendered for the unavailable widget (degraded, not blank).
    expect(container.querySelectorAll('[data-testid="metric-chart-container"]').length).toBe(0);
  });
});

describe("RuleTestRunChart — U10 P0-b rule test-run chart", () => {
  it("shows the threshold caption, breach band caption, and a verdict badge", async () => {
    installFetchHandler({
      layout: { views: [], generated_at: "2026-06-29T12:00:00.000Z" },
      queryByWidget: () => breachQuery(),
    });
    renderRuleChart("rule-1");

    // The threshold caption only renders once the /query response arrives
    // (it reads data.threshold), so awaiting it gates the verdict assertion on
    // data being present — otherwise the verdict badge reads "Unknown" while
    // current_value is still null.
    await screen.findByTestId("rule-test-run-threshold", {}, FIND_OPTS);
    // Verdict derived from current_value (0.95) > threshold (0.9) → Breach.
    expect(screen.getByTestId("rule-test-run-verdict").textContent ?? "").toContain("Breach");
    // Threshold caption renders the value as DOM text (canvas-independent).
    expect(screen.getByTestId("rule-test-run-threshold").textContent ?? "").toContain("0.9");
    // Breach band caption renders the breach-interval count as DOM text.
    expect(screen.getByTestId("rule-test-run-breach-count").textContent ?? "").toContain("1");
    // The chart container mounts (canvas initialised underneath).
    expect(screen.getByTestId("rule-test-run-chart")).toBeInTheDocument();
  });

  it("links the anomaly band to /problems?event_id=<uuid> when problemEventId is supplied", async () => {
    installFetchHandler({
      layout: { views: [], generated_at: "2026-06-29T12:00:00.000Z" },
      queryByWidget: () => breachQuery(),
    });
    renderRuleChart("rule-9", "evt-uuid-9");

    const link = await screen.findByTestId("rule-test-run-problem-link", {}, FIND_OPTS);
    const href = link.getAttribute("href") ?? "";
    expect(href).toContain("/problems");
    // The forward cross-jump targets the specific Problem by event_id (the
    // only param /api/problems highlights on), not the old ruleId form.
    expect(href).toContain("event_id=evt-uuid-9");
    expect(href).not.toContain("ruleId=");
  });

  it("does NOT render a Problem link on a standalone chart with a breach but no problemEventId (no fabricated /problems?ruleId=… URL)", async () => {
    installFetchHandler({
      layout: { views: [], generated_at: "2026-06-29T12:00:00.000Z" },
      queryByWidget: () => breachQuery(),
    });
    // No problemEventId — standalone rule-view / Problem-detail embed shape.
    renderRuleChart("rule-9");

    // The breach band caption confirms the breach is present (the gate that
    // would otherwise show the link), so a missing link is attributable to the
    // missing problemEventId, not to an absent breach.
    await screen.findByTestId("rule-test-run-breach-count", {}, FIND_OPTS);
    expect(screen.queryByTestId("rule-test-run-problem-link")).not.toBeInTheDocument();
  });

  it("shows a Normal verdict and no Problem link when there is no breach", async () => {
    installFetchHandler({
      layout: { views: [], generated_at: "2026-06-29T12:00:00.000Z" },
      queryByWidget: () => ({
        ok: true,
        status: "ok",
        reason: null,
        series: defaultSeries().series,
        current_value: 0.4, // < threshold 0.9 → normal
        threshold: { value: 0.9, operator: "gt" },
        breach_intervals: [],
        window_seconds: 3600,
        step_seconds: 60,
      }),
    });
    renderRuleChart("rule-ok");

    // Wait for the query to resolve (threshold caption is data-gated) before
    // asserting the verdict — otherwise the badge still reads "Unknown".
    await screen.findByTestId("rule-test-run-threshold", {}, FIND_OPTS);
    expect(screen.getByTestId("rule-test-run-verdict").textContent ?? "").toContain("Normal");
    expect(screen.queryByTestId("rule-test-run-problem-link")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rule-test-run-breach-count")).not.toBeInTheDocument();
  });
});

describe("BusinessMetricsDashboardPage — U11 Problem 关联视角 forward cross-jump", () => {
  it("renders the Problem view tab and deep-links each rule to /problems?event_id=<uuid> via the embedded chart", async () => {
    const user = userEvent.setup();
    const eventId = "11111111-2222-3333-4444-555555555555";
    installFetchHandler({
      layout: {
        views: [
          { key: "fleet", title: "Fleet 概览", widgets: fleetWidgets() },
          { key: "infra", title: "基础设施", widgets: [] },
          { key: "hostcontainer", title: "宿主机与容器", widgets: [] },
          { key: "appservice", title: "应用服务", widgets: [] },
          { key: "rule", title: "规则视角", widgets: [] },
          {
            key: "problem",
            title: "Problem 关联视角",
            widgets: [problemRuleWidget("rule-p", eventId)],
          },
        ],
        generated_at: "2026-06-29T12:00:00.000Z",
      },
      queryByWidget: (widgetId) =>
        widgetId === "rule:rule-p" ? breachQuery() : defaultSeries(),
    });
    renderPage();

    // The Problem view tab is present (six-view IA).
    await user.click(await screen.findByTestId("dashboard-view-tab-problem", {}, FIND_OPTS));

    // The embedded chart's forward link targets the specific Problem event.
    // ProblemAssociationView passes problem_event_id to RuleTestRunChart, so
    // the link is the chart's own (single link per card, no duplicate).
    const link = await screen.findByTestId("rule-test-run-problem-link", {}, FIND_OPTS);
    const href = link.getAttribute("href") ?? "";
    expect(href).toContain("/problems");
    expect(href).toContain(`event_id=${eventId}`);
    expect(href).not.toContain("ruleId=");
    // No duplicate external forward link — the chart owns the single link.
    expect(screen.queryByTestId("dashboard-problem-forward-link")).not.toBeInTheDocument();
  });

  it("shows the empty placeholder when no rule has both a breach and a linked Problem", async () => {
    const user = userEvent.setup();
    installFetchHandler({
      layout: {
        views: [
          { key: "fleet", title: "Fleet 概览", widgets: fleetWidgets() },
          { key: "infra", title: "基础设施", widgets: [] },
          { key: "hostcontainer", title: "宿主机与容器", widgets: [] },
          { key: "appservice", title: "应用服务", widgets: [] },
          { key: "rule", title: "规则视角", widgets: [] },
          { key: "problem", title: "Problem 关联视角", widgets: [] },
        ],
        generated_at: "2026-06-29T12:00:00.000Z",
      },
    });
    renderPage();
    await user.click(await screen.findByTestId("dashboard-view-tab-problem", {}, FIND_OPTS));
    // No chart-mounted forward link when the view is empty.
    expect(screen.queryByTestId("rule-test-run-problem-link")).not.toBeInTheDocument();
  });
});

/** Helper: render the full dashboard with the three Grafana-aligned
 * perspective views (infra / hostcontainer / appservice) populated from the
 * given widgets, wiring /query to defaultSeries(). */
function renderWith(opts: {
  infra?: unknown[];
  hostcontainer?: unknown[];
  appservice?: unknown[];
  rule?: unknown[];
  queryByWidget?: (widgetId: string) => unknown;
}) {
  const layout: Layout = {
    views: [
      { key: "fleet", title: "Fleet 概览", widgets: fleetWidgets() },
      { key: "infra", title: "基础设施", widgets: opts.infra ?? [] },
      { key: "hostcontainer", title: "宿主机与容器", widgets: opts.hostcontainer ?? [] },
      { key: "appservice", title: "应用服务", widgets: opts.appservice ?? [] },
      { key: "rule", title: "规则视角", widgets: opts.rule ?? [] },
    ],
    generated_at: "2026-06-29T12:00:00.000Z",
  };
  installFetchHandler({ layout, queryByWidget: opts.queryByWidget });
  return renderPage();
}
