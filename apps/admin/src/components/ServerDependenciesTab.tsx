import { App, Button, Card, Descriptions, Space, Table, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlusOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import type { MonitorTarget, TopologyEdge } from "../utils/discovery-types";
import { isGraphEligibleTarget, serializeManualEdgeNote } from "../utils/dependency-graph";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { ManualEdgeForm } from "./ManualEdgeForm";
import { ServerDependencyGraph } from "./ServerDependencyGraph";

type ServerDependenciesTabProps = {
  serverId: string;
  active?: boolean;
};

function isManualEdge(edge: TopologyEdge): boolean {
  return (
    edge.provenance === "manual" &&
    (edge.edge_type === "dependency" || edge.edge_type === "data_flow") &&
    edge.activation_state !== "ignored"
  );
}

export function ServerDependenciesTab({ serverId, active = true }: ServerDependenciesTabProps) {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const purgedRef = useRef(false);

  const { data: edgesData, isLoading } = useQuery({
    queryKey: ["server-edges", serverId],
    queryFn: () =>
      api<{ items: TopologyEdge[] }>(
        `/api/servers/${serverId}/edges?include_pending=true`,
      ),
    enabled: active,
  });

  const { data: localTargets } = useQuery({
    queryKey: ["server-targets", serverId],
    queryFn: () =>
      api<{ items: MonitorTarget[] }>(`/api/servers/${serverId}/targets`),
    enabled: active,
  });

  const edges = edgesData?.items ?? [];
  const manualEdges = useMemo(() => edges.filter(isManualEdge), [edges]);

  const edgeTargetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of manualEdges) {
      if (edge.source_target_id) ids.add(edge.source_target_id);
      if (edge.target_target_id) ids.add(edge.target_target_id);
    }
    return [...ids].sort();
  }, [manualEdges]);

  const { data: labelData } = useQuery({
    queryKey: ["target-labels", edgeTargetIds.join(",")],
    queryFn: () =>
      api<{ labels: Record<string, string> }>(
        `/api/servers/targets/labels?ids=${encodeURIComponent(edgeTargetIds.join(","))}`,
      ),
    enabled: active && edgeTargetIds.length > 0,
    staleTime: 60_000,
  });

  const allTargets = useMemo(
    () => new Map(Object.entries(labelData?.labels ?? {})),
    [labelData?.labels],
  );
  const selectedEdge = manualEdges.find((e) => e.id === selectedEdgeId) ?? null;

  const targetName = useMemo(() => {
    return (id: string | null) =>
      id ? allTargets?.get(id) ?? id.slice(0, 8) : "—";
  }, [allTargets]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["server-edges", serverId] });
    void queryClient.invalidateQueries({ queryKey: ["server-targets", serverId] });
  };

  const purgeDiscoveredMutation = useMutation({
    mutationFn: () =>
      api<{ deleted: number }>(`/api/servers/${serverId}/edges/purge-discovered`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      if (result.deleted > 0) invalidate();
    },
  });

  useEffect(() => {
    purgedRef.current = false;
  }, [serverId]);

  useEffect(() => {
    if (!active || purgedRef.current || !edgesData) return;
    const hasDiscovered = edges.some((e) => e.provenance !== "manual");
    if (!hasDiscovered) return;
    purgedRef.current = true;
    void purgeDiscoveredMutation.mutateAsync().catch(() => {
      purgedRef.current = false;
    });
  }, [active, edges, edgesData, purgeDiscoveredMutation.mutateAsync]);

  const deleteMutation = useMutation({
    mutationFn: (edgeId: string) =>
      api(`/api/servers/${serverId}/edges/${edgeId}`, { method: "DELETE" }),
    onSuccess: () => {
      setSelectedEdgeId(null);
      invalidate();
    },
  });

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/servers/${serverId}/edges`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
  });

  return (
    <>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setFormOpen(true)}>
          {t("servers.discovery.addDependency")}
        </Button>
      </Space>

      <Typography.Text type="secondary" style={{ display: "block", marginBottom: 12, fontSize: 12 }}>
        {t("servers.dependencies.graphHint")}
      </Typography.Text>

      <ServerDependencyGraph
        edges={manualEdges}
        localTargets={(localTargets?.items ?? []).filter(isGraphEligibleTarget)}
        targetLabels={allTargets ?? new Map()}
        selectedEdgeId={selectedEdgeId}
        onEdgeSelect={setSelectedEdgeId}
        onConnectNodes={async (sourceTargetId, targetTargetId, sourceHandle, targetHandle) => {
          const duplicate = manualEdges.some(
            (e) =>
              e.source_target_id === sourceTargetId &&
              e.target_target_id === targetTargetId,
          );
          if (duplicate) {
            message.warning(t("servers.dependencies.edgeDuplicate"));
            return;
          }
          await createMutation.mutateAsync({
            source_target_id: sourceTargetId,
            target_target_id: targetTargetId,
            edge_type: "dependency",
            note: serializeManualEdgeNote({
              sourceHandle: sourceHandle ?? undefined,
              targetHandle: targetHandle ?? undefined,
            }),
          });
          message.success(t("servers.dependencies.edgeSaved"));
        }}
        onDeleteEdge={(edgeId) =>
          new Promise<void>((resolve, reject) => {
            modal.confirm({
              title: t("servers.dependencies.deleteConfirm"),
              okType: "danger",
              onOk: async () => {
                await deleteMutation.mutateAsync(edgeId);
                message.success(t("servers.dependencies.edgeDeleted"));
                resolve();
              },
              onCancel: () => reject(new Error("cancelled")),
            });
          })
        }
      />

      {selectedEdge ? (
        <Card size="small" style={{ marginBottom: 16 }} title={t("servers.dependencies.selectedEdge")}>
          <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label={t("servers.discovery.sourceTarget")}>
              {targetName(selectedEdge.source_target_id)}
            </Descriptions.Item>
            <Descriptions.Item label={t("servers.discovery.targetTarget")}>
              {targetName(selectedEdge.target_target_id)}
            </Descriptions.Item>
            <Descriptions.Item label={t("servers.discovery.edgeType")}>
              {selectedEdge.edge_type}
            </Descriptions.Item>
            <Descriptions.Item label={t("servers.dependencies.portLabel")}>
              {selectedEdge.label ?? "—"}
            </Descriptions.Item>
          </Descriptions>
          <Space style={{ marginTop: 12 }}>
            <ConfirmDeleteButton
              type="default"
              title={t("servers.dependencies.deleteConfirm")}
              onConfirm={() => deleteMutation.mutate(selectedEdge.id)}
            />
          </Space>
        </Card>
      ) : null}

      <Card size="small" title={t("servers.dependencies.tableTitle")}>
        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={manualEdges}
          pagination={false}
          locale={{ emptyText: t("servers.dependencies.noEdges") }}
          rowClassName={(row) => (row.id === selectedEdgeId ? "dependency-row-selected" : "")}
          onRow={(row) => ({
            onClick: () => setSelectedEdgeId(row.id),
            style: { cursor: "pointer" },
          })}
          columns={[
            {
              title: t("servers.discovery.sourceTarget"),
              dataIndex: "source_target_id",
              render: (v: string | null) => targetName(v),
            },
            {
              title: t("servers.discovery.targetTarget"),
              dataIndex: "target_target_id",
              render: (v: string | null) => targetName(v),
            },
            { title: t("servers.discovery.edgeType"), dataIndex: "edge_type" },
            {
              title: t("servers.dependencies.portLabel"),
              dataIndex: "label",
              render: (v: string | null) => v ?? "—",
            },
            {
              title: t("common.actions"),
              render: (_: unknown, row: TopologyEdge) => (
                <Space onClick={(e) => e.stopPropagation()}>
                  <ConfirmDeleteButton
                    type="default"
                    title={t("servers.dependencies.deleteConfirm")}
                    onConfirm={() => deleteMutation.mutate(row.id)}
                  />
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <style>{`
        .dependency-row-selected td {
          background: rgba(22, 119, 255, 0.08) !important;
        }
      `}</style>

      <ManualEdgeForm
        open={formOpen}
        serverId={serverId}
        onClose={() => setFormOpen(false)}
        onSubmit={async (values) => {
          await createMutation.mutateAsync(values);
        }}
      />
    </>
  );
}