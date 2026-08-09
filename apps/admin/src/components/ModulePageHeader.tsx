import { Typography, theme } from "antd";
import type { ReactNode } from "react";

export type ModulePageHeaderProps = {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
};

export function ModulePageHeader({
  icon,
  title,
  subtitle,
  action,
}: ModulePageHeaderProps) {
  const { token } = theme.useToken();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        marginBottom: 24,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          minWidth: 0,
          flex: 1,
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: token.colorFillSecondary,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: token.colorText,
          }}
        >
          {icon}
        </div>
        <div style={{ minWidth: 0 }}>
          <Typography.Title level={4} style={{ margin: 0, lineHeight: 1.3 }}>
            {title}
          </Typography.Title>
          {subtitle ? (
            <Typography.Text
              type="secondary"
              style={{
                display: "block",
                marginTop: 6,
                fontSize: 14,
                lineHeight: 1.5,
              }}
            >
              {subtitle}
            </Typography.Text>
          ) : null}
        </div>
      </div>
      {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </div>
  );
}