import { ArrowDownOutlined, ArrowRightOutlined, ArrowUpOutlined } from "@ant-design/icons";
import { Card, Space, Spin, Statistic, Tag, Typography } from "antd";
import { useMemo } from "react";
import type { PanelType } from "../../api/business-metrics-dashboard";
import {
  displayUnit,
  metricDisplayPrecision,
  scaleSeriesToDisplay,
  scaleThresholdToDisplay,
  toDisplayValue,
} from "./metric-display";
import { UnavailableCard } from "./UnavailableCard";
import { Sparkline } from "./Sparkline";
import type { MetricSeries } from "./types";
import type { RuleThreshold } from "../../api/business-metrics-dashboard";

export interface StatCardProps {
  /** Panel title (the widget's display name). */
  title: string;
  /** Current scalar value. `null` ⇒ "—" (the panel still renders, unlike gauge). */
  value: number | null;
  /** Optional unit suffix rendered after the value (e.g. "%", "cores", "ops"). */
  unit?: string | null;
  /**
   * Optional 1h-trend series for the embedded sparkline + delta arrow. Only the
   * first series is used (a stat tile shows one trend); pass the same `series`
   * the MetricChart path consumes so the stat and trend views stay consistent.
   */
  series?: MetricSeries[];
  /** Rule threshold ({value, operator}) — rendered as a small caption tag. */
  threshold?: RuleThreshold | null;
  /** Risk tier (L1/L2/L3) — rendered as a coloured tag when present. */
  riskTier?: string | null;
  /** `'unavailable'` ⇒ UnavailableCard (degraded, never blank). */
  status?: "ok" | "unavailable";
  /** Reason shown in the degraded state. */
  reason?: string;
  /** Loading spinner over the sparkline area (first fetch in flight). */
  loading?: boolean;
  /** Panel height in px (default 160). */
  height?: number;
  /** Optional source-name line rendered under the title. */
  sourceName?: string | null;
  /** Optional class name. */
  className?: string;
  /** Panel type — drives Grafana-like decimal precision. */
  panelType?: PanelType | null;
}

const DEFAULT_HEIGHT = 160;

/** Risk-tier → antd Tag colour. L1 auto-execute (red), L2 approval (orange),
 * L3 alert-only (blue). Unknown tiers fall back to a neutral default tag. */
function riskTierColor(tier: string | null | undefined): string | undefined {
  switch (tier) {
    case "L1":
      return "red";
    case "L2":
      return "orange";
    case "L3":
      return "blue";
    default:
      return "default";
  }
}

interface Delta {
  /** Signed numeric delta (last - first). */
  amount: number;
  /** Display label, e.g. "+0.12" / "-0.05" / "0.00". */
  label: string;
  /** Arrow direction: up / down / flat. */
  direction: "up" | "down" | "flat";
}

/**
 * Compute a signed delta from the first → last non-null point of the first
 * series. Returns null when there is no usable pair (single point, all-null,
 * or no series) so the arrow block is omitted rather than fabricated. Values
 * are formatted to 2dp — stat-tile deltas are indicative, not authoritative.
 */
function computeDelta(series: MetricSeries[] | undefined): Delta | null {
  if (!series || series.length === 0) return null;
  const points = series[0]?.points ?? [];
  const first = points.find((p) => p.value != null && Number.isFinite(p.value));
  const last = [...points].reverse().find((p) => p.value != null && Number.isFinite(p.value));
  if (!first || !last || first === last) return null;
  const amount = (last.value as number) - (first.value as number);
  if (!Number.isFinite(amount)) return null;
  const direction = amount > 0 ? "up" : amount < 0 ? "down" : "flat";
  const label = `${amount >= 0 ? "+" : ""}${amount.toFixed(2)}`;
  return { amount, label, direction };
}

/**
 * Grafana-style **stat** panel (PRD F5 — "learn from Grafana"). Shows one big
 * current value with a unit, a 1h sparkline trend, a signed delta arrow, and
 * optional threshold / risk-tier badges. Degrades to UnavailableCard when the
 * backend reports `status: 'unavailable'` — never a blank panel (KTD 7).
 *
 * Unlike GaugePanel, a `null` current value still renders the panel (with
 * "—"): a stat tile is informational and the trend/delta may be readable even
 * when the latest scrape failed. Only the unavailable envelope degrades.
 */
