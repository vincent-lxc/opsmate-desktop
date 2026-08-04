import { Navigate, Route, Routes } from "react-router-dom";
import { AccountPage } from "../account/AccountPage";
import { CredentialsPage } from "../credentials/CredentialsPage";
import { MonitoringPage } from "../monitoring/MonitoringPage";
import { ServerDetailPlaceholder } from "../servers/ServerDetailPlaceholder";
import { ServersPage } from "../servers/ServersPage";

/**
 * Product route table for OpsMate Desktop.
 * Top-level: monitoring, servers, credentials, account.
 * Terminal/AI is contextual under `/servers/:serverId` (placeholder only for now).
 * Explicitly excludes admin surfaces: roles, users, system, provider, bot config.
 */

/** Explicit product paths registered in the foundation shell (no `/terminal`). */
export const REGISTERED_PRODUCT_PATHS = [
  "/monitoring",
  "/servers",
  "/servers/:serverId",
  "/credentials",
  "/account",
] as const;

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/monitoring" replace />} />
      <Route path="/monitoring" element={<MonitoringPage />} />
      <Route path="/servers" element={<ServersPage />} />
      <Route path="/servers/:serverId" element={<ServerDetailPlaceholder />} />
      <Route path="/credentials" element={<CredentialsPage />} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="*" element={<Navigate to="/monitoring" replace />} />
    </Routes>
  );
}
