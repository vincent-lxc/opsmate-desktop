import type { BreachInterval, RuleThreshold } from "../../api/business-metrics-dashboard";
import { formatDateTimeCompact } from "../../utils/datetime";
import type { MetricBand, MetricThreshold } from "./types";

/**
 * Shared g2-annotation builders for the U10 dashboard + rule test-run chart
 * (and the U11 Problem-embedded chart). Kept here so the breach-band and
 * threshold-line logic is defined once — both BusinessMetricsDashboard.tsx and
 * RuleTestRunChart.tsx previously carried byte-for-byte identical copies.
 *
 * Both helpers are defensive: malformed input (unparseable ISO, inverted
 * ranges, non-finite threshold values) is silently dropped rather than passed
 * to g2, where a bad annotation can break the whole canvas.
 */

/** Map dashboard breach intervals (ISO start/end) to chart bands (epoch ms).
 * Drops intervals whose dates do not parse or whose end precedes start. */
export function intervalsToBands(intervals: BreachInterval[] | null | undefined): MetricBand[] {
  if (!intervals) return [];
  const bands: MetricBand[] = [];
  for (const iv of intervals) {
    const start = Date.parse(iv.start);
    const end = Date.parse(iv.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      bands.push({ start, end });
    }
  }
  return bands;
}

/** Build a g2 `lineY` threshold reference-line config (one line) from a rule
 * threshold. Returns `undefined` when the threshold is missing or its value is
 * not a finite number, so callers can pass the result straight through. */
export function thresholdToLine(
  threshold: RuleThreshold | null,
  label?: string,
  color: string = "#ff4d4f",
): MetricThreshold[] | undefined {
  if (!threshold || typeof threshold.value !== "number" || !Number.isFinite(threshold.value)) {
    return undefined;
  }
  return [{ value: threshold.value, label, color }];
}

/** Human-readable axis/tooltip timestamp (epoch ms) — browser locale. */
export function formatMetricTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "—";
  return formatDateTimeCompact(timestamp);
}

/** Compact numeric readout for chart tooltips (Grafana-like, avoids Prometheus noise). */
export function formatMetricValue(value: unknown, unit?: string | null): string {
  if (value == null || !Number.isFinite(value as number)) return "—";
  const n = value as number;
  const abs = Math.abs(n);
  if (unit === "%") return n.toFixed(1);
  if (unit === "GB") return n.toFixed(2);
  if (unit === "MB" || unit === "MB/s") return n.toFixed(2);
  if (unit === "ops/s") return n.toFixed(2);
  if (unit === "cores") return n.toFixed(3);
  if (unit === "ms") return n.toFixed(1);
  if (unit === "s") return n.toFixed(3);
  if (!unit && abs >= 1) return n.toFixed(0);
  if (abs >= 100) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}