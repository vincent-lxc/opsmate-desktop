export type SetupStatus = "scanning" | "pending_review" | "ready";

export type MonitorTarget = {
  id: string;
  server_id: string;
  name: string;
  category: string;
  node_type: string;
  confidence: string;
  activation_state: "suggested" | "active" | "ignored";
  connection_hints: Record<string, unknown>;
  docker_meta: Record<string, unknown>;
  credential_status: string;
  foundation_component_id: string | null;
  service_name: string | null;
};

/** Categories for platform foundation components (no host_resources — host uses host_metrics). */
export const FOUNDATION_COMPONENT_CATEGORIES = [
  "container_runtime",
  "deployment_platform",
  "database",
  "cache",
  "message_queue",
  "middleware",
  "system_service",
] as const;

/** Non-application checklist categories → link 基础组件 (with category). */
export function isFoundationLinkCategory(category: string): boolean {
  return (FOUNDATION_COMPONENT_CATEGORIES as readonly string[]).includes(category);
}

/** Application checklist targets → link 应用组件 by service_name. */
export function isApplicationLinkCategory(category: string): boolean {
  return category === "application";
}

export type TopologyEdge = {
  id: string;
  server_id: string;
  source_target_id: string | null;
  target_target_id: string | null;
  edge_type: "network" | "dependency" | "data_flow";
  provenance: string;
  activation_state: string;
  confidence: string;
  label: string | null;
  note: string | null;
  unresolved_hostname: string | null;
};

/** Categories shown in the dependency topology graph */
export const DEPENDENCY_GRAPH_CATEGORIES = [
  "application",
  "database",
  "cache",
  "middleware",
  "message_queue",
] as const;

export type DiscoveryStatus = {
  setup_status: SetupStatus;
  last_discovery_run_id: string | null;
  run: {
    id: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    error_message: string | null;
  } | null;
  target_counts: { suggested: number; active: number; total: number };
};

export const TARGET_CATEGORY_ORDER = [
  "pending_review",
  "host_resources",
  "container_runtime",
  "application",
  "deployment_platform",
  "database",
  "cache",
  "message_queue",
  "middleware",
  "system_service",
] as const;

export const CATEGORY_LABEL_KEYS: Record<string, string> = {
  entry_external: "servers.dependencies.entryExternal",
  entry_internal: "servers.dependencies.entryInternal",
  pending_review: "servers.discovery.categories.pendingReview",
  host_resources: "servers.discovery.categories.host",
  container_runtime: "servers.discovery.categories.containers",
  application: "servers.discovery.categories.application",
  deployment_platform: "servers.discovery.categories.deploymentPlatform",
  database: "servers.discovery.categories.database",
  cache: "servers.discovery.categories.cache",
  message_queue: "servers.discovery.categories.mq",
  middleware: "servers.discovery.categories.middleware",
  system_service: "servers.discovery.categories.system",
};