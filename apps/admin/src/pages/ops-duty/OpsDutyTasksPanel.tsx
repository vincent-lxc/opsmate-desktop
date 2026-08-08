import {
  ProForm,
  ProFormDateTimePicker,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { App, Button, Modal, Space, Tabs, Tag, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, toIsoDateTime } from "../../api/client";
import { ConfirmDeleteButton } from "../../components/ConfirmDeleteButton";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import {
  moduleNestedTableProps,
  moduleProTableProps,
  moduleTableDetailIndent,
  moduleTableExpandable,
  moduleTablePagination,
  moduleTableSearch,
  moduleTabsInCardStyle,
} from "../../components/module-table-styles";
import { formatDateTime } from "../../utils/datetime";

type TaskRow = {
  id: string;
  template_id: string | null;
  title: string;
  cadence: string;
  due_at: string | null;
  status: string;
  assignee: string | null;
  created_at: string;
};

type RunRow = {
  id: string;
  task_id: string;
  status: string;
  notes: string | null;
  completed_at: string | null;
  created_at: string;
};

type DailySuggestion = {
  title: string;
  cadence: string;
  due_at: string;
  assignee: string | null;
  source: string;
  source_id: string;
};

const CADENCES = ["daily", "weekly", "monthly"] as const;
const TASK_STATUSES = ["pending", "in_progress", "completed", "skipped", "cancelled"] as const;

const EXPANDED_DETAIL_CLASS = "module-table-detail-panel";
const EXPANDED_DETAIL_STYLE = { paddingLeft: moduleTableDetailIndent } as const;

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "success";
    case "in_progress":
      return "processing";
    case "skipped":
      return "default";
    case "cancelled":
      return "error";
    default:
      return "warning";
  }
}

function TaskRunsExpand({ taskId }: { taskId: string }) {
  const { t } = useTranslation();

  const { data, isLoading } = useQuery({
    queryKey: ["ops-duty-runs", taskId],
    queryFn: () => api<{ items: RunRow[] }>(`/api/ops-duty/tasks/${taskId}/runs`),
  });

  return (
    <div className={EXPANDED_DETAIL_CLASS} style={EXPANDED_DETAIL_STYLE}>
      <ProTable<RunRow>
        {...moduleNestedTableProps}
        rowKey="id"
        loading={isLoading}
        dataSource={data?.items ?? []}
        locale={{ emptyText: t("opsDuty.tasks.runsEmpty") }}
        columns={[
          {
            title: t("opsDuty.tasks.columns.runStatus"),
            dataIndex: "status",
            width: 120,
            render: (_, row) => (
              <Tag color={statusColor(row.status)}>
                {t(`opsDuty.tasks.status.${row.status}`, { defaultValue: row.status })}
              </Tag>
            ),
          },
          {
            title: t("opsDuty.tasks.columns.runNotes"),
            dataIndex: "notes",
            ellipsis: true,
            render: (_, row) => row.notes ?? "—",
          },
          {
            title: t("opsDuty.tasks.columns.completedAt"),
            dataIndex: "completed_at",
            width: 180,
            render: (_, row) =>
              row.completed_at ? formatDateTime(row.completed_at) : "—",
          },
        ]}
      />
    </div>
  );
}

