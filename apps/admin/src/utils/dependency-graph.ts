import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import type { MonitorTarget, TopologyEdge } from "./discovery-types";
import { getTargetAppName, getTargetPorts } from "./target-display";

export const DEP_NODE_WIDTH = 196;
export const DEP_NODE_HEIGHT = 76;

export const DEPENDENCY_GRAPH_CATEGORIES = new Set([
  "application",
  "database",
  "cache",
  "middleware",
  "message_queue",
]);

export type LinkScope = "internal" | "published" | "external";

export type EdgeLinkMeta = {
  linkScope: LinkScope;
  sourcePort?: number;
  targetPort?: number;
  hostPort?: number;
};

export type ManualEdgeHandles = {
  sourceHandle?: string;
  targetHandle?: string;
};

export const DEFAULT_EDGE_SOURCE_HANDLE = "src-r";
export const DEFAULT_EDGE_TARGET_HANDLE = "tgt-l";

export function serializeManualEdgeNote(handles: ManualEdgeHandles): string {
  return JSON.stringify({ handles });
}

export function parseManualEdgeHandles(note: string | null | undefined): ManualEdgeHandles {
  if (!note) return {};
  try {
    const parsed = JSON.parse(note) as { handles?: ManualEdgeHandles; linkScope?: string };
    if (parsed?.handles) return parsed.handles;
  } catch {
    /* plain text note */
  }
  return {};
}

export type DependencyNodeData = {
  label: string;
  sublabel?: string;
  /** External reachable ports shown inside the node block */
  portNumbers?: number[];
  category: string;
  activationState?: string;
  isExternal?: boolean;
  isPendingHost?: boolean;
};

export const HOST_ENTRY_NODE_ID = "__host_entry__";

export type DependencyEdgeData = {
  edgeId: string;
  edgeType: TopologyEdge["edge_type"];
  provenance: string;
  activationState: string;
  linkScope: LinkScope;
  label?: string | null;
  deletable?: boolean;
};

/** Node ids that support drag-to-connect (real monitor targets on this server). */
export function isConnectableGraphNodeId(nodeId: string): boolean {
  if (!nodeId || nodeId.startsWith("pending:")) return false;
  if (nodeId === HOST_ENTRY_NODE_ID) return false;
  return true;
}

import { CATEGORY_COLORS, categoryColor as sharedCategoryColor } from "./category-colors";

const GATEWAY_NAME_PATTERN = /nginx|haproxy|traefik|caddy|envoy/i;

/** Left-to-right / top-to-bottom band order for category layering */
const CATEGORY_BAND: Record<string, number> = {
  entry_external: -1,
  entry_internal: 0,
  middleware: 0,
  application: 1,
  database: 2,
  cache: 2,
  message_queue: 2,
  system_service: 3,
  pending_review: 3,
};

const LINK_SCOPE_COLORS: Record<LinkScope, string> = {
  internal: "#13c2c2",
  published: "#fa8c16",
  external: "#722ed1",
};

const GRAPH_EDGE_TYPES = new Set<TopologyEdge["edge_type"]>(["dependency", "data_flow"]);

const IGNORED_DEPENDENCY_HOSTS = new Set([
  "download.redis.io",
  "github.com",
  "raw.githubusercontent.com",
  "hub.docker.com",
]);

function isIgnoredDependencyHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (IGNORED_DEPENDENCY_HOSTS.has(lower)) return true;
  return lower.startsWith("download.");
}

export function categoryColor(category: string): string {
  return sharedCategoryColor(category);
}

export function isGraphEligibleTarget(target: MonitorTarget): boolean {
  if (target.activation_state === "ignored") return false;
  return DEPENDENCY_GRAPH_CATEGORIES.has(target.category);
}

export function linkScopeStrokeColor(scope: LinkScope, activationState: string): string {
  if (activationState === "stale") return "#ff4d4f";
  if (activationState === "ignored") return "#bfbfbf";
  return LINK_SCOPE_COLORS[scope];
}

export function edgeStrokeColor(state: string): string {
  if (state === "active") return "#52c41a";
  if (state === "suggested") return "#1677ff";
  if (state === "stale") return "#ff4d4f";
  if (state === "ignored") return "#bfbfbf";
  return "#8c8c8c";
}

