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
import {
  AppstoreOutlined,
  LinkOutlined,
  PlusOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tabs,
  Typography,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { ApplicationManifestLinkModal } from "../components/ApplicationManifestLinkModal";
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
  CHECK_TYPES,
  type ApplicationProfile,
  type ApplicationStep,
  type DependencyManifestSet,
} from "../utils/monitoring-types";
import { MonitorStepScopeTag } from "../utils/monitor-step-scope";
import { MonitorStepConfigField } from "../components/MonitorStepConfigField";

type ApplicationInstance = {
  id: string;
  server_id: string;
  target_id: string;
  server_ip: string;
  server_name: string;
  target_name: string;
  docker_name: string | null;
  container_runtime_id: string | null;
  sort_order: number;
};

type ProfileDetail = {
  profile: ApplicationProfile;
  steps: ApplicationStep[];
  instances: ApplicationInstance[];
};

const EXPANDED_DETAIL_CLASS = "module-table-detail-panel";
const EXPANDED_DETAIL_STYLE = { paddingLeft: moduleTableDetailIndent } as const;

type ApplicationDetailExpandProps = {
  profileId: string;
  onAddStep: (profileId: string) => void;
  onEditStep: (profileId: string, step: ApplicationStep) => void;
};

function ApplicationDetailExpand({ profileId, onAddStep, onEditStep }: ApplicationDetailExpandProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const { data: detail, isLoading } = useQuery({
    queryKey: ["monitoring-application-detail", profileId],
    queryFn: () => api<ProfileDetail>(`/api/monitoring/applications/${profileId}`),
  });

  const refreshDetail = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["monitoring-applications"] });
    void queryClient.invalidateQueries({ queryKey: ["monitoring-application-detail", profileId] });
  }, [queryClient, profileId]);

  const deleteStepMutation = useMutation({
    mutationFn: (stepId: string) =>
      api(`/api/monitoring/applications/steps/${stepId}`, { method: "DELETE" }),
    onSuccess: () => {
      message.success(t("monitoring.applications.stepDeleted"));
      refreshDetail();
    },
    onError: () => message.error(t("common.error")),
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

  if (!detail) return null;

  return (
    <div className={EXPANDED_DETAIL_CLASS} style={EXPANDED_DETAIL_STYLE}>
      <Tabs
        size="small"
        items={[
          {
            key: "instances",
            label: t("monitoring.applications.tabs.instances"),
            children: (
              <ProTable<ApplicationInstance>
                {...moduleNestedTableProps}
                rowKey="id"
                dataSource={detail.instances ?? []}
                locale={{ emptyText: t("monitoring.applications.instancesEmpty") }}
                columns={[
                  { title: t("monitoring.applications.columns.serverName"), dataIndex: "server_name" },
                  { title: t("monitoring.applications.columns.serverIp"), dataIndex: "server_ip", width: 140 },
                  { title: t("monitoring.applications.columns.dockerName"), dataIndex: "docker_name" },
                  {
                    title: t("monitoring.applications.columns.containerRuntimeId"),
                    dataIndex: "container_runtime_id",
                    ellipsis: true,
                  },
                  {
                    title: t("common.actions"),
                    width: 100,
                    render: (_, row) => (
                      <Link to={`/servers/${row.server_id}`}>{t("monitoring.applications.viewServer")}</Link>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: "steps",
            label: t("monitoring.applications.tabs.monitorItems"),
            children: (
              <>
                <div style={{ marginBottom: 16, display: "flex", justifyContent: "flex-end" }}>
                  <Button type="primary" size="small" onClick={() => onAddStep(profileId)}>
                    {t("monitoring.applications.addMonitorItem")}
                  </Button>
                </div>
                <ProTable<ApplicationStep>
                  {...moduleNestedTableProps}
                  rowKey="id"
                  dataSource={detail.steps}
                  columns={[
                    { title: t("common.name"), dataIndex: "title" },
                    {
                      title: t("monitoring.applications.columns.checkType"),
                      dataIndex: "check_type",
                      width: 120,
                    },
                    {
                      title: t("monitoring.applications.columns.runtimeScope"),
                      width: 100,
                      render: (_, row) => <MonitorStepScopeTag config={row.config} t={t} />,
                    },
                    {
                      title: t("monitoring.applications.columns.interval"),
                      dataIndex: "default_interval_sec",
                      width: 100,
                      render: (v) => `${v}s`,
                    },
                    {
                      title: t("common.actions"),
                      width: 120,
                      render: (_, row) => (
                        <Space>
                          <Button type="link" size="small" onClick={() => onEditStep(profileId, row)}>
                            {t("common.edit")}
                          </Button>
                          <Popconfirm
                            title={t("monitoring.applications.confirmDeleteStep")}
                            onConfirm={() => deleteStepMutation.mutate(row.id)}
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

export function MonitorApplicationsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const manifestSetFilterId = searchParams.get("manifest_set_id");
  const [createOpen, setCreateOpen] = useState(false);
  const [stepModal, setStepModal] = useState<{
    open: boolean;
    profileId: string | null;
    step: ApplicationStep | null;
  }>({ open: false, profileId: null, step: null });
  const [manifestModal, setManifestModal] = useState<{
    open: boolean;
    profile: ApplicationProfile | null;
  }>({ open: false, profile: null });

  const { data: listData, isLoading } = useQuery({
    queryKey: ["monitoring-applications"],
    queryFn: () => api<{ items: ApplicationProfile[]; total: number }>("/api/monitoring/applications"),
  });

  const { data: manifestSets } = useQuery({
    queryKey: ["dependency-manifest-sets"],
    queryFn: () => api<{ items: DependencyManifestSet[] }>("/api/monitoring/dependency-manifest-sets"),
  });

  const filteredManifestSet = useMemo(
    () => (manifestSets?.items ?? []).find((item) => item.id === manifestSetFilterId) ?? null,
    [manifestSets?.items, manifestSetFilterId],
  );

  const tableItems = useMemo(() => {
    const items = listData?.items ?? [];
    if (!manifestSetFilterId) return items;
    return items.filter((item) => item.manifest_set_id === manifestSetFilterId);
  }, [listData?.items, manifestSetFilterId]);

  const clearManifestSetFilter = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("manifest_set_id");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const manifestSetById = useMemo(() => {
    const map = new Map<string, DependencyManifestSet>();
    for (const item of manifestSets?.items ?? []) {
      map.set(item.id, item);
    }
    return map;
  }, [manifestSets?.items]);

  const openManifestModal = useCallback((profile: ApplicationProfile) => {
    setManifestModal({ open: true, profile });
  }, []);

  const refresh = useCallback(
    (profileId?: string) => {
      void queryClient.invalidateQueries({ queryKey: ["monitoring-applications"] });
      if (profileId) {
        void queryClient.invalidateQueries({ queryKey: ["monitoring-application-detail", profileId] });
      }
    },
    [queryClient],
  );

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/monitoring/applications", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      message.success(t("monitoring.applications.created"));
      setCreateOpen(false);
      refresh();
    },
    onError: () => message.error(t("common.error")),
  });

  const syncMutation = useMutation({
    mutationFn: () =>
      api<{ targets_scanned: number; servers_synced: number }>(
        "/api/monitoring/applications/sync-from-checklist",
        { method: "POST" },
      ),
    onSuccess: (data) => {
      message.success(
        t("monitoring.applications.syncSuccess", {
          targets: data.targets_scanned,
          servers: data.servers_synced,
        }),
      );
      refresh();
    },
    onError: () => message.error(t("monitoring.applications.syncFailed")),
  });

  const deleteProfileMutation = useMutation({
    mutationFn: (profileId: string) =>
      api(`/api/monitoring/applications/${profileId}`, { method: "DELETE" }),
    onSuccess: () => {
      message.success(t("monitoring.applications.deleted"));
      refresh();
    },
    onError: () => message.error(t("common.error")),
  });

  const unlinkManifestMutation = useMutation({
    mutationFn: (profileId: string) =>
      api(`/api/monitoring/applications/${profileId}/manifest-set`, {
        method: "PUT",
        body: JSON.stringify({ manifest_set_id: null }),
      }),
    onSuccess: (_, profileId) => {
      message.success(t("monitoring.applications.unlinkedManifestSet"));
      refresh(profileId);
      void queryClient.invalidateQueries({ queryKey: ["dependency-manifest-sets"] });
    },
    onError: () => message.error(t("common.error")),
  });

  const columns: ProColumns<ApplicationProfile>[] = useMemo(
    () => [
      {
        title: t("monitoring.applications.columns.serviceName"),
        dataIndex: "service_name",
        width: 160,
      },
      {
        title: t("monitoring.applications.columns.dockerName"),
        dataIndex: "docker_name",
        width: 180,
        ellipsis: true,
      },
      {
        title: t("monitoring.applications.columns.containerRuntimeId"),
        dataIndex: "container_runtime_id",
        ellipsis: true,
        search: false,
      },
      {
        title: t("monitoring.applications.columns.description"),
        dataIndex: "description",
        ellipsis: true,
        search: false,
      },
      {
        title: t("monitoring.applications.columns.applicationDependencies"),
        dataIndex: "manifest_set_id",
        width: 260,
        search: false,
        render: (_, row) => {
          const linkedSet = row.manifest_set_id
            ? manifestSetById.get(row.manifest_set_id)
            : undefined;
          return (
            <Space direction="vertical" size={0}>
              {linkedSet ? (
                <Link
                  to={`/monitoring/dependency-manifests?manifest_set_id=${linkedSet.id}`}
                >
                  {linkedSet.name}
                </Link>
              ) : (
                <Typography.Text type="secondary">
                  {t("monitoring.applications.manifestSetNotLinked")}
                </Typography.Text>
              )}
              <Space size={4} wrap>
                <Button
                  type="link"
                  size="small"
                  icon={<LinkOutlined />}
                  style={{ padding: 0, height: "auto" }}
                  onClick={() => openManifestModal(row)}
                >
                  {linkedSet
                    ? t("monitoring.applications.changeDependencies")
                    : t("monitoring.applications.linkDependencies")}
                </Button>
                {linkedSet ? (
                  <Popconfirm
                    title={t("monitoring.applications.confirmRemoveDependencies")}
                    onConfirm={() => unlinkManifestMutation.mutate(row.id)}
                  >
                    <Button
                      type="link"
                      danger
                      size="small"
                      loading={
                        unlinkManifestMutation.isPending &&
                        unlinkManifestMutation.variables === row.id
                      }
                      style={{ padding: 0, height: "auto" }}
                    >
                      {t("monitoring.applications.removeDependencies")}
                    </Button>
                  </Popconfirm>
                ) : null}
              </Space>
            </Space>
          );
        },
      },
      {
        title: t("monitoring.applications.columns.instanceCount"),
        dataIndex: "instance_count",
        width: 90,
        search: false,
        render: (_, row) => row.instance_count ?? 0,
      },
      {
        title: t("common.actions"),
        width: 100,
        search: false,
        render: (_, row) => (
          <Popconfirm
            title={t("monitoring.applications.confirmDeleteProfile")}
            onConfirm={() => deleteProfileMutation.mutate(row.id)}
          >
            <Button
              type="link"
              danger
              size="small"
              loading={
                deleteProfileMutation.isPending && deleteProfileMutation.variables === row.id
              }
            >
              {t("common.delete")}
            </Button>
          </Popconfirm>
        ),
      },
    ],
    [t, deleteProfileMutation, manifestSetById, openManifestModal, unlinkManifestMutation],
  );

  const checkTypeOptions = CHECK_TYPES.map((value) => ({
    label: t(`monitoring.checkTypes.${value}`),
    value,
  }));

  const renderDetailExpand = useCallback(
    (record: ApplicationProfile) => (
      <ApplicationDetailExpand
        profileId={record.id}
        onAddStep={(profileId) => setStepModal({ open: true, profileId, step: null })}
        onEditStep={(profileId, step) => setStepModal({ open: true, profileId, step })}
      />
    ),
    [],
  );

  return (
    <>
      <ModulePageShell
        icon={<AppstoreOutlined style={{ fontSize: 20 }} />}
        title={t("monitoring.applications.title")}
        subtitle={t("monitoring.applications.subtitle")}
        action={
          <Space>
            <Button
              icon={<SyncOutlined />}
              loading={syncMutation.isPending}
              onClick={() => syncMutation.mutate()}
            >
              {t("monitoring.applications.syncFromChecklist")}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              {t("monitoring.applications.addProfile")}
            </Button>
          </Space>
        }
      >
        <ModuleTableCard>
          {manifestSetFilterId ? (
            <Alert
              type="info"
              showIcon
              style={{ margin: "0 16px 16px" }}
              message={t("monitoring.applications.filteredByManifestSet", {
                name: filteredManifestSet?.name ?? manifestSetFilterId,
              })}
              action={
                <Button size="small" onClick={clearManifestSetFilter}>
                  {t("monitoring.applications.clearManifestSetFilter")}
                </Button>
              }
            />
          ) : null}
          <ProTable<ApplicationProfile>
            {...moduleProTableProps}
            rowKey="id"
            bordered
            tableLayout="fixed"
            loading={isLoading}
            search={moduleTableSearch()}
            pagination={moduleTablePagination}
            columns={columns}
            dataSource={tableItems}
            expandable={{
              ...moduleTableExpandable,
              expandedRowRender: renderDetailExpand,
            }}
          />
        </ModuleTableCard>
      </ModulePageShell>

      <ModuleFormDrawer
        title={t("monitoring.applications.addProfile")}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      >
        <ProForm
          onFinish={async (values) => {
            const dockerName = String(values.docker_name ?? "").trim();
            await createMutation.mutateAsync({
              service_name: values.service_name,
              docker_name: dockerName,
              container_runtime_id: values.container_runtime_id || `manual:${dockerName}`,
              description: values.description ?? null,
              frameworks: [],
              referenced_components: [],
              uploaded_manifests: [],
            });
          }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
        >
          <ProFormText
            name="service_name"
            label={t("monitoring.applications.columns.serviceName")}
            rules={[{ required: true }]}
            placeholder="futures-users"
          />
          <ProFormText
            name="docker_name"
            label={t("monitoring.applications.columns.dockerName")}
            rules={[{ required: true }]}
            placeholder="docker-futures-users"
          />
          <ProFormText
            name="container_runtime_id"
            label={t("monitoring.applications.columns.containerRuntimeId")}
            placeholder="compose:shop:futures-users"
          />
          <ProFormTextArea name="description" label={t("monitoring.applications.columns.description")} />
        </ProForm>
      </ModuleFormDrawer>

      <Modal
        title={
          stepModal.step
            ? t("monitoring.applications.editMonitorItem")
            : t("monitoring.applications.addMonitorItem")
        }
        open={stepModal.open}
        onCancel={() => setStepModal({ open: false, profileId: null, step: null })}
        footer={null}
        destroyOnClose
        width={720}
      >
        <ProForm
          key={stepModal.step?.id ?? "new"}
          initialValues={
            stepModal.step ?? {
              check_type: "http_get",
              sort_order: 0,
              default_interval_sec: 300,
              enabled: true,
            }
          }
          onFinish={async (values) => {
            const profileId = stepModal.profileId;
            if (!profileId) return;
            let config: Record<string, unknown> = {};
            if (values.configJson) {
              try {
                config = JSON.parse(String(values.configJson));
              } catch {
                message.error(t("monitoring.foundation.invalidJson"));
                return;
              }
            } else if (stepModal.step?.config) {
              config = stepModal.step.config;
            }
            const payload = {
              title: values.title,
              check_type: values.check_type,
              sort_order: values.sort_order,
              default_interval_sec: values.default_interval_sec,
              enabled: values.enabled,
              config,
            };
            if (stepModal.step) {
              await api(`/api/monitoring/applications/steps/${stepModal.step.id}`, {
                method: "PATCH",
                body: JSON.stringify(payload),
              });
            } else {
              await api(`/api/monitoring/applications/${profileId}/steps`, {
                method: "POST",
                body: JSON.stringify(payload),
              });
            }
            message.success(t("monitoring.applications.stepSaved"));
            setStepModal({ open: false, profileId: null, step: null });
            refresh(profileId);
          }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
        >
          <ProFormText name="title" label={t("common.name")} rules={[{ required: true }]} />
          <ProFormSelect
            name="check_type"
            label={t("monitoring.applications.columns.checkType")}
            options={checkTypeOptions}
          />
          <ProFormDigit name="sort_order" label={t("monitoring.applications.columns.sortOrder")} min={0} />
          <ProFormDigit
            name="default_interval_sec"
            label={t("monitoring.applications.columns.intervalSec")}
            min={30}
          />
          <ProFormSwitch name="enabled" label={t("monitoring.applications.columns.enabled")} />
          <MonitorStepConfigField
            initialConfig={stepModal.step?.config}
            label={t("monitoring.applications.columns.config")}
          />
        </ProForm>
      </Modal>

      <ApplicationManifestLinkModal
        open={manifestModal.open}
        profile={manifestModal.profile}
        onClose={() => setManifestModal({ open: false, profile: null })}
      />
    </>
  );
}