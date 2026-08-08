import { AlertOutlined, CheckCircleTwoTone, LinkOutlined, WarningTwoTone } from "@ant-design/icons";
import { Card, Space, Tag, Typography } from "antd";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDashboardWidgetQuery } from "../../api/business-metrics-dashboard";
import type { RuleThreshold } from "../../api/business-metrics-dashboard";
import { intervalsToBands, thresholdToLine } from "../../components/charts/annotations";
import { MetricChart } from "../../components/charts/MetricChart";

/**
 * U10 — rule test-run chart (PRD §9 P0-b).
 *
 * The backend `anomaly_rules/:id/test` returns ONLY the instant verdict (no
 * time series), so the test-run curve reuses the U9 dashboard `/query`
 * endpoint with `widget_id = "rule:<id>"` to fetch the series + threshold +
 * breach intervals, then overlays:
 *   - the threshold line (g2 `lineY`),
 *   - the breach band(s) (g2 `rangeX`, via MetricChart `bands`),
 *   - the verdict badge (命中 / 正常 / 未知), derived client-side from
 *     `current_value` vs the rule threshold,
 *   - a "查看关联 Problem" cross-link when a breach window exists AND the
 *     caller supplied a Problem jump target (PRD F5 anomaly → Problem linkage).
 *
 * Problem link target (U11 fix): the backend `/api/problems` list only
 * supports the `event_id` query param (it highlights a specific Problem row),
 * NOT `ruleId`. The link therefore requires an explicit target supplied by
 * the caller — either `problemEventId` (renders `/problems?event_id=<uuid>`)
 * or a pre-built `problemHref`. A standalone chart with no target renders NO
 * link rather than a `/problems?ruleId=…` URL that would not resolve. The
 * Problem-association view passes `problem_event_id`; the rule view and the
 * Problem-detail embed omit it, so neither shows a broken link.
 *
 * Standalone and Prometheus-free so U11 can embed the same chart inside a
 * Problem detail. Degrades to an UnavailableCard (inside MetricChart) when
 * `query_range` is unavailable — never a blank panel.
 */

export interface RuleTestRunChartProps {
  ruleId: string;
  /** Rule name shown in the panel header. */
  ruleName?: string;
  /** Optional Y-axis unit. */
  unit?: string;
  /** Window length in seconds (default 1h, matching the dashboard default). */
  windowSeconds?: number;
  /** Step in seconds (default 60). */
  stepSeconds?: number;
  /** Panel height in px (default 260 — taller than a sparkline for detail). */
  height?: number;
  /** When false, skip the /query fetch (inactive dashboard tab). Default true. */
  enabled?: boolean;
  /**
   * U11 — Problem event id for the forward cross-jump. When set (and a breach
   * is present) the "查看关联 Problem" link targets `/problems?event_id=<uuid>`,
   * which highlights the specific Problem row in ProblemList. Omit for
   * standalone charts that have no Problem context (rule view, Problem-detail
   * embed) — the link is hidden rather than fabricated.
   */
  problemEventId?: string;
  /**
   * Pre-built Problem href override. Takes precedence over `problemEventId`
   * when a caller needs a non-standard target. Same hasBreach gate applies.
   */
  problemHref?: string;
}

type Verdict = "breach" | "ok" | "unknown";

/** Compare a current value against a rule threshold ({value, operator}).
 * Returns "unknown" when the value or threshold is missing/non-finite so the
 * badge never lies about an unavailable current value. An unrecognized operator
 * also yields "unknown" — a new backend operator should surface as visibly
 * broken rather than a confidently-wrong Breach/Normal. */
function evaluateVerdict(current: number | null | undefined, threshold: RuleThreshold | null): Verdict {
  if (current == null || !Number.isFinite(current)) return "unknown";
  if (!threshold || typeof threshold.value !== "number" || !Number.isFinite(threshold.value)) {
    return "unknown";
  }
  const v = threshold.value;
  switch (threshold.operator) {
    case "gt":
      return current > v ? "breach" : "ok";
    case "gte":
      return current >= v ? "breach" : "ok";
    case "lt":
      return current < v ? "breach" : "ok";
    case "lte":
      return current <= v ? "breach" : "ok";
    case "eq":
      return current === v ? "breach" : "ok";
    case undefined:
      // No operator stored → "exceeds threshold" (gt) semantics, the most
      // common threshold shape in the rule library.
      return current > v ? "breach" : "ok";
    default:
      // Unrecognized operator → do not guess.
      return "unknown";
  }
}