function pendingHostId(hostname: string): string {
  return `pending:${hostname}`;
}

function parseEdgeLinkMeta(note: string | null | undefined): EdgeLinkMeta | null {
  if (!note) return null;
  try {
    const parsed = JSON.parse(note) as EdgeLinkMeta;
    if (parsed && typeof parsed.linkScope === "string") return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

function parsePublishedPortEntry(
  entry: string,
): { hostPort: number; containerPort: number } | null {
  const withIp = String(entry).match(/^[^:]+:(\d{1,5})→(\d{1,5})/);
  if (withIp) {
    return {
      hostPort: Number.parseInt(withIp[1], 10),
      containerPort: Number.parseInt(withIp[2], 10),
    };
  }
  const legacy = String(entry).match(/^(\d{1,5})→(\d{1,5})/);
  if (!legacy) return null;
  return {
    hostPort: Number.parseInt(legacy[1], 10),
    containerPort: Number.parseInt(legacy[2], 10),
  };
}

function targetIsInternalEntry(target: MonitorTarget): boolean {
  if (target.category !== "middleware") return false;
  const hints = target.connection_hints ?? {};
  const upstreams = hints.reverse_proxy_upstreams as string[] | undefined;
  if (Array.isArray(upstreams) && upstreams.length > 0) return true;
  const name = target.name;
  const image = String(target.docker_meta?.image ?? "");
  return GATEWAY_NAME_PATTERN.test(name) || GATEWAY_NAME_PATTERN.test(image);
}

function resolveGraphCategory(target: MonitorTarget): string {
  if (targetIsInternalEntry(target)) return "entry_internal";
  return target.category;
}

function formatServicePortNumbers(target: MonitorTarget): number[] | undefined {
  const entries = getTargetPorts(target);
  const ports: number[] = [];
  for (const entry of entries) {
    const parsed = parsePublishedPortEntry(entry);
    if (parsed) {
      ports.push(parsed.hostPort);
      continue;
    }
    const containerOnly = String(entry).match(/→(\d{1,5})/);
    if (containerOnly) ports.push(Number.parseInt(containerOnly[1], 10));
  }
  const unique = [...new Set(ports)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : undefined;
}

/** Gateway (内入) shows verified external ports; other services show Docker publish/listen ports only. */
export function formatNodePortNumbers(
  target: MonitorTarget,
  graphCategory: string,
): number[] | undefined {
  if (graphCategory === "entry_internal") {
    const reachable = target.connection_hints.external_reachable_ports as number[] | undefined;
    if (Array.isArray(reachable) && reachable.length > 0) {
      return [...reachable].sort((a, b) => a - b);
    }
  }
  return formatServicePortNumbers(target);
}

export function chunkPortNumbers(ports: number[], perLine = 3): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ports.length; i += perLine) {
    chunks.push(ports.slice(i, i + perLine));
  }
  return chunks;
}

function inferLinkScope(
  edge: TopologyEdge,
  source?: MonitorTarget,
  target?: MonitorTarget,
): LinkScope {
  const fromNote = parseEdgeLinkMeta(edge.note);
  if (fromNote) return fromNote.linkScope;

  if (edge.unresolved_hostname || !edge.target_target_id) return "external";
  if (edge.edge_type === "network") return "internal";

  const label = edge.label ?? "";
  if (label.includes("↔")) return "published";

  if (source && target) {
    const targetPorts = getTargetPorts(target).map(parsePublishedPortEntry).filter(Boolean);
    if (targetPorts.length > 0 && edge.edge_type === "data_flow") {
      return "published";
    }
    return "internal";
  }

  return "internal";
}

function buildEdgeDisplayLabel(
  edge: TopologyEdge,
  linkScope: LinkScope,
  source?: MonitorTarget,
  target?: MonitorTarget,
): string {
  if (edge.label?.trim()) return edge.label.trim();

  const meta = parseEdgeLinkMeta(edge.note);
  if (meta) {
    if (linkScope === "published" && meta.hostPort && meta.targetPort) {
      return `${meta.hostPort}↔${meta.targetPort}`;
    }
    if (meta.targetPort) return String(meta.targetPort);
    if (meta.hostPort) return String(meta.hostPort);
  }

  if (linkScope === "published" && target) {
    const mapping = getTargetPorts(target).map(parsePublishedPortEntry).find(Boolean);
    if (mapping) return `${mapping.hostPort}↔${mapping.containerPort}`;
  }

  if (source && target && source.category === "application" && target.category === "application") {
    return edge.edge_type === "dependency" ? "depends" : edge.edge_type;
  }

  return edge.edge_type === "data_flow" ? "data" : edge.edge_type;
}

export function buildDependencyGraph(
  edges: TopologyEdge[],
  localTargets: MonitorTarget[],
  targetLabels: Map<string, string>,
  _options?: { externalEntryLabel?: string },
): { nodes: Node<DependencyNodeData>[]; edges: Edge<DependencyEdgeData>[] } {
  const nodeIds = new Set<string>();
  const localById = new Map(localTargets.map((t) => [t.id, t]));
  const eligibleIds = new Set(
    localTargets.filter(isGraphEligibleTarget).map((t) => t.id),
  );

  const graphEdges = edges.filter((edge) => {
    if (!GRAPH_EDGE_TYPES.has(edge.edge_type)) return false;
    if (edge.activation_state === "ignored" || edge.activation_state === "stale") return false;
    if (edge.unresolved_hostname && isIgnoredDependencyHost(edge.unresolved_hostname)) return false;
    if (edge.source_target_id && !eligibleIds.has(edge.source_target_id)) return false;
    if (edge.target_target_id && !eligibleIds.has(edge.target_target_id)) return false;
    return Boolean(edge.source_target_id);
  });

  for (const id of eligibleIds) {
    nodeIds.add(id);
  }
  for (const edge of graphEdges) {
    if (edge.source_target_id) nodeIds.add(edge.source_target_id);
    if (edge.target_target_id) nodeIds.add(edge.target_target_id);
    if (edge.unresolved_hostname) {
      nodeIds.add(pendingHostId(edge.unresolved_hostname));
    }
  }

  const nodes: Node<DependencyNodeData>[] = [];

  for (const id of nodeIds) {
    if (id.startsWith("pending:")) {
      const hostname = id.slice("pending:".length);
      nodes.push({
        id,
        type: "dependencyNode",
        position: { x: 0, y: 0 },
        data: {
          label: hostname,
          sublabel: "pending host",
          category: "pending_review",
          activationState: "pending_manual",
          isPendingHost: true,
        },
      });
      continue;
    }

    const local = localById.get(id);
    if (local) {
      const graphCategory = resolveGraphCategory(local);
      const hideSublabel = graphCategory === "entry_internal";
      nodes.push({
        id,
        type: "dependencyNode",
        position: { x: 0, y: 0 },
        data: {
          label: getTargetAppName(local),
          sublabel: hideSublabel ? undefined : local.name,
          portNumbers: formatNodePortNumbers(local, graphCategory),
          category: graphCategory,
          activationState: local.activation_state,
          isExternal: false,
        },
      });
      continue;
    }

    const label = targetLabels.get(id) ?? id.slice(0, 8);
    const slashIdx = label.indexOf(" / ");
    nodes.push({
      id,
      type: "dependencyNode",
      position: { x: 0, y: 0 },
      data: {
        label: slashIdx >= 0 ? label.slice(slashIdx + 3) : label,
        sublabel: slashIdx >= 0 ? label.slice(0, slashIdx) : "external",
        category: "middleware",
        isExternal: true,
      },
    });
  }

  const flowEdges: Edge<DependencyEdgeData>[] = graphEdges
    .map((edge) => {
      const targetId =
        edge.target_target_id ?? pendingHostId(edge.unresolved_hostname ?? "unknown");
      const sourceTarget = edge.source_target_id
        ? localById.get(edge.source_target_id)
        : undefined;
      const targetTarget = edge.target_target_id
        ? localById.get(edge.target_target_id)
        : undefined;
      const linkScope = inferLinkScope(edge, sourceTarget, targetTarget);
      const isManual = edge.provenance === "manual";
      const stroke = isManual
        ? "#1677ff"
        : linkScopeStrokeColor(linkScope, edge.activation_state);
      const isSuggested = edge.activation_state === "suggested" && !isManual;
      const displayLabel = buildEdgeDisplayLabel(edge, linkScope, sourceTarget, targetTarget);

      const manualHandles = isManual ? parseManualEdgeHandles(edge.note) : {};
      return {
        id: edge.id,
        source: edge.source_target_id ?? "",
        target: targetId,
        sourceHandle: manualHandles.sourceHandle ?? DEFAULT_EDGE_SOURCE_HANDLE,
        targetHandle: manualHandles.targetHandle ?? DEFAULT_EDGE_TARGET_HANDLE,
        type: "smoothstep",
        animated: isSuggested,
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        style: {
          stroke,
          strokeWidth: edge.activation_state === "active" ? 2 : 1.5,
          strokeDasharray:
            isSuggested || edge.activation_state === "ignored" ? "6 4" : undefined,
        },
        deletable:
          edge.provenance === "manual" ||
          edge.activation_state === "stale",
        data: {
          edgeId: edge.id,
          edgeType: edge.edge_type,
          provenance: edge.provenance,
          activationState: edge.activation_state,
          linkScope,
          label: displayLabel,
          deletable:
            edge.provenance === "manual" ||
            edge.activation_state === "stale",
        },
      };
    })
    .filter((e) => e.source && e.target);

  return { nodes, edges: flowEdges };
}

export function applyDagreLayout(
  nodes: Node<DependencyNodeData>[],
  edges: Edge<DependencyEdgeData>[],
  direction: "LR" | "TB" = "LR",
  savedPositions?: Map<string, { x: number; y: number }>,
): Node<DependencyNodeData>[] {
  if (nodes.length === 0) return nodes;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, ranksep: 70, nodesep: 40, marginx: 24, marginy: 24 });

  for (const node of nodes) {
    g.setNode(node.id, { width: DEP_NODE_WIDTH, height: DEP_NODE_HEIGHT });
  }
  for (const edge of edges) {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  const laidOut = nodes.map((node) => {
    const saved = savedPositions?.get(node.id);
    if (saved) {
      return { ...node, position: saved };
    }
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - DEP_NODE_WIDTH / 2,
        y: pos.y - DEP_NODE_HEIGHT / 2,
      },
    };
  });

  const allNodesHaveSaved =
    savedPositions &&
    savedPositions.size > 0 &&
    nodes.every((node) => savedPositions.has(node.id));
  if (allNodesHaveSaved) {
    return laidOut;
  }

  return applyCategoryBandLayout(laidOut, direction);
}

