import { ProForm, ProFormText, ProFormTextArea, ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { FileTextOutlined, PlusOutlined, ThunderboltOutlined, UploadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Popconfirm, Space, Typography, Upload } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { ConfirmDeleteButton } from "../components/ConfirmDeleteButton";
import { ModuleFormDrawer } from "../components/ModuleFormDrawer";
import { ModulePageShell } from "../components/ModulePageShell";
import { ModuleTableCard } from "../components/ModuleTableCard";
import { ReferencedComponentIssueSummaryTags } from "../components/ReferencedComponentIssueTags";
import { MonitorDependencyManifestSetExpand } from "./MonitorDependencyManifestSetExpand";
import {
  moduleNestedTableProps,
  moduleNestedTablePagination,
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
} from "../components/module-table-styles";
import type { DependencyManifestSet, UploadedManifest } from "../utils/monitoring-types";
import { summarizeReferencedComponentIssues } from "../utils/referenced-component-sort";
import { formatDateTime } from "../utils/datetime";

const ALLOWED_MANIFEST_FILENAMES = new Set([
  "go.mod",
  "go.sum",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "requirements.txt",
  "Pipfile",
  "poetry.lock",
  "Gemfile",
  "Gemfile.lock",
  "Cargo.toml",
  "Cargo.lock",
  "composer.json",
  "composer.lock",
]);

type StagedManifest = { filename: string; content: string };

export function MonitorDependencyManifestsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const manifestSetFilterId = searchParams.get("manifest_set_id");
  const [createOpen, setCreateOpen] = useState(false);
  const [editSet, setEditSet] = useState<DependencyManifestSet | null>(null);
  const [stagedManifests, setStagedManifests] = useState<StagedManifest[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["dependency-manifest-sets"],
    queryFn: () => api<{ items: DependencyManifestSet[] }>("/api/monitoring/dependency-manifest-sets"),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["dependency-manifest-sets"] });
    void queryClient.invalidateQueries({ queryKey: ["monitoring-applications"] });
  };

  const saveMutation = useMutation({
    mutationFn: async (payload: {
      id?: string;
      name: string;
      description?: string | null;
      manifests: StagedManifest[];
    }) => {
      const body = {
        name: payload.name,
        description: payload.description ?? null,
        manifests: payload.manifests,
        propagate: true,
      };
      if (payload.id) {
        return api<{ set: DependencyManifestSet; profiles_updated: number }>(
          `/api/monitoring/dependency-manifest-sets/${payload.id}`,
          { method: "PATCH", body: JSON.stringify(body) },
        );
      }
      return api<DependencyManifestSet>("/api/monitoring/dependency-manifest-sets", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (result) => {
      const updated =
        "profiles_updated" in result ? result.profiles_updated : 0;
      message.success(
        updated > 0
          ? t("monitoring.dependencyManifests.savedWithPropagate", { count: updated })
          : t("monitoring.dependencyManifests.saved"),
      );
      setCreateOpen(false);
      setEditSet(null);
      setStagedManifests([]);
      refresh();
    },
    onError: () => message.error(t("common.error")),
  });

  const aiEnrichMutation = useMutation({
    mutationFn: (setId: string) =>
      api<{ summary?: string }>(`/api/monitoring/dependency-manifest-sets/${setId}/ai-enrich`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      message.success(
        data.summary
          ? t("monitoring.dependencyManifests.aiEnrichSuccessWithSummary", { summary: data.summary })
          : t("monitoring.dependencyManifests.aiEnrichSuccess"),
      );
      refresh();
    },
    onError: () => message.error(t("monitoring.dependencyManifests.aiEnrichFailed")),
  });

  const tableItems = useMemo(() => {
    const items = data?.items ?? [];
    if (!manifestSetFilterId) return items;
    return items.filter((item) => item.id === manifestSetFilterId);
  }, [data?.items, manifestSetFilterId]);

  const filteredManifestSet = useMemo(
    () => tableItems[0] ?? (data?.items ?? []).find((item) => item.id === manifestSetFilterId) ?? null,
    [tableItems, data?.items, manifestSetFilterId],
  );

  const clearManifestSetFilter = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("manifest_set_id");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/dependency-manifest-sets/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      message.success(t("monitoring.dependencyManifests.deleted"));
      refresh();
    },
    onError: (_err, id) => {
      message.error(
        <span>
          {t("monitoring.dependencyManifests.deleteInUse")}{" "}
          <Link to={`/monitoring/applications?manifest_set_id=${id}`}>
            {t("monitoring.dependencyManifests.viewLinkedApps")}
          </Link>
        </span>,
      );
    },
  });

  const columns: ProColumns<DependencyManifestSet>[] = useMemo(
    () => [
      { title: t("common.name"), dataIndex: "name", width: 220 },
      { title: t("monitoring.dependencyManifests.columns.fileCount"), dataIndex: "manifests", width: 90, render: (_, row) => row.manifests?.length ?? 0 },
      {
        title: t("monitoring.applications.columns.referencedComponents"),
        dataIndex: "referenced_components",
        width: 100,
        search: false,
        render: (_, row) => row.referenced_components?.length ?? 0,
      },
      {
        title: t("monitoring.dependencyManifests.columns.profileCount"),
        dataIndex: "profile_count",
        width: 100,
        search: false,
        render: (_, row) => {
          const count = row.profile_count ?? 0;
          if (count <= 0) return 0;
          return (
            <Link to={`/monitoring/applications?manifest_set_id=${row.id}`}>
              {count}
            </Link>
          );
        },
      },
      {
        title: t("monitoring.dependencyManifests.columns.details"),
        dataIndex: "referenced_components",
        width: 260,
        search: false,
        render: (_, row) => (
          <ReferencedComponentIssueSummaryTags
            counts={summarizeReferencedComponentIssues(row.referenced_components ?? [])}
            t={t}
          />
        ),
      },
      {
        title: t("monitoring.dependencyManifests.columns.updatedAt"),
        dataIndex: "updated_at",
        width: 180,
        search: false,
        render: (_, row) => formatDateTime(row.updated_at),
      },
      {
        title: t("common.actions"),
        width: 160,
        search: false,
        render: (_, row) => (
          <Space>
            <Button
              type="link"
              size="small"
              onClick={async () => {
                const detail = await api<DependencyManifestSet>(
                  `/api/monitoring/dependency-manifest-sets/${row.id}`,
                );
                setEditSet(detail);
                setStagedManifests(
                  detail.manifests.map((m) => ({ filename: m.filename, content: m.content })),
                );
              }}
            >
              {t("common.edit")}
            </Button>
            <Popconfirm
              title={t("monitoring.dependencyManifests.confirmDelete")}
              onConfirm={() => deleteMutation.mutate(row.id)}
            >
              <Button type="link" size="small" danger>
                {t("common.delete")}
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [t, deleteMutation],
  );

  const renderManifestEditor = (mode: "create" | "edit") => (
    <>
      <ProFormText
        name="name"
        label={t("common.name")}
        rules={[{ required: true }]}
        disabled={mode === "edit"}
      />
      <ProFormTextArea name="description" label={t("monitoring.applications.columns.description")} />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {t("monitoring.applications.uploadManifestsHint")}
      </Typography.Paragraph>
      <Upload.Dragger
        multiple
        showUploadList={false}
        beforeUpload={(file) => {
          const baseName = file.name.split(/[/\\]/).pop() ?? file.name;
          if (!ALLOWED_MANIFEST_FILENAMES.has(baseName)) {
            message.error(`${t("monitoring.applications.uploadManifestsInvalid")}: ${baseName}`);
            return Upload.LIST_IGNORE;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const content = typeof reader.result === "string" ? reader.result.trim() : "";
            if (!content) return;
            setStagedManifests((prev) => [
              ...prev.filter((item) => item.filename !== baseName),
              { filename: baseName, content },
            ]);
          };
          reader.readAsText(file);
          return false;
        }}
      >
        <p className="ant-upload-drag-icon">
          <UploadOutlined />
        </p>
        <p className="ant-upload-text">{t("monitoring.applications.uploadManifests")}</p>
      </Upload.Dragger>
      {stagedManifests.length > 0 ? (
        <ProTable<UploadedManifest>
          {...moduleNestedTableProps}
          style={{ marginTop: 16 }}
          rowKey="filename"
          headerTitle={t("monitoring.applications.uploadedManifestsTitle")}
          dataSource={stagedManifests.map((m) => ({
            filename: m.filename,
            content: m.content,
            uploaded_at: new Date().toISOString(),
          }))}
          columns={[
            { title: t("common.name"), dataIndex: "filename" },
            {
              title: t("common.actions"),
              width: 80,
              render: (_, row) => (
                <ConfirmDeleteButton
                  title={t("monitoring.dependencyManifests.confirmDeleteStaged")}
                  onConfirm={() =>
                    setStagedManifests((prev) => prev.filter((m) => m.filename !== row.filename))
                  }
                />
              ),
            },
          ]}
          search={false}
          pagination={false}
        />
      ) : null}
    </>
  );

  return (
    <>
      <ModulePageShell
        icon={<FileTextOutlined style={{ fontSize: 20 }} />}
        title={t("monitoring.dependencyManifests.title")}
        subtitle={t("monitoring.dependencyManifests.subtitle")}
        action={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t("monitoring.dependencyManifests.addSet")}
          </Button>
        }
      >
        <ModuleTableCard>
          {manifestSetFilterId ? (
            <Alert
              type="info"
              showIcon
              style={{ margin: "0 16px 16px" }}
              message={t("monitoring.dependencyManifests.filteredByManifestSet", {
                name: filteredManifestSet?.name ?? manifestSetFilterId,
              })}
              action={
                <Button size="small" onClick={clearManifestSetFilter}>
                  {t("monitoring.dependencyManifests.clearManifestSetFilter")}
                </Button>
              }
            />
          ) : null}
          <ProTable<DependencyManifestSet>
            {...moduleProTableProps}
            rowKey="id"
            loading={isLoading}
            search={manifestSetFilterId ? false : moduleTableSearch()}
            pagination={moduleTablePagination}
            columns={columns}
            dataSource={tableItems}
            expandable={{
              defaultExpandedRowKeys: manifestSetFilterId ? [manifestSetFilterId] : undefined,
              expandedRowRender: (record) => (
                <MonitorDependencyManifestSetExpand
                  record={record}
                  onAiEnrich={(setId) => aiEnrichMutation.mutate(setId)}
                  aiEnrichPending={aiEnrichMutation.isPending}
                  aiEnrichSetId={aiEnrichMutation.variables}
                />
              ),
            }}
          />
        </ModuleTableCard>
      </ModulePageShell>

      <ModuleFormDrawer
        title={t("monitoring.dependencyManifests.addSet")}
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setStagedManifests([]);
        }}
      >
        <ProForm
          onFinish={async (values) => {
            if (!stagedManifests.length) {
              message.error(t("monitoring.applications.uploadManifestsEmpty"));
              return;
            }
            await saveMutation.mutateAsync({
              name: values.name,
              description: values.description,
              manifests: stagedManifests,
            });
          }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
        >
          {renderManifestEditor("create")}
        </ProForm>
      </ModuleFormDrawer>

      <ModuleFormDrawer
        title={t("monitoring.dependencyManifests.editSet")}
        open={Boolean(editSet)}
        onClose={() => {
          setEditSet(null);
          setStagedManifests([]);
        }}
      >
        <ProForm
          key={editSet?.id}
          initialValues={{
            name: editSet?.name,
            description: editSet?.description,
          }}
          onFinish={async (values) => {
            if (!editSet) return;
            await saveMutation.mutateAsync({
              id: editSet.id,
              name: editSet.name,
              description: values.description,
              manifests: stagedManifests,
            });
          }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
        >
          {renderManifestEditor("edit")}
        </ProForm>
      </ModuleFormDrawer>
    </>
  );
}