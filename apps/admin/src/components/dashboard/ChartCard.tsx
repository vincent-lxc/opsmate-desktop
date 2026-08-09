import { Card, theme } from "antd";
import type { CardProps } from "antd";
import type { CSSProperties, ReactNode } from "react";

export type ChartCardProps = {
  title: ReactNode;
  action?: ReactNode;
  total?: ReactNode | number | (() => ReactNode | number);
  footer?: ReactNode;
  contentHeight?: number;
  avatar?: ReactNode;
  style?: CSSProperties;
} & CardProps;

function ChartCardTotal({
  total,
  totalStyle,
}: {
  total?: ReactNode | number | (() => ReactNode | number);
  totalStyle: CSSProperties;
}) {
  if (total === undefined || total === null) return null;
  const value = typeof total === "function" ? total() : total;
  return <div style={totalStyle}>{value}</div>;
}

export function ChartCard({
  title,
  action,
  total,
  footer,
  contentHeight,
  avatar,
  children,
  loading = false,
  variant = "borderless",
  style,
  ...cardProps
}: ChartCardProps) {
  const { token } = theme.useToken();

  const totalStyle: CSSProperties = {
    height: 38,
    marginTop: 4,
    marginBottom: 0,
    overflow: "hidden",
    color: token.colorTextHeading,
    fontSize: 30,
    lineHeight: "38px",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  };

  const body = (
    <div style={{ position: "relative" }}>
      <div
        style={{
          position: "relative",
          width: "100%",
          overflow: "hidden",
          marginBottom: !children && !footer ? 12 : 0,
        }}
      >
        {avatar ? (
          <div style={{ position: "relative", top: 4, float: "left", marginRight: 20 }}>
            {avatar}
          </div>
        ) : null}
        <div style={{ float: "left", width: avatar ? "calc(100% - 60px)" : "100%" }}>
          <div
            style={{
              position: "relative",
              height: 22,
              paddingRight: action ? 24 : 0,
              color: token.colorTextSecondary,
              fontSize: token.fontSize,
              lineHeight: "22px",
            }}
          >
            <span>{title}</span>
            {action ? (
              <span
                style={{
                  position: "absolute",
                  top: 4,
                  right: 0,
                  lineHeight: 1,
                  cursor: "pointer",
                }}
              >
                {action}
              </span>
            ) : null}
          </div>
          <ChartCardTotal total={total} totalStyle={totalStyle} />
        </div>
        <div style={{ clear: "both" }} />
      </div>
      {children ? (
        <div
          style={{
            position: "relative",
            width: "100%",
            marginBottom: 12,
            height: contentHeight ?? "auto",
          }}
        >
          <div
            style={
              contentHeight
                ? { position: "absolute", bottom: 0, left: 0, width: "100%" }
                : undefined
            }
          >
            {children}
          </div>
        </div>
      ) : null}
      {footer ? (
        <div
          style={{
            marginTop: children ? 8 : 20,
            paddingTop: 9,
            borderTop: `1px solid ${token.colorSplit}`,
          }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );

  return (
    <Card
      loading={loading}
      variant={variant}
      style={style}
      styles={{
        body: {
          padding: "20px 24px 8px 24px",
        },
      }}
      {...cardProps}
    >
      {loading ? null : body}
    </Card>
  );
}