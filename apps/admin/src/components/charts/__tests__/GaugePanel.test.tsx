import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GaugePanel } from "../GaugePanel";

/**
 * GaugePanel — Grafana-style gauge panel (PRD F5).
 *
 * @ant-design/charts <Gauge> renders on <canvas>; src/test/setup.ts stubs
 * getContext so the gauge MOUNTS under jsdom, but the dial pixels are not DOM
 * text. We assert on wrapper testids, the DOM-rendered Statistic value /
 * threshold / risk captions, and that a <canvas> mounts — not on the gauge arc
 * itself (per the MetricChart compatibility-gate convention).
 */

function canvasCount(container: HTMLElement): number {
  return container.querySelectorAll("canvas").length;
}

describe("GaugePanel — Grafana-style gauge panel", () => {
  it("renders a single percent readout (not the raw 0–100 value) and mounts a gauge canvas", () => {
    const { container } = render(
      <GaugePanel title="cpu utilisation" value={87} max={100} unit="%" />,
    );
    expect(screen.getByTestId("gauge-panel-title").textContent).toBe("cpu utilisation");
    expect(screen.getByTestId("gauge-panel-value").textContent ?? "").toContain("87.0");
    expect(screen.getByTestId("gauge-panel-value").textContent ?? "").toContain("%");
    expect(screen.queryByTestId("gauge-panel-percent")).not.toBeInTheDocument();
    expect(canvasCount(container)).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("unavailable-card")).not.toBeInTheDocument();
  });

  it("accepts a 0–1 fraction with max=1 and shows only the percent readout", () => {
    render(<GaugePanel title="redis mem ratio" value={0.92} max={1} unit="%" />);
    expect(screen.getByTestId("gauge-panel-value").textContent ?? "").toContain("92.0");
    expect(screen.getByTestId("gauge-panel-value").textContent ?? "").not.toContain("0.9");
    expect(screen.queryByTestId("gauge-panel-percent")).not.toBeInTheDocument();
  });

  it("clamps an out-of-range value to 100% (needle pinned, not off-arc)", () => {
    render(<GaugePanel title="burst" value={150} max={100} unit="%" />);
    expect(screen.getByTestId("gauge-panel-value").textContent ?? "").toContain("100.0");
  });

  it("renders risk-tier + threshold badges when supplied", () => {
    render(
      <GaugePanel
        title="redis memory"
        value={0.95}
        max={1}
        unit="%"
        riskTier="L2"
        threshold={{ value: 0.9, operator: "gt" }}
      />,
    );
    expect(screen.getByTestId("gauge-panel-risk").textContent).toBe("L2");
    expect(screen.getByTestId("gauge-panel-threshold").textContent ?? "").toContain("0.9");
  });

  it("degrades to UnavailableCard when value is null (a gauge with no reading is meaningless)", () => {
    render(<GaugePanel title="no reading" value={null} max={100} unit="%" />);
    expect(screen.getByTestId("unavailable-card")).toBeInTheDocument();
    expect(screen.queryByTestId("gauge-panel")).not.toBeInTheDocument();
  });

  it("degrades to UnavailableCard when status is 'unavailable' even if a value is present", () => {
    render(
      <GaugePanel
        title="down gauge"
        value={42}
        max={100}
        unit="%"
        status="unavailable"
        reason="Prometheus query_range HTTP 503"
      />,
    );
    expect(screen.getByTestId("unavailable-card")).toBeInTheDocument();
    expect(screen.queryByTestId("gauge-panel")).not.toBeInTheDocument();
  });

  it("falls back to max=100 when max is non-positive", () => {
    render(<GaugePanel title="bad max" value={50} max={0} unit="%" />);
    expect(screen.getByTestId("gauge-panel-value").textContent ?? "").toContain("50.0");
    expect(screen.queryByTestId("unavailable-card")).not.toBeInTheDocument();
  });
});