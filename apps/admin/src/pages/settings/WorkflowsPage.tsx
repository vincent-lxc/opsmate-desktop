import {
  ProForm,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProFormTextArea,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { ApiOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, App, Button, Space, Tabs, Tag, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { ConfirmDeleteButton } from "../../components/ConfirmDeleteButton";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
  moduleTabsInCardStyle,
} from "../../components/module-table-styles";

type ProviderRow = {
  id: string;
  name: string;
  type: string;
  config_json: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
};

type TemplateRow = {
  id: string;
  name: string;
  trigger_kind: string;
  action_kind: string;
  config_json: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
};

const PROVIDER_TYPES = [
  "generic",
  "alertmanager",
  "grafana",
  "pagerduty",
  "opsgenie",
  "jira",
  "linear",
] as const;
const TRIGGER_KINDS = [
  "webhook_alert",
  "problem_resolved",
  "l2_approval_pending",
  "drill_completed",
] as const;
const ACTION_KINDS = [
  "create_problem",
  "generate_incident_report",
  "notify_channel",
  "archive_event",
  "create_ticket",
] as const;

function parseConfigJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function stringifyConfig(config: Record<string, unknown> | undefined): string {
  return JSON.stringify(config ?? {}, null, 2);
}

export function WorkflowsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [section, setSection] = useState<"providers" | "templates">("providers");
  const [providerFormOpen, setProviderFormOpen] = useState(false);
  const [templateFormOpen, setTemplateFormOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderRow | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<TemplateRow | null>(null);

  const { data: providers, isLoading: providersLoading } = useQuery({
    queryKey: ["workflow-providers"],
    queryFn: () => api<{ items: ProviderRow[] }>("/api/workflows/providers"),
  });

  const { data: templates, isLoading: templatesLoading } = useQuery({
    queryKey: ["workflow-templates"],
    queryFn: () => api<{ items: TemplateRow[] }>("/api/workflows/templates"),
  });

  const saveProviderMutation = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      let config_json: Record<string, unknown> = {};
      try {
        config_json = parseConfigJson(values.config_json_text);
      } catch {
        throw new Error("invalid_json");
      }
      const payload = {
        name: values.name,
        type: values.type,
        enabled: values.enabled ?? true,
        config_json,
      };
      if (editingProvider) {
        return api(`/api/workflows/providers/${editingProvider.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      }
      return api("/api/workflows/providers", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflow-providers"] });
      message.success(t("workflows.providers.saved"));
      setProviderFormOpen(false);
      setEditingProvider(null);
    },
    onError: (err) => {
      if (err instanceof Error && err.message === "invalid_json") {
        message.error(t("workflows.invalidJson"));
        return;
      }
      message.error(t("common.error"));
    },
  });

  const testTicketMutation = useMutation({
    mutationFn: async (row: ProviderRow) => {
      if (row.type !== "jira" && row.type !== "linear") {
        throw new Error("unsupported");
      }
      return api<{ ok: boolean; message: string }>("/api/workflows/providers/test-ticket", {
        method: "POST",
        body: JSON.stringify({ type: row.type, config_json: row.config_json }),
      });
    },
    onSuccess: (result) => {
      message[result.ok ? "success" : "error"](result.message);
    },
    onError: (err) => {
      if (err instanceof Error && err.message === "unsupported") return;
      message.error(t("common.error"));
    },
  });

  const deleteProviderMutation = useMutation({
    mutationFn: (id: string) => api(`/api/workflows/providers/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflow-providers"] });
      message.success(t("workflows.providers.deleted"));
    },
    onError: () => message.error(t("common.error")),
  });

  const saveTemplateMutation = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      let config_json: Record<string, unknown> = {};
      try {
        config_json = parseConfigJson(values.config_json_text);
      } catch {
        throw new Error("invalid_json");
      }
      const payload = {
        name: values.name,
        trigger_kind: values.trigger_kind,
        action_kind: values.action_kind,
        enabled: values.enabled ?? true,
        config_json,
      };
      if (editingTemplate) {
        return api(`/api/workflows/templates/${editingTemplate.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      }
      return api("/api/workflows/templates", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflow-templates"] });
      message.success(t("workflows.templates.saved"));
      setTemplateFormOpen(false);
      setEditingTemplate(null);
    },
    onError: (err) => {
      if (err instanceof Error && err.message === "invalid_json") {
        message.error(t("workflows.invalidJson"));
        return;
      }
      message.error(t("common.error"));
    },
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: (id: string) => api(`/api/workflows/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workflow-templates"] });
      message.success(t("workflows.templates.deleted"));
    },
    onError: () => message.error(t("common.error")),
  });

  const providerColumns = useMemo<ProColumns<ProviderRow>[]>(
    () => [
      { title: t("workflows.providers.columns.name"), dataIndex: "name", ellipsis: true },
      {
        title: t("workflows.providers.columns.type"),
        dataIndex: "type",
        width: 140,
        render: (_, row) =>
          t(`workflows.providers.types.${row.type}`, { defaultValue: row.type }),
      },
      {
        title: t("workflows.providers.columns.enabled"),
        dataIndex: "enabled",
        width: 90,
        search: false,
        render: (_, row) => (
          <Tag color={row.enabled ? "success" : "default"}>
            {row.enabled ? t("common.yes") : t("common.no")}
          </Tag>
        ),
      },
      {
        title: t("common.actions"),
        width: 200,
        fixed: "right",
        search: false,
        valueType: "option",
        render: (_, row) => (
          <Space size={4} wrap>
            {(row.type === "jira" || row.type === "linear") && (
              <Button
                type="link"
                size="small"
                loading={testTicketMutation.isPending}
                onClick={() => testTicketMutation.mutate(row)}
              >
                {t("workflows.providers.testTicket")}
              </Button>
            )}
            <Button
              type="link"
              size="small"
              onClick={() => {
                setEditingProvider(row);
                setProviderFormOpen(true);
              }}
            >
              {t("common.edit")}
            </Button>
            <ConfirmDeleteButton
              title={t("workflows.providers.deleteConfirm")}
              onConfirm={() => deleteProviderMutation.mutate(row.id)}
            />
          </Space>
        ),
      },
    ],
    [t, deleteProviderMutation, testTicketMutation],
  );

  const templateColumns = useMemo<ProColumns<TemplateRow>[]>(
    () => [
      { title: t("workflows.templates.columns.name"), dataIndex: "name", ellipsis: true },
      {
        title: t("workflows.templates.columns.trigger"),
        dataIndex: "trigger_kind",
        width: 170,
        render: (_, row) => t(`workflows.templates.triggers.${row.trigger_kind}`),
      },
      {
        title: t("workflows.templates.columns.action"),
        dataIndex: "action_kind",
        width: 190,
        render: (_, row) => t(`workflows.templates.actions.${row.action_kind}`),
      },
      {
        title: t("workflows.templates.columns.enabled"),
        dataIndex: "enabled",
        width: 90,
        search: false,
        render: (_, row) => (
          <Tag color={row.enabled ? "success" : "default"}>
            {row.enabled ? t("common.yes") : t("common.no")}
          </Tag>
        ),
      },
      {
        title: t("common.actions"),
        width: 140,
        fixed: "right",
        search: false,
        valueType: "option",
        render: (_, row) => (
          <Space size={4}>
            <Button
              type="link"
              size="small"
              onClick={() => {
                setEditingTemplate(row);
                setTemplateFormOpen(true);
              }}
            >
              {t("common.edit")}
            </Button>
            <ConfirmDeleteButton
              title={t("workflows.templates.deleteConfirm")}
              onConfirm={() => deleteTemplateMutation.mutate(row.id)}
            />
          </Space>
        ),
      },
    ],
    [t, deleteTemplateMutation],
  );

  const headerAction =
    section === "providers" ? (
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => {
          setEditingProvider(null);
          setProviderFormOpen(true);
        }}
      >
        {t("workflows.providers.add")}
      </Button>
    ) : (
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => {
          setEditingTemplate(null);
          setTemplateFormOpen(true);
        }}
      >
        {t("workflows.templates.add")}
      </Button>
    );

  return (
    <ModulePageShell
      icon={<ApiOutlined style={{ fontSize: 20 }} />}
      title={t("workflows.title")}
      subtitle={t("workflows.subtitle")}
      action={headerAction}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t("workflows.webhookEndpoint")}
        description={
          <Typography.Text code copyable>
            /api/webhook/receive
          </Typography.Text>
        }
      />

      <ModuleTableCard>
        <Tabs
          activeKey={section}
          onChange={(key) => setSection(key as "providers" | "templates")}
          style={moduleTabsInCardStyle}
          items={[
            { key: "providers", label: t("workflows.providers.section") },
            { key: "templates", label: t("workflows.templates.section") },
          ]}
        />
        {section === "providers" ? (
          <ProTable<ProviderRow>
            {...moduleProTableProps}
            rowKey="id"
            loading={providersLoading}
            columns={providerColumns}
            dataSource={providers?.items ?? []}
            search={moduleTableSearch()}
            pagination={moduleTablePagination}
            locale={{ emptyText: t("workflows.providers.empty") }}
          />
        ) : (
          <ProTable<TemplateRow>
            {...moduleProTableProps}
            rowKey="id"
            loading={templatesLoading}
            columns={templateColumns}
            dataSource={templates?.items ?? []}
            search={moduleTableSearch()}
            pagination={moduleTablePagination}
            locale={{ emptyText: t("workflows.templates.empty") }}
          />
        )}
      </ModuleTableCard>

      <ModuleFormDrawer
        title={editingProvider ? t("workflows.providers.edit") : t("workflows.providers.add")}
        open={providerFormOpen}
        onClose={() => {
          setProviderFormOpen(false);
          setEditingProvider(null);
        }}
        width={560}
      >
        <ProForm
          key={editingProvider?.id ?? "new-provider"}
          initialValues={
            editingProvider
              ? {
                  name: editingProvider.name,
                  type: editingProvider.type,
                  enabled: editingProvider.enabled,
                  config_json_text: stringifyConfig(editingProvider.config_json),
                }
              : { type: "generic", enabled: true, config_json_text: "{}" }
          }
          onFinish={async (values) => {
            await saveProviderMutation.mutateAsync(values);
            return true;
          }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
        >
          <ProFormText
            name="name"
            label={t("workflows.providers.columns.name")}
            rules={[{ required: true }]}
          />
          <ProFormSelect
            name="type"
            label={t("workflows.providers.columns.type")}
            options={PROVIDER_TYPES.map((type) => ({
              label: t(`workflows.providers.types.${type}`),
              value: type,
            }))}
            rules={[{ required: true }]}
          />
          <ProFormSwitch name="enabled" label={t("workflows.providers.columns.enabled")} />
          <ProFormTextArea
            name="config_json_text"
            label={t("workflows.configJson")}
            fieldProps={{ rows: 6, style: { fontFamily: "monospace", fontSize: 13 } }}
          />
        </ProForm>
      </ModuleFormDrawer>

      <ModuleFormDrawer
        title={editingTemplate ? t("workflows.templates.edit") : t("workflows.templates.add")}
        open={templateFormOpen}
        onClose={() => {
          setTemplateFormOpen(false);
          setEditingTemplate(null);
        }}
        width={560}
      >
        <ProForm
          key={editingTemplate?.id ?? "new-template"}
          initialValues={
            editingTemplate
              ? {
                  name: editingTemplate.name,
                  trigger_kind: editingTemplate.trigger_kind,
                  action_kind: editingTemplate.action_kind,
                  enabled: editingTemplate.enabled,
                  config_json_text: stringifyConfig(editingTemplate.config_json),
                }
              : {
                  trigger_kind: "webhook_alert",
                  action_kind: "create_problem",
                  enabled: true,
                  config_json_text: "{}",
                }
          }
          onFinish={async (values) => {
            await saveTemplateMutation.mutateAsync(values);
            return true;
          }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
        >
          <ProFormText
            name="name"
            label={t("workflows.templates.columns.name")}
            rules={[{ required: true }]}
          />
          <ProFormSelect
            name="trigger_kind"
            label={t("workflows.templates.columns.trigger")}
            options={TRIGGER_KINDS.map((kind) => ({
              label: t(`workflows.templates.triggers.${kind}`),
              value: kind,
            }))}
            rules={[{ required: true }]}
          />
          <ProFormSelect
            name="action_kind"
            label={t("workflows.templates.columns.action")}
            options={ACTION_KINDS.map((kind) => ({
              label: t(`workflows.templates.actions.${kind}`),
              value: kind,
            }))}
            rules={[{ required: true }]}
          />
          <ProFormSwitch name="enabled" label={t("workflows.templates.columns.enabled")} />
          <ProFormTextArea
            name="config_json_text"
            label={t("workflows.configJson")}
            fieldProps={{ rows: 6, style: { fontFamily: "monospace", fontSize: 13 } }}
          />
        </ProForm>
      </ModuleFormDrawer>
    </ModulePageShell>
  );
}