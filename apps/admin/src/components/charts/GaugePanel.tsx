import { Gauge } from "@ant-design/charts";
import { Card, Space, Spin, Statistic, Tag, Typography } from "antd";
import { useMemo } from "react";
import { displayUnit, metricDisplayPrecision } from "./metric-display";
import { UnavailableCard } from "./UnavailableCard";
import type { RuleThreshold } from "../../api/business-metrics-dashboard";
import "./dashboard-grid.css";

export interface GaugePanelProps {
  /** Panel title (the widget's display name). */
  title: string;
  /**
   * Current scalar value driving the gauge needle. `null` / non-finite ⇒
   * UnavailableCard (a gauge with no reading is meaningless, unlike a stat
   * tile which can still show a trend).
   */
  value: number | null;
  /**
   * The value that maps to 100% on the dial (the gauge's full scale). Default
   * 100 — so a `value` already expressed as a percent (0–100) renders
   * directly, and a 0–1 fraction is passed with `max={1}`. For ratio metrics
   * (e.g. redis_memory_used / redis_memory_max) pass `max={1}` and `unit="%"`
   * with the value × 100, or `max` = the divisor and `value` = the raw ratio.
   */
  max?: number;
  /** Optional unit suffix rendered next to the numeric readout (e.g. "%"). */
  unit?: string | null;
  /** Rule threshold ({value, operator}) — rendered as a caption tag. */
  threshold?: RuleThreshold | null;
  /** Risk tier (L1/L2/L3) — rendered as a coloured tag when present. */
  riskTier?: string | null;
  /** `'unavailable'` ⇒ UnavailableCard (degraded, never blank). */
  status?: "ok" | "unavailable";
  /** Reason shown in the degraded state. */
  reason?: string;
  /**
   * Loading spinner over the dial area. While true AND no value has arrived
   * yet, the card frame mounts with a Spin (testid `gauge-panel` present)
   * rather than flashing UnavailableCard for the whole network round-trip —
   * mirrors MetricChart/StatCard's loading guard.
   */
  loading?: boolean;
  /** Panel height in px (default 200). */
  height?: number;
  /** Optional source-name line rendered under the title. */
  sourceName?: string | null;
  /** Optional class name. */
  className?: string;
}

const DEFAULT_HEIGHT = 200;

/** Risk-tier → antd Tag colour (mirrors StatCard). */
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
 * Grafana-style **gauge** panel (PRD F5 — "learn from Grafana"). Renders a
 * 0–100% utilisation dial (@ant-design/charts `<Gauge>`, g2 gauge mark) with
 * the numeric readout + unit beneath, plus optional threshold / risk-tier
 * badges. The needle is driven by `value / max` clamped to [0, 1].
 *
 * Degradation (KTD 7): a gauge with no current reading is meaningless, so a
 * `null`/non-finite value OR `status: 'unavailable'` renders UnavailableCard
 * — never a dial parked at an arbitrary zero. This is the deliberate
 * distinction from StatCard, which still renders "—" + trend on a null value.
 */
export function GaugePanel({
  title,
  value,
  max = 100,
  unit = null,
  threshold,
  riskTier,
  status = "ok",
  reason,
  loading = false,
  height = DEFAULT_HEIGHT,
  sourceName,
  className,
}: GaugePanelProps) {
  const valueFinite = value != null && Number.isFinite(value);
  const maxFinite = Number.isFinite(max) && max > 0 ? max : 100;

  if (status === "unavailable" || (!valueFinite && !loading)) {
    return <UnavailableCard reason={reason ?? "暂无当前读数 / No current reading"} title={title} height={height} className={className} />;
  }

  // Loading + no value yet: mount the card frame with a spinner so the panel
  // does not flash the unavailable state for the whole first fetch.
  if (!valueFinite) {
    return (
      <Card
        className={className}
        bodyStyle={{
          padding: 12,
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        data-testid="gauge-panel"
        aria-label={title}
      >
        <Spin />
      </Card>
    );
  }

  // g2 gauge `data` is a 0–1 fraction (the dial's percent channel). Clamp so
  // an out-of-range scrape (e.g. >100% during a burst) pins the needle rather
  // than rendering off-arc.
  const fraction = Math.min(Math.max((value as number) / maxFinite, 0), 1);
  const percentValue = fraction * 100;
  const unitLabel = displayUnit(unit);
  const isPercentGauge = unitLabel === "%";
  const precision = metricDisplayPrecision(unit, "gauge");
  const dialHeight = Math.max(140, height - (isPercentGauge ? 72 : 88));

  // g2 gauge threshold zones — coloured arc segments at 60% / 80% by default
  // (green / orange / red), tightened to the rule threshold when one is
  // supplied so the dial's red zone starts at the alert line.
  const gaugeThreshold = useMemo(() => {
    const tv = threshold?.value;
    if (typeof tv === "number" && Number.isFinite(tv) && tv > 0 && tv <= maxFinite) {
      const tFrac = tv / maxFinite;
      return [Math.min(tFrac * 0.6, 0.6), Math.min(tFrac, 0.99)] as [number, number];
    }
    return [0.6, 0.8] as [number, number];
  }, [threshold, maxFinite]);

  const config = {
    data: fraction,
    height: dialHeight,
    autoFit: true,
    // Symmetric padding keeps the dial centred in the card (auto skews left).
    padding: [4, 4, 4, 4] as [number, number, number, number],
    threshold: gaugeThreshold,
    legend: false,
    tooltip: false,
    // g2 gauge paints target.toString() (the 0–1 fraction) at the dial centre
    // by default — hide it; the Statistic below shows the human percent.
    style: {
      text: {
        content: () => "",
      },
    },
  };

  return (
    <Card
      className={className}
      style={{ height: "100%", width: "100%" }}
      bodyStyle={{ padding: 12, height, display: "flex", flexDirection: "column", gap: 4 }}
      data-testid="gauge-panel"
      aria-label={title}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <Typography.Text strong style={{ display: "block" }} data-testid="gauge-panel-title">
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
            <Tag color={riskTierColor(riskTier)} data-testid="gauge-panel-risk">
              {riskTier}
            </Tag>
          ) : null}
          {threshold && typeof threshold.value === "number" && Number.isFinite(threshold.value) ? (
            <Tag data-testid="gauge-panel-threshold">
              阈值 {threshold.value}
              {threshold.operator ? ` ${threshold.operator}` : ""}
            </Tag>
          ) : null}
        </Space>
      </div>

      <div
        className="gauge-panel-dial"
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
        data-testid="gauge-panel-dial"
      >
        <Gauge {...config} />
      </div>

      <div style={{ display: "flex", justifyContent: "center", paddingTop: 4 }}>
        {isPercentGauge ? (
          // Grafana-style: one human-readable percent — hide the raw 0–1 fraction.
          <Statistic
            value={percentValue}
            precision={1}
            suffix="%"
            valueStyle={{ fontSize: 20, fontWeight: 600 }}
            data-testid="gauge-panel-value"
          />
        ) : (
          <Statistic
            value={value as number}
            precision={precision}
            suffix={unitLabel ? ` ${unitLabel}` : undefined}
            valueStyle={{ fontSize: 20, fontWeight: 600 }}
            data-testid="gauge-panel-value"
          />
        )}
      </div>
    </Card>
  );
}

export default GaugePanel;