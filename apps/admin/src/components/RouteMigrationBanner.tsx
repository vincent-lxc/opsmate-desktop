import { Alert } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";

type RouteSunsetResponse = {
  deadlines: Record<string, string>;
  warning_days: number;
};

function daysUntil(isoDate: string): number {
  const end = new Date(`${isoDate}T23:59:59.000Z`).getTime();
  return Math.ceil((end - Date.now()) / (24 * 3_600_000));
}

export function RouteMigrationBanner({ routeKey }: { routeKey: string }) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["route-sunset"],
    queryFn: () => api<RouteSunsetResponse>("/api/config/route-sunset"),
    staleTime: 60_000,
  });

  const deadline = data?.deadlines[routeKey];
  if (!deadline) return null;

  const remaining = daysUntil(deadline);
  if (remaining < 0) return null;

  const warningDays = data?.warning_days ?? 14;
  const isUpgrade = remaining <= warningDays;

  return (
    <Alert
      type={isUpgrade ? "warning" : "info"}
      showIcon
      style={{ marginBottom: 16 }}
      message={
        isUpgrade
          ? t("routeMigration.upgradeTitle")
          : t("routeMigration.bannerTitle")
      }
      description={t("routeMigration.bannerBody", {
        target: t(`routeMigration.targets.${routeKey}`),
        date: deadline,
        days: remaining,
      })}
    />
  );
}