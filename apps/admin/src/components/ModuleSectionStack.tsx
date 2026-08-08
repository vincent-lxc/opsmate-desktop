import type { ReactNode } from "react";
import { moduleSectionStackStyle } from "./module-table-styles";

export type ModuleSectionStackProps = {
  children: ReactNode;
};

export function ModuleSectionStack({ children }: ModuleSectionStackProps) {
  return <div style={moduleSectionStackStyle}>{children}</div>;
}