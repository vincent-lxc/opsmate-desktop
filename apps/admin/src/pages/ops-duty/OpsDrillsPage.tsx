import {
  ProForm,
  ProFormDateTimePicker,
  ProFormList,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { ExperimentOutlined, PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { App, Button, Space, Tag } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, toIsoDateTime } from "../../api/client";
import { ConfirmDeleteButton } from "../../components/ConfirmDeleteButton";
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

type DrillStep = {
  title?: string;
  label?: string;
  description?: string;
};

type DrillRow = {
  id: string;
  title: string;
  status: string;
  scheduled_at: string | null;
  approval_status: string;
  review_notes: string | null;
  steps_json?: DrillStep[];
};

const EXPANDED_DETAIL_CLASS = "module-table-detail-panel";
const EXPANDED_DETAIL_STYLE = { paddingLeft: moduleTableDetailIndent } as const;

function DrillStepsExpand({ steps }: { steps: DrillStep[] }) {
  const { t } = useTranslation();

  return (
    <div className={EXPANDED_DETAIL_CLASS} style={EXPANDED_DETAIL_STYLE}>
      <ProTable<DrillStep & { key: number }>
        {...moduleNestedTableProps}
        rowKey="key"
        dataSource={steps.map((step, index) => ({ ...step, key: index }))}
        locale={{ emptyText: t("opsDuty.drills.stepsEmpty") }}
        columns={[
          {
            title: t("opsDuty.drills.columns.stepTitle"),
            dataIndex: "title",
            render: (_, row) => row.title ?? row.label ?? "—",
          },
          {
            title: t("opsDuty.drills.columns.stepDescription"),
            dataIndex: "description",
            ellipsis: true,
            render: (_, row) => row.description ?? "—",
          },
        ]}
      />
    </div>
  );
}

export function OpsDrillsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DrillRow | null>(null);
  const [suggestValues, setSuggestValues] = useState<Record<string, unknown> | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["ops-drills"],
    queryFn: () => api<{ items: DrillRow[] }>("/api/ops-duty/drills"),
  });

  const saveMutation = useMutation({
    mutationFn: async ({
      id,
      values,
    }: {
      id?: string;
      values: Record<string, unknown>;
    }) => {
      const payload = {
        ...values,
        scheduled_at: toIsoDateTime(values.scheduled_at),
        steps_json: values.steps_json ?? [],
      };
      if (id) {
        return api(`/api/ops-duty/drills/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      }
      return api("/api/ops-duty/drills", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ops-drills"] });
      message.success(t("opsDuty.drills.saved"));
      setFormOpen(false);
      setEditing(null);
      setSuggestValues(null);
    },
    onError: () => message.error(t("common.error")),
  });

  const suggestMutation = useMutation({
    mutationFn: () =>
      api<{ suggestion: Record<string, unknown> }>("/api/ops-duty/suggest/drill", {
        method: "POST",
        body: JSON.stringify({ lookback_days: 14 }),
      }),
    onSuccess: (result) => {
      setEditing(null);
      setSuggestValues(result.suggestion);
      setFormOpen(true);
    },
    onError: () => message.error(t("common.error")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/api/ops-duty/drills/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ops-drills"] });
      message.success(t("opsDuty.drills.deleted"));
    },
    onError: () => message.error(t("common.error")),
  });

  const columns = useMemo<ProColumns<DrillRow>[]>(
    () => [
      { title: t("opsDuty.drills.columns.title"), dataIndex: "title", ellipsis: true },
      {
        title: t("opsDuty.drills.columns.status"),
        dataIndex: "status",
        width: 120,
        render: (_, row) => <Tag>{row.status}</Tag>,
      },
      {
        title: t("opsDuty.drills.columns.approval"),
        dataIndex: "approval_status",
        width: 120,
        render: (_, row) => (
          <Tag color={row.approval_status === "approved" ? "green" : "gold"}>
            {row.approval_status}
          </Tag>
        ),
      },
      {
        title: t("opsDuty.drills.columns.scheduledAt"),
        dataIndex: "scheduled_at",
        valueType: "dateTime",
        width: 170,
        search: false,
      },
      {
        title: t("opsDuty.drills.columns.steps"),
        dataIndex: "steps_json",
        width: 80,
        search: false,
        render: (_, row) => row.steps_json?.length ?? 0,
      },
      {
        title: t("common.actions"),
        width: 140,
        fixed: "right",
        search: false,
        valueType: "option",
        render: (_, row) => [
          <Button
            key="edit"
            type="link"
            size="small"
            onClick={() => {
              setEditing(row);
              setSuggestValues(null);
              setFormOpen(true);
            }}
          >
            {t("common.edit")}
          </Button>,
          <ConfirmDeleteButton
            key="delete"
            title={t("opsDuty.drills.deleteConfirm")}
            onConfirm={() => deleteMutation.mutate(row.id)}
          />,
        ],
      },
    ],
    [t, deleteMutation],
  );

  const formInitialValues = editing
    ? {
        title: editing.title,
        status: editing.status,
        approval_status: editing.approval_status,
        scheduled_at: editing.scheduled_at,
        review_notes: editing.review_notes,
        steps_json: editing.steps_json ?? [],
      }
    : (suggestValues ?? { status: "planned", approval_status: "pending", steps_json: [] });

  return (
    <ModulePageShell
      icon={<ExperimentOutlined style={{ fontSize: 20 }} />}
      title={t("opsDuty.drills.title")}
      subtitle={t("opsDuty.drills.subtitle")}
      action={
        <Space>
          <Button
            icon={<ThunderboltOutlined />}
            loading={suggestMutation.isPending}
            onClick={() => suggestMutation.mutate()}
          >
            {t("opsDuty.drills.suggest")}
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setSuggestValues(null);
              setFormOpen(true);
            }}
          >
            {t("opsDuty.drills.add")}
          </Button>
        </Space>
      }
    >
      <ModuleTableCard>
        <ProTable<DrillRow>
          {...moduleProTableProps}
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={data?.items ?? []}
          search={moduleTableSearch()}
          pagination={moduleTablePagination}
          locale={{ emptyText: t("opsDuty.drills.empty") }}
          expandable={{
            ...moduleTableExpandable,
            rowExpandable: (row) => (row.steps_json?.length ?? 0) > 0,
            expandedRowRender: (row) => (
              <DrillStepsExpand steps={row.steps_json ?? []} />
            ),
          }}
        />
      </ModuleTableCard>

      <ModuleFormDrawer
        title={editing ? t("opsDuty.drills.edit") : t("opsDuty.drills.add")}
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
          setSuggestValues(null);
        }}
        width={560}
      >
        <ProForm
          key={editing?.id ?? "new"}
          initialValues={formInitialValues}
          onFinish={async (values) => {
            await saveMutation.mutateAsync({ id: editing?.id, values });
            return true;
          }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
        >
          <ProFormText
            name="title"
            label={t("opsDuty.drills.columns.title")}
            rules={[{ required: true }]}
          />
          <ProFormSelect
            name="status"
            label={t("opsDuty.drills.columns.status")}
            options={["planned", "scheduled", "in_progress", "completed", "cancelled"].map((v) => ({
              label: v,
              value: v,
            }))}
          />
          <ProFormSelect
            name="approval_status"
            label={t("opsDuty.drills.columns.approval")}
            options={["pending", "approved", "rejected"].map((v) => ({ label: v, value: v }))}
          />
          <ProFormDateTimePicker name="scheduled_at" label={t("opsDuty.drills.columns.scheduledAt")} />
          <ProFormTextArea name="review_notes" label={t("opsDuty.drills.columns.reviewNotes")} />
          <ProFormList
            name="steps_json"
            label={t("opsDuty.drills.columns.steps")}
            creatorButtonProps={{ creatorButtonText: t("opsDuty.drills.addStep") }}
          >
            <ProFormText name="title" label={t("opsDuty.drills.columns.stepTitle")} />
            <ProFormTextArea
              name="description"
              label={t("opsDuty.drills.columns.stepDescription")}
              fieldProps={{ rows: 2 }}
            />
          </ProFormList>
        </ProForm>
      </ModuleFormDrawer>
    </ModulePageShell>
  );
}