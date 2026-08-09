import {
  ProForm,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { FilterOutlined, PlusOutlined } from "@ant-design/icons";
import { App, Alert, Button, Modal, Space, Table, Tabs, Tag, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import { canWrite } from "../../services/auth/roles";
import {
  moduleProTableProps,
  moduleTablePagination,
} from "../../components/module-table-styles";

type RuleType = "log_match" | "signature_suppress" | "duplicate_binding";

type AlertTuningRule = {
  id: string;
  rule_type: RuleType;
  signature: string | null;
  action: "watch" | "merge" | "suppress" | null;
  match_pattern: string | null;
  exclude_substring: string | null;
  server_id: string | null;
  binding_title: string | null;
  level_filter: string;
  enabled: boolean;
  expires_at: string | null;
  created_at: string;
};

function ttlTag(expiresAt: string | null, t: TFunction) {
  if (!expiresAt) return <Tag>{t("monitoring.alertTuning.ttl.none")}</Tag>;
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return <Tag color="default">{t("monitoring.alertTuning.ttl.expired")}</Tag>;
  const hours = Math.ceil(remaining / 3_600_000);
  const warn = remaining <= 24 * 3_600_000;
  return (
    <Tag color={warn ? "warning" : "blue"}>
      {t("monitoring.alertTuning.ttl.remaining", { hours })}
    </Tag>
  );
}

function RuleTable({
  ruleType,
  onAdd,
}: {
  ruleType: RuleType;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const writable = canWrite();

  const { data, isLoading } = useQuery({
    queryKey: ["alert-tuning", ruleType],
    queryFn: () =>
      api<{ items: AlertTuningRule[]; total: number }>(
        `/api/monitoring/alert-tuning?rule_type=${ruleType}`,
      ),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/alert-tuning/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      message.success(t("monitoring.alertTuning.deleted"));
      void queryClient.invalidateQueries({ queryKey: ["alert-tuning", ruleType] });
    },
    onError: () => message.error(t("common.error")),
  });

  const columns: ProColumns<AlertTuningRule>[] = useMemo(() => {
    const base: ProColumns<AlertTuningRule>[] = [
      {
        title: t("monitoring.alertTuning.columns.enabled"),
        dataIndex: "enabled",
        width: 80,
        render: (_, row) =>
          row.enabled ? (
            <Tag color="green">{t("common.yes")}</Tag>
          ) : (
            <Tag>{t("common.no")}</Tag>
          ),
      },
    ];

    if (ruleType === "log_match") {
      base.push(
        {
          title: t("monitoring.alertTuning.columns.pattern"),
          dataIndex: "match_pattern",
          ellipsis: true,
        },
        {
          title: t("monitoring.alertTuning.columns.levelFilter"),
          dataIndex: "level_filter",
          width: 120,
        },
      );
    }
    if (ruleType === "signature_suppress") {
      base.push(
        {
          title: t("monitoring.alertTuning.columns.signature"),
          dataIndex: "signature",
          ellipsis: true,
        },
        {
          title: t("monitoring.alertTuning.columns.action"),
          dataIndex: "action",
          width: 100,
        },
        {
          title: t("monitoring.alertTuning.columns.ttl"),
          dataIndex: "expires_at",
          width: 130,
          render: (_, row) => ttlTag(row.expires_at, t),
        },
      );
    }
    if (ruleType === "duplicate_binding") {
      base.push(
        {
          title: t("monitoring.alertTuning.columns.bindingTitle"),
          dataIndex: "binding_title",
          ellipsis: true,
        },
        {
          title: t("monitoring.alertTuning.columns.server"),
          dataIndex: "server_id",
          width: 120,
          render: (_, row) => row.server_id?.slice(0, 8) ?? "—",
        },
      );
    }

    base.push({
      title: t("common.actions"),
      valueType: "option",
      width: 100,
      render: (_, row) =>
        writable
          ? [
              <Button
                key="delete"
                type="link"
                danger
                size="small"
                onClick={() => {
                  modal.confirm({
                    title: t("monitoring.alertTuning.deleteConfirm"),
                    onOk: () => deleteMutation.mutateAsync(row.id),
                  });
                }}
              >
                {t("common.delete")}
              </Button>,
            ]
          : [],
    });

    return base;
  }, [deleteMutation, modal, ruleType, t, writable]);

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Button type="primary" icon={<PlusOutlined />} disabled={!writable} onClick={onAdd}>
        {t("monitoring.alertTuning.addRule")}
      </Button>
      <ProTable<AlertTuningRule>
        {...moduleProTableProps}
        rowKey="id"
        search={false}
        options={false}
        cardProps={false}
        ghost
        loading={isLoading}
        dataSource={data?.items ?? []}
        pagination={moduleTablePagination}
        scroll={{ x: 900 }}
        columns={columns}
        locale={{ emptyText: t("monitoring.alertTuning.empty") }}
      />
    </Space>
  );
}

type Recommendation = {
  signature: string;
  hit_count_7d: number;
  execution_failed_count: number;
  sample_event_id: string | null;
};

export function AlertTuningPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<RuleType>("log_match");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedSignatures, setSelectedSignatures] = useState<string[]>([]);
  const [dryRunPreview, setDryRunPreview] = useState<{
    items: Array<{ signature: string; would_watch_count: number }>;
    total_would_watch: number;
  } | null>(null);
  const [rollbackVisible, setRollbackVisible] = useState(false);

  const { data: recommendations } = useQuery({
    queryKey: ["alert-tuning-recommendations"],
    queryFn: () =>
      api<{ items: Recommendation[]; total: number }>("/api/monitoring/alert-tuning/recommendations"),
  });

  const dryRunMutation = useMutation({
    mutationFn: (signatures: string[]) =>
      api<{
        items: Array<{ signature: string; would_watch_count: number }>;
        total_would_watch: number;
      }>(
        "/api/monitoring/alert-tuning/recommendations/dry-run",
        { method: "POST", body: JSON.stringify({ signatures }) },
      ),
    onSuccess: (result) => setDryRunPreview(result),
  });

  const applyMutation = useMutation({
    mutationFn: (signatures: string[]) =>
      api("/api/monitoring/alert-tuning/recommendations/apply", {
        method: "POST",
        body: JSON.stringify({ signatures }),
      }),
    onSuccess: () => {
      message.success(t("monitoring.alertTuning.recommendations.applied"));
      setRollbackVisible(true);
      setSelectedSignatures([]);
      setDryRunPreview(null);
      void queryClient.invalidateQueries({ queryKey: ["alert-tuning", "signature_suppress"] });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: () =>
      api("/api/monitoring/alert-tuning/recommendations/rollback", { method: "POST" }),
    onSuccess: () => {
      message.success(t("monitoring.alertTuning.recommendations.rolledBack"));
      setRollbackVisible(false);
      void queryClient.invalidateQueries({ queryKey: ["alert-tuning"] });
    },
  });

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/monitoring/alert-tuning", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      message.success(t("monitoring.alertTuning.created"));
      setDrawerOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["alert-tuning", activeTab] });
    },
    onError: () => message.error(t("common.error")),
  });

  return (
    <ModulePageShell
      icon={<FilterOutlined style={{ fontSize: 20 }} />}
      title={t("monitoring.alertTuning.title")}
      subtitle={t("monitoring.alertTuning.subtitle")}
    >
      <ModuleTableCard>
        <Space direction="vertical" size={12} style={{ width: "100%", marginBottom: 16 }}>
          <Typography.Text strong>{t("monitoring.alertTuning.recommendations.title")}</Typography.Text>
          <Table<Recommendation>
            size="small"
            rowKey="signature"
            pagination={false}
            dataSource={recommendations?.items ?? []}
            locale={{ emptyText: t("monitoring.alertTuning.recommendations.empty") }}
            rowSelection={{
              selectedRowKeys: selectedSignatures,
              onChange: (keys) => setSelectedSignatures(keys.map(String)),
            }}
            columns={[
              {
                title: t("monitoring.alertTuning.fields.signature"),
                dataIndex: "signature",
                ellipsis: true,
              },
              {
                title: t("monitoring.alertTuning.recommendations.hits7d"),
                dataIndex: "hit_count_7d",
                width: 100,
              },
              {
                title: t("monitoring.alertTuning.recommendations.failed"),
                dataIndex: "execution_failed_count",
                width: 120,
              },
              {
                title: t("monitoring.alertTuning.recommendations.sample"),
                dataIndex: "sample_event_id",
                width: 120,
                render: (id: string | null) =>
                  id ? (
                    <a href={`/timeline?event_id=${id}`} target="_blank" rel="noreferrer">
                      {id.slice(0, 8)}
                    </a>
                  ) : (
                    "—"
                  ),
              },
            ]}
          />
          {dryRunPreview ? (
            <Alert
              type="info"
              message={t("monitoring.alertTuning.recommendations.dryRunTitle")}
              description={t("monitoring.alertTuning.recommendations.dryRunBody", {
                total: dryRunPreview.total_would_watch,
              })}
            />
          ) : null}
          {rollbackVisible ? (
            <Alert
              type="warning"
              message={t("monitoring.alertTuning.recommendations.rollbackBanner")}
              action={
                <Button size="small" onClick={() => rollbackMutation.mutate()}>
                  {t("monitoring.alertTuning.recommendations.rollbackAction")}
                </Button>
              }
            />
          ) : null}
          <Space>
            <Button
              disabled={selectedSignatures.length === 0}
              loading={dryRunMutation.isPending}
              onClick={() => dryRunMutation.mutate(selectedSignatures)}
            >
              {t("monitoring.alertTuning.recommendations.dryRun")}
            </Button>
            <Button
              type="primary"
              disabled={selectedSignatures.length === 0}
              loading={applyMutation.isPending}
              onClick={() => applyMutation.mutate(selectedSignatures)}
            >
              {t("monitoring.alertTuning.recommendations.apply", {
                count: selectedSignatures.length,
              })}
            </Button>
          </Space>
        </Space>
        <Tabs
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as RuleType)}
          items={[
            {
              key: "log_match",
              label: t("monitoring.alertTuning.tabs.logMatch"),
              children: (
                <RuleTable ruleType="log_match" onAdd={() => setDrawerOpen(true)} />
              ),
            },
            {
              key: "signature_suppress",
              label: t("monitoring.alertTuning.tabs.signatureSuppress"),
              children: (
                <RuleTable ruleType="signature_suppress" onAdd={() => setDrawerOpen(true)} />
              ),
            },
            {
              key: "duplicate_binding",
              label: t("monitoring.alertTuning.tabs.duplicateBinding"),
              children: (
                <RuleTable ruleType="duplicate_binding" onAdd={() => setDrawerOpen(true)} />
              ),
            },
          ]}
        />
      </ModuleTableCard>

      <ModuleFormDrawer
        open={drawerOpen}
        title={t("monitoring.alertTuning.addRule")}
        onClose={() => setDrawerOpen(false)}
      >
        <ProForm
          initialValues={{ rule_type: activeTab, enabled: true, level_filter: "error,warn" }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
          onFinish={async (values) => {
            await createMutation.mutateAsync({
              rule_type: activeTab,
              ...values,
            });
            return true;
          }}
        >
          {activeTab === "log_match" ? (
            <>
              <ProFormText
                name="match_pattern"
                label={t("monitoring.alertTuning.fields.pattern")}
                rules={[{ required: true }]}
              />
              <ProFormText
                name="level_filter"
                label={t("monitoring.alertTuning.fields.levelFilter")}
              />
            </>
          ) : null}
          {activeTab === "signature_suppress" ? (
            <>
              <ProFormText
                name="signature"
                label={t("monitoring.alertTuning.fields.signature")}
                rules={[{ required: true }]}
              />
              <ProFormSelect
                name="action"
                label={t("monitoring.alertTuning.fields.action")}
                options={[
                  { label: "watch", value: "watch" },
                  { label: "merge", value: "merge" },
                  { label: "suppress", value: "suppress" },
                ]}
                rules={[{ required: true }]}
              />
            </>
          ) : null}
          {activeTab === "duplicate_binding" ? (
            <ProFormText
              name="binding_title"
              label={t("monitoring.alertTuning.fields.bindingTitle")}
              rules={[{ required: true }]}
            />
          ) : null}
          <ProFormSwitch name="enabled" label={t("monitoring.alertTuning.fields.enabled")} />
        </ProForm>
      </ModuleFormDrawer>

      <Typography.Text type="secondary" style={{ display: "block", marginTop: 8 }}>
        {t("monitoring.alertTuning.hint")}
      </Typography.Text>
    </ModulePageShell>
  );
}