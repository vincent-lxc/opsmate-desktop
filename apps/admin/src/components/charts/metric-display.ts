import type { PanelType } from "../../api/business-metrics-dashboard";
import type { RuleThreshold } from "../../api/business-metrics-dashboard";
import type { MetricSeries, MetricThreshold } from "./types";

/** Binary megabyte — legacy helper for tests / rate scaling. */
export const BYTES_PER_MB = 1024 * 1024;

/** Binary gigabyte — storage bytes display (Grafana IEC, powers of 1024). */
export const BYTES_PER_GB = 1024 * 1024 * 1024;

/** Whether the backend/catalog unit is raw bytes (not a rate). */
export function isByteUnit(unit: string | null | undefined): boolean {
  return unit === "bytes";
}

/** Whether the backend/catalog unit is a byte throughput rate. */
export function isByteRateUnit(unit: string | null | undefined): boolean {
  return unit === "bytes/s";
}

/** Display label for a metric unit (Grafana-style short suffix). */
export function displayUnit(unit: string | null | undefined): string | null | undefined {
  if (isByteUnit(unit)) return "GB";
  if (isByteRateUnit(unit)) return "MB/s";
  if (unit === "%") return "%";
  if (unit === "ops") return "ops/s";
  if (unit === "cores") return "cores";
  if (unit === "ms") return "ms";
  if (unit === "s") return "s";
  return unit ?? undefined;
}

/**
 * Grafana-like decimal precision per unit shape — stats show integers for
 * counts, one decimal for %, two for rates/memory, three for cores/latency.
 */
export function metricDisplayPrecision(
  unit: string | null | undefined,
  panelType?: PanelType | null,
): number {
  if (unit === "%") return panelType === "gauge" ? 1 : 1;
  if (isByteUnit(unit) || isByteRateUnit(unit)) return 2;
  if (unit === "cores") return 3;
  if (unit === "ms") return 1;
  if (unit === "s") return 3;
  if (unit === "ops") return 2;
  if (!unit) return 0;
  return 2;
}

/** Scale a scalar from raw storage units to the display unit when applicable. */
export function toDisplayValue(
  value: number | null | undefined,
  unit: string | null | undefined,
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (isByteUnit(unit)) return value / BYTES_PER_GB;
  if (isByteRateUnit(unit)) return value / BYTES_PER_MB;
  return value;
}

/** Scale every point in a series for chart/sparkline rendering. */
export function scaleSeriesToDisplay(
  series: MetricSeries[] | undefined,
  unit: string | null | undefined,
): MetricSeries[] {
  if (!series || (!isByteUnit(unit) && !isByteRateUnit(unit))) return series ?? [];
  const divisor = isByteUnit(unit) ? BYTES_PER_GB : BYTES_PER_MB;
  return series.map((s) => ({
    ...s,
    points: s.points.map((p) => ({
      ...p,
      value:
        p.value != null && Number.isFinite(p.value) ? (p.value as number) / divisor : p.value,
    })),
  }));
}

/** Scale a rule threshold line to match a byte series displayed in MB. */
export function scaleThresholdToDisplay(
  threshold: RuleThreshold | null | undefined,
  unit: string | null | undefined,
): RuleThreshold | null | undefined {
  if (!threshold || typeof threshold.value !== "number" || !Number.isFinite(threshold.value)) {
    return threshold ?? null;
  }
  if (!isByteUnit(unit) && !isByteRateUnit(unit)) return threshold;
  const divisor = isByteUnit(unit) ? BYTES_PER_GB : BYTES_PER_MB;
  return { ...threshold, value: threshold.value / divisor };
}

/** Scale g2 threshold annotations to match a byte Y axis displayed in MB. */
export function scaleMetricThresholdsToDisplay(
  thresholds: MetricThreshold[] | undefined,
  unit: string | null | undefined,
): MetricThreshold[] | undefined {
  if (!thresholds || (!isByteUnit(unit) && !isByteRateUnit(unit))) return thresholds;
  const divisor = isByteUnit(unit) ? BYTES_PER_GB : BYTES_PER_MB;
  return thresholds.map((t) => ({ ...t, value: t.value / divisor }));
}

/** @deprecated Use {@link grafanaPanelColSpan} from `./dashboard-grid` instead. */
export { grafanaPanelColSpan as grafanaWidgetColSpan } from "./dashboard-grid";