import { Card, Empty, Typography } from "antd";
import type { CSSProperties, ReactNode } from "react";

export interface UnavailableCardProps {
  /**
   * Human-readable reason the chart cannot be shown (e.g. "Prometheus
   * unreachable", "No data in range"). When omitted a generic empty-state
   * message is rendered.
   */
  reason?: string;
  /** Optional custom icon/node rendered above the reason. */
  icon?: ReactNode;
  /** Optional title for the card header. */
  title?: string;
  /** Optional inline style override for the card body. */
  bodyStyle?: CSSProperties;
  /** Optional class name. */
  className?: string;
  /** Optional height; the card will fill this so it lines up with charts. */
  height?: number;
}

/**
 * Degraded-state placeholder used by MetricChart / Sparkline when data is
 * missing or a datasource is unreachable. Rendered instead of a chart so
 * dashboards keep a stable layout and operators always see *why* a panel is
 * blank rather than silently-empty axes.
 */
export function UnavailableCard({
  reason,
  icon,
  title,
  bodyStyle,
  className,
  height,
}: UnavailableCardProps) {
  return (
    <Card
      className={className}
      bodyStyle={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: 16,
        height: height ?? 200,
        ...bodyStyle,
      }}
      data-testid="unavailable-card"
      aria-label={title ? `${title} unavailable` : "chart unavailable"}
    >
      {icon ?? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={false} />}
      <Typography.Text type="secondary" style={{ textAlign: "center" }}>
        {reason ?? "暂无数据 / No data"}
      </Typography.Text>
    </Card>
  );
}

export default UnavailableCard;