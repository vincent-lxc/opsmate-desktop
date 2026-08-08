import type { TFunction } from "i18next";

export type MonitorOwnerKind = "foundation" | "application";

export function monitorOwnerKindLabel(
  kind: MonitorOwnerKind | null | undefined,
  t: TFunction,
): string {
  if (kind === "application") {
    return t("monitoring.patrolRecords.stepColumns.ownerKindApplication");
  }
  return t("monitoring.patrolRecords.stepColumns.ownerKindFoundation");
}

export function monitorOwnerNameLabel(
  name: string | null | undefined,
  t: TFunction,
): string {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return "—";
  if (trimmed === "host") return t("monitoring.patrolRecords.stepColumns.ownerHost");
  return trimmed;
}