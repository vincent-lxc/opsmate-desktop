import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Connection,
  type OnConnect,
  type Edge,
  type Node,
  type OnEdgesChange,
  type OnNodesChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Alert, Button, Card, Empty, Segmented, Space, theme } from "antd";
import {
  ApartmentOutlined,
  ColumnHeightOutlined,
  ColumnWidthOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DependencyGraphNode } from "./DependencyGraphNode";
import type { MonitorTarget, TopologyEdge } from "../utils/discovery-types";
import {
  applyDagreLayout,
  buildDependencyGraph,
  isConnectableGraphNodeId,
  type DependencyEdgeData,
  type DependencyNodeData,
} from "../utils/dependency-graph";

const nodeTypes = { dependencyNode: DependencyGraphNode };

type ServerDependencyGraphProps = {
  edges: TopologyEdge[];
  localTargets: MonitorTarget[];
  targetLabels: Map<string, string>;
  selectedEdgeId?: string | null;
  onEdgeSelect: (edgeId: string | null) => void;
  onConnectNodes: (
    sourceTargetId: string,
    targetTargetId: string,
    sourceHandle: string | null,
    targetHandle: string | null,
  ) => Promise<void>;
  onDeleteEdge: (edgeId: string) => Promise<void>;
};

function rememberNodePositions(
  nodes: Node[],
  savedPositions: Map<string, { x: number; y: number }>,
) {
  for (const node of nodes) {
    savedPositions.set(node.id, { ...node.position });
  }
}

function mergeGraphNodes(
  graphNodes: Node<DependencyNodeData>[],
  prevNodes: Node[],
  savedPositions: Map<string, { x: number; y: number }>,
): Node[] {
  const prevById = new Map(prevNodes.map((node) => [node.id, node]));
  return graphNodes.map((graphNode) => {
    const saved = savedPositions.get(graphNode.id);
    const prev = prevById.get(graphNode.id);
    const position = saved ?? prev?.position ?? graphNode.position;
    savedPositions.set(graphNode.id, { ...position });
    return { ...graphNode, position };
  });
}

