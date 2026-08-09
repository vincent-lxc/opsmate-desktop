import {
  ProForm,
  ProFormDigit,
  ProFormSwitch,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { DatabaseOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { App, Button, Space, Tag } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";

type RetentionPolicyRow = {
  id: string;
  resource_kind: string;
  retention_days: number;
  enabled: boolean;
  created_at: string;
};

type CleanupResult = {
  incident_reports: number;
  operation_audit_logs: number;
  patrol_records: number;
};

export function RetentionPoliciesPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RetentionPolicyRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["retention-policies"],
    queryFn: () => api<{ items: RetentionPolicyRow[] }>("/api/incident-reports/retention-policies"),
  });

  const saveMutation = useMutation({
    mutationFn: async (values: { retention_days: number; enabled: boolean }) => {
      if (!editing) return;
      return api(`/api/incident-reports/retention-policies/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify(values),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["retention-policies"] });
      message.success(t("security.retention.saved"));
      setEditing(null);
    },
    onError: () => message.error(t("common.error")),
  });

  const cleanupMutation = useMutation({
    mutationFn: () =>
      api<CleanupResult>("/api/incident-reports/retention-policies/run-cleanup", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (result) => {
      message.success(
        t("security.retention.cleanupDone", {
          reports: result.incident_reports,
          audit: result.operation_audit_logs,
          patrol: result.patrol_records,
        }),
      );
    },
    onError: () => message.error(t("common.error")),
  });

  const columns = useMemo<ProColumns<RetentionPolicyRow>[]>(
    () => [
      {
        title: t("security.retention.columns.resource"),
        dataIndex: "resource_kind",
        render: (_, row) =>
          t(`security.retention.resources.${row.resource_kind}`, {
            defaultValue: row.resource_kind,
          }),
      },
      {
        title: t("security.retention.columns.days"),
        dataIndex: "retention_days",
        width: 140,
        search: false,
      },
      {
        title: t("security.retention.columns.enabled"),
        dataIndex: "enabled",
        width: 100,
        search: false,
        render: (_, row) => (
          <Tag color={row.enabled ? "success" : "default"}>
            {row.enabled ? t("common.yes") : t("common.no")}
          </Tag>
        ),
      },
      {
        title: t("common.actions"),
        width: 100,
        fixed: "right",
        search: false,
        valueType: "option",
        render: (_, row) => (
          <Button type="link" size="small" onClick={() => setEditing(row)}>
            {t("common.edit")}
          </Button>
        ),
      },
    ],
    [t],
  );

  return (
    <ModulePageShell
      icon={<DatabaseOutlined style={{ fontSize: 20 }} />}
      title={t("security.retention.title")}
      subtitle={t("security.retention.subtitle")}
      action={
        <Button
          icon={<PlayCircleOutlined />}
          loading={cleanupMutation.isPending}
          onClick={() => cleanupMutation.mutate()}
        >
          {t("security.retention.runCleanup")}
        </Button>
      }
    >
      <ModuleTableCard>
        <ProTable<RetentionPolicyRow>
          {...moduleProTableProps}
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={data?.items ?? []}
          search={moduleTableSearch()}
          pagination={moduleTablePagination}
          locale={{ emptyText: t("security.retention.empty") }}
        />
      </ModuleTableCard>

      <ModuleFormDrawer
        title={t("security.retention.edit")}
        open={!!editing}
        onClose={() => setEditing(null)}
        width={420}
      >
        {editing ? (
          <ProForm
            key={editing.id}
            initialValues={{
              retention_days: editing.retention_days,
              enabled: editing.enabled,
            }}
            onFinish={async (values) => {
              await saveMutation.mutateAsync({
                retention_days: Number(values.retention_days),
                enabled: Boolean(values.enabled),
              });
              return true;
            }}
            submitter={{ searchConfig: { submitText: t("common.save") } }}
          >
            <ProFormDigit
              name="retention_days"
              label={t("security.retention.columns.days")}
              min={1}
              max={3650}
              rules={[{ required: true }]}
            />
            <ProFormSwitch name="enabled" label={t("security.retention.columns.enabled")} />
          </ProForm>
        ) : null}
      </ModuleFormDrawer>
    </ModulePageShell>
  );
}