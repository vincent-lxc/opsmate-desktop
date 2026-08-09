import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimeseriesPanel } from "../TimeseriesPanel";

const now = Date.UTC(2026, 5, 29, 12, 0, 0);

describe("TimeseriesPanel — Grafana-style timeseries card", () => {
  it("renders title, current value, and chart inside a card shell", () => {
    const { container } = render(
      <TimeseriesPanel
        title="redis memory"
        value={1.234}
        unit="cores"
        series={[
          {
            name: "redis",
            points: [
              { timestamp: now, value: 100 },
              { timestamp: now + 60_000, value: 200 },
            ],
          },
        ]}
        height={300}
      />,
    );
    expect(screen.getByTestId("timeseries-panel")).toBeInTheDocument();
    expect(screen.getByTestId("timeseries-panel-title").textContent).toBe("redis memory");
    expect(screen.getByTestId("timeseries-panel-value").textContent ?? "").toContain("1.234");
    expect(screen.getByTestId("metric-chart-container")).toBeInTheDocument();
    expect(container.querySelectorAll("canvas").length).toBeGreaterThanOrEqual(1);
  });

  it("degrades to UnavailableCard when status is unavailable", () => {
    render(
      <TimeseriesPanel
        title="down metric"
        value={null}
        series={[]}
        status="unavailable"
        reason="Prometheus unreachable"
      />,
    );
    expect(screen.getByTestId("unavailable-card")).toBeInTheDocument();
    expect(screen.queryByTestId("timeseries-panel")).not.toBeInTheDocument();
  });
});