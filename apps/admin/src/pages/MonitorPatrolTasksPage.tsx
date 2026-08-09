import {
  ProForm,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProFormTextArea,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { FundOutlined, MoreOutlined, PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { App, Button, Descriptions, Dropdown, Modal, Space, Spin, Tabs } from "antd";
import type { MenuProps } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { PatrolRunProgressModal } from "../components/PatrolRunProgressModal";
import { ModulePageShell } from "../components/ModulePageShell";
import { ModuleTableCard } from "../components/ModuleTableCard";
import {
  moduleNestedTableProps,
  moduleProTableProps,
  moduleTableDetailIndent,
  moduleTableExpandable,
  moduleTablePagination,
  moduleTableSearch,
} from "../components/module-table-styles";
import type { InternalPatrolTask, PatrolRound } from "../utils/monitoring-types";
import { aiEnabledTag, taskStatusTag } from "../utils/patrol-display";
import { formatDateTime } from "../utils/datetime";

const EXPANDED_DETAIL_CLASS = "module-table-detail-panel";
const EXPANDED_DETAIL_STYLE = { paddingLeft: moduleTableDetailIndent } as const;

/** Expand col + data columns; enables horizontal scroll when viewport is narrow. */
const PATROL_TASKS_SCROLL_X =
  36 + 200 + 140 + 100 + 80 + 90 + 80 + 170 + 170 + 160;

function formatInterval(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function filterPatrolTasks(
  items: InternalPatrolTask[],
  params: Record<string, unknown>,
): InternalPatrolTask[] {
  const title = String(params.title ?? "").trim().toLowerCase();
  const group = params.server_group_name as string | undefined;
  const status = params.status as string | undefined;
  return items.filter((task) => {
    if (title && !task.title.toLowerCase().includes(title)) return false;
    if (group && task.server_group_name !== group) return false;
    if (status && task.status !== status) return false;
    return true;
  });
}

type PatrolTaskDetailExpandProps = { task: InternalPatrolTask };

function PatrolTaskDetailExpand({ task }: PatrolTaskDetailExpandProps) {
  const { t } = useTranslation();
  const { data: rounds, isLoading } = useQuery({
    queryKey: ["patrol-rounds", task.id],
    queryFn: () =>
      api<{ items: PatrolRound[] }>(`/api/monitoring/patrol-rounds?task_id=${task.id}&limit=8`),
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
            label: t("monitoring.patrolTasks.tabs.config"),
            children: (
              <Descriptions bordered size="small" column={2} style={{ marginBottom: 0 }}>
                <Descriptions.Item label={t("monitoring.patrolTasks.form.description")} span={2}>
                  {task.description || "—"}
                </Descriptions.Item>
                <Descriptions.Item label={t("monitoring.patrolTasks.form.scheduleSec")}>
                  {task.schedule_interval_sec}s ({formatInterval(task.schedule_interval_sec)})
                </Descriptions.Item>
                <Descriptions.Item label={t("monitoring.patrolTasks.form.retentionDays")}>
                  {task.retention_days}
                </Descriptions.Item>
                <Descriptions.Item label={t("monitoring.patrolTasks.form.mandatoryHardware")}>
                  {task.mandatory_hardware ? t("common.yes") : t("common.no")}
                </Descriptions.Item>
                <Descriptions.Item label={t("monitoring.patrolTasks.form.aiEnabled")}>
                  {aiEnabledTag(task.ai_enabled, t)}
                </Descriptions.Item>
                <Descriptions.Item label={t("monitoring.patrolTasks.form.responseLocale")}>
                  {task.response_locale === "en-US"
                    ? t("monitoring.patrolTasks.localeEn")
                    : t("monitoring.patrolTasks.localeZh")}
                </Descriptions.Item>
              </Descriptions>
            ),
          },
          {
            key: "rounds",
            label: t("monitoring.patrolTasks.tabs.recentRounds"),
            children: (
              <ProTable<PatrolRound>
                {...moduleNestedTableProps}
                rowKey="id"
                locale={{ emptyText: t("monitoring.patrolTasks.roundsEmpty") }}
                dataSource={rounds?.items ?? []}
                columns={[
                  {
                    title: t("monitoring.patrolRecords.columns.time"),
                    dataIndex: "started_at",
                    width: 170,
                    render: (_, row) => formatDateTime(row.started_at),
                  },
                  {
                    title: t("monitoring.patrolTasks.columns.status"),
                    dataIndex: "status",
                    width: 100,
                  },
                  {
                    title: t("monitoring.patrolTasks.roundColumns.servers"),
                    width: 90,
                    render: (_, row) => `${row.completed_count}/${row.server_count}`,
                  },
                  {
                    title: t("monitoring.patrolTasks.roundColumns.anomalies"),
                    dataIndex: "anomaly_count",
                    width: 80,
                  },
                  {
                    title: t("common.actions"),
                    width: 120,
                    render: () => (
                      <Link to={`/monitoring/patrol-records?task_id=${task.id}`}>
                        {t("monitoring.patrolTasks.viewRecords")}
                      </Link>
                    ),
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

export function MonitorPatrolTasksPage() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTask, setEditTask] = useState<InternalPatrolTask | null>(null);
  const [searchParams, setSearchParams] = useState<Record<string, unknown>>({});
  const [runProgress, setRunProgress] = useState<{
    open: boolean;
    taskId: string | null;
    taskTitle: string;
    roundId: string | null;
  }>({ open: false, taskId: null, taskTitle: "", roundId: null });

  const { data: listData, isLoading } = useQuery({
    queryKey: ["patrol-tasks"],
    queryFn: () => api<{ items: InternalPatrolTask[] }>("/api/monitoring/patrol-tasks"),
  });

  const { data: groupsData } = useQuery({
    queryKey: ["server-groups"],
    queryFn: () => api<{ items: { name: string; count: number }[] }>("/api/servers/groups"),
  });

  const groupOptions = useMemo(
    () => (groupsData?.items ?? []).map((g) => ({ label: `${g.name} (${g.count})`, value: g.name })),
    [groupsData?.items],
  );

  const statusValueEnum = useMemo(
    () => ({
      running: { text: t("monitoring.patrolTasks.statusRunning") },
      stopped: { text: t("monitoring.patrolTasks.statusStopped") },
    }),
    [t],
  );

  const filteredItems = useMemo(
    () => filterPatrolTasks(listData?.items ?? [], searchParams),
    [listData?.items, searchParams],
  );

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["patrol-tasks"] });
    void queryClient.invalidateQueries({ queryKey: ["patrol-records"] });
    void queryClient.invalidateQueries({ queryKey: ["patrol-rounds"] });
  }, [queryClient]);

  const closeRunProgress = useCallback(() => {
    setRunProgress({ open: false, taskId: null, taskTitle: "", roundId: null });
  }, []);

  const handleRunProgressComplete = useCallback(() => {
    message.success(t("monitoring.patrolTasks.runNowDone"));
    refresh();
  }, [message, refresh, t]);

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/monitoring/patrol-tasks", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      message.success(t("monitoring.patrolTasks.saved"));
      setCreateOpen(false);
      refresh();
    },
    onError: () => message.error(t("common.error")),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/api/monitoring/patrol-tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      message.success(t("monitoring.patrolTasks.saved"));
      setEditTask(null);
      refresh();
    },
    onError: () => message.error(t("common.error")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/api/monitoring/patrol-tasks/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      message.success(t("monitoring.patrolTasks.deleted"));
      refresh();
    },
    onError: () => message.error(t("common.error")),
  });

  const startMutation = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/patrol-tasks/${id}/start`, { method: "POST" }),
    onSuccess: () => {
      message.success(t("monitoring.patrolTasks.started"));
      refresh();
    },
    onError: async (err: Error) => {
      message.error(err.message || t("common.error"));
    },
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => api(`/api/monitoring/patrol-tasks/${id}/stop`, { method: "POST" }),
    onSuccess: () => {
      message.success(t("monitoring.patrolTasks.stopped"));
      refresh();
    },
    onError: () => message.error(t("common.error")),
  });

  const runNowMutation = useMutation({
    mutationFn: (task: InternalPatrolTask) =>
      api<PatrolRound>(`/api/monitoring/patrol-tasks/${task.id}/run-now`, { method: "POST" }),
    onMutate: (task) => {
      setRunProgress({
        open: true,
        taskId: task.id,
        taskTitle: task.title,
        roundId: null,
      });
    },
    onSuccess: (round, task) => {
      setRunProgress({
        open: true,
        taskId: task.id,
        taskTitle: task.title,
        roundId: round.id,
      });
    },
    onError: (err: Error) => {
      const code =
        err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
      if (code === "NOT_RUNNING") {
        message.warning(t("monitoring.patrolTasks.runNowNotRunning"));
      } else {
        message.error(t("monitoring.patrolTasks.runNowFailed"));
      }
      setRunProgress({ open: false, taskId: null, taskTitle: "", roundId: null });
    },
  });

  const renderDetailExpand = useCallback(
    (record: InternalPatrolTask) => <PatrolTaskDetailExpand task={record} />,
    [],
  );

  const columns: ProColumns<InternalPatrolTask>[] = useMemo(
    () => [
      {
        title: t("monitoring.patrolTasks.columns.title"),
        dataIndex: "title",
        width: 200,
        ellipsis: true,
      },
      {
        title: t("monitoring.patrolTasks.columns.group"),
        dataIndex: "server_group_name",
        width: 140,
        valueType: "select",
        fieldProps: { options: groupOptions },
      },
      {
        title: t("monitoring.patrolTasks.columns.status"),
        dataIndex: "status",
        width: 100,
        valueType: "select",
        valueEnum: statusValueEnum,
        render: (_, row) => taskStatusTag(row.status, t),
      },
      {
        title: t("monitoring.patrolTasks.columns.ai"),
        dataIndex: "ai_enabled",
        width: 80,
        search: false,
        render: (_, row) => aiEnabledTag(row.ai_enabled, t),
      },
      {
        title: t("monitoring.patrolTasks.columns.schedule"),
        dataIndex: "schedule_interval_sec",
        width: 90,
        search: false,
        render: (_, row) => formatInterval(row.schedule_interval_sec),
      },
      {
        title: t("monitoring.patrolTasks.columns.servers"),
        dataIndex: "server_count",
        width: 80,
        search: false,
      },
      {
        title: t("monitoring.patrolTasks.columns.nextRun"),
        dataIndex: "next_run_at",
        width: 170,
        search: false,
        render: (_, row) =>
          row.status === "running" && row.next_run_at
            ? formatDateTime(row.next_run_at)
            : "—",
      },
      {
        title: t("monitoring.patrolTasks.columns.lastRound"),
        dataIndex: "last_round_at",
        width: 170,
        search: false,
        render: (_, row) =>
          row.last_round_at ? formatDateTime(row.last_round_at) : "—",
      },
      {
        title: t("common.actions"),
        width: 160,
        fixed: "right",
        search: false,
        render: (_, row) => {
          const moreItems: MenuProps["items"] = [
            {
              key: "edit",
              label: t("common.edit"),
              disabled: row.status === "running",
              onClick: () => setEditTask(row),
            },
            {
              key: "records",
              label: (
                <Link to={`/monitoring/patrol-records?task_id=${row.id}`}>
                  {t("monitoring.patrolTasks.viewRecords")}
                </Link>
              ),
            },
            {
              key: "delete",
              label: t("common.delete"),
              danger: true,
              disabled: row.status === "running",
              onClick: () => {
                modal.confirm({
                  title: t("monitoring.patrolTasks.deleteConfirm"),
                  okType: "danger",
                  onOk: () => deleteMutation.mutateAsync(row.id),
                });
              },
            },
          ];

          return (
            <Space size={4} wrap={false}>
              {row.status === "stopped" ? (
                <Button type="link" size="small" onClick={() => startMutation.mutate(row.id)}>
                  {t("monitoring.patrolTasks.start")}
                </Button>
              ) : (
                <>
                  <Button type="link" size="small" onClick={() => stopMutation.mutate(row.id)}>
                    {t("monitoring.patrolTasks.stop")}
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    icon={<ThunderboltOutlined />}
                    title={t("monitoring.patrolTasks.runNow")}
                    loading={runNowMutation.isPending && runNowMutation.variables?.id === row.id}
                    onClick={() => runNowMutation.mutate(row)}
                  />
                </>
              )}
              <Dropdown menu={{ items: moreItems }} trigger={["click"]}>
                <Button type="link" size="small" icon={<MoreOutlined />} />
              </Dropdown>
            </Space>
          );
        },
      },
    ],
    [t, groupOptions, statusValueEnum, startMutation, stopMutation, runNowMutation, deleteMutation, modal],
  );

  const taskForm = (initial?: InternalPatrolTask | null, onFinish?: (v: Record<string, unknown>) => void) => (
    <ProForm
      initialValues={{
        title: initial?.title ?? "",
        description: initial?.description ?? "",
        server_group_name: initial?.server_group_name,
        schedule_interval_sec: initial?.schedule_interval_sec ?? 3600,
        retention_days: initial?.retention_days ?? 30,
        mandatory_hardware: initial?.mandatory_hardware ?? true,
        ai_enabled: initial?.ai_enabled ?? true,
      }}
      onFinish={async (values) => {
        onFinish?.(values);
        return true;
      }}
      submitter={{ searchConfig: { submitText: t("common.save") } }}
    >
      <ProFormText name="title" label={t("monitoring.patrolTasks.form.title")} rules={[{ required: true }]} />
      <ProFormTextArea name="description" label={t("monitoring.patrolTasks.form.description")} />
      <ProFormSelect
        name="server_group_name"
        label={t("monitoring.patrolTasks.form.group")}
        options={groupOptions}
        rules={[{ required: true }]}
        disabled={Boolean(initial)}
      />
      <ProFormDigit
        name="schedule_interval_sec"
        label={t("monitoring.patrolTasks.form.scheduleSec")}
        min={60}
        max={604800}
        fieldProps={{ precision: 0 }}
      />
      <ProFormDigit
        name="retention_days"
        label={t("monitoring.patrolTasks.form.retentionDays")}
        min={1}
        max={365}
        fieldProps={{ precision: 0 }}
      />
      <ProFormSwitch name="mandatory_hardware" label={t("monitoring.patrolTasks.form.mandatoryHardware")} />
      <ProFormSwitch name="ai_enabled" label={t("monitoring.patrolTasks.form.aiEnabled")} />
    </ProForm>
  );

  return (
    <>
      <ModulePageShell
        icon={<FundOutlined style={{ fontSize: 20 }} />}
        title={t("menu.monitoringTasks")}
        subtitle={t("monitoring.patrolTasks.subtitle")}
        action={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t("monitoring.patrolTasks.create")}
          </Button>
        }
      >
        <ModuleTableCard>
          <ProTable<InternalPatrolTask>
            {...moduleProTableProps}
            rowKey="id"
            bordered
            tableLayout="fixed"
            scroll={{ x: PATROL_TASKS_SCROLL_X }}
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

      <Modal
        title={t("monitoring.patrolTasks.create")}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        footer={null}
        destroyOnClose
      >
        {taskForm(null, (v) => createMutation.mutate(v))}
      </Modal>

      <Modal
        title={t("monitoring.patrolTasks.edit")}
        open={Boolean(editTask)}
        onCancel={() => setEditTask(null)}
        footer={null}
        destroyOnClose
      >
        {editTask && taskForm(editTask, (v) => updateMutation.mutate({ id: editTask.id, body: v }))}
      </Modal>

      <PatrolRunProgressModal
        open={runProgress.open}
        taskId={runProgress.taskId}
        taskTitle={runProgress.taskTitle}
        roundId={runProgress.roundId}
        onClose={closeRunProgress}
        onComplete={handleRunProgressComplete}
      />
    </>
  );
}