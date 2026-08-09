import { Tag } from "antd";
import type { TFunction } from "i18next";

export function monitorStepScopeLabel(
  config: Record<string, unknown> | undefined,
  t: TFunction,
): string {
  const scope = config?.scope;
  if (scope === "docker") return t("monitoring.stepScope.docker");
  if (scope === "host") return t("monitoring.stepScope.host");
  return t("monitoring.stepScope.both");
}

export function MonitorStepScopeTag({
  config,
  t,
}: {
  config: Record<string, unknown> | undefined;
  t: TFunction;
}) {
  const scope = config?.scope;
  if (scope === "docker") {
    return <Tag color="geekblue">{t("monitoring.stepScope.docker")}</Tag>;
  }
  if (scope === "host") {
    return <Tag color="purple">{t("monitoring.stepScope.host")}</Tag>;
  }
  return <Tag>{t("monitoring.stepScope.both")}</Tag>;
}