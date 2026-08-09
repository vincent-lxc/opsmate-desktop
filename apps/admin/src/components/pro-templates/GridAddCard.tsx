import type { ReactNode } from "react";
import { Card } from "antd";
import { PlusOutlined } from "@ant-design/icons";

type GridAddCardProps = {
  label: ReactNode;
  onClick: () => void;
  height?: number;
};

export function GridAddCard({ label, onClick, height = 280 }: GridAddCardProps) {
  return (
    <Card
      hoverable
      style={{
        height,
        borderStyle: "dashed",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      styles={{
        body: {
          padding: 0,
          width: "100%",
          textAlign: "center",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        },
      }}
      onClick={onClick}
    >
      <div>
        <PlusOutlined
          style={{
            fontSize: 24,
            color: "rgba(0,0,0,0.45)",
            display: "block",
            marginBottom: 8,
          }}
        />
        <span style={{ color: "rgba(0,0,0,0.65)" }}>{label}</span>
      </div>
    </Card>
  );
}