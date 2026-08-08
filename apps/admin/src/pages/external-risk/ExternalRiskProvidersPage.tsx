import {
  ProForm,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProFormTextArea,
  ProTable,
} from "@ant-design/pro-components";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { GlobalOutlined, PlusOutlined, SendOutlined } from "@ant-design/icons";
import { App, Button } from "antd";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { externalRiskApi, type ExternalRiskProvider } from "../../api/external-risk";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";
import { enabledTag, providerHealthTag } from "../../utils/external-risk-display";

function parseConfigJson(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function ExternalRiskProvidersPage() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const actionRef = useRef<ActionType>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ExternalRiskProvider | null>(null);

  const refresh = () => {
    void actionRef.current?.reload();
  };

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => externalRiskApi.createProvider(body),
    onSuccess: () => {
      message.success(t("externalRisk.providers.saved"));
      setFormOpen(false);
      refresh();
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      externalRiskApi.updateProvider(id, body),
    onSuccess: () => {
      message.success(t("externalRisk.providers.saved"));
      setEditing(null);
      refresh();
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.deleteProvider(id),
    onSuccess: () => {
      message.success(t("externalRisk.providers.deleted"));
      refresh();
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.testProvider(id),
    onSuccess: (result) => {
      if (result.ok) {
        message.success(result.message);
      } else {
        message.error(result.message);
      }
      refresh();
    },
    onError: (err: Error) => message.error(err.message || t("externalRisk.providers.testFailed")),
  });

  const kindOptions = useMemo(
    () => [
      { label: "OSV", value: "osv" },
      { label: "GitHub Advisory", value: "github_advisory" },
      { label: "GitHub Repo", value: "github_repo" },
      { label: "NVD", value: "nvd" },
      { label: "Registry", value: "registry" },
      { label: t("externalRisk.providers.kinds.customUrl"), value: "custom_url" },
      { label: "RSS", value: "rss" },
    ],
    [t],
  );

  const columns = useMemo<ProColumns<ExternalRiskProvider>[]>(
    () => [
      { title: t("externalRisk.providers.columns.name"), dataIndex: "name", ellipsis: true },
      {
        title: t("externalRisk.providers.columns.kind"),
        dataIndex: "kind",
        width: 160,
      },
      {
        title: t("externalRisk.providers.columns.enabled"),
        dataIndex: "enabled",
        width: 100,
        valueType: "select",
        valueEnum: {
          true: { text: t("externalRisk.status.enabled") },
          false: { text: t("externalRisk.status.disabled") },
        },
        render: (_, row) => enabledTag(row.enabled, t),
      },
      {
        title: t("externalRisk.providers.columns.health"),
        dataIndex: "last_health_status",
        width: 120,
        search: false,
        render: (_, row) => providerHealthTag(row.last_health_status, t),
      },
      {
        title: t("externalRisk.providers.columns.lastChecked"),
        dataIndex: "last_checked_at",
        valueType: "dateTime",
        width: 170,
        search: false,
      },
      {
        title: t("externalRisk.providers.columns.rateLimit"),
        dataIndex: "rate_limit_per_min",
        width: 120,
        search: false,
        render: (_, row) =>
          row.rate_limit_per_min != null ? `${row.rate_limit_per_min}/min` : "—",
      },
      {
        title: t("common.actions"),
        valueType: "option",
        width: 180,
        fixed: "right",
        search: false,
        render: (_, row) => [
          <Button
            key="test"
            type="link"
            size="small"
            icon={<SendOutlined />}
            loading={testMutation.isPending}
            onClick={() => testMutation.mutate(row.id)}
          >
            {t("externalRisk.providers.actions.test")}
          </Button>,
          <Button
            key="edit"
            type="link"
            size="small"
            onClick={() => {
              setEditing(row);
              setFormOpen(true);
            }}
          >
            {t("common.edit")}
          </Button>,
          <Button
            key="delete"
            type="link"
            size="small"
            danger
            onClick={() => {
              modal.confirm({
                title: t("externalRisk.providers.deleteConfirm"),
                okType: "danger",
                onOk: () => deleteMutation.mutateAsync(row.id),
              });
            }}
          >
            {t("common.delete")}
          </Button>,
        ],
      },
    ],
    [t, testMutation, deleteMutation, modal],
  );

  const providerForm = (initial?: ExternalRiskProvider | null) => (
    <ProForm
      initialValues={{
        name: initial?.name ?? "",
        kind: initial?.kind ?? "osv",
        config_json: initial ? JSON.stringify(initial.config_json, null, 2) : "{}",
        enabled: initial?.enabled ?? true,
        rate_limit_per_min: initial?.rate_limit_per_min ?? undefined,
      }}
      onFinish={async (values) => {
        const payload = {
          name: values.name,
          kind: values.kind,
          config_json: parseConfigJson(values.config_json as string | undefined),
          enabled: values.enabled,
          rate_limit_per_min: values.rate_limit_per_min ?? null,
        };
        if (initial) {
          await updateMutation.mutateAsync({ id: initial.id, body: payload });
        } else {
          await createMutation.mutateAsync(payload);
        }
        return true;
      }}
      submitter={{ searchConfig: { submitText: t("common.save") } }}
    >
      <ProFormText name="name" label={t("externalRisk.providers.form.name")} rules={[{ required: true }]} />
      <ProFormSelect
        name="kind"
        label={t("externalRisk.providers.form.kind")}
        options={kindOptions}
        rules={[{ required: true }]}
        disabled={Boolean(initial)}
      />
      <ProFormTextArea
        name="config_json"
        label={t("externalRisk.providers.form.config")}
        fieldProps={{ rows: 6, style: { fontFamily: "monospace" } }}
      />
      <ProFormDigit
        name="rate_limit_per_min"
        label={t("externalRisk.providers.form.rateLimit")}
        min={1}
        max={10000}
        fieldProps={{ precision: 0 }}
      />
      <ProFormSwitch name="enabled" label={t("externalRisk.providers.form.enabled")} />
    </ProForm>
  );

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <>
      <ModulePageShell
        icon={<GlobalOutlined style={{ fontSize: 20 }} />}
        title={t("externalRisk.providers.title")}
        subtitle={t("externalRisk.providers.subtitle")}
        action={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t("externalRisk.providers.create")}
          </Button>
        }
      >
        <ModuleTableCard>
          <ProTable<ExternalRiskProvider>
            {...moduleProTableProps}
            actionRef={actionRef}
            rowKey="id"
            columns={columns}
            request={async () => {
              const res = await externalRiskApi.listProviders();
              return { data: res.items, total: res.total, success: true };
            }}
            search={moduleTableSearch()}
            pagination={moduleTablePagination}
            locale={{ emptyText: t("externalRisk.providers.empty") }}
          />
        </ModuleTableCard>
      </ModulePageShell>

      <ModuleFormDrawer
        title={
          editing ? t("externalRisk.providers.editTitle") : t("externalRisk.providers.createTitle")
        }
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
      >
        {providerForm(editing)}
      </ModuleFormDrawer>
    </>
  );
}