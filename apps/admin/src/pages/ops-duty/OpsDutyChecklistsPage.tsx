import {
  ProForm,
  ProFormList,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { PlusOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { App, Button, Space, Tabs } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { ConfirmDeleteButton } from "../../components/ConfirmDeleteButton";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import { useOpsDutyTasksSection } from "./OpsDutyTasksPanel";
import {
  moduleNestedTableProps,
  moduleProTableProps,
  moduleTableDetailIndent,
  moduleTableExpandable,
  moduleTablePagination,
  moduleTableSearch,
  moduleTabsInCardStyle,
} from "../../components/module-table-styles";

type ChecklistItem = {
  label?: string;
  title?: string;
  description?: string;
};

type TemplateRow = {
  id: string;
  title: string;
  cadence: string;
  owner: string | null;
  enabled: boolean;
  items_json?: ChecklistItem[];
};

const CADENCES = ["daily", "weekly", "monthly"] as const;

const EXPANDED_DETAIL_CLASS = "module-table-detail-panel";
const EXPANDED_DETAIL_STYLE = { paddingLeft: moduleTableDetailIndent } as const;

function ChecklistItemsExpand({ items }: { items: ChecklistItem[] }) {
  const { t } = useTranslation();

  return (
    <div className={EXPANDED_DETAIL_CLASS} style={EXPANDED_DETAIL_STYLE}>
      <ProTable<ChecklistItem & { key: number }>
        {...moduleNestedTableProps}
        rowKey="key"
        dataSource={items.map((item, index) => ({ ...item, key: index }))}
        locale={{ emptyText: t("opsDuty.checklists.itemsEmpty") }}
        columns={[
          {
            title: t("opsDuty.checklists.columns.itemLabel"),
            dataIndex: "label",
            render: (_, row) => row.label ?? row.title ?? "—",
          },
          {
            title: t("opsDuty.checklists.columns.itemDescription"),
            dataIndex: "description",
            ellipsis: true,
            render: (_, row) => row.description ?? "—",
          },
        ]}
      />
    </div>
  );
}

export function OpsDutyChecklistsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [section, setSection] = useState<"tasks" | "templates">("tasks");
  const [tab, setTab] = useState<string>("daily");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const tasksSection = useOpsDutyTasksSection();

  const { data, isLoading } = useQuery({
    queryKey: ["ops-duty-templates"],
    queryFn: () => api<{ items: TemplateRow[] }>("/api/ops-duty/templates"),
  });

  const filtered = useMemo(
    () => (data?.items ?? []).filter((row) => row.cadence === tab),
    [data?.items, tab],
  );

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
        owner: values.owner || null,
        items_json: values.items_json ?? [],
      };
      if (id) {
        return api(`/api/ops-duty/templates/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      }
      return api("/api/ops-duty/templates", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ops-duty-templates"] });
      message.success(t("opsDuty.checklists.saved"));
      setFormOpen(false);
      setEditing(null);
    },
    onError: () => message.error(t("common.error")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api(`/api/ops-duty/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ops-duty-templates"] });
      message.success(t("opsDuty.checklists.deleted"));
    },
    onError: () => message.error(t("common.error")),
  });

  const columns = useMemo<ProColumns<TemplateRow>[]>(
    () => [
      { title: t("opsDuty.checklists.columns.title"), dataIndex: "title", ellipsis: true },
      { title: t("opsDuty.checklists.columns.owner"), dataIndex: "owner", width: 140 },
      {
        title: t("opsDuty.checklists.columns.items"),
        dataIndex: "items_json",
        width: 80,
        search: false,
        render: (_, row) => row.items_json?.length ?? 0,
      },
      {
        title: t("opsDuty.checklists.columns.enabled"),
        dataIndex: "enabled",
        width: 90,
        render: (_, row) => (row.enabled ? t("common.yes") : t("common.no")),
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
            title={t("opsDuty.checklists.deleteConfirm")}
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
        cadence: editing.cadence,
        owner: editing.owner ?? "",
        enabled: editing.enabled,
        items_json: editing.items_json ?? [],
      }
    : { cadence: tab, enabled: true, owner: "", items_json: [] };

  return (
    <ModulePageShell
      icon={<UnorderedListOutlined style={{ fontSize: 20 }} />}
      title={t("opsDuty.checklists.title")}
      subtitle={t("opsDuty.checklists.subtitle")}
      action={
        section === "tasks" ? (
          tasksSection.headerActions
        ) : (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            {t("opsDuty.checklists.add")}
          </Button>
        )
      }
    >
      <ModuleTableCard>
        <Tabs
          activeKey={section}
          onChange={(key) => setSection(key as "tasks" | "templates")}
          style={moduleTabsInCardStyle}
          items={[
            { key: "tasks", label: t("opsDuty.tasks.section") },
            { key: "templates", label: t("opsDuty.checklists.sectionTemplates") },
          ]}
        />
        {section === "tasks" ? (
          tasksSection.content
        ) : (
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
            <ProTable<TemplateRow>
              {...moduleProTableProps}
              rowKey="id"
              loading={isLoading}
              columns={columns}
              dataSource={filtered}
              search={moduleTableSearch()}
              pagination={moduleTablePagination}
              locale={{ emptyText: t("opsDuty.checklists.empty") }}
              expandable={{
                ...moduleTableExpandable,
                rowExpandable: (row) => (row.items_json?.length ?? 0) > 0,
                expandedRowRender: (row) => (
                  <ChecklistItemsExpand items={row.items_json ?? []} />
                ),
              }}
            />
          </>
        )}
      </ModuleTableCard>

      <ModuleFormDrawer
        title={editing ? t("opsDuty.checklists.edit") : t("opsDuty.checklists.add")}
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
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
          <ProFormText
            name="title"
            label={t("opsDuty.checklists.columns.title")}
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
          <ProFormText name="owner" label={t("opsDuty.checklists.columns.owner")} />
          <ProFormSwitch name="enabled" label={t("opsDuty.checklists.columns.enabled")} />
          <ProFormList
            name="items_json"
            label={t("opsDuty.checklists.columns.items")}
            creatorButtonProps={{ creatorButtonText: t("opsDuty.checklists.addItem") }}
          >
            <ProFormText name="label" label={t("opsDuty.checklists.columns.itemLabel")} />
            <ProFormText name="description" label={t("opsDuty.checklists.columns.itemDescription")} />
          </ProFormList>
        </ProForm>
      </ModuleFormDrawer>
    </ModulePageShell>
  );
}