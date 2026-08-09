import {
  ProForm,
  ProFormDateTimePicker,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProFormTextArea,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { MoreOutlined, PlusOutlined, ThunderboltOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { App, Button, Descriptions, Dropdown, Modal, Space, Spin, Tabs } from "antd";
import type { MenuProps } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  externalRiskApi,
  formatScopeSummary,
  type ExternalRiskRun,
  type ExternalRiskTask,
} from "../../api/external-risk";
import { toIsoDateTime } from "../../api/client";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleNestedTableProps,
  moduleProTableProps,
  moduleTableDetailIndent,
  moduleTableExpandable,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";
import { aiEnabledTag, enabledTag, runStatusTag } from "../../utils/external-risk-display";
import { formatDateTime } from "../../utils/datetime";

const EXPANDED_DETAIL_CLASS = "module-table-detail-panel";
const EXPANDED_DETAIL_STYLE = { paddingLeft: moduleTableDetailIndent } as const;

function formatInterval(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function filterTasks(items: ExternalRiskTask[], params: Record<string, unknown>): ExternalRiskTask[] {
  const title = String(params.title ?? "").trim().toLowerCase();
  const targetKind = params.target_kind as string | undefined;
  const enabledRaw = params.enabled;
  const enabled =
    enabledRaw === "true" || enabledRaw === true
      ? true
      : enabledRaw === "false" || enabledRaw === false
        ? false
        : undefined;
  return items.filter((task) => {
    if (title && !task.title.toLowerCase().includes(title)) return false;
    if (targetKind && task.target_kind !== targetKind) return false;
    if (enabled !== undefined && task.enabled !== enabled) return false;
    return true;
  });
}

function parseJsonField(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type TaskRunsExpandProps = { task: ExternalRiskTask };

function TaskRunsExpand({ task }: TaskRunsExpandProps) {
  const { t } = useTranslation();
  const { data: runs, isLoading } = useQuery({
    queryKey: ["external-risk-runs", task.id],
    queryFn: () => externalRiskApi.listRuns(task.id),
  });

  if (isLoading) {
    return (
      <div
        className={EXPANDED_DETAIL_CLASS}
        style={{ ...EXPANDED_DETAIL_STYLE, textAlign: "center", padding: 16 }}
      >
        <Spin />
      </div>
    );
  }

  return (
    <div className={EXPANDED_DETAIL_CLASS} style={EXPANDED_DETAIL_STYLE}>
      <Tabs
        size="small"
        items={[
          {
            key: "config",
            label: t("externalRisk.tasks.tabs.config"),
            children: (
              <Descriptions bordered size="small" column={2} style={{ marginBottom: 0 }}>
                <Descriptions.Item label={t("externalRisk.tasks.form.description")} span={2}>
                  {task.description || "—"}
                </Descriptions.Item>
                <Descriptions.Item label={t("externalRisk.tasks.form.scheduleSec")}>
                  {task.schedule_interval_sec}s ({formatInterval(task.schedule_interval_sec)})
                </Descriptions.Item>
                <Descriptions.Item label={t("externalRisk.tasks.form.confidenceThreshold")}>
                  {task.confidence_threshold}
                </Descriptions.Item>
                <Descriptions.Item label={t("externalRisk.tasks.form.aiEnabled")}>
                  {aiEnabledTag(task.ai_enabled, t)}
                </Descriptions.Item>
                <Descriptions.Item label={t("externalRisk.tasks.form.nextRun")}>
                  {task.next_run_at ? formatDateTime(task.next_run_at) : "—"}
                </Descriptions.Item>
              </Descriptions>
            ),
          },
          {
            key: "runs",
            label: t("externalRisk.tasks.tabs.recentRuns"),
            children: (
              <ProTable<ExternalRiskRun>
                {...moduleNestedTableProps}
                rowKey="id"
                locale={{ emptyText: t("externalRisk.tasks.runsEmpty") }}
                dataSource={runs?.items ?? []}
                columns={[
                  {
                    title: t("externalRisk.tasks.runColumns.startedAt"),
                    dataIndex: "started_at",
                    width: 170,
                    render: (_, row) => formatDateTime(row.started_at),
                  },
                  {
                    title: t("externalRisk.tasks.runColumns.status"),
                    dataIndex: "status",
                    width: 100,
                    render: (_, row) => runStatusTag(row.status, t),
                  },
                  {
                    title: t("externalRisk.tasks.runColumns.findings"),
                    dataIndex: "finding_count",
                    width: 90,
                  },
                  {
                    title: t("externalRisk.tasks.runColumns.signals"),
                    dataIndex: "raw_signal_count",
                    width: 90,
                  },
                  {
                    title: t("externalRisk.tasks.runColumns.ai"),
                    dataIndex: "ai_analyzed_count",
                    width: 80,
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </div>
  );
}

export function ExternalRiskTasksPage() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ExternalRiskTask | null>(null);
  const [pauseTask, setPauseTask] = useState<ExternalRiskTask | null>(null);
  const [searchParams, setSearchParams] = useState<Record<string, unknown>>({});
  const [latestFindings, setLatestFindings] = useState<Record<string, number>>({});

  const { data: listData, isLoading } = useQuery({
    queryKey: ["external-risk-tasks"],
    queryFn: () => externalRiskApi.listTasks(),
  });

  const { data: providersData } = useQuery({
    queryKey: ["external-risk-providers"],
    queryFn: () => externalRiskApi.listProviders(),
  });

  const providerOptions = useMemo(
    () => (providersData?.items ?? []).map((p) => ({ label: p.name, value: p.id })),
    [providersData?.items],
  );

  const filteredItems = useMemo(
    () => filterTasks(listData?.items ?? [], searchParams),
    [listData?.items, searchParams],
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["external-risk-tasks"] });
    void queryClient.invalidateQueries({ queryKey: ["external-risk-runs"] });
    void queryClient.invalidateQueries({ queryKey: ["external-risk-summary"] });
    void queryClient.invalidateQueries({ queryKey: ["external-risk-findings"] });
  };

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => externalRiskApi.createTask(body),
    onSuccess: () => {
      message.success(t("externalRisk.tasks.saved"));
      setFormOpen(false);
      refresh();
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      externalRiskApi.updateTask(id, body),
    onSuccess: () => {
      message.success(t("externalRisk.tasks.saved"));
      setEditing(null);
      refresh();
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.deleteTask(id),
    onSuccess: () => {
      message.success(t("externalRisk.tasks.deleted"));
      refresh();
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.runTask(id),
    onSuccess: (result, id) => {
      message.success(t("externalRisk.tasks.runDone"));
      setLatestFindings((prev) => ({ ...prev, [id]: result.run.finding_count }));
      refresh();
    },
    onError: (err: Error) => message.error(err.message || t("externalRisk.tasks.runFailed")),
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.stopTask(id),
    onSuccess: () => {
      message.success(t("externalRisk.tasks.stopped"));
      refresh();
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const enableMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.enableTask(id),
    onSuccess: () => {
      message.success(t("externalRisk.tasks.enabled"));
      refresh();
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const pauseMutation = useMutation({
    mutationFn: ({ id, until }: { id: string; until: string }) =>
      externalRiskApi.pauseTask(id, until),
    onSuccess: () => {
      message.success(t("externalRisk.tasks.paused"));
      setPauseTask(null);
      refresh();
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const skipNextRunMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.skipNextRun(id),
    onSuccess: () => {
      message.success(t("externalRisk.tasks.skipNextRunDone"));
      refresh();
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const renderDetailExpand = useCallback(
    (record: ExternalRiskTask) => <TaskRunsExpand task={record} />,
    [],
  );

  const buildPayload = (values: Record<string, unknown>) => ({
    title: values.title,
    description: values.description ?? null,
    target_kind: values.target_kind,
    target_scope_json: parseJsonField(values.target_scope_json as string | undefined),
    schedule_interval_sec: values.schedule_interval_sec,
    provider_ids: values.provider_ids ?? [],
    ai_enabled: values.ai_enabled,
    confidence_threshold: values.confidence_threshold,
    force_notify_policy_json: parseJsonField(
      values.force_notify_policy_json as string | undefined,
    ),
    enabled: values.enabled,
  });

  const columns = useMemo<ProColumns<ExternalRiskTask>[]>(
    () => [
      { title: t("externalRisk.tasks.columns.title"), dataIndex: "title", ellipsis: true },
      {
        title: t("externalRisk.tasks.columns.targetKind"),
        dataIndex: "target_kind",
        width: 120,
        valueType: "select",
        valueEnum: {
          foundation: { text: t("externalRisk.tasks.targetKind.foundation") },
          dependency: { text: t("externalRisk.tasks.targetKind.dependency") },
          both: { text: t("externalRisk.tasks.targetKind.both") },
        },
      },
      {
        title: t("externalRisk.tasks.columns.scope"),
        dataIndex: "target_scope_json",
        ellipsis: true,
        search: false,
        render: (_, row) => formatScopeSummary(row.target_scope_json),
      },
      {
        title: t("externalRisk.tasks.columns.providers"),
        dataIndex: "provider_ids",
        width: 100,
        search: false,
        render: (_, row) => row.provider_ids.length,
      },
      {
        title: t("externalRisk.tasks.columns.aiEnabled"),
        dataIndex: "ai_enabled",
        width: 100,
        search: false,
        render: (_, row) => aiEnabledTag(row.ai_enabled, t),
      },
      {
        title: t("externalRisk.tasks.columns.enabled"),
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
        title: t("externalRisk.tasks.columns.lastRun"),
        dataIndex: "last_run_at",
        width: 170,
        search: false,
        render: (_, row) =>
          row.last_run_at ? formatDateTime(row.last_run_at) : "—",
      },
      {
        title: t("externalRisk.tasks.columns.findingsCount"),
        dataIndex: "id",
        width: 100,
        search: false,
        render: (_, row) => latestFindings[row.id] ?? "—",
      },
      {
        title: t("common.actions"),
        width: 180,
        fixed: "right",
        search: false,
        render: (_, row) => {
          const moreItems: MenuProps["items"] = [
            {
              key: "edit",
              label: t("common.edit"),
              onClick: () => setEditing(row),
            },
            {
              key: "pause",
              label: t("externalRisk.tasks.actions.pause"),
              onClick: () => setPauseTask(row),
            },
            {
              key: "skipNextRun",
              label: t("externalRisk.tasks.actions.skipNextRun"),
              disabled: !row.enabled,
              onClick: () => skipNextRunMutation.mutate(row.id),
            },
            {
              key: "delete",
              label: t("common.delete"),
              danger: true,
              onClick: () => {
                modal.confirm({
                  title: t("externalRisk.tasks.deleteConfirm"),
                  okType: "danger",
                  onOk: () => deleteMutation.mutateAsync(row.id),
                });
              },
            },
          ];

          return (
            <Space size={4} wrap={false}>
              {row.enabled ? (
                <Button type="link" size="small" onClick={() => stopMutation.mutate(row.id)}>
                  {t("externalRisk.tasks.actions.stop")}
                </Button>
              ) : (
                <Button type="link" size="small" onClick={() => enableMutation.mutate(row.id)}>
                  {t("externalRisk.tasks.actions.enable")}
                </Button>
              )}
              <Button
                type="link"
                size="small"
                icon={<ThunderboltOutlined />}
                loading={runMutation.isPending}
                onClick={() => runMutation.mutate(row.id)}
              >
                {t("externalRisk.tasks.actions.runNow")}
              </Button>
              <Dropdown menu={{ items: moreItems }} trigger={["click"]}>
                <Button type="link" size="small" icon={<MoreOutlined />} />
              </Dropdown>
            </Space>
          );
        },
      },
    ],
    [t, latestFindings, runMutation, stopMutation, enableMutation, skipNextRunMutation, deleteMutation, modal],
  );

  const taskForm = (initial?: ExternalRiskTask | null) => (
    <ProForm
      initialValues={{
        title: initial?.title ?? "",
        description: initial?.description ?? "",
        target_kind: initial?.target_kind ?? "both",
        target_scope_json: initial
          ? JSON.stringify(initial.target_scope_json, null, 2)
          : "{}",
        schedule_interval_sec: initial?.schedule_interval_sec ?? 3600,
        provider_ids: initial?.provider_ids ?? [],
        ai_enabled: initial?.ai_enabled ?? true,
        confidence_threshold: initial?.confidence_threshold ?? "medium",
        force_notify_policy_json: initial
          ? JSON.stringify(initial.force_notify_policy_json, null, 2)
          : "{}",
        enabled: initial?.enabled ?? true,
      }}
      onFinish={async (values) => {
        const payload = buildPayload(values);
        if (initial) {
          await updateMutation.mutateAsync({ id: initial.id, body: payload });
        } else {
          await createMutation.mutateAsync(payload);
        }
        return true;
      }}
      submitter={{ searchConfig: { submitText: t("common.save") } }}
    >
      <ProFormText name="title" label={t("externalRisk.tasks.form.title")} rules={[{ required: true }]} />
      <ProFormTextArea name="description" label={t("externalRisk.tasks.form.description")} />
      <ProFormSelect
        name="target_kind"
        label={t("externalRisk.tasks.form.targetKind")}
        options={[
          { label: t("externalRisk.tasks.targetKind.foundation"), value: "foundation" },
          { label: t("externalRisk.tasks.targetKind.dependency"), value: "dependency" },
          { label: t("externalRisk.tasks.targetKind.both"), value: "both" },
        ]}
        rules={[{ required: true }]}
      />
      <ProFormTextArea
        name="target_scope_json"
        label={t("externalRisk.tasks.form.targetScope")}
        fieldProps={{ rows: 4, style: { fontFamily: "monospace" } }}
      />
      <ProFormSelect
        name="provider_ids"
        label={t("externalRisk.tasks.form.providers")}
        mode="multiple"
        options={providerOptions}
      />
      <ProFormDigit
        name="schedule_interval_sec"
        label={t("externalRisk.tasks.form.scheduleSec")}
        min={300}
        max={86400}
        fieldProps={{ precision: 0 }}
      />
      <ProFormSelect
        name="confidence_threshold"
        label={t("externalRisk.tasks.form.confidenceThreshold")}
        options={[
          { label: t("externalRisk.findings.confidence.high"), value: "high" },
          { label: t("externalRisk.findings.confidence.medium"), value: "medium" },
          { label: t("externalRisk.findings.confidence.low"), value: "low" },
        ]}
      />
      <ProFormTextArea
        name="force_notify_policy_json"
        label={t("externalRisk.tasks.form.forceNotifyPolicy")}
        fieldProps={{ rows: 3, style: { fontFamily: "monospace" } }}
      />
      <ProFormSwitch name="ai_enabled" label={t("externalRisk.tasks.form.aiEnabled")} />
      <ProFormSwitch name="enabled" label={t("externalRisk.tasks.form.enabled")} />
    </ProForm>
  );

  return (
    <>
      <ModulePageShell
        icon={<UnorderedListOutlined style={{ fontSize: 20 }} />}
        title={t("externalRisk.tasks.title")}
        subtitle={t("externalRisk.tasks.subtitle")}
        action={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setFormOpen(true)}>
            {t("externalRisk.tasks.create")}
          </Button>
        }
      >
        <ModuleTableCard>
          <ProTable<ExternalRiskTask>
            {...moduleProTableProps}
            rowKey="id"
            loading={isLoading}
            search={moduleTableSearch()}
            pagination={moduleTablePagination}
            columns={columns}
            dataSource={filteredItems}
            onSubmit={(params) => setSearchParams(params)}
            onReset={() => setSearchParams({})}
            expandable={{
              ...moduleTableExpandable,
              expandedRowRender: renderDetailExpand,
            }}
          />
        </ModuleTableCard>
      </ModulePageShell>

      <ModuleFormDrawer
        title={editing ? t("externalRisk.tasks.editTitle") : t("externalRisk.tasks.createTitle")}
        open={formOpen || Boolean(editing)}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
      >
        {taskForm(editing)}
      </ModuleFormDrawer>

      <Modal
        title={t("externalRisk.tasks.pauseTitle")}
        open={Boolean(pauseTask)}
        onCancel={() => setPauseTask(null)}
        footer={null}
        destroyOnClose
      >
        {pauseTask && (
          <ProForm
            onFinish={async (values) => {
              const until = toIsoDateTime(values.paused_until);
              if (!until) {
                message.error(t("externalRisk.tasks.pauseUntilRequired"));
                return false;
              }
              await pauseMutation.mutateAsync({ id: pauseTask.id, until });
              return true;
            }}
            submitter={{ searchConfig: { submitText: t("common.save") } }}
          >
            <ProFormDateTimePicker
              name="paused_until"
              label={t("externalRisk.tasks.form.pauseUntil")}
              rules={[{ required: true }]}
            />
          </ProForm>
        )}
      </Modal>
    </>
  );
}