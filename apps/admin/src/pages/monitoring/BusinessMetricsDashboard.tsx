import { DashboardOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Statistic,
  Tabs,
  Typography,
} from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAnomalyRules } from "../../api/anomaly-rules";
import { api } from "../../api/client";
import {
  useDashboardLayout,
  useDashboardWidgetQuery,
  useBusinessDataSources,
  useSyncBusinessMetrics,
} from "../../api/business-metrics-dashboard";
import type { DashboardQueryResult, DashboardView, DashboardWidget } from "../../api/business-metrics-dashboard";
import { ModulePageShell } from "../../components/ModulePageShell";
import { intervalsToBands, thresholdToLine } from "../../components/charts/annotations";
import { DashboardPanelGrid } from "../../components/charts/DashboardPanelGrid";
import {
  grafanaPanelHeight,
  packRuleWidgetsIntoRows,
  packWidgetsIntoRows,
} from "../../components/charts/dashboard-grid";
import { GaugePanel } from "../../components/charts/GaugePanel";
import { StatCard } from "../../components/charts/StatCard";
import { TimeseriesPanel } from "../../components/charts/TimeseriesPanel";
import { RuleTestRunChart } from "./RuleTestRunChart";

/**
 * U10 — F5 six-view business-metrics dashboard (PRD §5 F5, §9 P0-b; v0.3
 * Grafana-aligned split).
 *
 * Renders six views as distinct tabs — NOT a flat chart list:
 *   - Fleet 概览 — the four roll-up summary cards;
 *   - 基础设施 / 宿主机与容器 / 应用服务 — the three Grafana-aligned
 *     perspectives (mirroring the Futures - 基础设施 / 宿主机与容器 / 应用服务
 *     dashboards). Each queryable widget (confirmed profile or enabled rule)
 *     runs its own `query_range` via the U9 `/query` endpoint and renders a
 *     Grafana-style panel chosen by its `panel_type`: stat → StatCard, gauge →
 *     GaugePanel, timeseries (default) → MetricChart;
 *   - 规则视角 — a RuleTestRunChart per rule (curve + threshold + breach band
 *     + verdict + Problem cross-link);
 *   - Problem 关联视角 (U11) — one RuleTestRunChart per rule that has BOTH a
 *     breach and a linked open Problem, with a forward cross-jump from the
 *     breach to `/problems?event_id=<id>` — the 异常区间 → Problem half of the
 *     bidirectional bridge (the reverse half lives in ProblemList.tsx, which
 *     embeds the same chart in a Problem detail).
 *
 * Degradation (PRD F5): when `query_range` is unavailable the backend returns
 * `{ ok:false, status:'unavailable', reason, current_value }` and each panel
 * renders an UnavailableCard — never a blank panel.
 */

type WindowKey = "15m" | "1h" | "6h" | "24h";

type ViewKey = DashboardView["key"];

const DASHBOARD_QUERY_PATH = "/api/monitoring/dashboards/business-metrics/query";

const WINDOW_SECONDS: Record<WindowKey, number> = {
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
};

/** Step per window — coarse enough to keep the range query cheap across a
 * long window, fine enough that the curve reads as a trend, not a stair. */
const STEP_SECONDS: Record<WindowKey, number> = {
  "15m": 15,
  "1h": 60,
  "6h": 120,
  "24h": 300,
};

/**
 * A single queryable widget card (profile or rule) in the 基础设施 / 宿主机与
 * 容器 / 应用服务 views. Fetches its `query_range` and renders a Grafana-style
 * panel chosen by the widget's `panel_type` (migration 0059):
 *   - 'stat'      → StatCard (big current value + sparkline + delta + badges)
 *   - 'gauge'     → GaugePanel (0–100% utilisation dial)
 *   - 'timeseries' → MetricChart (line trend + threshold + breach bands)
 * The backend infers a type from `unit`/`kind` when the operator left
 * `panel_type` null, so `timeseries` is the safe default. Every panel
 * degrades to an UnavailableCard on query_range failure (never blank).
 */
