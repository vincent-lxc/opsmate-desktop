import { Typography, theme } from "antd";

export type ModuleSectionHeaderProps = {
  title: string;
};

export function ModuleSectionHeader({ title }: ModuleSectionHeaderProps) {
  const { token } = theme.useToken();

  return (
    <div
      style={{
        padding: "16px 24px",
        borderBottom: `1px solid ${token.colorBorder}`,
      }}
    >
      <Typography.Title level={5} style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>
        {title}
      </Typography.Title>
    </div>
  );
}