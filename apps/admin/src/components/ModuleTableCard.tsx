import { Card } from "antd";
import type { ReactNode } from "react";

export type ModuleTableCardProps = {
  children: ReactNode;
};

/** Inner outlined card wrapping a ProTable inside ModulePageShell. */
export function ModuleTableCard({ children }: ModuleTableCardProps) {
  return (
    <Card
      className="module-table-card"
      variant="outlined"
      style={{ maxWidth: "100%", minWidth: 0 }}
      styles={{
        body: {
          padding: 0,
          minWidth: 0,
          maxWidth: "100%",
          overflow: "visible",
        },
      }}
    >
      {children}
    </Card>
  );
}