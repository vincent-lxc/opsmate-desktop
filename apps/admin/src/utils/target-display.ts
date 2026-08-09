import type { MonitorTarget } from "./discovery-types";

export function getTargetAppName(target: MonitorTarget): string {
  const fromMeta = target.docker_meta.appName;
  if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta;
  const fromHints = target.connection_hints.appName;
  if (typeof fromHints === "string" && fromHints.trim()) return fromHints;
  return target.name;
}

export function getTargetPorts(target: MonitorTarget): string[] {
  const raw = target.docker_meta.ports ?? target.connection_hints.ports;
  if (!Array.isArray(raw)) return [];
  return raw.map(String).filter(Boolean);
}

export function getTargetImage(target: MonitorTarget): string | null {
  const image = target.docker_meta.image;
  return typeof image === "string" && image.trim() ? image : null;
}

export function getTargetStatus(target: MonitorTarget): string | null {
  const status = target.docker_meta.status;
  return typeof status === "string" && status.trim() ? status : null;
}

export function isContainerRunning(status: string | null): boolean | null {
  if (!status) return null;
  return /up|running/i.test(status);
}

type TargetCredentials = {
  username?: string;
  password_set?: boolean;
  source?: string;
  env_keys?: string[];
  auth_mode?: string;
};

export function getTargetCredentials(target: MonitorTarget): TargetCredentials | null {
  const creds = target.connection_hints.credentials;
  if (!creds || typeof creds !== "object") return null;
  return creds as TargetCredentials;
}

export function isCredentialFromEnv(target: MonitorTarget): boolean {
  return getTargetCredentials(target)?.source === "env";
}

export function getCredentialEnvKeys(target: MonitorTarget): string[] {
  const keys = getTargetCredentials(target)?.env_keys;
  return Array.isArray(keys) ? keys.map(String) : [];
}

export function isNoAuthTarget(target: MonitorTarget): boolean {
  return getTargetCredentials(target)?.auth_mode === "none";
}

export function isDockerTarget(target: MonitorTarget): boolean {
  if (target.connection_hints.runtime === "host") return false;
  if (target.connection_hints.runtime === "docker") return true;
  if (target.category === "host_resources") return false;
  return Boolean(target.docker_meta.image);
}

export function getComposeProject(target: MonitorTarget): string | null {
  const fromHints = target.connection_hints.composeProject;
  if (typeof fromHints === "string" && fromHints.trim()) return fromHints.trim();
  const labels = target.docker_meta.labels as Record<string, string> | undefined;
  const fromLabels = labels?.["com.docker.compose.project"];
  return typeof fromLabels === "string" && fromLabels.trim() ? fromLabels.trim() : null;
}