export function RuleTestRunChart({
  ruleId,
  ruleName,
  unit,
  windowSeconds = 3600,
  stepSeconds = 60,
  height = 260,
  problemEventId,
  problemHref,
  enabled = true,
}: RuleTestRunChartProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError, error } = useDashboardWidgetQuery(`rule:${ruleId}`, {
    window_seconds: windowSeconds,
    step_seconds: stepSeconds,
    enabled,
  });

  const threshold = data?.threshold ?? null;
  const verdict = useMemo(() => evaluateVerdict(data?.current_value ?? null, threshold), [data?.current_value, threshold]);
  const bands = useMemo(() => intervalsToBands(data?.breach_intervals), [data?.breach_intervals]);

  if (!enabled) {
    return null;
  }

  const thresholdLine = thresholdToLine(
    threshold,
    threshold && typeof threshold.value === "number" ? t("monitoring.dashboard.thresholdLabel", { value: threshold.value }) : undefined,
  );

  const hasBreach = bands.length > 0;

  // A true network/5xx failure (not the fail-soft 200 envelope) rejects the
  // hook — degrade to the same UnavailableCard with the real reason.
  const isHardError = isError || data?.status === "unavailable";
  const errorReason = isError
    ? error instanceof Error
      ? error.message
      : "query failed"
    : (data?.reason ?? undefined);

  const verdictTag = (() => {
    if (verdict === "breach") {
      return (
        <Tag color="red" icon={<WarningTwoTone twoToneColor="#ff4d4f" />} data-testid="rule-test-run-verdict">
          {t("monitoring.dashboard.verdictBreach")}
        </Tag>
      );
    }
    if (verdict === "ok") {
      return (
        <Tag color="green" icon={<CheckCircleTwoTone twoToneColor="#52c41a" />} data-testid="rule-test-run-verdict">
          {t("monitoring.dashboard.verdictOk")}
        </Tag>
      );
    }
    return (
      <Tag color="default" data-testid="rule-test-run-verdict">
        {t("monitoring.dashboard.verdictUnknown")}
      </Tag>
    );
  })();

  // U11 — forward cross-jump target. `/api/problems` only highlights by
  // `event_id`, so the link requires an explicit caller-supplied target: a
  // pre-built `problemHref` wins, then `problemEventId` builds the event_id
  // URL. With neither (standalone rule view / Problem-detail embed), no link
  // is rendered — never a fabricated `/problems?ruleId=…` that would not
  // resolve. The hasBreach gate still applies: the jump originates from a
  // 命中区间, so no breach → no jump source → no link.
  const href =
    problemHref ??
    (problemEventId ? `/problems?event_id=${encodeURIComponent(problemEventId)}` : null);

  const chartHeight = Math.max(160, height - 72);

  return (
    <Card
      data-testid="rule-test-run-chart"
      style={{ width: "100%", height: "100%" }}
      bodyStyle={{
        padding: 12,
        height,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <Space size="small" wrap style={{ alignItems: "center" }}>
        {ruleName ? (
          <Typography.Text strong data-testid="rule-test-run-title">
            {ruleName}
          </Typography.Text>
        ) : null}
        {verdictTag}
        {threshold && typeof threshold.value === "number" && Number.isFinite(threshold.value) ? (
          <Typography.Text type="secondary" data-testid="rule-test-run-threshold">
            {t("monitoring.dashboard.thresholdCaption", { value: threshold.value, operator: threshold.operator ?? "gt" })}
          </Typography.Text>
        ) : null}
        {hasBreach ? (
          <Typography.Text type="secondary" data-testid="rule-test-run-breach-count">
            {t("monitoring.dashboard.breachCaption", { count: bands.length })}
          </Typography.Text>
        ) : null}
        {hasBreach && href ? (
          <Typography.Link href={href} data-testid="rule-test-run-problem-link">
            <AlertOutlined /> {t("monitoring.dashboard.viewProblem")} <LinkOutlined />
          </Typography.Link>
        ) : null}
      </Space>
      <div style={{ flex: 1, minHeight: 0 }}>
        <MetricChart
          series={data?.series ?? []}
          thresholds={thresholdLine}
          bands={bands}
          status={isHardError ? "unavailable" : (data?.status ?? "ok")}
          reason={errorReason}
          loading={isLoading}
          yUnit={unit}
          height={chartHeight}
        />
      </div>
    </Card>
  );
}

export default RuleTestRunChart;