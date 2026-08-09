import {
  ProForm,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { DatabaseOutlined, PlusOutlined } from "@ant-design/icons";
import { App, Button, Popconfirm, Space, Tag } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useSyncBusinessMetrics } from "../../api/business-metrics-dashboard";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";
import { formatDateTime } from "../../utils/datetime";

type DataSourceRow = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  last_test_at: string | null;
  server_ip: string | null;
  server_name: string | null;
};

export function BusinessDataSourcesPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [sourceFormOpen, setSourceFormOpen] = useState(false);
  const syncMutation = useSyncBusinessMetrics();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["business-data-sources"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard-layout"] });
  };

  const createSourceMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/monitoring/business-metrics/data-sources", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      message.success(t("monitoring.businessMetrics.saved"));
      setSourceFormOpen(false);
      refresh();
    },
    onError: (err: unknown) => {
      const reason = err instanceof Error ? err.message : t("common.error");
      message.error(reason);
    },
  });

  const deleteSourceMutation = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/business-metrics/data-sources/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      message.success(t("monitoring.businessMetrics.deleted"));
      refresh();
    },
    onError: (err: unknown) => {
      const reason = err instanceof Error ? err.message : t("common.error");
      message.error(reason);
    },
  });

  const testSourceMutation = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; message: string; tested_at: string }>(
        `/api/monitoring/business-metrics/data-sources/${id}/test`,
        { method: "POST" },
      ),
    onSuccess: (data) => {
      if (data.ok) {
        message.success(t("monitoring.businessMetrics.testOk"));
      } else {
        message.warning(data.message);
      }
      refresh();
    },
    onError: (err: unknown) => {
      const reason = err instanceof Error ? err.message : t("common.error");
      message.error(reason);
    },
  });

  const sourceColumns = useMemo<ProColumns<DataSourceRow>[]>(
    () => [
      { title: t("monitoring.businessMetrics.columns.name"), dataIndex: "name", ellipsis: true },
      {
        title: t("monitoring.businessMetrics.columns.serverIp"),
        dataIndex: "server_ip",
        width: 140,
        search: false,
        render: (_, row) => row.server_ip ?? "—",
      },
      {
        title: t("monitoring.businessMetrics.columns.serverName"),
        dataIndex: "server_name",
        width: 160,
        ellipsis: true,
        search: false,
        render: (_, row) => row.server_name ?? "—",
      },
      {
        title: t("monitoring.businessMetrics.columns.type"),
        dataIndex: "type",
        width: 120,
        valueType: "select",
        valueEnum: {
          prometheus: { text: "Prometheus" },
          otlp: { text: "OpenTelemetry" },
          http_json: { text: "HTTP JSON" },
          sql: { text: "SQL" },
          log_source: { text: "Log" },
          webhook: { text: "Webhook" },
        },
      },
      {
        title: t("monitoring.businessMetrics.columns.enabled"),
        dataIndex: "enabled",
        width: 90,
        search: false,
        render: (_, row) =>
          row.enabled ? (
            <Tag color="green">{t("common.yes")}</Tag>
          ) : (
            <Tag>{t("common.no")}</Tag>
          ),
      },
      {
        title: t("monitoring.businessMetrics.columns.lastTest"),
        dataIndex: "last_test_at",
        width: 180,
        search: false,
        render: (_, row) =>
          row.last_test_at ? formatDateTime(row.last_test_at) : "—",
      },
      {
        title: t("common.actions"),
        width: 260,
        fixed: "right",
        search: false,
        render: (_, row) => (
          <Space size={4} wrap>
            <Button size="small" onClick={() => testSourceMutation.mutate(row.id)}>
              {t("monitoring.businessMetrics.actions.test")}
            </Button>
            <Button
              size="small"
              type="primary"
              loading={syncMutation.isPending && syncMutation.variables === row.id}
              onClick={async () => {
                try {
                  const res = await syncMutation.mutateAsync(row.id);
                  message.success(
                    t("monitoring.dashboard.syncDone", res as unknown as Record<string, number>),
                  );
                } catch (err) {
                  const reason = err instanceof Error ? err.message : t("common.error");
                  message.error(t("monitoring.dashboard.syncFailed", { reason }));
                }
              }}
            >
              {t("monitoring.businessMetrics.actions.sync")}
            </Button>
            <Popconfirm
              title={t("common.deleteConfirm")}
              onConfirm={() => deleteSourceMutation.mutate(row.id)}
            >
              <Button
                size="small"
                danger
                loading={deleteSourceMutation.isPending && deleteSourceMutation.variables === row.id}
              >
                {t("common.delete")}
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [t, testSourceMutation, syncMutation, deleteSourceMutation],
  );

  return (
    <ModulePageShell
      icon={<DatabaseOutlined style={{ fontSize: 20 }} />}
      title={t("menu.businessDataSources")}
      subtitle={t("monitoring.businessMetrics.dataSourcesSubtitle")}
      action={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setSourceFormOpen(true)}>
          {t("monitoring.businessMetrics.addSource")}
        </Button>
      }
    >
      <ModuleTableCard>
        <ProTable<DataSourceRow>
          {...moduleProTableProps}
          rowKey="id"
          columns={sourceColumns}
          request={async () => {
            const result = await api<{ items: DataSourceRow[]; total: number }>(
              "/api/monitoring/business-metrics/data-sources",
            );
            return { data: result.items, total: result.total, success: true };
          }}
          search={moduleTableSearch()}
          pagination={moduleTablePagination}
          locale={{ emptyText: t("monitoring.businessMetrics.dataSourcesEmpty") }}
        />
      </ModuleTableCard>

      <ModuleFormDrawer
        title={t("monitoring.businessMetrics.addSource")}
        open={sourceFormOpen}
        width={480}
        onClose={() => setSourceFormOpen(false)}
      >
        <ProForm
          initialValues={{ type: "prometheus", enabled: true }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
          onFinish={async (values) => {
            await createSourceMutation.mutateAsync({
              ...values,
              config_json: values.config_json ? JSON.parse(String(values.config_json)) : {},
            });
            return true;
          }}
        >
          <ProFormText name="name" label={t("monitoring.businessMetrics.form.name")} rules={[{ required: true }]} />
          <ProFormSelect
            name="type"
            label={t("monitoring.businessMetrics.form.type")}
            options={[
              { label: "Prometheus", value: "prometheus" },
              { label: "OpenTelemetry", value: "otlp" },
              { label: "HTTP JSON", value: "http_json" },
              { label: "SQL", value: "sql" },
              { label: "Log source", value: "log_source" },
              { label: "Webhook", value: "webhook" },
            ]}
          />
          <ProFormText
            name="config_json"
            label={t("monitoring.businessMetrics.form.config")}
            placeholder='{"url":"http://localhost:9090"}'
          />
          <ProFormSwitch name="enabled" label={t("monitoring.businessMetrics.form.enabled")} />
        </ProForm>
      </ModuleFormDrawer>
    </ModulePageShell>
  );
}

export default BusinessDataSourcesPage;