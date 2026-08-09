import { theme } from "antd";
import type { CSSProperties, ReactNode } from "react";

export type FieldProps = {
  label: ReactNode;
  value: ReactNode;
  style?: CSSProperties;
};

export function Field({ label, value, style }: FieldProps) {
  const { token } = theme.useToken();

  return (
    <div
      style={{
        margin: 0,
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        ...style,
      }}
    >
      <span style={{ fontSize: token.fontSize, lineHeight: "22px" }}>{label}</span>
      <span
        style={{
          marginLeft: 8,
          color: token.colorTextHeading,
        }}
      >
        {value}
      </span>
    </div>
  );
}