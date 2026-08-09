import {
  ProForm,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { FundOutlined, PlusOutlined, SyncOutlined, ThunderboltOutlined } from "@ant-design/icons";
import {
  App,
  Button,
  Collapse,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { categoryColor } from "../utils/category-colors";
import {
  CATEGORY_LABEL_KEYS,
  FOUNDATION_COMPONENT_CATEGORIES,
} from "../utils/discovery-types";
import { ExternalRiskAssetSummaryPanel } from "../components/ExternalRiskAssetSummaryPanel";
import { ModuleFormDrawer } from "../components/ModuleFormDrawer";
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
import {
  filterFoundationItems,
  groupFoundationByProduct,
} from "../utils/foundation-list-grouping";
import {
  CHECK_TYPES,
  type FoundationComponent,
  type IntelSource,
  type InternalStep,
} from "../utils/monitoring-types";
import { MonitorStepScopeTag } from "../utils/monitor-step-scope";
import { MonitorStepConfigField } from "../components/MonitorStepConfigField";

type FoundationInstance = {
  id: string;
  server_id: string;
  target_id: string;
  server_ip: string;
  server_name: string;
  target_name: string;
  connection_port: number | null;
  sort_order: number;
  last_synced_at: string;
};

type FoundationDetail = {
  component: FoundationComponent;
  sources: IntelSource[];
  internalSteps: InternalStep[];
  instances: FoundationInstance[];
};

const EXPANDED_DETAIL_CLASS = "module-table-detail-panel";
const EXPANDED_DETAIL_STYLE = { paddingLeft: moduleTableDetailIndent } as const;

type FoundationComponentDetailExpandProps = {
  componentId: string;
  onAddInternalStep: (componentId: string) => void;
  onEditInternalStep: (componentId: string, step: InternalStep) => void;
};

function FoundationComponentDetailExpand({
  componentId,
  onAddInternalStep,
  onEditInternalStep,
}: FoundationComponentDetailExpandProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const { data: detail, isLoading } = useQuery({
    queryKey: ["monitoring-foundation-detail", componentId],
    queryFn: () => api<FoundationDetail>(`/api/monitoring/foundation/${componentId}`),
  });

  const refreshDetail = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["monitoring-foundation"] });
    void queryClient.invalidateQueries({
      queryKey: ["monitoring-foundation-detail", componentId],
    });
  }, [queryClient, componentId]);

  const deleteInternalMutation = useMutation({
    mutationFn: (stepId: string) =>
      api(`/api/monitoring/foundation/internal-steps/${stepId}`, { method: "DELETE" }),
    onSuccess: () => {
      message.success(t("monitoring.foundation.stepDeleted"));
      refreshDetail();
    },
    onError: () => message.error(t("common.error")),
  });

  const aiEnrichMutation = useMutation({
    mutationFn: () =>
      api<FoundationDetail & { summary?: string; github_repo?: string | null }>(
        `/api/monitoring/foundation/${componentId}/ai-enrich`,
        { method: "POST" },
      ),
    onSuccess: (data) => {
      message.success(
        data.summary
          ? t("monitoring.foundation.aiEnrichSuccessWithSummary", { summary: data.summary })
          : t("monitoring.foundation.aiEnrichSuccess"),
      );
      refreshDetail();
    },
    onError: (err: Error) => {
      const code =
        err instanceof ApiError
          ? (err.body as { code?: string } | undefined)?.code
          : undefined;
      if (code === "AI_NOT_CONFIGURED") {
        message.error(t("monitoring.foundation.aiEnrichNotConfigured"));
        return;
      }
      message.error(t("monitoring.foundation.aiEnrichFailed"));
    },
  });

  if (isLoading) {
    return (
      <div
        className={EXPANDED_DETAIL_CLASS}
        style={{ ...EXPANDED_DETAIL_STYLE, textAlign: "center", paddingTop: 16, paddingBottom: 16 }}
      >
        <Spin />
      </div>
    );
  }

  if (!detail) {
    return null;
  }

  return (
    <div className={EXPANDED_DETAIL_CLASS} style={EXPANDED_DETAIL_STYLE}>
      <Tabs
        size="small"
        items={[
          {
            key: "instances",
            label: t("monitoring.foundation.tabs.instances"),
            children: (
              <ProTable<FoundationInstance>
                {...moduleNestedTableProps}
                rowKey="id"
                dataSource={detail.instances ?? []}
                locale={{
                  emptyText: t("monitoring.foundation.instancesEmpty"),
                }}
                columns={[
                  { title: t("monitoring.foundation.columns.serverName"), dataIndex: "server_name" },
                  { title: t("monitoring.foundation.columns.serverIp"), dataIndex: "server_ip", width: 140 },
                  { title: t("monitoring.foundation.columns.targetName"), dataIndex: "target_name" },
                  {
                    title: t("monitoring.foundation.columns.port"),
                    dataIndex: "connection_port",
                    width: 80,
                    render: (v) => (v != null ? String(v) : "—"),
                  },
                  {
                    title: t("common.actions"),
                    width: 100,
                    render: (_, row) => (
                      <Link to={`/servers/${row.server_id}`}>{t("monitoring.foundation.viewServer")}</Link>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: "sources",
            label: t("monitoring.foundation.tabs.sources"),
            children: (
              <ProTable<IntelSource>
                {...moduleNestedTableProps}
                rowKey="id"
                dataSource={detail.sources ?? []}
                columns={[
                  {
                    title: t("monitoring.foundation.columns.kind"),
                    dataIndex: "kind",
                    width: 120,
                  },
                  { title: t("common.name"), dataIndex: "label", width: 220 },
                  {
                    title: "URL",
                    dataIndex: "url",
                    ellipsis: true,
                    render: (_, row) => (
                      <Typography.Link href={row.url} target="_blank" rel="noreferrer">
                        {row.url}
                      </Typography.Link>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: "externalRisk",
            label: t("externalRisk.assetSummary.tab"),
            children: (
              <ExternalRiskAssetSummaryPanel
                targetKind="foundation_component"
                targetId={componentId}
                componentName={detail.component.display_name || detail.component.product}
                fallbackVersion={detail.component.version_range}
              />
            ),
          },
          {
            key: "internal",
            label: t("monitoring.foundation.tabs.internalSteps"),
            children: (
              <>
                <div
                  style={{
                    marginBottom: 16,
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 8,
                  }}
                >
                  <Button
                    size="small"
                    icon={<ThunderboltOutlined />}
                    loading={aiEnrichMutation.isPending}
                    onClick={() => aiEnrichMutation.mutate()}
                  >
                    {t("monitoring.foundation.aiEnrich")}
                  </Button>
                  <Button
                    type="primary"
                    size="small"
                    onClick={() => onAddInternalStep(componentId)}
                  >
                    {t("monitoring.foundation.addInternalStep")}
                  </Button>
                </div>
                <ProTable<InternalStep>
                  {...moduleNestedTableProps}
                  rowKey="id"
                  dataSource={detail.internalSteps}
                  columns={[
                    { title: t("common.name"), dataIndex: "title" },
                    {
                      title: t("monitoring.foundation.columns.checkType"),
                      dataIndex: "check_type",
                      width: 120,
                    },
                    {
                      title: t("monitoring.foundation.columns.runtimeScope"),
                      width: 100,
                      render: (_, row) => <MonitorStepScopeTag config={row.config} t={t} />,
                    },
                    {
                      title: t("monitoring.foundation.columns.interval"),
                      dataIndex: "default_interval_sec",
                      width: 100,
                      render: (v) => `${v}s`,
                    },
                    {
                      title: t("common.actions"),
                      width: 120,
                      render: (_, row) => (
                        <Space>
                          <Button
                            type="link"
                            size="small"
                            onClick={() => onEditInternalStep(componentId, row)}
                          >
                            {t("common.edit")}
                          </Button>
                          <Popconfirm
                            title={t("monitoring.foundation.confirmDeleteStep")}
                            onConfirm={() => deleteInternalMutation.mutate(row.id)}
                          >
                            <Button type="link" danger size="small">
                              {t("common.delete")}
                            </Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
        ]}
      />
    </div>
  );
}

export function MonitorFoundationPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [internalModal, setInternalModal] = useState<{
    open: boolean;
    componentId: string | null;
    step: InternalStep | null;
  }>({ open: false, componentId: null, step: null });
  const [searchParams, setSearchParams] = useState<Record<string, unknown>>({});
  const [activeProductKeys, setActiveProductKeys] = useState<string[]>([]);

  const { data: listData, isLoading } = useQuery({
    queryKey: ["monitoring-foundation"],
    queryFn: () =>
      api<{ items: FoundationComponent[]; total: number }>("/api/monitoring/foundation"),
  });

  const refresh = useCallback(
    (componentId?: string) => {
      void queryClient.invalidateQueries({ queryKey: ["monitoring-foundation"] });
      if (componentId) {
        void queryClient.invalidateQueries({
          queryKey: ["monitoring-foundation-detail", componentId],
        });
      }
    },
    [queryClient],
  );

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/monitoring/foundation", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      message.success(t("monitoring.foundation.created"));
      setCreateOpen(false);
      refresh();
    },
    onError: () => message.error(t("common.error")),
  });

  const syncMutation = useMutation({
    mutationFn: () =>
      api<{
        targets_scanned: number;
        components_touched: number;
        monitor_items_added: number;
        servers_synced: number;
      }>("/api/monitoring/foundation/sync-from-checklist", { method: "POST" }),
    onSuccess: (data) => {
      message.success(
        t("monitoring.foundation.syncSuccess", {
          targets: data.targets_scanned,
          servers: data.servers_synced,
        }),
      );
      refresh();
    },
    onError: () => message.error(t("monitoring.foundation.syncFailed")),
  });

  const deleteComponentMutation = useMutation({
    mutationFn: (componentId: string) =>
      api(`/api/monitoring/foundation/${componentId}`, { method: "DELETE" }),
    onSuccess: () => {
      message.success(t("monitoring.foundation.deleted"));
      refresh();
    },
    onError: () => message.error(t("common.error")),
  });

  const categoryOptions = useMemo(
    () =>
      FOUNDATION_COMPONENT_CATEGORIES.map((value) => ({
        label: t(CATEGORY_LABEL_KEYS[value] ?? value),
        value,
      })),
    [t],
  );

  const categoryValueEnum = useMemo(
    () =>
      Object.fromEntries(
        FOUNDATION_COMPONENT_CATEGORIES.map((cat) => [
          cat,
          { text: t(CATEGORY_LABEL_KEYS[cat] ?? cat) },
        ]),
      ),
    [t],
  );

  const renderCategoryTag = useCallback(
    (category: string) => {
      const color = categoryColor(category);
      return (
        <Tag
          style={{
            color,
            borderColor: color,
            background: `${color}18`,
          }}
        >
          {t(CATEGORY_LABEL_KEYS[category] ?? category)}
        </Tag>
      );
    },
    [t],
  );

  const columns: ProColumns<FoundationComponent>[] = useMemo(
    () => [
      {
        title: t("monitoring.foundation.columns.displayName"),
        dataIndex: "display_name",
        width: 200,
        ellipsis: true,
      },
      { title: t("monitoring.foundation.columns.product"), dataIndex: "product", width: 120 },
      { title: t("monitoring.foundation.columns.version"), dataIndex: "version_range", width: 100 },
      {
        title: t("monitoring.foundation.columns.category"),
        dataIndex: "category",
        width: 140,
        valueType: "select",
        valueEnum: categoryValueEnum,
        render: (_, row) => renderCategoryTag(row.category),
      },
      {
        title: t("monitoring.foundation.columns.sourceKind"),
        dataIndex: "source_kind",
        width: 100,
        search: false,
      },
      {
        title: t("common.actions"),
        width: 100,
        search: false,
        render: (_, row) => (
          <Popconfirm
            title={t("monitoring.foundation.confirmDeleteComponent")}
            onConfirm={() => deleteComponentMutation.mutate(row.id)}
          >
            <Button
              type="link"
              danger
              size="small"
              loading={
                deleteComponentMutation.isPending &&
                deleteComponentMutation.variables === row.id
              }
            >
              {t("common.delete")}
            </Button>
          </Popconfirm>
        ),
      },
    ],
    [categoryValueEnum, deleteComponentMutation, renderCategoryTag, t],
  );

  const versionColumns: ProColumns<FoundationComponent>[] = useMemo(
    () => [
      {
        title: t("monitoring.foundation.columns.displayName"),
        dataIndex: "display_name",
        width: 200,
        ellipsis: true,
        search: false,
      },
      { title: t("monitoring.foundation.columns.version"), dataIndex: "version_range", width: 100, search: false },
      {
        title: t("monitoring.foundation.columns.category"),
        dataIndex: "category",
        width: 140,
        search: false,
        render: (_, row) => renderCategoryTag(row.category),
      },
      {
        title: t("monitoring.foundation.columns.sourceKind"),
        dataIndex: "source_kind",
        width: 100,
        search: false,
      },
      {
        title: t("common.actions"),
        width: 100,
        search: false,
        render: (_, row) => (
          <Popconfirm
            title={t("monitoring.foundation.confirmDeleteComponent")}
            onConfirm={() => deleteComponentMutation.mutate(row.id)}
          >
            <Button
              type="link"
              danger
              size="small"
              loading={
                deleteComponentMutation.isPending &&
                deleteComponentMutation.variables === row.id
              }
            >
              {t("common.delete")}
            </Button>
          </Popconfirm>
        ),
      },
    ],
    [deleteComponentMutation, renderCategoryTag, t],
  );

  const filteredItems = useMemo(
    () => filterFoundationItems(listData?.items ?? [], searchParams),
    [listData?.items, searchParams],
  );

  const { singletons, productGroups } = useMemo(
    () => groupFoundationByProduct(filteredItems),
    [filteredItems],
  );

  useEffect(() => {
    setActiveProductKeys(productGroups.map((group) => group.product));
  }, [productGroups]);

  const renderDetailExpand = useCallback(
    (record: FoundationComponent) => (
      <FoundationComponentDetailExpand
        componentId={record.id}
        onAddInternalStep={(componentId) =>
          setInternalModal({ open: true, componentId, step: null })
        }
        onEditInternalStep={(componentId, step) =>
          setInternalModal({ open: true, componentId, step })
        }
      />
    ),
    [],
  );

  const checkTypeOptions = CHECK_TYPES.map((value) => ({
    label: t(`monitoring.checkTypes.${value}`),
    value,
  }));

  return (
    <>
      <ModulePageShell
        icon={<FundOutlined style={{ fontSize: 20 }} />}
        title={t("monitoring.foundation.title")}
        subtitle={t("monitoring.foundation.subtitle")}
        action={
          <Space>
            <Button
              icon={<SyncOutlined />}
              loading={syncMutation.isPending}
              onClick={() => syncMutation.mutate()}
            >
              {t("monitoring.foundation.syncFromChecklist")}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              {t("monitoring.foundation.addComponent")}
            </Button>
          </Space>
        }
      >
        <ModuleTableCard>
          <ProTable<FoundationComponent>
            {...moduleProTableProps}
            rowKey="id"
            bordered
            tableLayout="fixed"
            loading={isLoading}
            search={moduleTableSearch()}
            pagination={singletons.length > 0 ? moduleTablePagination : false}
            showHeader={singletons.length > 0}
            locale={
              singletons.length === 0 && productGroups.length > 0
                ? { emptyText: " " }
                : undefined
            }
            columns={columns}
            dataSource={singletons}
            onSubmit={(params) => setSearchParams(params)}
            onReset={() => setSearchParams({})}
            expandable={{
              ...moduleTableExpandable,
              expandedRowRender: renderDetailExpand,
            }}
          />
          {productGroups.length > 0 ? (
            <Collapse
              bordered
              activeKey={activeProductKeys}
              onChange={(keys) => {
                const next = Array.isArray(keys) ? keys : keys ? [keys] : [];
                setActiveProductKeys(next.map(String));
              }}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 16,
                margin: singletons.length > 0 ? "16px 16px 0" : "0 16px",
              }}
              items={productGroups.map((group) => ({
                key: group.product,
                label: (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 16,
                      paddingRight: 8,
                    }}
                  >
                    <Typography.Title level={5} style={{ margin: 0 }}>
                      {group.label}
                    </Typography.Title>
                    <Typography.Text type="secondary">
                      {t("monitoring.foundation.versionCount", { count: group.items.length })}
                    </Typography.Text>
                  </div>
                ),
                children: (
                  <ProTable<FoundationComponent>
                    {...moduleNestedTableProps}
                    rowKey="id"
                    bordered
                    tableLayout="fixed"
                    columns={versionColumns}
                    dataSource={group.items}
                    expandable={{
                      ...moduleTableExpandable,
                      expandedRowRender: renderDetailExpand,
                    }}
                  />
                ),
              }))}
            />
          ) : null}
        </ModuleTableCard>
      </ModulePageShell>

      <ModuleFormDrawer
        title={t("monitoring.foundation.addComponent")}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      >
        <ProForm
          onFinish={async (values) => {
            await createMutation.mutateAsync(values);
          }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
        >
          <ProFormText name="display_name" label={t("monitoring.foundation.columns.displayName")} rules={[{ required: true }]} />
          <ProFormText name="product" label={t("monitoring.foundation.columns.product")} rules={[{ required: true }]} />
          <ProFormText name="version_range" label={t("monitoring.foundation.columns.version")} rules={[{ required: true }]} />
          <ProFormSelect
            name="category"
            label={t("monitoring.foundation.columns.category")}
            options={categoryOptions}
            rules={[{ required: true }]}
          />
        </ProForm>
      </ModuleFormDrawer>

      <Modal
        title={
          internalModal.step
            ? t("monitoring.foundation.editInternalStep")
            : t("monitoring.foundation.addInternalStep")
        }
        open={internalModal.open}
        onCancel={() => setInternalModal({ open: false, componentId: null, step: null })}
        footer={null}
        destroyOnClose
        width={720}
      >
        <ProForm
          key={internalModal.step?.id ?? "new"}
          initialValues={
            internalModal.step ?? {
              check_type: "ssh_command",
              sort_order: 0,
              default_interval_sec: 300,
              enabled: true,
              config: {},
            }
          }
          onFinish={async (values) => {
            const componentId = internalModal.componentId;
            if (!componentId) return;
            let config: Record<string, unknown> = {};
            if (values.configJson) {
              try {
                config = JSON.parse(String(values.configJson));
              } catch {
                message.error(t("monitoring.foundation.invalidJson"));
                return;
              }
            } else if (internalModal.step?.config) {
              config = internalModal.step.config;
            }
            const payload = {
              title: values.title,
              check_type: values.check_type,
              sort_order: values.sort_order,
              default_interval_sec: values.default_interval_sec,
              enabled: values.enabled,
              config,
            };
            if (internalModal.step) {
              await api(`/api/monitoring/foundation/internal-steps/${internalModal.step.id}`, {
                method: "PATCH",
                body: JSON.stringify(payload),
              });
            } else {
              await api(`/api/monitoring/foundation/${componentId}/internal-steps`, {
                method: "POST",
                body: JSON.stringify(payload),
              });
            }
            message.success(t("monitoring.foundation.stepSaved"));
            setInternalModal({ open: false, componentId: null, step: null });
            refresh(componentId);
          }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
        >
          <ProFormText name="title" label={t("common.name")} rules={[{ required: true }]} />
          <ProFormSelect name="check_type" label={t("monitoring.foundation.columns.checkType")} options={checkTypeOptions} />
          <ProFormDigit name="sort_order" label={t("monitoring.foundation.columns.sortOrder")} min={0} />
          <ProFormDigit name="default_interval_sec" label={t("monitoring.foundation.columns.intervalSec")} min={30} />
          <ProFormSwitch name="enabled" label={t("monitoring.foundation.columns.enabled")} />
          <MonitorStepConfigField
            collapsible
            initialConfig={internalModal.step?.config}
          />
        </ProForm>
      </Modal>
    </>
  );
}
