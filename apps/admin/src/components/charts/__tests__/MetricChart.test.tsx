import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Line, Tiny } from "@ant-design/charts";
import { formatMetricTimestamp, formatMetricValue } from "../annotations";
import { MetricChart } from "../MetricChart";
import { Sparkline } from "../Sparkline";
import { UnavailableCard } from "../UnavailableCard";
import type { MetricSeries, MetricThreshold } from "../types";

const now = Date.UTC(2026, 5, 29, 12, 0, 0);
const stepMs = 60_000;

function makeSeries(name: string, values: Array<number | null>): MetricSeries {
  return {
    name,
    points: values.map((v, i) => ({ timestamp: now + i * stepMs, value: v })),
  };
}

/**
 * Compatibility note (U1 gate):
 *
 * @ant-design/charts v2 renders via @antv/g2 on a <canvas>. In jsdom there is no
 * real Canvas API, so we stub HTMLCanvasElement.prototype.getContext in
 * src/test/setup.ts to a no-op Proxy. This lets chart components MOUNT without
 * throwing — which is the actual compatibility guarantee U6/U10/U11 rely on.
 *
 * Consequence: series names, axes, and legends are drawn as canvas pixels, NOT
 * as DOM text nodes. We therefore assert on (a) the wrapper container being
 * mounted, (b) a <canvas> element being rendered inside it, and (c) no thrown
 * errors. We do NOT assert on legend text in the DOM — that would require
 * pixel inspection and would defeat the purpose of a fast jsdom gate.
 */

function canvasCount(container: HTMLElement): number {
  return container.querySelectorAll("canvas").length;
}

describe("metric chart formatters", () => {
  it("formats epoch-ms timestamps for tooltips", () => {
    const label = formatMetricTimestamp(now);
    expect(label).not.toMatch(/^\d{13}$/);
    expect(label.length).toBeGreaterThan(5);
  });

  it("formats noisy Prometheus floats for tooltips (Grafana-like per unit)", () => {
    // Unitless counts ≥ 1 render as integers (Grafana stat style).
    expect(formatMetricValue(20.971428571428568)).toBe("21");
    expect(formatMetricValue(362525952)).toBe("362525952");
    // Unit-aware: memory in MB keeps two decimals; % keeps one.
    expect(formatMetricValue(8.456, "GB")).toBe("8.46");
    expect(formatMetricValue(87.456, "%")).toBe("87.5");
  });
});

describe("MetricChart — compatibility gate (@ant-design/charts under jsdom)", () => {
  it("smoke-renders @ant-design/charts <Line> in antd v6 + react 19 + jsdom without throwing", () => {
    let node: ReturnType<typeof render> | undefined;
    expect(() => {
      node = render(
        <Line
          data={[
            { t: 1, v: 2 },
            { t: 2, v: 4 },
            { t: 3, v: 6 },
          ]}
          xField="t"
          yField="v"
          height={120}
        />,
      );
    }).not.toThrow();
    // A canvas element is the real proof the chart initialised.
    expect(node!.container.querySelectorAll("canvas").length).toBeGreaterThan(0);
  });

  it("smoke-renders <Tiny.Line> (sparkline primitive) under jsdom without throwing", () => {
    let node: ReturnType<typeof render> | undefined;
    expect(() => {
      node = render(
        <Tiny.Line
          data={[{ t: 1, v: 2 }, { t: 2, v: 3 }, { t: 3, v: 2.5 }]}
          xField="t"
          yField="v"
          height={36}
          width={120}
        />,
      );
    }).not.toThrow();
    expect(node!.container.querySelectorAll("canvas").length).toBeGreaterThan(0);
  });
});

describe("MetricChart — happy path", () => {
  it("mounts the chart container with a canvas for a 3-point series", () => {
    const series = makeSeries("cpu_usage", [10, 20, 30]);
    render(<MetricChart series={[series]} height={200} />);

    const container = screen.getByTestId("metric-chart-container");
    expect(container).toBeInTheDocument();
    expect(container).toHaveAttribute("data-chart-status", "ok");
    // The chart initialised a canvas — the series name is encoded in the
    // colorField config and would appear in the canvas-rendered legend.
    expect(canvasCount(container)).toBeGreaterThan(0);
  });

  it("mounts a canvas when multiple series are supplied", () => {
    render(
      <MetricChart
        series={[makeSeries("cpu", [1, 2, 3]), makeSeries("mem", [4, 5, 6])]}
        height={200}
      />,
    );
    const container = screen.getByTestId("metric-chart-container");
    expect(canvasCount(container)).toBeGreaterThan(0);
  });
});

describe("MetricChart — edge: empty series", () => {
  it("renders the degraded UnavailableCard and does not crash", () => {
    render(<MetricChart series={[]} height={200} reason="no points in range" />);
    expect(screen.getByText("no points in range")).toBeInTheDocument();
    expect(screen.queryByTestId("metric-chart-container")).not.toBeInTheDocument();
  });

  it("renders a generic empty state when no reason is supplied", () => {
    render(<MetricChart series={[makeSeries("x", [])]} />);
    // Exact match — antd Empty also renders an SVG <title>"No data"</title>,
    // so a regex would match multiple elements. Use the exact Typography copy.
    expect(screen.getByText("暂无数据 / No data")).toBeInTheDocument();
  });
});

