import { useCallback } from "react";
import { useTranslation } from "react-i18next";

const EVENT_TYPE_COLORS: Record<string, string> = {
  normal_snapshot: "blue",
  anomaly_detected: "red",
  anomaly_updated: "orange",
  human_intervention: "purple",
  ai_action: "cyan",
  resolution: "green",
};

const SEVERITY_STATUS: Record<string, "error" | "warning" | "processing"> = {
  P1: "error",
  P2: "warning",
  P3: "processing",
};

const STATE_COLORS: Record<string, string> = {
  healthy: "green",
  anomaly_detected: "orange",
  degraded: "volcano",
  critical: "red",
  recovering: "blue",
};

export function useEventTypeLabel() {
  const { t } = useTranslation();

  return useCallback(
    (key: string) => ({
      text: t(`labels.eventType.${key}`, { defaultValue: key }),
      color: EVENT_TYPE_COLORS[key] ?? "default",
    }),
    [t],
  );
}

export function useSeverityLabel() {
  const { t } = useTranslation();

  return useCallback(
    (key: string) => ({
      text: t(`labels.severity.${key}`, { defaultValue: key }),
      status: SEVERITY_STATUS[key] ?? ("default" as const),
    }),
    [t],
  );
}

export function useStateLabel() {
  const { t } = useTranslation();

  return useCallback(
    (key: string) => ({
      text: t(`labels.state.${key}`, { defaultValue: key }),
      color: STATE_COLORS[key] ?? "default",
    }),
    [t],
  );
}

export { EVENT_TYPE_COLORS, SEVERITY_STATUS, STATE_COLORS };