export function applyCategoryBandLayout(
  nodes: Node<DependencyNodeData>[],
  direction: "LR" | "TB" = "LR",
): Node<DependencyNodeData>[] {
  const bandSpacing = DEP_NODE_WIDTH + 88;
  const nodeSpacing = DEP_NODE_HEIGHT + 36;
  const byBand = new Map<number, Node<DependencyNodeData>[]>();

  for (const node of nodes) {
    const band = CATEGORY_BAND[node.data.category] ?? 2;
    if (!byBand.has(band)) byBand.set(band, []);
    byBand.get(band)!.push(node);
  }

  const sortedBands = [...byBand.entries()].sort((a, b) => a[0] - b[0]);
  const result: Node<DependencyNodeData>[] = [];

  for (const [band, bandNodes] of sortedBands) {
    if (direction === "LR") {
      bandNodes.sort((a, b) => a.position.y - b.position.y);
      bandNodes.forEach((node, index) => {
        result.push({
          ...node,
          position: {
            x: band * bandSpacing,
            y: index * nodeSpacing,
          },
        });
      });
    } else {
      bandNodes.sort((a, b) => a.position.x - b.position.x);
      bandNodes.forEach((node, index) => {
        result.push({
          ...node,
          position: {
            x: index * (DEP_NODE_WIDTH + 52),
            y: band * (DEP_NODE_HEIGHT + 56),
          },
        });
      });
    }
  }

  return result;
}