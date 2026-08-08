import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { MetricChartStatus, MetricSeries } from "../components/charts/types";

/**
 * U10 — admin react-query hooks for the F5 business-metrics dashboard.
 *
 * Two endpoints back the six-view dashboard:
 *   - `GET  /api/monitoring/dashboards/business-metrics` → the auto-generated
 *     six-view layout (Fleet 概览 / 基础设施 / 宿主机与容器 / 应用服务 / 规则视角
 *     / Problem 关联视角) with one widget per confirmed profile / enabled rule
 *     plus the Fleet roll-up summary cards. The Problem view adds a forward
 *     cross-jump target (`problem_event_id`) per rule widget (U11).
 *   - `POST /api/monitoring/dashboards/business-metrics/query` → a time series
 *     + current value + threshold + breach intervals for a single widget, run
 *     server-side via `metricConnectors.queryRange` (the admin never calls
 *     Prometheus directly).
 *
 * The backend degrades to `{ ok:false, status:'unavailable', reason }` rather
 * than throwing on query_range failure (KTD 7): that fail-soft envelope is
 * returned with HTTP 200, so a query hook resolves and the dashboard renders
 * an UnavailableCard. A true network/5xx failure (not the fail-soft envelope)
 * still rejects the hook — callers read `isError` and degrade to the same
 * UnavailableCard with the error reason (see WidgetChart / RuleTestRunChart).
 * Query keys are scoped per widget + window so switching tabs does not refetch
 * siblings.
 */

const BASE = "/api/monitoring/dashboards/business-metrics";

/** A contiguous breach window (ISO start/end) for a rule, from test-runs. */
export interface BreachInterval {
  start: string;
  end: string;
  matched_count: number;
}

/** Comparison operator for a rule threshold. `undefined` (no operator stored)
 * is tolerated by consumers as "exceeds" (gt) semantics — the common shape. */
export type RuleOperator = "gt" | "gte" | "lt" | "lte" | "eq";

/** A rule threshold ({value, operator}) as returned by the dashboard routes. */
export interface RuleThreshold {
  value?: number;
  operator?: RuleOperator | string;
}

export type DashboardWidgetKind = "profile" | "rule" | "summary";

/**
 * Grafana-style panel render hint (migration 0059). The dashboard dispatches
 * a widget to a StatCard / GaugePanel / MetricChart by this value; `null` ⇒
 * the backend already inferred a type from `unit`/`kind` (see
 * business-metrics-dashboard service `inferPanelType`), so the rendered
 * widget always carries a non-null `panel_type`.
 */
export type PanelType = "stat" | "gauge" | "timeseries";

export interface DashboardWidget {
  /** Prefix-tagged: "profile:<id>" | "rule:<id>" | "summary:<key>". */
  id: string;
  kind: DashboardWidgetKind;
  title: string;
  source_id: string | null;
  source_name: string | null;
  query: string | null;
  unit: string | null;
  risk_tier: string | null;
  target_kind: string | null;
  target_ref: string | null;
  /** Rule threshold_json ({value, operator}) — drives the threshold line. */
  threshold: RuleThreshold | null;
  /** Most recent contiguous breach window (rule widgets only). */
  recent_breach_interval: BreachInterval | null;
  rule_id: string | null;
  profile_id: string | null;
  /** Curated catalog key (`metric_name`); drives Grafana panel order server-side. */
  metric_name: string | null;
  /** Summary widgets only: the scalar count for the Fleet card. */
  value: number | null;
  /**
   * Grafana-style panel render hint (migration 0059). Drives WidgetChart
   * dispatch: 'stat' → StatCard, 'gauge' → GaugePanel, 'timeseries' →
   * MetricChart. The backend infers a type when the operator left it null,
   * so rendered widgets carry a non-null value.
   */
  panel_type: PanelType | null;
  /**
   * U11 — Problem-association view only: the most recent open Problem event id
   * linked to this rule. Drives the forward cross-jump to
   * `/problems?event_id=<problem_event_id>`. Null outside the problem view or
   * when no open Problem is linked.
   */
  problem_event_id: string | null;
  /** Problem group id for the linked Problem. */
  problem_group_id: string | null;
  /** Severity (P1/P2/P3) of the linked Problem. */
  problem_severity: string | null;
  /** Display title for the linked Problem. */
  problem_title: string | null;
}

export interface DashboardView {
  /**
   * Six Grafana-aligned views (PRD F5, post v0.3 split): Fleet overview /
   * 基础设施 / 宿主机与容器 / 应用服务 / 规则视角 / Problem 关联视角. The
   * three middle views mirror the Grafana "Futures - 基础设施 / 宿主机与容器 /
   * 应用服务" dashboards; fleet/rule/problem preserve the prior U9/U11 bridges.
   */
  key: "fleet" | "infra" | "hostcontainer" | "appservice" | "rule" | "problem";
  title: string;
  widgets: DashboardWidget[];
}