export function useOpsDutyTasksSection(): { headerActions: ReactNode; content: ReactNode } {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<string>("daily");
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskRow | null>(null);
  const [runTask, setRunTask] = useState<TaskRow | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<DailySuggestion[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["ops-duty-tasks", tab],
    queryFn: () => api<{ items: TaskRow[] }>(`/api/ops-duty/tasks?cadence=${tab}`),
  });

  const invalidateTasks = () => {
    void queryClient.invalidateQueries({ queryKey: ["ops-duty-tasks"] });
    void queryClient.invalidateQueries({ queryKey: ["ops-duty-runs"] });
  };

  const saveTaskMutation = useMutation({
    mutationFn: async ({
      id,
      values,
    }: {
      id?: string;
      values: Record<string, unknown>;
    }) => {
      const payload = {
        ...values,
        cadence: values.cadence ?? tab,
        due_at: toIsoDateTime(values.due_at),
        assignee: values.assignee || null,
      };
      if (id) {
        return api(`/api/ops-duty/tasks/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      }
      return api("/api/ops-duty/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      invalidateTasks();
      message.success(t("opsDuty.tasks.saved"));
      setTaskFormOpen(false);
      setEditingTask(null);
    },
    onError: () => message.error(t("common.error")),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (id: string) => api(`/api/ops-duty/tasks/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateTasks();
      message.success(t("opsDuty.tasks.deleted"));
    },
    onError: () => message.error(t("common.error")),
  });

  const recordRunMutation = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      if (!runTask) return;
      return api(`/api/ops-duty/tasks/${runTask.id}/runs`, {
        method: "POST",
        body: JSON.stringify(values),
      });
    },
    onSuccess: () => {
      invalidateTasks();
      message.success(t("opsDuty.tasks.runRecorded"));
      setRunTask(null);
    },
    onError: () => message.error(t("common.error")),
  });

  const suggestMutation = useMutation({
    mutationFn: () =>
      api<{ suggestions: DailySuggestion[] }>("/api/ops-duty/suggest/daily-tasks", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    onSuccess: (result) => {
      setSuggestions(result.suggestions ?? []);
      setSuggestOpen(true);
    },
    onError: () => message.error(t("common.error")),
  });

  const applySuggestionsMutation = useMutation({
    mutationFn: () =>
      api<{ created: number }>("/api/ops-duty/suggest/daily-tasks/apply", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    onSuccess: (result) => {
      invalidateTasks();
      setSuggestOpen(false);
      setSuggestions([]);
      message.success(t("opsDuty.tasks.suggestionsApplied", { count: result.created }));
    },
    onError: () => message.error(t("common.error")),
  });

  const columns = useMemo<ProColumns<TaskRow>[]>(
    () => [
      { title: t("opsDuty.tasks.columns.title"), dataIndex: "title", ellipsis: true },
      {
        title: t("opsDuty.tasks.columns.status"),
        dataIndex: "status",
        width: 130,
        render: (_, row) => (
          <Tag color={statusColor(row.status)}>
            {t(`opsDuty.tasks.status.${row.status}`, { defaultValue: row.status })}
          </Tag>
        ),
      },
      {
        title: t("opsDuty.tasks.columns.dueAt"),
        dataIndex: "due_at",
        width: 180,
        search: false,
        render: (_, row) => (row.due_at ? formatDateTime(row.due_at) : "—"),
      },
      {
        title: t("opsDuty.tasks.columns.assignee"),
        dataIndex: "assignee",
        width: 140,
        render: (_, row) => row.assignee ?? "—",
      },
      {
        title: t("common.actions"),
        width: 220,
        fixed: "right",
        search: false,
        valueType: "option",
        render: (_, row) => [
          <Button
            key="edit"
            type="link"
            size="small"
            onClick={() => {
              setEditingTask(row);
              setTaskFormOpen(true);
            }}
          >
            {t("common.edit")}
          </Button>,
          <Button key="run" type="link" size="small" onClick={() => setRunTask(row)}>
            {t("opsDuty.tasks.recordRun")}
          </Button>,
          <ConfirmDeleteButton
            key="delete"
            title={t("opsDuty.tasks.deleteConfirm")}
            onConfirm={() => deleteTaskMutation.mutate(row.id)}
          />,
        ],
      },
    ],
    [deleteTaskMutation, t],
  );

  const taskFormInitialValues = editingTask
    ? {
        title: editingTask.title,
        cadence: editingTask.cadence,
        status: editingTask.status,
        due_at: editingTask.due_at,
        assignee: editingTask.assignee ?? "",
      }
    : {
        cadence: tab,
        status: "pending",
        assignee: "",
      };

  const suggestColumns = useMemo<ProColumns<DailySuggestion>[]>(
    () => [
      { title: t("opsDuty.tasks.columns.title"), dataIndex: "title", ellipsis: true },
      {
        title: t("opsDuty.tasks.columns.source"),
        dataIndex: "source",
        width: 120,
        render: (_, row) => t(`opsDuty.tasks.sources.${row.source}`, { defaultValue: row.source }),
      },
      {
        title: t("opsDuty.tasks.columns.dueAt"),
        dataIndex: "due_at",
        width: 180,
        render: (_, row) => formatDateTime(row.due_at),
      },
    ],
    [t],
  );

  const headerActions = (
    <Space>
      <Button
        icon={<ThunderboltOutlined />}
        loading={suggestMutation.isPending}
        onClick={() => suggestMutation.mutate()}
      >
        {t("opsDuty.tasks.suggest")}
      </Button>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => {
          setEditingTask(null);
          setTaskFormOpen(true);
        }}
      >
        {t("opsDuty.tasks.add")}
      </Button>
    </Space>
  );

  const content = (
    <>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        style={moduleTabsInCardStyle}
        items={CADENCES.map((cadence) => ({
          key: cadence,
          label: t(`opsDuty.checklists.tabs.${cadence}`),
        }))}
      />
      <ProTable<TaskRow>
        {...moduleProTableProps}
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={data?.items ?? []}
        search={moduleTableSearch()}
        pagination={moduleTablePagination}
        locale={{ emptyText: t("opsDuty.tasks.empty") }}
        expandable={{
          ...moduleTableExpandable,
          expandedRowRender: (row) => <TaskRunsExpand taskId={row.id} />,
        }}
      />

      <ModuleFormDrawer
        title={editingTask ? t("opsDuty.tasks.edit") : t("opsDuty.tasks.add")}
        open={taskFormOpen}
        onClose={() => {
          setTaskFormOpen(false);
          setEditingTask(null);
        }}
        width={520}
      >
        <ProForm
          key={editingTask?.id ?? "new-task"}
          initialValues={taskFormInitialValues}
          onFinish={async (values) => {
            await saveTaskMutation.mutateAsync({ id: editingTask?.id, values });
            return true;
          }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
        >
          <ProFormText
            name="title"
            label={t("opsDuty.tasks.columns.title")}
            rules={[{ required: true }]}
          />
          <ProFormSelect
            name="cadence"
            label={t("opsDuty.checklists.columns.cadence")}
            options={CADENCES.map((c) => ({
              label: t(`opsDuty.checklists.tabs.${c}`),
              value: c,
            }))}
            rules={[{ required: true }]}
          />
          <ProFormSelect
            name="status"
            label={t("opsDuty.tasks.columns.status")}
            options={TASK_STATUSES.map((status) => ({
              label: t(`opsDuty.tasks.status.${status}`),
              value: status,
            }))}
          />
          <ProFormDateTimePicker name="due_at" label={t("opsDuty.tasks.columns.dueAt")} />
          <ProFormText name="assignee" label={t("opsDuty.tasks.columns.assignee")} />
        </ProForm>
      </ModuleFormDrawer>

      <ModuleFormDrawer
        title={t("opsDuty.tasks.recordRun")}
        open={!!runTask}
        onClose={() => setRunTask(null)}
        width={480}
      >
        {runTask ? (
          <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
            {runTask.title}
          </Typography.Paragraph>
        ) : null}
        <ProForm
          key={runTask?.id ?? "run"}
          initialValues={{ status: "completed" }}
          onFinish={async (values) => {
            await recordRunMutation.mutateAsync(values);
            return true;
          }}
          submitter={{ searchConfig: { submitText: t("opsDuty.tasks.recordRun") } }}
        >
          <ProFormSelect
            name="status"
            label={t("opsDuty.tasks.columns.runStatus")}
            options={TASK_STATUSES.map((status) => ({
              label: t(`opsDuty.tasks.status.${status}`),
              value: status,
            }))}
            rules={[{ required: true }]}
          />
          <ProFormTextArea name="notes" label={t("opsDuty.tasks.columns.runNotes")} />
        </ProForm>
      </ModuleFormDrawer>

      <Modal
        title={t("opsDuty.tasks.suggestTitle")}
        open={suggestOpen}
        onCancel={() => {
          setSuggestOpen(false);
          setSuggestions([]);
        }}
        width={720}
        footer={
          <Space>
            <Button onClick={() => setSuggestOpen(false)}>{t("common.cancel")}</Button>
            <Button
              type="primary"
              loading={applySuggestionsMutation.isPending}
              onClick={() => applySuggestionsMutation.mutate()}
            >
              {t("opsDuty.tasks.applySuggestions")}
            </Button>
          </Space>
        }
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          {t("opsDuty.tasks.suggestHint")}
        </Typography.Paragraph>
        <ProTable<DailySuggestion>
          {...moduleNestedTableProps}
          rowKey={(row) => `${row.source}-${row.source_id}`}
          dataSource={suggestions}
          columns={suggestColumns}
          pagination={false}
          locale={{ emptyText: t("opsDuty.tasks.suggestionsEmpty") }}
        />
      </Modal>
    </>
  );

  return { headerActions, content };
}