import { Tag } from "antd";
import type { TFunction } from "i18next";
import { remediationTierTag } from "./patrol-display";

export function problemVerdictSourceTag(source: string | null, t: TFunction) {
  if (!source) return "—";
  const labels: Record<string, string> = {
    ai: t("problems.detail.verdictAi"),
    rules: t("problems.detail.verdictRules"),
    rules_fallback: t("problems.detail.verdictRulesFallback"),
  };
  const color =
    source === "ai" ? "geekblue" : source === "rules_fallback" ? "orange" : "default";
  return <Tag color={color}>{labels[source] ?? source}</Tag>;
}

export function remediationMethodLabel(method: string | null, t: TFunction): string {
  if (!method) return "—";
  return t(`problems.remediationMethod.${method}`, { defaultValue: method });
}

export function remediationExecutedLabel(executed: boolean | null, t: TFunction): string {
  if (executed == null) return "—";
  return executed
    ? t("problems.detail.remediationExecutedYes")
    : t("problems.detail.remediationExecutedNo");
}

export function verificationStatusTag(status: string | null, t: TFunction) {
  if (!status) return "—";
  const colors: Record<string, string> = {
    not_applicable: "default",
    pending_patrol: "processing",
    confirmed: "success",
    still_failing: "error",
  };
  const color = colors[status] ?? "default";
  return (
    <Tag color={color === "default" ? undefined : color}>
      {t(`problems.verificationStatus.${status}`, { defaultValue: status })}
    </Tag>
  );
}

export function problemRemediationTag(
  tier: string | null,
  status: string | null,
  t: TFunction,
) {
  if (!tier) return "—";
  return remediationTierTag(
    tier,
    status ? t(`problems.remediationStatus.${status}`, { defaultValue: status }) : null,
  );
}