import {
  ProForm,
  ProFormDateTimePicker,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { PlusOutlined, SwapOutlined } from "@ant-design/icons";
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
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";

type ChangeTaskRow = {
  id: string;
  title: string;
  status: string;
  risk_tier: string | null;
  maintenance_window: string | null;
  rollback_plan: string | null;
};

export function ChangeTasksPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ChangeTaskRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["change-tasks"],
    queryFn: () => api<{ items: ChangeTaskRow[] }>("/api/ops-duty/changes"),
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
        maintenance_window: toIsoDateTime(values.maintenance_window),
        linked_problem_ids: [],
      };
      if (id) {
        return api(`/api/ops-duty/changes/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      }
      return api("/api/ops-duty/changes", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["change-tasks"] });
      message.success(t("opsDuty.changes.saved"));
      setFormOpen(false);
      setEditing(null);
    },
    onError: () => message.error(t("common.error")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/api/ops-duty/changes/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["change-tasks"] });
      message.success(t("opsDuty.changes.deleted"));
    },
    onError: () => message.error(t("common.error")),
  });

  const columns = useMemo<ProColumns<ChangeTaskRow>[]>(
    () => [
      { title: t("opsDuty.changes.columns.title"), dataIndex: "title", ellipsis: true },
      {
        title: t("opsDuty.changes.columns.riskTier"),
        dataIndex: "risk_tier",
        width: 100,
        render: (_, row) => (row.risk_tier ? <Tag>{row.risk_tier}</Tag> : "—"),
      },
      {
        title: t("opsDuty.changes.columns.status"),
        dataIndex: "status",
        width: 120,
        render: (_, row) => <Tag>{row.status}</Tag>,
      },
      {
        title: t("opsDuty.changes.columns.window"),
        dataIndex: "maintenance_window",
        valueType: "dateTime",
        width: 170,
        search: false,
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
              setFormOpen(true);
            }}
          >
            {t("common.edit")}
          </Button>,
          <ConfirmDeleteButton
            key="delete"
            title={t("opsDuty.changes.deleteConfirm")}
            onConfirm={() => deleteMutation.mutate(row.id)}
          />,
        ],
      },
    ],
    [deleteMutation, t],
  );

  const formInitialValues = editing
    ? {
        title: editing.title,
        risk_tier: editing.risk_tier,
        status: editing.status,
        maintenance_window: editing.maintenance_window,
        rollback_plan: editing.rollback_plan,
      }
    : { status: "planned", risk_tier: "L2" };

  return (
    <ModulePageShell
      icon={<SwapOutlined style={{ fontSize: 20 }} />}
      title={t("opsDuty.changes.title")}
      subtitle={t("opsDuty.changes.subtitle")}
      action={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(null); setFormOpen(true); }}>
          {t("opsDuty.changes.add")}
        </Button>
      }
    >
      <ModuleTableCard>
        <ProTable<ChangeTaskRow>
          {...moduleProTableProps}
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={data?.items ?? []}
          search={moduleTableSearch()}
          pagination={moduleTablePagination}
          locale={{ emptyText: t("opsDuty.changes.empty") }}
          toolBarRender={() => []}
        />
      </ModuleTableCard>

      <ModuleFormDrawer
        title={editing ? t("opsDuty.changes.edit") : t("opsDuty.changes.add")}
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditing(null); }}
        width={520}
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
          <ProFormText name="title" label={t("opsDuty.changes.columns.title")} rules={[{ required: true }]} />
          <ProFormSelect
            name="risk_tier"
            label={t("opsDuty.changes.columns.riskTier")}
            options={["L1", "L2", "L3"].map((v) => ({ label: v, value: v }))}
          />
          <ProFormSelect
            name="status"
            label={t("opsDuty.changes.columns.status")}
            options={["planned", "approved", "in_progress", "completed", "rolled_back", "cancelled"].map((v) => ({
              label: v,
              value: v,
            }))}
          />
          <ProFormDateTimePicker name="maintenance_window" label={t("opsDuty.changes.columns.window")} />
          <ProFormTextArea name="rollback_plan" label={t("opsDuty.changes.columns.rollback")} />
        </ProForm>
      </ModuleFormDrawer>
    </ModulePageShell>
  );
}