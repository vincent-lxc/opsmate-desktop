import { Tag } from "antd";
import type { TFunction } from "i18next";

const VERDICT_COLORS: Record<string, string> = {
  normal: "#52c41a",
  watch: "#faad14",
  anomaly: "#ff4d4f",
};

export function verdictTag(verdict: string) {
  const color = VERDICT_COLORS[verdict] ?? "#8c8c8c";
  return (
    <Tag style={{ color, borderColor: color, background: `${color}18` }}>{verdict}</Tag>
  );
}

export function taskStatusTag(status: string, t: TFunction) {
  const running = status === "running";
  const color = running ? "#52c41a" : "#8c8c8c";
  return (
    <Tag style={{ color, borderColor: color, background: `${color}18` }}>
      {running ? t("monitoring.patrolTasks.statusRunning") : t("monitoring.patrolTasks.statusStopped")}
    </Tag>
  );
}

const ROUND_STATUS_COLORS: Record<string, string> = {
  running: "#1677ff",
  completed: "#52c41a",
  partial: "#faad14",
  failed: "#ff4d4f",
};

export function roundStatusTag(status: string, t: TFunction) {
  const color = ROUND_STATUS_COLORS[status] ?? "#8c8c8c";
  return (
    <Tag style={{ color, borderColor: color, background: `${color}18` }}>
      {t(`monitoring.patrolTasks.roundStatus.${status}`, { defaultValue: status })}
    </Tag>
  );
}

export function aiEnabledTag(enabled: boolean, t: TFunction) {
  if (!enabled) {
    return <Tag>{t("monitoring.patrolTasks.aiOff")}</Tag>;
  }
  return (
    <Tag color="geekblue" style={{ borderColor: "#2f54eb", background: "#2f54eb18" }}>
      {t("monitoring.patrolTasks.aiOn")}
    </Tag>
  );
}

const STEP_STATUS_COLORS: Record<string, string> = {
  ok: "#52c41a",
  warn: "#faad14",
  fail: "#ff4d4f",
  error: "#ff4d4f",
  skipped: "#8c8c8c",
};

export function stepStatusTag(status: string) {
  const color = STEP_STATUS_COLORS[status] ?? "#8c8c8c";
  return (
    <Tag style={{ color, borderColor: color, background: `${color}18` }}>{status}</Tag>
  );
}

export function remediationTierTag(tier: string | null, status: string | null) {
  if (!tier) return "—";
  const colors: Record<string, string> = { L1: "#52c41a", L2: "#fa8c16", L3: "#ff4d4f" };
  const color = colors[tier] ?? "#8c8c8c";
  return (
    <Tag style={{ color, borderColor: color, background: `${color}18` }}>
      {tier}
      {status ? ` · ${status}` : ""}
    </Tag>
  );
}