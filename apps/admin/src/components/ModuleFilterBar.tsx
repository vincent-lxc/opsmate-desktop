import type { ReactNode } from "react";
import { moduleFilterBarStyle } from "./module-table-styles";

export type ModuleFilterBarProps = {
  children: ReactNode;
};

export function ModuleFilterBar({ children }: ModuleFilterBarProps) {
  return <div style={moduleFilterBarStyle}>{children}</div>;
}