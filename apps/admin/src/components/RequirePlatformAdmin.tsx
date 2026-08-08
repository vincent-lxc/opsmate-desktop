import type { ReactNode } from "react";
import { Result } from "antd";
import { isPlatformAdmin } from "../services/auth/roles";

export function RequirePlatformAdmin({ children }: { children: ReactNode }) {
  if (!isPlatformAdmin()) {
    return <Result status="403" title="403" subTitle="仅平台超级管理员可访问此页面" />;
  }
  return <>{children}</>;
}
