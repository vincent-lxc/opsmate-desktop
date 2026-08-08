import { Navigate, useLocation } from "react-router-dom";
import { RouteMigrationBanner } from "../../components/RouteMigrationBanner";

export function MigratedAnomalyRulesRedirect({
  routeKey,
  target,
}: {
  routeKey: "risk_metrics" | "anomaly_rule_drafts";
  target: string;
}) {
  const location = useLocation();

  return (
    <div style={{ padding: 24 }}>
      <RouteMigrationBanner routeKey={routeKey} />
      <Navigate to={`${target}${location.search}`} replace />
    </div>
  );
}