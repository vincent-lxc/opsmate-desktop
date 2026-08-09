import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BYTES_PER_GB } from "../metric-display";
import { StatCard } from "../StatCard";
import type { MetricSeries } from "../types";

/**
 * StatCard — Grafana-style stat panel (PRD F5).
 *
 * @ant-design/charts renders on <canvas>; src/test/setup.ts stubs getContext
 * so the embedded Sparkline MOUNTS under jsdom, but the trend pixels are not
 * DOM text. We assert on wrapper testids, the DOM-rendered Statistic value /
 * delta / threshold / risk captions, and canvas counts — not on sparkline
 * pixels (per the MetricChart compatibility-gate convention).
 */

const NOW = Date.UTC(2026, 6, 2, 12, 0, 0);
const STEP = 60_000;

function series(name: string, values: Array<number | null>): MetricSeries {
  return {
    name,
    points: values.map((v, i) => ({ timestamp: NOW + i * STEP, value: v })),
  };
}

function canvasCount(container: HTMLElement): number {
  return container.querySelectorAll("canvas").length;
}

describe("StatCard — Grafana-style stat panel", () => {
  it("renders a fill-width sparkline constrained to the stat card cell", () => {
    render(<StatCard title="redis connections" value={22} series={[series("redis", [20, 21, 22])]} />);
    expect(screen.getByTestId("sparkline-container")).toHaveStyle({ width: "100%" });
    expect(screen.getByTestId("stat-card-spark")).toHaveStyle({ overflow: "hidden" });
  });

  it("renders the current value + unit and mounts a sparkline canvas", () => {
    const { container } = render(
      <StatCard
        title="container cpu usage"
        value={0.87}
        unit="cores"
        series={[series("cpu", [0.4, 0.6, 0.87])]}
      />,
    );
    expect(screen.getByTestId("stat-card-title").textContent).toBe("container cpu usage");
    // Statistic renders the value as DOM text.
    expect(screen.getByTestId("stat-card-value").textContent ?? "").toContain("0.87");
    expect(screen.getByTestId("stat-card-value").textContent ?? "").toContain("cores");
    // A sparkline canvas mounts underneath.
    expect(canvasCount(container)).toBeGreaterThanOrEqual(1);
    // No degraded state when data is present.
    expect(screen.queryByTestId("unavailable-card")).not.toBeInTheDocument();
  });

  it("displays byte metrics in GB instead of raw bytes", () => {
    render(
      <StatCard
        title="总内存"
        value={8 * BYTES_PER_GB}
        unit="bytes"
        series={[series("mem", [8 * BYTES_PER_GB, 7.9 * BYTES_PER_GB])]}
      />,
    );
    const text = screen.getByTestId("stat-card-value").textContent ?? "";
    expect(text).toMatch(/GB/);
    expect(text).not.toMatch(/bytes/i);
    expect(text).toContain("8.00");
  });

  it("renders a signed delta arrow when the series has a usable trend", () => {
    render(
      <StatCard
        title="error rate"
        value={0.6}
        unit="ops"
        series={[series("err", [0.4, 0.5, 0.6])]}
      />,
    );
    const delta = screen.getByTestId("stat-card-delta");
    // first=0.4 → last=0.6 ⇒ +0.20 (up arrow).
    expect(delta.textContent ?? "").toContain("+0.20");
  });

  it("omits the delta block when the series is empty or single-point", () => {
    render(<StatCard title="solo" value={1} series={[series("s", [1])]} />);
    expect(screen.queryByTestId("stat-card-delta")).not.toBeInTheDocument();
  });

  it("renders risk-tier + threshold badges when supplied", () => {
    render(
      <StatCard
        title="redis memory"
        value={0.95}
        unit="%"
        riskTier="L2"
        threshold={{ value: 0.9, operator: "gt" }}
        series={[series("mem", [0.8, 0.9, 0.95])]}
      />,
    );
    expect(screen.getByTestId("stat-card-risk").textContent).toBe("L2");
    expect(screen.getByTestId("stat-card-threshold").textContent ?? "").toContain("0.9");
    expect(screen.getByTestId("stat-card-threshold").textContent ?? "").toContain("gt");
  });

  it("renders '—' (NOT a full UnavailableCard) when value is null but status is ok", () => {
    // A null value still renders the stat card itself with "—"; the embedded
    // sparkline may show its own compact empty-state (no series), but the
    // StatCard does not degrade to a full UnavailableCard unless status is
    // 'unavailable'. The main stat-card container is the proof it rendered.
    render(<StatCard title="missing" value={null} status="ok" />);
    expect(screen.getByTestId("stat-card")).toBeInTheDocument();
    expect(screen.getByTestId("stat-card-value").textContent ?? "").toContain("—");
  });

  it("degrades to UnavailableCard when status is 'unavailable' (never blank)", () => {
    render(
      <StatCard
        title="down metric"
        value={null}
        status="unavailable"
        reason="Prometheus query_range HTTP 503"
      />,
    );
    expect(screen.getByTestId("unavailable-card")).toBeInTheDocument();
    expect(screen.queryByTestId("stat-card")).not.toBeInTheDocument();
  });

  it("shows the source-name line when supplied", () => {
    render(
      <StatCard
        title="container cpu"
        value={0.3}
        sourceName="docker-futures-prom"
      />,
    );
    expect(screen.getByText("docker-futures-prom")).toBeInTheDocument();
  });
});