describe("MetricChart — error: status='unavailable'", () => {
  it("renders the reason and no chart, even when series data is present", () => {
    const series = makeSeries("cpu_usage", [10, 20, 30]);
    render(
      <MetricChart
        series={[series]}
        status="unavailable"
        reason="Prometheus unreachable (503)"
        height={200}
      />,
    );
    expect(screen.getByText("Prometheus unreachable (503)")).toBeInTheDocument();
    expect(screen.queryByTestId("metric-chart-container")).not.toBeInTheDocument();
  });

  it("marks the unavailable card with aria-label when a title is supplied", () => {
    render(
      <MetricChart series={[]} status="unavailable" title="CPU usage" reason="down" />,
    );
    const card = screen.getByTestId("unavailable-card");
    expect(card).toHaveAttribute("aria-label", "CPU usage unavailable");
  });
});

describe("MetricChart — thresholds", () => {
  it("mounts without throwing when threshold marks are configured", () => {
    const thresholds: MetricThreshold[] = [
      { value: 80, label: "warn", color: "#faad14" },
      { value: 95, label: "crit", color: "#ff4d4f" },
    ];
    let node: ReturnType<typeof render> | undefined;
    expect(() => {
      node = render(
        <MetricChart
          series={[makeSeries("cpu", [10, 50, 90])]}
          thresholds={thresholds}
          height={200}
        />,
      );
    }).not.toThrow();
    expect(node!.getByTestId("metric-chart-container")).toBeInTheDocument();
  });
});

describe("MetricChart — connectNulls contract (P1 #1)", () => {
  it("defaults to connectNulls=false (g2 default: line breaks at null) and still mounts", () => {
    // Series with a null gap in the middle; default behaviour is the g2
    // default (line breaks at null). Must not throw and must mount a canvas.
    let node: ReturnType<typeof render> | undefined;
    expect(() => {
      node = render(<MetricChart series={[makeSeries("x", [1, null, 2])]} height={200} />);
    }).not.toThrow();
    const container = node!.getByTestId("metric-chart-container");
    expect(container).toBeInTheDocument();
    expect(canvasCount(container)).toBeGreaterThan(0);
    // data-chart-status stays "ok" because there is at least one non-null value.
    expect(container).toHaveAttribute("data-chart-status", "ok");
  });

  it("mounts without throwing when connectNulls=true bridges the gap", () => {
    let node: ReturnType<typeof render> | undefined;
    expect(() => {
      node = render(
        <MetricChart series={[makeSeries("x", [1, null, 2])]} connectNulls height={200} />,
      );
    }).not.toThrow();
    const container = node!.getByTestId("metric-chart-container");
    expect(container).toBeInTheDocument();
    expect(canvasCount(container)).toBeGreaterThan(0);
  });

  it("all-null series still degrades even if connectNulls=true (no non-null point to draw)", () => {
    render(
      <MetricChart
        series={[makeSeries("x", [null, null, null])]}
        connectNulls
        reason="all null"
      />,
    );
    expect(screen.getByText("all null")).toBeInTheDocument();
    expect(screen.queryByTestId("metric-chart-container")).not.toBeInTheDocument();
  });
});

describe("Sparkline", () => {
  it("renders the sparkline container with a canvas when data is present", () => {
    render(
      <Sparkline
        series={makeSeries("cpu", [1, 2, 3, 2.5, 4])}
        label="cpu"
        latestValue="4"
      />,
    );
    const container = screen.getByTestId("sparkline-container");
    expect(container).toBeInTheDocument();
    expect(screen.getByText("cpu")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(canvasCount(container)).toBeGreaterThan(0);
  });

  it("renders the degraded state when points are empty", () => {
    render(<Sparkline points={[]} label="cpu" />);
    expect(screen.getByText("暂无数据 / No data")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-container")).not.toBeInTheDocument();
  });

  it("renders the reason when status='unavailable'", () => {
    render(
      <Sparkline
        points={[{ timestamp: now, value: 1 }]}
        status="unavailable"
        reason="target down"
      />,
    );
    expect(screen.getByText("target down")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-container")).not.toBeInTheDocument();
  });

  it("does not throw and does not coerce null to 0 when points contain a null gap (P1 #2)", () => {
    // Sparkline preserves null so a failed scrape renders as a gap, not as 0.
    // Under jsdom we cannot read canvas pixels, so we assert: mount does not
    // throw, the sparkline container is present (data was sufficient because
    // at least one non-null point exists), and a canvas initialised.
    let node: ReturnType<typeof render> | undefined;
    expect(() => {
      node = render(
        <Sparkline
          series={makeSeries("cpu", [1, null, 2])}
          label="cpu"
          latestValue="2"
        />,
      );
    }).not.toThrow();
    const container = node!.getByTestId("sparkline-container");
    expect(container).toBeInTheDocument();
    expect(canvasCount(container)).toBeGreaterThan(0);
  });

  it("degrades to UnavailableCard when every point is null (P1 #2)", () => {
    render(
      <Sparkline
        series={makeSeries("cpu", [null, null, null])}
        label="cpu"
        reason="no points in range"
      />,
    );
    expect(screen.getByText("no points in range")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-container")).not.toBeInTheDocument();
  });

  it("shows the reason even when status='ok' and points are empty (P1 #3 — aligned with MetricChart)", () => {
    // Before the fix, Sparkline dropped reason unless status='unavailable'.
    // Now reason is always shown when supplied, matching MetricChart.
    render(<Sparkline points={[]} status="ok" reason="no points in range" />);
    expect(screen.getByText("no points in range")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-container")).not.toBeInTheDocument();
  });
});

describe("UnavailableCard", () => {
  it("renders the supplied reason and exposes the testid", () => {
    render(<UnavailableCard reason="boom" height={80} />);
    const card = screen.getByTestId("unavailable-card");
    expect(card).toBeInTheDocument();
    expect(within(card).getByText("boom")).toBeInTheDocument();
  });
});