export function StatCard({
  title,
  value,
  unit = null,
  series,
  threshold,
  riskTier,
  status = "ok",
  reason,
  loading = false,
  height = DEFAULT_HEIGHT,
  sourceName,
  className,
  panelType = "stat",
}: StatCardProps) {
  if (status === "unavailable") {
    return <UnavailableCard reason={reason} title={title} height={height} className={className} />;
  }

  const unitLabel = displayUnit(unit);
  const displayValue = toDisplayValue(value, unit);
  const displaySeries = useMemo(() => scaleSeriesToDisplay(series, unit), [series, unit]);
  const displayThreshold = scaleThresholdToDisplay(threshold, unit);
  const valueFinite = displayValue != null && Number.isFinite(displayValue);
  const precision = metricDisplayPrecision(unit, panelType);
  const delta = useMemo(() => computeDelta(displaySeries), [displaySeries]);
  const firstSeries = useMemo(
    () => (displaySeries.length > 0 ? displaySeries[0] : undefined),
    [displaySeries],
  );
  const sparkPoints = useMemo(() => firstSeries?.points ?? [], [firstSeries]);

  const deltaIcon =
    delta?.direction === "up" ? (
      <ArrowUpOutlined style={{ color: "#52c41a" }} />
    ) : delta?.direction === "down" ? (
      <ArrowDownOutlined style={{ color: "#ff4d4f" }} />
    ) : (
      <ArrowRightOutlined style={{ color: "#8c8c8c" }} />
    );
  const deltaColor =
    delta?.direction === "up" ? "#52c41a" : delta?.direction === "down" ? "#ff4d4f" : "#8c8c8c";

  return (
    <Card
      className={className}
      style={{ height: "100%", width: "100%" }}
      bodyStyle={{
        padding: 12,
        height,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
        overflow: "hidden",
      }}
      data-testid="stat-card"
      aria-label={title}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Typography.Text strong style={{ display: "block" }} data-testid="stat-card-title" ellipsis>
            {title}
          </Typography.Text>
          {sourceName ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {sourceName}
            </Typography.Text>
          ) : null}
        </div>
        <Space size={4} wrap>
          {riskTier ? (
            <Tag color={riskTierColor(riskTier)} data-testid="stat-card-risk">
              {riskTier}
            </Tag>
          ) : null}
          {displayThreshold &&
          typeof displayThreshold.value === "number" &&
          Number.isFinite(displayThreshold.value) ? (
            <Tag data-testid="stat-card-threshold">
              阈值 {displayThreshold.value}
              {unitLabel ? ` ${unitLabel}` : ""}
              {displayThreshold.operator ? ` ${displayThreshold.operator}` : ""}
            </Tag>
          ) : null}
        </Space>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Statistic
          value={valueFinite ? (displayValue as number) : "—"}
          precision={valueFinite ? precision : 0}
          suffix={unitLabel ? ` ${unitLabel}` : undefined}
          data-testid="stat-card-value"
        />
        {delta ? (
          <Space size={4} data-testid="stat-card-delta" style={{ color: deltaColor }}>
            {deltaIcon}
            <Typography.Text style={{ fontSize: 12, color: deltaColor }}>{delta.label}</Typography.Text>
          </Space>
        ) : null}
      </div>

      <div
        style={{ marginTop: "auto", width: "100%", minWidth: 0, overflow: "hidden", flexShrink: 0 }}
        data-testid="stat-card-spark"
      >
        {loading && sparkPoints.length === 0 ? (
          // While the first fetch is in flight (no points yet) show a spinner
          // rather than flashing the sparkline's "暂无数据" empty state.
          <div style={{ height: 36, display: "flex", alignItems: "center" }}>
            <Spin />
          </div>
        ) : (
          <Sparkline points={sparkPoints} status="ok" height={36} fillWidth />
        )}
      </div>
    </Card>
  );
}

export default StatCard;