/**
 * Shared metric-chart domain types.
 *
 * Kept Prometheus-agnostic on purpose: callers (U6 sparkline, U10 dashboard,
 * U10 test-run chart, U11 Problem-embedded chart) are responsible for mapping
 * their datasource into these plain shapes. This keeps the chart wrapper free
 * of any Prometheus/client APIs so it can be unit-tested in isolation and
 * reused for non-Prometheus series later.
 */

export interface MetricPoint {
  /** Unix epoch ms. */
  timestamp: number;
  /**
   * Metric value. `null` represents a gap; by default the line breaks at null
   * points (g2 default). Pass `connectNulls={true}` to MetricChart to bridge
   * gaps.
   */
  value: number | null;
}

export interface MetricSeries {
  /** Series label shown in the chart legend. */
  name: string;
  points: MetricPoint[];
  /** Optional explicit line color; otherwise the chart palette assigns one. */
  color?: string;
}

export interface MetricThreshold {
  /** Y value the reference line is drawn at. */
  value: number;
  /** Optional label rendered next to the line. */
  label?: string;
  /** Optional line color (defaults to a warning red). */
  color?: string;
}

export type MetricChartStatus = "ok" | "unavailable";

/**
 * A highlighted vertical band on the time axis (e.g. a contiguous anomaly
 * "breach interval"). Rendered as a g2 `rangeX` annotation so it spans the
 * full Y range between `start` and `end` (Unix epoch ms). Used by the U10
 * rule test-run chart to overlay breach windows on the metric curve.
 */
export interface MetricBand {
  /** Band start, Unix epoch ms. */
  start: number;
  /** Band end, Unix epoch ms. */
  end: number;
  /** Optional fill color (defaults to a warning red). */
  color?: string;
}