import type { ReactNode } from "react";
import type { GridRow } from "./dashboard-grid";
import "./dashboard-grid.css";

export interface DashboardPanelGridProps<T> {
  rows: GridRow<T>[];
  /** Render the panel card for a widget; the grid supplies the cell wrapper. */
  renderWidget: (widget: T, rowHeight: number) => ReactNode;
  /** Optional test id on the outer container. */
  "data-testid"?: string;
  /** Extract a stable React key from each widget. */
  getKey: (widget: T) => string;
}

/**
 * Grafana-style dashboard layout: explicit rows on a 24-column grid, each cell
 * hosting one panel Card. Rows are pre-packed so column spans sum to 24.
 */
export function DashboardPanelGrid<T>({
  rows,
  renderWidget,
  getKey,
  "data-testid": testId = "dashboard-panel-grid",
}: DashboardPanelGridProps<T>) {
  return (
    <div className="dashboard-panel-grid" data-testid={testId}>
      {rows.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className="dashboard-panel-grid-row"
          style={{ minHeight: row.height }}
          data-testid="dashboard-panel-grid-row"
        >
          {row.widgets.map(({ widget, colSpan }) => (
            <div
              key={getKey(widget)}
              className="dashboard-panel-grid-cell"
              style={{ gridColumn: `span ${colSpan}` }}
              data-testid="dashboard-widget-card"
            >
              {renderWidget(widget, row.height)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default DashboardPanelGrid;