import { Line } from "@ant-design/charts";
import { Empty, Spin, Typography } from "antd";
import { useMemo } from "react";
import { formatMetricTimestamp, formatMetricValue } from "./annotations";
import { displayUnit, scaleMetricThresholdsToDisplay, scaleSeriesToDisplay } from "./metric-display";
import { UnavailableCard } from "./UnavailableCard";
import type { MetricBand, MetricChartStatus, MetricSeries, MetricThreshold } from "./types";

export interface MetricChartProps {
  /** One or more named series. Empty array or all-empty series ⇒ degraded state. */
  series: MetricSeries[];
  /** Optional reference lines (e.g. SLO / alert thresholds). */
  thresholds?: MetricThreshold[];
  /** When `'unavailable'`, always render UnavailableCard regardless of series. */
  status?: MetricChartStatus;
  /** Reason shown in the degraded state. */
  reason?: string;
  /** Panel height in px (default 240). */
  height?: number;
  /** Optional Y-axis unit suffix shown in tooltips/axis. */
  yUnit?: string;
  /** Loading spinner over the chart area. */
  loading?: boolean;
  /** Optional panel title rendered above the chart. */
  title?: string;
  /** Optional class name passed to the chart container. */
  className?: string;
  /**
   * When true, bridge null points with a continuous line (g2 `connectNulls`).
   * Defaults to `false` — the g2 default, where the line breaks at null points.
   */
  connectNulls?: boolean;
  /**
   * Optional highlighted vertical bands on the time axis (e.g. contiguous
   * anomaly breach windows). Rendered as g2 `rangeX` annotations spanning the
   * full Y range between each band's `start`/`end` (Unix epoch ms), matching
   * the series x scale so bands align with the curve. No DOM effect when the
   * chart degrades to UnavailableCard.
   */
  bands?: MetricBand[];
}

const DEFAULT_HEIGHT = 240;

interface FlattenedRow {
  series: string;
  timestamp: number;
  value: number | null;
}

/**
 * Shared, degradation-aware line-chart wrapper for OpsMate admin.
 *
 * Accepts plain `MetricSeries[]` (timestamps + values), optional
 * `MetricThreshold[]`, and a coarse `status`. Renders:
 *   - `status === 'unavailable'` ⇒ UnavailableCard with the reason,
 *   - empty / all-empty series ⇒ UnavailableCard empty state,
 *   - otherwise an @ant-design/charts `<Line>` with threshold reference lines.
 *
 * Intentionally Prometheus-free so U6 (sparkline), U10 (dashboard + test-run),
 * and U11 (Problem-embedded) can all reuse it without coupling.
 */
export function MetricChart({
  series,
  thresholds,
  status = "ok",
  reason,
  height = DEFAULT_HEIGHT,
  yUnit,
  loading = false,
  title,
  className,
  connectNulls = false,
  bands,
}: MetricChartProps) {
  const chartUnit = displayUnit(yUnit);
  const displaySeries = useMemo(() => scaleSeriesToDisplay(series, yUnit), [series, yUnit]);
  const displayThresholds = useMemo(
    () => scaleMetricThresholdsToDisplay(thresholds, yUnit),
    [thresholds, yUnit],
  );

  const rows: FlattenedRow[] = useMemo(() => {
    const out: FlattenedRow[] = [];
    for (const s of displaySeries) {
      for (const p of s.points) {
        out.push({ series: s.name, timestamp: p.timestamp, value: p.value });
      }
    }
    return out;
  }, [displaySeries]);

  const hasData = rows.length > 0 && rows.some((r) => r.value !== null);

  // Explicit unavailable status wins regardless of data.
  if (status === "unavailable") {
    return <UnavailableCard reason={reason} title={title} height={height} className={className} />;
  }

  if (!hasData) {
    // While the first fetch is in flight, show a spinner rather than a
    // premature "No data" card — the `loading` overlay below only renders in
    // the chart branch, so without this guard every widget flashes
    // UnavailableCard for the whole network round-trip on dashboard load.
    // Distinct testid so tests that wait for `metric-chart-container` only
    // resolve once real data has mounted.
    if (loading) {
      return (
        <div
          className={className}
          style={{ width: "100%", height, display: "flex", alignItems: "center", justifyContent: "center" }}
          data-testid="metric-chart-loading"
          data-chart-status="loading"
          aria-label={title ?? "metric chart"}
        >
          <Spin />
        </div>
      );
    }
    return <UnavailableCard reason={reason} title={title} height={height} className={className} />;
  }

  // Threshold reference lines via @antv/g2 lineY annotation grammar, plus
  // optional breach bands via rangeX (vertical time-axis bands). Both use the
  // g2 annotation grammar forwarded by @ant-design/charts' `annotations` prop;
  // lineY draws a horizontal threshold line, rangeX shades a time window.
  const thresholdAnnotations = (displayThresholds ?? [])
    .filter((t) => typeof t.value === "number" && Number.isFinite(t.value))
    .map((t) => ({
      type: "lineY" as const,
      yField: t.value,
      style: {
        stroke: t.color ?? "#ff4d4f",
        lineDash: [4, 4],
      },
      labels: t.label
        ? [
            {
              text: t.label,
              position: "right" as const,
              style: { fill: t.color ?? "#ff4d4f", fontSize: 11 },
            },
          ]
        : undefined,
    }));
  const bandAnnotations = (bands ?? [])
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end >= b.start)
    .map((b) => ({
      type: "rangeX" as const,
      xField: [b.start, b.end] as [number, number],
      style: {
        fill: b.color ?? "#ff4d4f",
        fillOpacity: 0.12,
      },
    }));
  const annotations =
    thresholdAnnotations.length || bandAnnotations.length
      ? [...thresholdAnnotations, ...bandAnnotations]
      : undefined;

  const lineConfig = {
    data: rows,
    xField: "timestamp",
    yField: "value",
    colorField: "series",
    width: undefined,
    height,
    autoFit: true,
    padding: "auto" as const,
    connectNulls,
    scale: {
      x: { type: "time" as const },
      y: {
        nice: true,
        ...(chartUnit ? { unit: chartUnit } : {}),
      },
    },
    axis: {
      x: { title: "time" },
      y: { title: chartUnit ?? "value" },
    },
    legend: {
      color: {
        legend: true,
        position: "top-left" as const,
        itemMarker: "square" as const,
      },
    },
    tooltip: {
      title: (datum: FlattenedRow) => formatMetricTimestamp(datum.timestamp),
      items: [
        {
          channel: "y",
          name: chartUnit ? `value (${chartUnit})` : "value",
          valueFormatter: (value: number) => formatMetricValue(value, chartUnit),
        },
        {
          field: "series",
          name: "series",
        },
      ],
    },
    annotations,
    interactions: [{ type: "tooltip" }, { type: "legend-filter" }],
  };

  return (
    <div
      className={className}
      style={{ width: "100%", height }}
      data-testid="metric-chart-container"
      data-chart-status={status}
      aria-label={title ?? "metric chart"}
    >
      {title ? (
        <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
          {title}
        </Typography.Text>
      ) : null}
      <div style={{ position: "relative", width: "100%", height: title ? height - 28 : height }}>
        {loading ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(255,255,255,0.65)",
              zIndex: 2,
            }}
          >
            <Spin />
          </div>
        ) : null}
        <Line {...lineConfig} />
      </div>
    </div>
  );
}

export default MetricChart;

// Re-export the empty-state marker for callers that want to detect it.
export const __NO_DATA__ = Empty.PRESENTED_IMAGE_SIMPLE;