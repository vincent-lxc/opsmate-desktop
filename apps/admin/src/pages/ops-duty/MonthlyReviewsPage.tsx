import {
  ProForm,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { FileTextOutlined, PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { App, Button, Space, Tag, Typography } from "antd";
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
  moduleTableDetailIndent,
  moduleTableExpandable,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";

type ReviewRow = {
  id: string;
  period: string;
  status: string;
  draft_markdown: string;
  created_at: string;
};

const EXPANDED_DETAIL_CLASS = "module-table-detail-panel";
const EXPANDED_DETAIL_STYLE = { paddingLeft: moduleTableDetailIndent } as const;

function ReviewDraftExpand({ draft }: { draft: string }) {
  return (
    <div className={EXPANDED_DETAIL_CLASS} style={EXPANDED_DETAIL_STYLE}>
      <Typography.Paragraph
        style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 13 }}
      >
        {draft || "—"}
      </Typography.Paragraph>
    </div>
  );
}

export function MonthlyReviewsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ReviewRow | null>(null);
  const [suggestValues, setSuggestValues] = useState<Record<string, unknown> | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["monthly-reviews"],
    queryFn: () => api<{ items: ReviewRow[] }>("/api/ops-duty/reviews"),
  });

  const saveMutation = useMutation({
    mutationFn: async ({
      id,
      values,
    }: {
      id?: string;
      values: Record<string, unknown>;
    }) => {
      if (id) {
        return api(`/api/ops-duty/reviews/${id}`, {
          method: "PATCH",
          body: JSON.stringify(values),
        });
      }
      return api("/api/ops-duty/reviews", {
        method: "POST",
        body: JSON.stringify(values),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["monthly-reviews"] });
      message.success(t("opsDuty.reviews.saved"));
      setFormOpen(false);
      setEditing(null);
      setSuggestValues(null);
    },
    onError: () => message.error(t("common.error")),
  });

  const suggestMutation = useMutation({
    mutationFn: () =>
      api<{ suggestion: Record<string, unknown> }>("/api/ops-duty/suggest/monthly-review", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (result) => {
      setEditing(null);
      setSuggestValues(result.suggestion);
      setFormOpen(true);
    },
    onError: () => message.error(t("common.error")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/api/ops-duty/reviews/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["monthly-reviews"] });
      message.success(t("opsDuty.reviews.deleted"));
    },
    onError: () => message.error(t("common.error")),
  });

  const columns = useMemo<ProColumns<ReviewRow>[]>(
    () => [
      { title: t("opsDuty.reviews.columns.period"), dataIndex: "period", width: 140 },
      {
        title: t("opsDuty.reviews.columns.status"),
        dataIndex: "status",
        width: 120,
        render: (_, row) => <Tag>{row.status}</Tag>,
      },
      {
        title: t("opsDuty.reviews.columns.updatedAt"),
        dataIndex: "created_at",
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
              setSuggestValues(null);
              setFormOpen(true);
            }}
          >
            {t("common.edit")}
          </Button>,
          <ConfirmDeleteButton
            key="delete"
            title={t("opsDuty.reviews.deleteConfirm")}
            onConfirm={() => deleteMutation.mutate(row.id)}
          />,
        ],
      },
    ],
    [t, deleteMutation],
  );

  return (
    <ModulePageShell
      icon={<FileTextOutlined style={{ fontSize: 20 }} />}
      title={t("opsDuty.reviews.title")}
      subtitle={t("opsDuty.reviews.subtitle")}
      action={
        <Space>
          <Button
            icon={<ThunderboltOutlined />}
            loading={suggestMutation.isPending}
            onClick={() => suggestMutation.mutate()}
          >
            {t("opsDuty.reviews.suggest")}
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
            {t("opsDuty.reviews.add")}
          </Button>
        </Space>
      }
    >
      <ModuleTableCard>
        <ProTable<ReviewRow>
          {...moduleProTableProps}
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={data?.items ?? []}
          search={moduleTableSearch()}
          pagination={moduleTablePagination}
          locale={{ emptyText: t("opsDuty.reviews.empty") }}
          expandable={{
            ...moduleTableExpandable,
            rowExpandable: (row) => Boolean(row.draft_markdown?.trim()),
            expandedRowRender: (row) => <ReviewDraftExpand draft={row.draft_markdown} />,
          }}
        />
      </ModuleTableCard>

      <ModuleFormDrawer
        title={editing ? t("opsDuty.reviews.edit") : t("opsDuty.reviews.add")}
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
          setSuggestValues(null);
        }}
        width={640}
      >
        <ProForm
          key={editing?.id ?? "new"}
          initialValues={
            editing ?? suggestValues ?? { status: "draft", period: "", draft_markdown: "" }
          }
          onFinish={async (values) => {
            await saveMutation.mutateAsync({ id: editing?.id, values });
            return true;
          }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
        >
          <ProFormText
            name="period"
            label={t("opsDuty.reviews.columns.period")}
            rules={[{ required: true }]}
            placeholder="2026-06"
          />
          <ProFormSelect
            name="status"
            label={t("opsDuty.reviews.columns.status")}
            options={["draft", "reviewing", "finalized"].map((v) => ({ label: v, value: v }))}
          />
          <ProFormTextArea
            name="draft_markdown"
            label={t("opsDuty.reviews.columns.draft")}
            fieldProps={{ rows: 16, style: { fontFamily: "monospace" } }}
          />
        </ProForm>
      </ModuleFormDrawer>
    </ModulePageShell>
  );
}