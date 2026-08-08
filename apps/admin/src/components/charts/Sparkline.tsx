import { Tiny } from "@ant-design/charts";
import { Tooltip, Typography } from "antd";
import { useMemo } from "react";
import { UnavailableCard } from "./UnavailableCard";
import type { MetricPoint, MetricSeries } from "./types";

export interface SparklineProps {
  /** Single compact 1h-trend series. Pass `points` directly for ad-hoc use. */
  series?: MetricSeries;
  /** Convenience: raw points when the caller has no series name. */
  points?: MetricPoint[];
  /** Optional label rendered to the left of / above the sparkline. */
  label?: string;
  /** Optional latest-value override shown next to the label (e.g. "87.3%"). */
  latestValue?: string | number;
  /** Optional status; `'unavailable'` ⇒ UnavailableCard (compact). */
  status?: "ok" | "unavailable";
  /** Reason shown when degraded. */
  reason?: string;
  /** Width in px (default 120). Ignored when `fillWidth` is true. */
  width?: number;
  /** Height in px (default 36). */
  height?: number;
  /**
   * Stretch the sparkline to the parent cell width (stat tiles in the 24-col
   * grid). Prevents a fixed-width canvas from overflowing narrow cards.
   */
  fillWidth?: boolean;
  /** Optional class name. */
  className?: string;
}

const DEFAULT_WIDTH = 120;
const DEFAULT_HEIGHT = 36;

/**
 * Compact 1h-trend sparkline for table rows / card headers (U6 DS candidates,
 * U10 dashboard mini-tiles). Renders a tiny line when data is present and a
 * tiny UnavailableCard otherwise. No axes, no legend — just the trend shape.
 */
export function Sparkline({
  series,
  points,
  label,
  latestValue,
  status = "ok",
  reason,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  fillWidth = false,
  className,
}: SparklineProps) {
  const resolvedPoints: MetricPoint[] = useMemo(() => {
    if (series) return series.points;
    if (points) return points;
    return [];
  }, [series, points]);

  const hasData =
    status !== "unavailable" && resolvedPoints.length > 0 && resolvedPoints.some((p) => p.value !== null);

  if (!hasData) {
    return (
      <UnavailableCard
        reason={reason}
        height={height}
        className={className}
        bodyStyle={{ padding: 4 }}
      />
    );
  }

  // Preserve null points so g2 breaks the line at gaps (consistent with
  // MetricChart). Tiny.Line accepts null values and renders a gap; mapping
  // null→0 would mislead (e.g. a failed CPU scrape drawn as "0%").
  const data = resolvedPoints.map((p) => ({ timestamp: p.timestamp, value: p.value }));

  const config = {
    data,
    xField: "timestamp",
    yField: "value",
    width: fillWidth ? undefined : width,
    height,
    autoFit: true,
    padding: [2, 4, 2, 4] as [number, number, number, number],
    scale: { x: { type: "time" as const }, y: { nice: true } },
    axis: false,
    legend: false,
    tooltip: false,
    shapeField: "smooth" as const,
    style: { fill: "transparent", stroke: "#1677ff", lineWidth: 1.5 },
  };

  const chartBoxStyle = fillWidth
    ? { width: "100%", height, overflow: "hidden" as const, minWidth: 0 }
    : { width, height };

  return (
    <div
      className={className}
      style={{
        display: fillWidth ? "block" : "inline-flex",
        alignItems: "center",
        gap: 8,
        width: fillWidth ? "100%" : undefined,
        minWidth: 0,
      }}
      data-testid="sparkline-container"
    >
      {label ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {label}
        </Typography.Text>
      ) : null}
      <Tooltip title={reason ? `${label ?? ""} ${reason}`.trim() : undefined}>
        <div style={chartBoxStyle}>
          <Tiny.Line {...config} />
        </div>
      </Tooltip>
      {latestValue !== undefined ? (
        <Typography.Text strong style={{ fontSize: 12 }}>
          {latestValue}
        </Typography.Text>
      ) : null}
    </div>
  );
}

export default Sparkline;