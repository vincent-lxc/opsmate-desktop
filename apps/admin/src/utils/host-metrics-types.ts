export type HostMetrics = {
  cpu: {
    usage_pct: number;
    cores: number;
    load: [number, number, number];
  };
  memory: {
    total_bytes: number;
    used_bytes: number;
    usage_pct: number;
  };
  disk: {
    total_bytes: number;
    used_bytes: number;
    usage_pct: number;
    mount: string;
  };
  network: {
    rx_bytes: number;
    tx_bytes: number;
  };
  system: {
    hostname: string;
    os: string;
    kernel: string;
    uptime_seconds: number;
  };
  docker?: {
    installed: boolean;
    version: string | null;
    api_version: string | null;
    storage_driver: string | null;
    cgroup_driver: string | null;
    containers_total: number;
    containers_running: number;
  };
  collected_at: string;
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function usageProgressStatus(pct: number): "success" | "normal" | "exception" {
  if (pct >= 85) return "exception";
  if (pct >= 70) return "normal";
  return "success";
}