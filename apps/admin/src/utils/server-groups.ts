import type { ServerRecord } from "../components/ServerFormDrawer";

export const DEFAULT_SERVER_GROUP = "default";

export type ServerGroupSection = {
  name: string;
  label: string;
  servers: ServerRecord[];
};

export function formatGroupLabel(
  groupName: string,
  t: (key: string) => string,
): string {
  return groupName === DEFAULT_SERVER_GROUP
    ? t("servers.groups.default")
    : groupName;
}

/** Default group last; other groups alphabetical (matches legacy card-list UX). */
export function compareServerGroupNames(left: string, right: string): number {
  if (left === DEFAULT_SERVER_GROUP) return 1;
  if (right === DEFAULT_SERVER_GROUP) return -1;
  return left.localeCompare(right);
}

export function sortServerGroupSummaries<T extends { name: string }>(groups: T[]): T[] {
  return [...groups].sort((left, right) => compareServerGroupNames(left.name, right.name));
}

function compareServersNewestFirst(a: ServerRecord, b: ServerRecord): number {
  const aTime = a.created_at ? Date.parse(a.created_at) : 0;
  const bTime = b.created_at ? Date.parse(b.created_at) : 0;
  if (bTime !== aTime) return bTime - aTime;
  return b.name.localeCompare(a.name);
}

export function groupServers(
  servers: ServerRecord[],
  t: (key: string) => string,
): ServerGroupSection[] {
  const map = new Map<string, ServerRecord[]>();

  for (const server of servers) {
    const groupName = server.group_name || DEFAULT_SERVER_GROUP;
    const bucket = map.get(groupName) ?? [];
    bucket.push(server);
    map.set(groupName, bucket);
  }

  return Array.from(map.entries())
    .sort(([left], [right]) => compareServerGroupNames(left, right))
    .map(([name, groupServersList]) => ({
      name,
      label: formatGroupLabel(name, t),
      servers: groupServersList.sort(compareServersNewestFirst),
    }));
}