import { describe, expect, it } from "vitest";
import {
  GRAFANA_GRID_COLUMNS,
  grafanaPanelColSpan,
  packRuleWidgetsIntoRows,
  packWidgetsIntoRows,
} from "../dashboard-grid";

describe("dashboard-grid — Grafana 24-column layout", () => {
  it("assigns column spans per panel type and view", () => {
    expect(grafanaPanelColSpan("stat", "infra")).toBe(4);
    expect(grafanaPanelColSpan("stat", "appservice")).toBe(6);
    expect(grafanaPanelColSpan("stat", "hostcontainer")).toBe(12);
    expect(grafanaPanelColSpan("gauge", "hostcontainer")).toBe(8);
    expect(grafanaPanelColSpan("timeseries", "infra")).toBe(12);
  });

  it("packs infra stats into one row of six (4×6 = 24)", () => {
    const widgets = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      panel_type: "stat" as const,
    }));
    const rows = packWidgetsIntoRows(widgets, "infra");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.widgets).toHaveLength(6);
    expect(rows[0]!.widgets.reduce((sum, p) => sum + p.colSpan, 0)).toBe(GRAFANA_GRID_COLUMNS);
  });

  it("packs infra timeseries two per row (12+12 = 24)", () => {
    const widgets = Array.from({ length: 4 }, (_, i) => ({
      id: `t${i}`,
      panel_type: "timeseries" as const,
    }));
    const rows = packWidgetsIntoRows(widgets, "infra");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.widgets).toHaveLength(2);
      expect(row.widgets.reduce((sum, p) => sum + p.colSpan, 0)).toBe(GRAFANA_GRID_COLUMNS);
    }
  });

  it("packs hostcontainer gauges three per row (8×3 = 24)", () => {
    const widgets = Array.from({ length: 3 }, (_, i) => ({
      id: `g${i}`,
      panel_type: "gauge" as const,
    }));
    const rows = packWidgetsIntoRows(widgets, "hostcontainer");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.widgets).toHaveLength(3);
    expect(rows[0]!.widgets.every((p) => p.colSpan === 8)).toBe(true);
  });

  it("packs rule charts two per row", () => {
    const widgets = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const rows = packRuleWidgetsIntoRows(widgets);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.widgets).toHaveLength(2);
    expect(rows[1]!.widgets).toHaveLength(1);
    expect(rows[0]!.widgets[0]!.colSpan).toBe(12);
  });
});