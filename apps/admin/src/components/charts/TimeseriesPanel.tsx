import { Card, Space, Statistic, Tag, Typography } from "antd";
import { useMemo } from "react";
import type { RuleThreshold } from "../../api/business-metrics-dashboard";
import {
  displayUnit,
  metricDisplayPrecision,
  scaleThresholdToDisplay,
  toDisplayValue,
} from "./metric-display";
import { MetricChart } from "./MetricChart";
import { UnavailableCard } from "./UnavailableCard";
import type { MetricBand, MetricSeries, MetricThreshold } from "./types";

export interface TimeseriesPanelProps {
  /** Panel title (the widget's display name). */
  title: string;
  /** Current scalar value shown above the chart. */
  value: number | null;
  /** Optional unit suffix (e.g. "MB", "cores"). */
  unit?: string | null;
  /** Time series rendered in the chart area. */
  series: MetricSeries[];
  /** Optional threshold reference lines on the chart. */
  thresholds?: MetricThreshold[];
  /** Optional breach bands on the time axis. */
  bands?: MetricBand[];
  /** Rule threshold — rendered as a caption tag in the header. */
  threshold?: RuleThreshold | null;
  /** Risk tier (L1/L2/L3) — rendered as a coloured tag when present. */
  riskTier?: string | null;
  /** `'unavailable'` ⇒ UnavailableCard (degraded, never blank). */
  status?: "ok" | "unavailable";
  /** Reason shown in the degraded state. */
  reason?: string;
  /** Loading spinner over the chart area. */
  loading?: boolean;
  /** Panel height in px (default 300). */
  height?: number;
  /** Optional source-name line rendered under the title. */
  sourceName?: string | null;
  /** Optional class name. */
  className?: string;
}

const DEFAULT_HEIGHT = 300;

/** Risk-tier → antd Tag colour (mirrors StatCard / GaugePanel). */
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

/**
 * Grafana-style **timeseries** panel. Wraps MetricChart in the same Card shell
 * as StatCard / GaugePanel so title, current value, and curve stay aligned in
 * the dashboard grid — never loose Typography nodes floating above a chart.
 */
export function TimeseriesPanel({
  title,
  value,
  unit = null,
  series,
  thresholds,
  bands,
  threshold,
  riskTier,
  status = "ok",
  reason,
  loading = false,
  height = DEFAULT_HEIGHT,
  sourceName,
  className,
}: TimeseriesPanelProps) {
  const unitLabel = displayUnit(unit);
  const displayValue = toDisplayValue(value, unit);
  const displayThreshold = useMemo(() => scaleThresholdToDisplay(threshold, unit), [threshold, unit]);
  const valueFinite = displayValue != null && Number.isFinite(displayValue);
  const precision = metricDisplayPrecision(unit, "timeseries");
  const chartHeight = Math.max(140, height - 96);

  if (status === "unavailable") {
    return <UnavailableCard reason={reason} title={title} height={height} className={className} />;
  }

  return (
    <Card
      className={className}
      style={{ height: "100%" }}
      bodyStyle={{
        padding: 12,
        height,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
      data-testid="timeseries-panel"
      aria-label={title}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Typography.Text strong style={{ display: "block" }} data-testid="timeseries-panel-title">
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
            <Tag color={riskTierColor(riskTier)} data-testid="timeseries-panel-risk">
              {riskTier}
            </Tag>
          ) : null}
          {displayThreshold &&
          typeof displayThreshold.value === "number" &&
          Number.isFinite(displayThreshold.value) ? (
            <Tag data-testid="timeseries-panel-threshold">
              阈值 {displayThreshold.value}
              {unitLabel ? ` ${unitLabel}` : ""}
              {displayThreshold.operator ? ` ${displayThreshold.operator}` : ""}
            </Tag>
          ) : null}
        </Space>
      </div>

      <Statistic
        value={valueFinite ? (displayValue as number) : "—"}
        precision={valueFinite ? precision : 0}
        suffix={unitLabel ? ` ${unitLabel}` : undefined}
        data-testid="timeseries-panel-value"
      />

      <div style={{ flex: 1, minHeight: 0 }} data-testid="timeseries-panel-chart">
        <MetricChart
          series={series}
          thresholds={thresholds}
          bands={bands}
          status="ok"
          reason={reason}
          loading={loading}
          yUnit={unit ?? undefined}
          height={chartHeight}
        />
      </div>
    </Card>
  );
}

export default TimeseriesPanel;