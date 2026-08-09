import { ProTable } from "@ant-design/pro-components";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { UnorderedListOutlined } from "@ant-design/icons";
import { App, Button, Space, Tag, Typography } from "antd";
import { useMemo, useRef, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api, proTableRequest } from "../../api/client";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";
import { canOncallIntervene, canWrite } from "../../services/auth/roles";
import { formatDateTime } from "../../utils/datetime";

type QueueItem = {
  id: string;
  problem_event_id: string;
  server_id: string | null;
  failure_reason: string;
  suggested_next_step: string;
  exit_status: "new" | "in_progress" | "closed";
  source: string;
  l2_approval_id: string | null;
  created_at: string;
  updated_at: string;
};

function exitStatusTag(status: QueueItem["exit_status"], t: (k: string) => string) {
  const color =
    status === "new" ? "red" : status === "in_progress" ? "processing" : "default";
  return <Tag color={color}>{t(`oncall.remediationQueue.status.${status}`)}</Tag>;
}

export function RemediationQueuePage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const actionRef = useRef<ActionType>(null);
  const writable = canWrite();
  const canIntervene = canOncallIntervene();

  const statusMutation = useMutation({
    mutationFn: async (input: { id: string; exit_status: QueueItem["exit_status"] }) =>
      api<QueueItem>(`/api/oncall/remediation-queue/${input.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ exit_status: input.exit_status }),
      }),
    onSuccess: () => {
      message.success(t("oncall.remediationQueue.actions.statusUpdated"));
      void actionRef.current?.reload();
    },
  });

  const interveneMutation = useMutation({
    mutationFn: async (id: string) =>
      api<{ session_id: string }>(`/api/oncall/remediation-queue/${id}/intervene`, {
        method: "POST",
      }),
    onSuccess: () => {
      message.success(t("oncall.remediationQueue.actions.sessionStarted"));
      void actionRef.current?.reload();
    },
  });

  const columns: ProColumns<QueueItem>[] = useMemo(
    () => [
      {
        title: t("oncall.remediationQueue.columns.status"),
        dataIndex: "exit_status",
        width: 110,
        valueType: "select",
        valueEnum: {
          new: { text: t("oncall.remediationQueue.status.new") },
          in_progress: { text: t("oncall.remediationQueue.status.in_progress") },
          closed: { text: t("oncall.remediationQueue.status.closed") },
        },
        render: (_, row) => exitStatusTag(row.exit_status, t),
      },
      {
        title: t("oncall.remediationQueue.columns.failureReason"),
        dataIndex: "failure_reason",
        ellipsis: true,
        search: false,
      },
      {
        title: t("oncall.remediationQueue.columns.nextStep"),
        dataIndex: "suggested_next_step",
        ellipsis: true,
        search: false,
      },
      {
        title: t("oncall.remediationQueue.columns.source"),
        dataIndex: "source",
        width: 160,
        search: false,
      },
      {
        title: t("oncall.remediationQueue.columns.problem"),
        dataIndex: "problem_event_id",
        width: 120,
        search: false,
        render: (_, row) => (
          <Link to={`/problems?event_id=${row.problem_event_id}`}>
            {row.problem_event_id.slice(0, 8)}
          </Link>
        ),
      },
      {
        title: t("oncall.remediationQueue.columns.updatedAt"),
        dataIndex: "updated_at",
        width: 170,
        search: false,
        render: (_, row) => formatDateTime(row.updated_at),
      },
      {
        title: t("oncall.remediationQueue.columns.actions"),
        valueType: "option",
        width: 220,
        search: false,
        render: (_, row) => {
          const actions: ReactNode[] = [];

          if (writable && row.exit_status === "new") {
            actions.push(
              <Button
                key="start"
                type="link"
                size="small"
                loading={statusMutation.isPending}
                onClick={() =>
                  statusMutation.mutate({ id: row.id, exit_status: "in_progress" })
                }
              >
                {t("oncall.remediationQueue.actions.startIntervention")}
              </Button>,
              <Button
                key="accept"
                type="link"
                size="small"
                loading={statusMutation.isPending}
                onClick={() => statusMutation.mutate({ id: row.id, exit_status: "closed" })}
              >
                {t("oncall.remediationQueue.actions.acceptRisk")}
              </Button>,
            );
          }

          if (writable && row.exit_status === "in_progress") {
            actions.push(
              <Button
                key="resolve"
                type="link"
                size="small"
                loading={statusMutation.isPending}
                onClick={() => statusMutation.mutate({ id: row.id, exit_status: "closed" })}
              >
                {t("oncall.remediationQueue.actions.markResolved")}
              </Button>,
            );
          }

          if (canIntervene && row.exit_status !== "closed") {
            actions.push(
              <Button
                key="intervene"
                type="link"
                size="small"
                loading={interveneMutation.isPending}
                onClick={() => interveneMutation.mutate(row.id)}
              >
                {t("oncall.remediationQueue.actions.sshIntervene")}
              </Button>,
            );
          }

          return actions.length > 0 ? <Space size={0} wrap>{actions}</Space> : "—";
        },
      },
    ],
    [canIntervene, interveneMutation, statusMutation, t, writable],
  );

  return (
    <ModulePageShell
      icon={<UnorderedListOutlined style={{ fontSize: 20 }} />}
      title={t("oncall.remediationQueue.title")}
      subtitle={t("oncall.remediationQueue.subtitle")}
    >
      <ModuleTableCard>
        <ProTable<QueueItem>
          {...moduleProTableProps}
          actionRef={actionRef}
          rowKey="id"
          bordered
          tableLayout="fixed"
          search={moduleTableSearch()}
          pagination={moduleTablePagination}
          options={false}
          cardProps={false}
          ghost
          scroll={{ x: 1200 }}
          columns={columns}
          request={async (params, sort, filter) =>
            proTableRequest<QueueItem>("/api/oncall/remediation-queue", params, sort, filter)
          }
          locale={{ emptyText: t("oncall.remediationQueue.empty") }}
        />
      </ModuleTableCard>
      <Typography.Text type="secondary" style={{ display: "block", marginTop: 8 }}>
        {t("oncall.remediationQueue.hint")}
      </Typography.Text>
    </ModulePageShell>
  );
}