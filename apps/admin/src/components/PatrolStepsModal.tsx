import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { Modal } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { moduleNestedTableProps } from "./module-table-styles";
import type { PatrolStepRun } from "../utils/monitoring-types";
import {
  monitorOwnerKindLabel,
  monitorOwnerNameLabel,
} from "../utils/monitor-owner-display";
import { stepStatusTag } from "../utils/patrol-display";

export type PatrolStepsModalFilter = "all" | "anomaly";

type PatrolStepsModalProps = {
  open: boolean;
  roundId: string | null;
  serverId: string | null;
  serverName?: string;
  filter: PatrolStepsModalFilter;
  onClose: () => void;
};

function isAnomalyStep(status: string): boolean {
  return status === "fail" || status === "error";
}

export function PatrolStepsModal({
  open,
  roundId,
  serverId,
  serverName,
  filter,
  onClose,
}: PatrolStepsModalProps) {
  const { t } = useTranslation();

  const { data, isLoading } = useQuery({
    queryKey: ["patrol-round-steps-modal", roundId, serverId],
    queryFn: () =>
      api<{ items: PatrolStepRun[] }>(
        `/api/monitoring/patrol-rounds/${roundId}/steps?server_id=${serverId}`,
      ),
    enabled: open && Boolean(roundId && serverId),
  });

  const items = useMemo(() => {
    const all = data?.items ?? [];
    if (filter === "anomaly") return all.filter((row) => isAnomalyStep(row.status));
    return all;
  }, [data?.items, filter]);

  const columns: ProColumns<PatrolStepRun>[] = useMemo(
    () => [
      {
        title: t("monitoring.patrolRecords.stepColumns.ownerName"),
        dataIndex: "monitor_owner_name",
        width: 140,
        ellipsis: true,
        render: (_, row) => (
          <span title={monitorOwnerNameLabel(row.monitor_owner_name, t)}>
            {monitorOwnerNameLabel(row.monitor_owner_name, t)}
          </span>
        ),
      },
      {
        title: t("monitoring.patrolRecords.stepColumns.ownerKind"),
        dataIndex: "monitor_owner_kind",
        width: 72,
        render: (_, row) => monitorOwnerKindLabel(row.monitor_owner_kind, t),
      },
      {
        title: t("monitoring.patrolRecords.stepColumns.binding"),
        dataIndex: "binding_title",
        width: 180,
        ellipsis: true,
      },
      {
        title: t("monitoring.patrolRecords.stepColumns.status"),
        dataIndex: "status",
        width: 100,
        render: (_, row) => stepStatusTag(row.status),
      },
      {
        title: t("monitoring.patrolRecords.stepColumns.excerpt"),
        dataIndex: "raw_excerpt",
        ellipsis: true,
        render: (_, row) => row.skip_reason ?? row.raw_excerpt ?? row.error ?? "—",
      },
    ],
    [t],
  );

  const title =
    filter === "anomaly"
      ? t("monitoring.patrolRecords.stepsModal.anomalyTitle", { server: serverName ?? "" })
      : t("monitoring.patrolRecords.stepsModal.allTitle", { server: serverName ?? "" });

  return (
    <Modal title={title} open={open} onCancel={onClose} footer={null} width={920} destroyOnClose>
      <ProTable<PatrolStepRun>
        {...moduleNestedTableProps}
        rowKey="id"
        loading={isLoading}
        dataSource={items}
        columns={columns}
        locale={{ emptyText: t("monitoring.patrolRecords.stepsEmpty") }}
        pagination={{ pageSize: 10, showSizeChanger: false }}
      />
    </Modal>
  );
}
