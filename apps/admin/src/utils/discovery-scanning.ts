import type { DiscoveryStatus } from "./discovery-types";

export function isDiscoveryScanning(status?: DiscoveryStatus): boolean {
  if (!status) return false;
  return status.setup_status === "scanning" || status.run?.status === "running";
}