function WidgetChart({ widget, rowHeight, windowSeconds, stepSeconds, chartActive }: {
  widget: DashboardWidget;
  /** Row height from the 24-col grid packer — keeps cards in a row aligned. */
  rowHeight: number;
  windowSeconds: number;
  stepSeconds: number;
  /** When false the pane is hidden — defer canvas mount to avoid 0×0 charts. */
  chartActive: boolean;
}) {
  const { data, isLoading, isError, error } = useDashboardWidgetQuery(widget.id, {
    window_seconds: windowSeconds,
    step_seconds: stepSeconds,
  });

  // Threshold precedence: a widget-side threshold wins only when it carries a
  // finite value; otherwise fall through to the /query threshold so a rule
  // rendered in a perspective view does not silently lose its line.
  const wt = widget.threshold;
  const effectiveThreshold =
    wt && typeof wt.value === "number" && Number.isFinite(wt.value)
      ? wt
      : (data?.threshold ?? wt ?? null);
  const thresholds = thresholdToLine(effectiveThreshold);
  const bands = intervalsToBands(data?.breach_intervals);

  // A true network/5xx failure (not the fail-soft 200 envelope) rejects the
  // hook — surface it as the same UnavailableCard with the real reason, and
  // keep the current-value honest ('—' rather than a fabricated 0).
  const isHardError = isError || data?.status === "unavailable";
  const errorReason = isError
    ? error instanceof Error
      ? error.message
      : "query failed"
    : (data?.reason ?? undefined);
  const cv = data?.current_value;
  const cvFinite = cv != null && Number.isFinite(cv);
  const status = isHardError ? "unavailable" : (data?.status ?? "ok");
  const series = data?.series ?? [];
  const panelHeight = rowHeight;

  if (!chartActive) {
    return null;
  }

  if (widget.panel_type === "stat") {
    return (
      <StatCard
        className="dashboard-widget-panel"
        title={widget.title}
        value={cvFinite ? (cv as number) : null}
        unit={widget.unit}
        series={series}
        threshold={effectiveThreshold}
        riskTier={widget.risk_tier}
        status={status}
        reason={errorReason}
        loading={isLoading}
        sourceName={widget.source_name}
        height={panelHeight}
        panelType="stat"
      />
    );
  }
  if (widget.panel_type === "gauge") {
    return (
      <GaugePanel
        className="dashboard-widget-panel"
        title={widget.title}
        value={cvFinite ? (cv as number) : null}
        max={cvFinite && Math.abs(cv as number) <= 1 ? 1 : 100}
        unit={widget.unit}
        threshold={effectiveThreshold}
        riskTier={widget.risk_tier}
        status={status}
        reason={errorReason}
        loading={isLoading}
        sourceName={widget.source_name}
        height={panelHeight}
      />
    );
  }
  return (
    <TimeseriesPanel
      className="dashboard-widget-panel"
      title={widget.title}
      value={cvFinite ? (cv as number) : null}
      unit={widget.unit}
      series={series}
      thresholds={thresholds}
      bands={bands}
      threshold={effectiveThreshold}
      riskTier={widget.risk_tier}
      status={status}
      reason={errorReason}
      loading={isLoading}
      sourceName={widget.source_name}
      height={panelHeight}
    />
  );
}

/** Fleet overview: four summary cards on one 24-col row (6 + 6 + 6 + 6). */
function FleetSummary({ widgets }: { widgets: DashboardWidget[] }) {
  const row = {
    widgets: widgets.map((w) => ({ widget: w, colSpan: 6 })),
    height: grafanaPanelHeight("stat"),
  };
  return (
    <DashboardPanelGrid
      rows={[row]}
      getKey={(w) => w.id}
      data-testid="dashboard-fleet-summary"
      renderWidget={(w, h) => (
        <Card style={{ height: "100%" }} bodyStyle={{ padding: 16, height: h }}>
          <Statistic title={w.title} value={w.value ?? "—"} data-testid="fleet-summary-card" />
        </Card>
      )}
    />
  );
}

/**
 * U11 — Problem 关联视角: the 异常区间 → Problem forward half of the
 * bidirectional bridge. Each rule widget that has BOTH a breach interval AND a
 * linked open Problem (carried as `problem_event_id`) renders a
 * RuleTestRunChart with `problemEventId` set, so the chart's own
 * "查看关联 Problem" link targets `/problems?event_id=<problem_event_id>` —
 * that deep link highlights the specific Problem row in ProblemList
 * (ProblemList.tsx reads `event_id` from search params). The reverse direction
 * (Problem detail → embedded chart) is already wired in ProblemList, so this
 * completes the closed loop PRD F5 describes ("把'看到趋势'和'看到事件'接成闭环").
 *
 * The forward link is owned by the chart (single source per card) — a second
 * external link would duplicate the same target. The widget's `problem_*`
 * fields are null outside the problem view (the backend only populates them
 * for rules with an open Problem), so the link renders exactly when there is a
 * real jump target — no "no Problem" stub. When the view is empty (no rule has
 * both a breach and a Problem) it degrades to an Empty placeholder, never a
 * blank panel (KTD 7).
 */
