import { PageContainer } from "@ant-design/pro-components";
import { Card } from "antd";
import type { ReactNode } from "react";
import { ModulePageHeader, type ModulePageHeaderProps } from "./ModulePageHeader";

export type ModulePageShellProps = ModulePageHeaderProps & {
  children: ReactNode;
};

export function ModulePageShell({
  icon,
  title,
  subtitle,
  action,
  children,
}: ModulePageShellProps) {
  return (
    <PageContainer ghost title={false}>
      <Card
        variant="outlined"
        style={{ maxWidth: "100%", minWidth: 0 }}
        styles={{
          body: {
            padding: 24,
            minWidth: 0,
            overflowX: "auto",
            overflowY: "auto",
          },
        }}
      >
        <ModulePageHeader
          icon={icon}
          title={title}
          subtitle={subtitle}
          action={action}
        />
        <div style={{ minWidth: 0, maxWidth: "100%" }}>{children}</div>
      </Card>
    </PageContainer>
  );
}