export interface DashboardLayout {
  views: DashboardView[];
  generated_at: string;
}

export interface DashboardQueryResult {
  ok: boolean;
  status: MetricChartStatus;
  reason: string | null;
  series: MetricSeries[];
  current_value: number | null;
  threshold: RuleThreshold | null;
  breach_intervals: BreachInterval[];
  window_seconds: number;
  step_seconds: number;
}

const LAYOUT_KEY = ["dashboard-layout"] as const;

/** The auto-generated six-view layout. */
export function useDashboardLayout() {
  return useQuery({
    queryKey: LAYOUT_KEY,
    queryFn: () => api<DashboardLayout>(BASE),
    // Fail-soft at the service boundary: the layout route returns an empty
    // six-view layout (200) on transient DB failure rather than throwing, so
    // this resolves even when the backend is partially degraded.
    retry: 1,
  });
}

// --- Discovery redesign (migration 0061): on-demand metric sync --------------
//
// The dashboard no longer relies on an AI recommend/confirm/enable flow. The
// operator triggers a manual "同步业务指标" action that calls
// POST /api/monitoring/business-metrics/data-sources/:id/sync, which records
// the data source's full discovered metric set into business_metric_profiles
// (is_curated=false) and writes the Grafana-aligned curated KPI rows from the
// code-level catalog (is_curated=true) whose base metrics actually exist on
// that source. On success the layout query is invalidated so the dashboard
// refetches and the new/refreshed curated panels appear.

/** A business data source row (GET /data-sources). */
export interface BusinessDataSource {
  id: string;
  name: string;
  type: string;
  /** ISO timestamp of the most recent sync, if any. */
  last_synced_at?: string | null;
}

/** Result shape returned by POST /data-sources/:id/sync. */
export interface SyncMetricsResult {
  total_discovered: number;
  curated_count: number;
  curated_skipped: number;
}

const DATA_SOURCES_KEY = ["business-data-sources"] as const;

/** List business data sources (for the sync-source picker). */
export function useBusinessDataSources() {
  return useQuery({
    queryKey: DATA_SOURCES_KEY,
    queryFn: () => api<{ items: BusinessDataSource[]; total: number }>(
      "/api/monitoring/business-metrics/data-sources",
    ),
    retry: 1,
  });
}

/**
 * Trigger an on-demand metric sync for one data source. On success the layout
 * + data-sources queries are invalidated so the dashboard refetches the curated
 * panels and the "last synced" stamp updates. The mutation rejects on a non-2xx
 * (e.g. Prometheus unreachable → 500 with the real reason), so the caller can
 * surface the message in an error toast — the backend deliberately does not
 * fail-soft here, so the operator sees why the sync did not happen.
 */
export function useSyncBusinessMetrics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) =>
      api<SyncMetricsResult>(
        `/api/monitoring/business-metrics/data-sources/${sourceId}/sync`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LAYOUT_KEY });
      qc.invalidateQueries({ queryKey: DATA_SOURCES_KEY });
    },
  });
}

export interface DashboardWidgetQueryOpts {
  /** Window length in seconds (default 1h). */
  window_seconds?: number;
  /** Step in seconds (default 60). */
  step_seconds?: number;
  /** When false the hook is disabled (no fetch). Default: widgetId present. */
  enabled?: boolean;
}

/**
 * Run `query_range` for a single widget. Pass a `widget_id` (`profile:<id>` or
 * `rule:<id>`) resolved server-side to its source + query. Degrades to an
 * `unavailable` envelope (with a current_value from the instant fallback) on
 * query_range failure — the hook still resolves, so the caller renders an
 * UnavailableCard, not a thrown error boundary.
 */
export function useDashboardWidgetQuery(
  widgetId: string | null | undefined,
  opts: DashboardWidgetQueryOpts = {},
) {
  const window_seconds = opts.window_seconds ?? 3600;
  const step_seconds = opts.step_seconds ?? 60;
  return useQuery({
    queryKey: ["dashboard-query", widgetId, window_seconds, step_seconds] as const,
    enabled: (opts.enabled ?? Boolean(widgetId)) && Boolean(widgetId),
    queryFn: () =>
      api<DashboardQueryResult>(`${BASE}/query`, {
        method: "POST",
        body: JSON.stringify({ widget_id: widgetId, window_seconds, step_seconds }),
      }),
    // The backend fail-soft envelope is a 200, so a true network failure is
    // the only rejection path — keep retry conservative to avoid hammering a
    // downed Prometheus on the dashboard.
    retry: 1,
    // Keep the previous window's data visible while a window switch refetches
    // so the verdict / threshold / curve do not flash to "unknown" / blank for
    // the duration of every refetch.
    placeholderData: keepPreviousData,
  });
}