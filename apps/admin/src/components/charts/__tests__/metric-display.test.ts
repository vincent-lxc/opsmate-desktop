import { describe, expect, it } from "vitest";
import {
  BYTES_PER_GB,
  BYTES_PER_MB,
  displayUnit,
  grafanaWidgetColSpan,
  metricDisplayPrecision,
  scaleSeriesToDisplay,
  toDisplayValue,
} from "../metric-display";

describe("metric-display — Grafana-aligned units", () => {
  it("maps storage bytes to GB and rates to MB/s", () => {
    expect(displayUnit("bytes")).toBe("GB");
    expect(displayUnit("bytes/s")).toBe("MB/s");
    expect(displayUnit("ops")).toBe("ops/s");
  });

  it("scales raw byte scalars and series to GB", () => {
    expect(toDisplayValue(8 * BYTES_PER_GB, "bytes")).toBeCloseTo(8, 5);
    const scaled = scaleSeriesToDisplay(
      [{ name: "redis", points: [{ timestamp: 1, value: BYTES_PER_GB * 3 }] }],
      "bytes",
    );
    expect(scaled[0]?.points[0]?.value).toBe(3);
  });

  it("still scales byte rates to MB/s", () => {
    expect(toDisplayValue(BYTES_PER_MB * 5, "bytes/s")).toBeCloseTo(5, 5);
  });

  it("uses Grafana-like precision per unit", () => {
    expect(metricDisplayPrecision("%", "gauge")).toBe(1);
    expect(metricDisplayPrecision("bytes")).toBe(2);
    expect(metricDisplayPrecision(null)).toBe(0);
    expect(metricDisplayPrecision("cores")).toBe(3);
  });

  it("assigns Grafana panel column spans per view (24-col grid)", () => {
    expect(grafanaWidgetColSpan("stat", "infra")).toBe(4);
    expect(grafanaWidgetColSpan("stat", "appservice")).toBe(6);
    expect(grafanaWidgetColSpan("gauge", "hostcontainer")).toBe(8);
    expect(grafanaWidgetColSpan("timeseries", "infra")).toBe(12);
  });
});