import type { PanelType } from "../../api/business-metrics-dashboard";

/** Grafana dashboard grid width (columns). */
export const GRAFANA_GRID_COLUMNS = 24;

export type DashboardViewKey = "infra" | "hostcontainer" | "appservice";

/**
 * Column span (1–24) for a panel type in a perspective view — mirrors Grafana
 * gridPos.w on the Futures dashboards.
 */
export function grafanaPanelColSpan(
  panelType: PanelType | null | undefined,
  viewKey: DashboardViewKey,
): number {
  const type = panelType ?? "timeseries";
  if (type === "stat") {
    if (viewKey === "appservice") return 6;
    if (viewKey === "hostcontainer") return 12;
    return 4;
  }
  if (type === "gauge") return 8;
  return 12;
}

/** Fixed panel height per type so cards in the same row align. */
export function grafanaPanelHeight(panelType: PanelType | null | undefined): number {
  const type = panelType ?? "timeseries";
  if (type === "stat") return 160;
  if (type === "gauge") return 260;
  return 300;
}

/** Row height = tallest panel in that row. */
export function grafanaRowHeight(panelTypes: Array<PanelType | null | undefined>): number {
  let max = 160;
  for (const t of panelTypes) {
    max = Math.max(max, grafanaPanelHeight(t));
  }
  return max;
}

export interface GridPlacedWidget<T> {
  widget: T;
  colSpan: number;
}

export interface GridRow<T> {
  widgets: GridPlacedWidget<T>[];
  height: number;
}

/**
 * Pack widgets into explicit rows on a 24-column grid (left-to-right, wrap).
 * Each row's column spans always sum to 24 — no ragged Ant Design Col wraps.
 */
export function packWidgetsIntoRows<T extends { panel_type?: PanelType | null }>(
  widgets: T[],
  viewKey: DashboardViewKey,
): GridRow<T>[] {
  const rows: GridRow<T>[] = [];
  let current: GridPlacedWidget<T>[] = [];
  let usedCols = 0;

  const flush = () => {
    if (current.length === 0) return;
    rows.push({
      widgets: current,
      height: grafanaRowHeight(current.map((p) => p.widget.panel_type)),
    });
    current = [];
    usedCols = 0;
  };

  for (const widget of widgets) {
    const span = grafanaPanelColSpan(widget.panel_type, viewKey);
    if (usedCols > 0 && usedCols + span > GRAFANA_GRID_COLUMNS) {
      flush();
    }
    current.push({ widget, colSpan: span });
    usedCols += span;
    if (usedCols >= GRAFANA_GRID_COLUMNS) {
      flush();
    }
  }
  flush();
  return rows;
}

/** Rule / Problem charts: two panels per row (12 + 12). */
export function packRuleWidgetsIntoRows<T>(widgets: T[]): GridRow<T>[] {
  const rows: GridRow<T>[] = [];
  for (let i = 0; i < widgets.length; i += 2) {
    const pair = widgets.slice(i, i + 2);
    rows.push({
      widgets: pair.map((widget) => ({ widget, colSpan: 12 })),
      height: 300,
    });
  }
  return rows;
}