function ProblemAssociationView({
  widgets,
  windowSeconds,
  stepSeconds,
  enabled,
}: {
  widgets: DashboardWidget[];
  windowSeconds: number;
  stepSeconds: number;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const linkable = widgets.filter((w) => w.kind === "rule" && w.rule_id && w.problem_event_id);
  if (!enabled) {
    return null;
  }
  if (linkable.length === 0) {
    return <Empty description={t("monitoring.dashboard.emptyProblem")} />;
  }
  const rows = packRuleWidgetsIntoRows(linkable);
  return (
    <DashboardPanelGrid
      rows={rows}
      getKey={(w) => w.id}
      data-testid="dashboard-problem-view"
      renderWidget={(w, h) => (
        <RuleTestRunChart
          ruleId={w.rule_id!}
          ruleName={w.title}
          windowSeconds={windowSeconds}
          stepSeconds={stepSeconds}
          problemEventId={w.problem_event_id!}
          height={h}
          enabled
        />
      )}
    />
  );
}

export function BusinessMetricsDashboardPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const { data: layout, isLoading } = useDashboardLayout();
  const { data: enabledRulesData } = useAnomalyRules("enabled");
  const [windowKey, setWindowKey] = useState<WindowKey>("1h");
  const [activeViewKey, setActiveViewKey] = useState<ViewKey>("fleet");
  const windowSeconds = WINDOW_SECONDS[windowKey];
  const stepSeconds = STEP_SECONDS[windowKey];

  // Discovery redesign (migration 0061): on-demand metric sync. The modal
  // lists business data sources; picking one and confirming calls
  // POST /data-sources/:id/sync, which records the full discovered metric set
  // + the Grafana-aligned curated KPI rows. On success the layout refetches
  // so the new curated panels appear. A connector failure (Prometheus
  // unreachable) rejects → the real reason surfaces in an error toast.
  const { data: sourcesData } = useBusinessDataSources();
  const syncMutation = useSyncBusinessMetrics();
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncSourceId, setSyncSourceId] = useState<string | undefined>();
  const sources = sourcesData?.items ?? [];

  const runSync = async () => {
    if (!syncSourceId) return;
    try {
      const res = await syncMutation.mutateAsync(syncSourceId);
      message.success(
        t("monitoring.dashboard.syncDone", res as unknown as Record<string, number>),
      );
      setSyncOpen(false);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "sync failed";
      message.error(t("monitoring.dashboard.syncFailed", { reason }));
    }
  };

  const views = useMemo(() => layout?.views ?? [], [layout]);

  const uncoveredHighRiskProfile = useMemo(() => {
    const profileWidgets = views.flatMap((view) =>
      view.widgets.filter((w) => w.kind === "profile" && w.profile_id),
    );
    const enabledRules = enabledRulesData?.items ?? [];
    return (
      profileWidgets.find((w) => {
        const tier = w.risk_tier;
        if (tier !== "L2" && tier !== "L3") return false;
        return !enabledRules.some(
          (r) => r.source_id === w.source_id && r.query_text === w.query,
        );
      }) ?? null
    );
  }, [views, enabledRulesData?.items]);

  // Prefetch every queryable widget so switching tabs does not cold-start
  // Prometheus, while deferring chart mount until the pane is visible (charts
  // in hidden panes render at 0×0 and never recover with @ant-design/charts).
  useEffect(() => {
    if (!views.length) return;
    const widgets = views.flatMap((view) =>
      view.widgets.filter((w) => w.kind === "profile" || w.kind === "rule"),
    );
    for (const widget of widgets) {
      void queryClient.prefetchQuery({
        queryKey: ["dashboard-query", widget.id, windowSeconds, stepSeconds] as const,
        queryFn: () =>
          api<DashboardQueryResult>(DASHBOARD_QUERY_PATH, {
            method: "POST",
            body: JSON.stringify({
              widget_id: widget.id,
              window_seconds: windowSeconds,
              step_seconds: stepSeconds,
            }),
          }),
        staleTime: 30_000,
      });
    }
  }, [views, windowSeconds, stepSeconds, queryClient]);

  const tabItems = useMemo(() => {
    const chartActive = (viewKey: ViewKey) => activeViewKey === viewKey;
    return views.map((view) => {
      let children: ReactNode;
      if (view.key === "fleet") {
        children = view.widgets.length ? (
          <FleetSummary widgets={view.widgets} />
        ) : (
          <Empty description={t("monitoring.dashboard.emptyFleet")} />
        );
      } else if (view.key === "rule") {
        const ruleWidgets = view.widgets.filter((w) => w.kind === "rule" && w.rule_id);
        children = !chartActive("rule") ? null : ruleWidgets.length ? (
          <DashboardPanelGrid
            rows={packRuleWidgetsIntoRows(ruleWidgets)}
            getKey={(w) => w.id}
            renderWidget={(w, h) => (
              <RuleTestRunChart
                ruleId={w.rule_id!}
                ruleName={w.title}
                windowSeconds={windowSeconds}
                stepSeconds={stepSeconds}
                height={h}
                enabled={chartActive("rule")}
              />
            )}
          />
        ) : (
          <Empty description={t("monitoring.dashboard.emptyRule")} />
        );
      } else if (view.key === "problem") {
        children = (
          <ProblemAssociationView
            widgets={view.widgets}
            windowSeconds={windowSeconds}
            stepSeconds={stepSeconds}
            enabled={chartActive("problem")}
          />
        );
      } else {
        // infra / hostcontainer / appservice: the three Grafana-aligned
        // perspective views — queryable widgets dispatched by panel_type.
        const queryable = view.widgets.filter((w) => w.kind === "profile" || w.kind === "rule");
        children = queryable.length ? (
          <DashboardPanelGrid
            rows={packWidgetsIntoRows(queryable, view.key)}
            getKey={(w) => w.id}
            renderWidget={(w, h) => (
              <WidgetChart
                widget={w}
                rowHeight={h}
                windowSeconds={windowSeconds}
                stepSeconds={stepSeconds}
                chartActive={chartActive(view.key)}
              />
            )}
          />
        ) : (
          <Empty description={t("monitoring.dashboard.emptyView")} />
        );
      }
      return {
        key: view.key,
        label: (
          <span data-testid={`dashboard-view-tab-${view.key}`}>{view.title}</span>
        ),
        children,
      };
    });
  }, [views, windowSeconds, stepSeconds, activeViewKey, t]);

  return (
    <ModulePageShell
      icon={<DashboardOutlined style={{ fontSize: 20 }} />}
      title={t("monitoring.dashboard.title")}
      subtitle={t("monitoring.dashboard.subtitle")}
      action={
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              setSyncSourceId(sources[0]?.id);
              setSyncOpen(true);
            }}
            data-testid="dashboard-sync-button"
          >
            {t("monitoring.dashboard.syncAction")}
          </Button>
          <Segmented
            value={windowKey}
            onChange={(v) => setWindowKey(v as WindowKey)}
            options={[
              { label: "15m", value: "15m" },
              { label: "1h", value: "1h" },
              { label: "6h", value: "6h" },
              { label: "24h", value: "24h" },
            ]}
            data-testid="dashboard-window-selector"
          />
        </div>
      }
    >
      {uncoveredHighRiskProfile ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          data-testid="dashboard-profile-guidance"
          message={t("monitoring.dashboard.profileGuidance.message", {
            name: uncoveredHighRiskProfile.title,
          })}
          action={
            <Link
              to={`/monitoring/risk-metrics?profile_id=${uncoveredHighRiskProfile.profile_id}`}
            >
              <Button size="small" type="primary">
                {t("monitoring.dashboard.profileGuidance.cta")}
              </Button>
            </Link>
          }
        />
      ) : null}

      {isLoading ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : views.length === 0 ? (
        <Empty description={t("monitoring.dashboard.emptyLayout")} />
      ) : (
        <Tabs
          activeKey={activeViewKey}
          onChange={(key) => setActiveViewKey(key as ViewKey)}
          items={tabItems}
        />
      )}

      <Modal
        open={syncOpen}
        title={t("monitoring.dashboard.syncTitle")}
        okText={t("monitoring.dashboard.syncOk")}
        cancelText={t("monitoring.dashboard.syncCancel")}
        okButtonProps={{ loading: syncMutation.isPending, disabled: !syncSourceId }}
        onCancel={() => setSyncOpen(false)}
        onOk={runSync}
        data-testid="dashboard-sync-modal"
      >
        <Typography.Paragraph type="secondary">
          {t("monitoring.dashboard.syncPickSourceHint")}
        </Typography.Paragraph>
        <Select
          style={{ width: "100%" }}
          placeholder={t("monitoring.dashboard.syncPickSource")}
          value={syncSourceId}
          onChange={setSyncSourceId}
          options={sources.map((s) => ({ label: s.name, value: s.id }))}
          data-testid="dashboard-sync-source-select"
        />
      </Modal>
    </ModulePageShell>
  );
}

export default BusinessMetricsDashboardPage;