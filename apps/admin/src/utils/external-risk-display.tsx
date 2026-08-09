import { Tag } from "antd";
import type { TFunction } from "i18next";

const SEVERITY_COLORS: Record<string, string> = {
  P1: "#ff4d4f",
  P2: "#fa8c16",
  P3: "#8c8c8c",
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "#52c41a",
  medium: "#faad14",
  low: "#8c8c8c",
};

const STATUS_COLORS: Record<string, string> = {
  new: "#1677ff",
  acknowledged: "#13c2c2",
  in_progress: "#722ed1",
  resolved: "#52c41a",
  ignored: "#8c8c8c",
  false_positive: "#bfbfbf",
  superseded: "#d9d9d9",
};

const HEALTH_COLORS: Record<string, string> = {
  healthy: "#52c41a",
  degraded: "#faad14",
  unhealthy: "#ff4d4f",
  unknown: "#8c8c8c",
};

function tintedTag(label: string, color: string) {
  return (
    <Tag style={{ color, borderColor: color, background: `${color}18` }}>{label}</Tag>
  );
}

export function severityTag(severity: string) {
  const color = SEVERITY_COLORS[severity] ?? "#8c8c8c";
  return tintedTag(severity, color);
}

export function confidenceTag(confidence: string, t: TFunction) {
  const color = CONFIDENCE_COLORS[confidence] ?? "#8c8c8c";
  const label =
    confidence === "high"
      ? t("externalRisk.findings.confidence.high")
      : confidence === "medium"
        ? t("externalRisk.findings.confidence.medium")
        : confidence === "low"
          ? t("externalRisk.findings.confidence.low")
          : confidence;
  return tintedTag(label, color);
}

export function findingStatusTag(status: string, t: TFunction) {
  const color = STATUS_COLORS[status] ?? "#8c8c8c";
  const key = `externalRisk.findings.status.${status}`;
  const label = t(key, { defaultValue: status });
  return tintedTag(label, color);
}

export function providerHealthTag(status: string | null, t: TFunction) {
  const normalized = status ?? "unknown";
  const color = HEALTH_COLORS[normalized] ?? "#8c8c8c";
  const label =
    normalized === "healthy"
      ? t("externalRisk.providers.health.healthy")
      : normalized === "degraded"
        ? t("externalRisk.providers.health.degraded")
        : normalized === "unhealthy"
          ? t("externalRisk.providers.health.unhealthy")
          : t("externalRisk.providers.health.unknown");
  return tintedTag(label, color);
}

export function enabledTag(enabled: boolean, t: TFunction) {
  const color = enabled ? "#52c41a" : "#8c8c8c";
  return tintedTag(
    enabled ? t("externalRisk.status.enabled") : t("externalRisk.status.disabled"),
    color,
  );
}

export function aiEnabledTag(enabled: boolean, t: TFunction) {
  if (!enabled) return <Tag>{t("common.no")}</Tag>;
  return (
    <Tag color="geekblue" style={{ borderColor: "#2f54eb", background: "#2f54eb18" }}>
      {t("common.yes")}
    </Tag>
  );
}

export function runStatusTag(status: string, t: TFunction) {
  const colors: Record<string, string> = {
    pending: "#8c8c8c",
    running: "#1677ff",
    completed: "#52c41a",
    failed: "#ff4d4f",
    cancelled: "#bfbfbf",
  };
  const color = colors[status] ?? "#8c8c8c";
  const label = t(`externalRisk.tasks.runStatus.${status}`, { defaultValue: status });
  return tintedTag(label, color);
}

export function riskFlagTags(
  finding: { exploit_available: boolean; internet_exposed: boolean },
  t: TFunction,
) {
  const tags = [];
  if (finding.exploit_available) {
    tags.push(
      <Tag key="exploit" color="red">
        {t("externalRisk.critical.flags.exploit")}
      </Tag>,
    );
  }
  if (finding.internet_exposed) {
    tags.push(
      <Tag key="exposed" color="orange">
        {t("externalRisk.critical.flags.exposed")}
      </Tag>,
    );
  }
  return tags.length > 0 ? tags : null;
}