export function ServerDependencyGraph({
  edges,
  localTargets,
  targetLabels,
  selectedEdgeId,
  onEdgeSelect,
  onConnectNodes,
  onDeleteEdge,
}: ServerDependencyGraphProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const savedPositions = useRef(new Map<string, { x: number; y: number }>());
  const localTargetIds = useRef(new Set<string>());
  const fitViewDone = useRef(false);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const [layoutDir, setLayoutDir] = useState<"LR" | "TB">("LR");
  const [nodes, setNodes] = useState<Node[]>([]);
  const [flowEdges, setFlowEdges] = useState<Edge[]>([]);
  const [connecting, setConnecting] = useState(false);

  const targetSignature = useMemo(
    () => localTargets.map((target) => target.id).sort().join("|"),
    [localTargets],
  );

  const graph = useMemo(
    () => buildDependencyGraph(edges, localTargets, targetLabels),
    [edges, localTargets, targetLabels],
  );

  const graphNodeKey = useMemo(
    () =>
      graph.nodes
        .map(
          (node) =>
            `${node.id}:${node.data.label}:${node.data.category}:${(node.data.portNumbers ?? []).join(",")}`,
        )
        .sort()
        .join("|"),
    [graph.nodes],
  );

  useEffect(() => {
    localTargetIds.current = new Set(localTargets.map((t) => t.id));
  }, [localTargets]);

  useEffect(() => {
    setNodes((prev) => {
      if (graph.nodes.length === 0) return [];

      const prevIds = new Set(prev.map((node) => node.id));
      const graphIds = new Set(graph.nodes.map((node) => node.id));
      const structureChanged =
        prev.length !== graph.nodes.length ||
        graph.nodes.some((node) => !prevIds.has(node.id)) ||
        prev.some((node) => !graphIds.has(node.id));

      if (prev.length === 0 || structureChanged) {
        const laid = applyDagreLayout(
          graph.nodes,
          graph.edges,
          layoutDir,
          savedPositions.current,
        );
        rememberNodePositions(laid, savedPositions.current);
        return laid;
      }

      return mergeGraphNodes(graph.nodes, prev, savedPositions.current);
    });
  }, [graph, graphNodeKey, layoutDir, targetSignature]);

  useEffect(() => {
    setFlowEdges(
      graph.edges.map((edge) => ({
        ...edge,
        selected: edge.id === selectedEdgeId,
      })),
    );
  }, [graph.edges, selectedEdgeId]);

  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      const removable = changes.filter((change) => {
        if (change.type !== "remove") return true;
        const edge = flowEdges.find((e) => e.id === change.id);
        return Boolean(edge?.deletable);
      });

      for (const change of changes) {
        if (change.type !== "remove") continue;
        const edge = flowEdges.find((e) => e.id === change.id);
        const data = edge?.data as DependencyEdgeData | undefined;
        if (data?.edgeId && edge?.deletable) {
          void onDeleteEdge(data.edgeId).catch(() => {
            setFlowEdges(
              graph.edges.map((e) => ({ ...e, selected: e.id === selectedEdgeId })),
            );
          });
        }
      }

      setFlowEdges((eds) => applyEdgeChanges(removable, eds));
    },
    [flowEdges, graph.edges, onDeleteEdge, selectedEdgeId],
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const source = connection.source ?? "";
      const target = connection.target ?? "";
      if (source === target) return;
      if (!isConnectableGraphNodeId(source) || !isConnectableGraphNodeId(target)) return;
      if (!localTargetIds.current.has(source) || !localTargetIds.current.has(target)) return;

      const duplicate = edges.some(
        (e) =>
          e.source_target_id === source &&
          e.target_target_id === target &&
          (e.edge_type === "dependency" || e.edge_type === "data_flow") &&
          e.activation_state !== "ignored",
      );
      if (duplicate) return;

      rememberNodePositions(nodes, savedPositions.current);

      const pendingId = `pending:${source}->${target}`;
      setFlowEdges((eds) => {
        if (eds.some((e) => e.id === pendingId)) return eds;
        return addEdge(
          {
            ...connection,
            id: pendingId,
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed, color: "#1677ff" },
            style: { stroke: "#1677ff", strokeWidth: 2 },
            data: { pending: true },
          },
          eds,
        );
      });

      setConnecting(true);
      void onConnectNodes(source, target, connection.sourceHandle, connection.targetHandle)
        .catch(() => {
          setFlowEdges((eds) => eds.filter((e) => e.id !== pendingId));
        })
        .finally(() => setConnecting(false));
    },
    [edges, nodes, onConnectNodes],
  );

  const handleNodeDragStop = useCallback((_: unknown, node: Node) => {
    savedPositions.current.set(node.id, { ...node.position });
  }, []);

  const resetLayout = useCallback(() => {
    savedPositions.current.clear();
    fitViewDone.current = false;
    const laid = applyDagreLayout(graph.nodes, graph.edges, layoutDir);
    rememberNodePositions(laid, savedPositions.current);
    setNodes(laid);
    requestAnimationFrame(() => {
      flowRef.current?.fitView({ padding: 0.2 });
      fitViewDone.current = true;
    });
  }, [graph.edges, graph.nodes, layoutDir]);

  const handleInit = useCallback((instance: ReactFlowInstance) => {
    flowRef.current = instance;
    if (!fitViewDone.current) {
      instance.fitView({ padding: 0.2 });
      fitViewDone.current = true;
    }
  }, []);

  if (localTargets.length === 0) {
    return (
      <Card size="small" style={{ marginBottom: 16 }}>
        <Empty description={t("servers.dependencies.noGraph")} />
      </Card>
    );
  }

  return (
    <Card
      size="small"
      title={
        <Space>
          <ApartmentOutlined />
          {t("servers.dependencies.graphTitle")}
        </Space>
      }
      extra={
        <Space wrap>
          <Segmented
            size="small"
            value={layoutDir}
            onChange={(v) => setLayoutDir(v as "LR" | "TB")}
            options={[
              {
                value: "LR",
                icon: <ColumnWidthOutlined />,
                label: t("servers.dependencies.layoutHorizontal"),
              },
              {
                value: "TB",
                icon: <ColumnHeightOutlined />,
                label: t("servers.dependencies.layoutVertical"),
              },
            ]}
          />
          <Button size="small" onClick={resetLayout}>
            {t("servers.dependencies.resetLayout")}
          </Button>
        </Space>
      }
      style={{ marginBottom: 16 }}
      styles={{ body: { padding: 0 } }}
    >
      <Alert
        type="info"
        showIcon
        message={t("servers.dependencies.dragConnectHint")}
        style={{ margin: 12, marginBottom: graph.edges.length === 0 ? 0 : 12 }}
      />
      {graph.edges.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          message={t("servers.dependencies.noEdges")}
          style={{ margin: 12, marginTop: 0, marginBottom: 0 }}
        />
      ) : null}

      <div
        style={{
          height: 420,
          background: token.colorFillAlter,
          opacity: connecting ? 0.85 : 1,
          transition: "opacity 0.15s ease",
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={flowEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={handleInit}
          nodeTypes={nodeTypes}
          connectionMode={ConnectionMode.Strict}
          nodesDraggable
          nodesConnectable
          elementsSelectable
          edgesReconnectable={false}
          deleteKeyCode={["Backspace", "Delete"]}
          onNodeDragStop={handleNodeDragStop}
          onEdgeClick={(_, edge) => onEdgeSelect(edge.id)}
          onPaneClick={() => onEdgeSelect(null)}
          onNodeClick={() => onEdgeSelect(null)}
          connectionLineStyle={{ stroke: token.colorPrimary, strokeWidth: 2 }}
        >
          <Background gap={16} size={1} color={token.colorBorderSecondary} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeStrokeWidth={2}
            pannable
            zoomable
            style={{ background: token.colorBgContainer }}
          />
        </ReactFlow>
      </div>
    </Card>
  );
}