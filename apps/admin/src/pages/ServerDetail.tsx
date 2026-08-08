import { Button, Space, Spin, Tabs, message } from "antd";
import { ArrowLeftOutlined, CloudServerOutlined, ReloadOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { getServerSaveErrorMessage } from "../utils/server-api-errors";
import { ModulePageShell } from "../components/ModulePageShell";
import { ServerDependenciesTab } from "../components/ServerDependenciesTab";
import {
  ServerFormDrawer,
  type ServerFormValues,
  type ServerRecord,
} from "../components/ServerFormDrawer";
import { ServerMonitorChecklist } from "../components/ServerMonitorChecklist";
import { ServerOverviewTab } from "../components/ServerOverviewTab";

import { ServerTerminalPanel } from "../components/ServerTerminalPanel";
import type { DiscoveryStatus } from "../utils/discovery-types";
import { buildServerPayload } from "../utils/server-form-payload";
import { isDiscoveryScanning } from "../utils/discovery-scanning";
import { useCallback, useEffect, useRef, useState } from "react";

export function ServerDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);

  const tabKey = searchParams.get("tab") ?? "overview";

  const { data: server, isLoading, isError } = useQuery({
    queryKey: ["server", id],
    queryFn: () => api<ServerRecord>(`/api/servers/${id}`),
    enabled: Boolean(id),
  });

  const { data: discoveryStatus } = useQuery({
    queryKey: ["discovery-status", id],
    queryFn: () => api<DiscoveryStatus>(`/api/servers/${id}/discovery/status`),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const setup = query.state.data?.setup_status;
      const runStatus = query.state.data?.run?.status;
      if (setup === "scanning" || runStatus === "running") return 2000;
      return false;
    },
  });

  const rescanMutation = useMutation({
    mutationFn: () => api(`/api/servers/${id}/discovery/run`, { method: "POST" }),
    onSuccess: () => {
      message.success(t("servers.discovery.rescanStarted"));
      void queryClient.invalidateQueries({ queryKey: ["discovery-status", id] });
      void queryClient.invalidateQueries({ queryKey: ["server-targets", id] });
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
    },
  });

  const completeSetupMutation = useMutation({
    mutationFn: () => api(`/api/servers/${id}/setup/complete`, { method: "POST" }),
    onSuccess: () => {
      message.success(t("servers.discovery.finishSetupSuccess"));
      void queryClient.invalidateQueries({ queryKey: ["discovery-status", id] });
      void queryClient.invalidateQueries({ queryKey: ["server-targets", id] });
      void queryClient.invalidateQueries({ queryKey: ["server", id] });
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (error: Error) => {
      message.error(error.message || t("servers.discovery.finishSetup"));
    },
  });

  const handleRescan = useCallback(() => {
    rescanMutation.mutate();
  }, [rescanMutation]);

  const discoveryScanning = isDiscoveryScanning(discoveryStatus);
  const wasScanningRef = useRef(false);

  useEffect(() => {
    if (wasScanningRef.current && !discoveryScanning) {
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
      void queryClient.invalidateQueries({ queryKey: ["server-targets", id] });
      void queryClient.invalidateQueries({ queryKey: ["server-edges", id] });
      message.success(t("servers.discovery.rescanComplete"));
    }
    wasScanningRef.current = discoveryScanning;
  }, [discoveryScanning, id, queryClient, t]);

  const handleSubmit = useCallback(
    async (values: ServerFormValues) => {
      if (!server) return false;

      const payload = buildServerPayload(values, true);

      try {
        await api(`/api/servers/${server.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        message.success(t("servers.updated"));
        void queryClient.invalidateQueries({ queryKey: ["servers"] });
        void queryClient.invalidateQueries({ queryKey: ["server", id] });
        void queryClient.invalidateQueries({ queryKey: ["discovery-status", id] });
        return true;
      } catch (error) {
        message.error(getServerSaveErrorMessage(error, t));
        return false;
      }
    },
    [id, queryClient, server, t],
  );

  if (isLoading) {
    return (
      <ModulePageShell
        icon={<CloudServerOutlined style={{ fontSize: 20 }} />}
        title={t("servers.detail.title")}
        subtitle={t("servers.detail.loading")}
      >
        <Spin />
      </ModulePageShell>
    );
  }

  if (isError || !server) {
    return (
      <ModulePageShell
        icon={<CloudServerOutlined style={{ fontSize: 20 }} />}
        title={t("servers.detail.title")}
        subtitle={t("servers.detail.notFound")}
        action={
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/servers")}>
            {t("servers.detail.back")}
          </Button>
        }
      >
        <Spin />
      </ModulePageShell>
    );
  }

  const displaySetupStatus = discoveryStatus?.setup_status ?? server.setup_status;
  const setupTag =
    displaySetupStatus === "ready"
      ? t("servers.discovery.statusReady")
      : displaySetupStatus === "scanning"
        ? t("servers.discovery.statusScanning")
        : t("servers.discovery.statusPending");

  return (
    <>
      <ModulePageShell
        icon={<CloudServerOutlined style={{ fontSize: 20 }} />}
        title={server.name}
        subtitle={`${server.ip} · ${setupTag}`}
        action={
          <Space>
            {displaySetupStatus === "pending_review" ? (
              <Button
                type="primary"
                loading={completeSetupMutation.isPending}
                onClick={() => completeSetupMutation.mutate()}
              >
                {t("servers.discovery.finishSetup")}
              </Button>
            ) : null}
            <Button
              icon={<ReloadOutlined />}
              loading={discoveryScanning}
              onClick={handleRescan}
            >
              {t("servers.discovery.rescan")}
            </Button>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/servers")}>
              {t("servers.detail.back")}
            </Button>
          </Space>
        }
      >
        <Tabs
          activeKey={tabKey}
          onChange={(key) => navigate(`/servers/${id}?tab=${key}`)}
          destroyInactiveTabPane
          items={[
            {
              key: "overview",
              label: t("servers.detail.tabs.overview"),
              children:
                tabKey === "overview" ? (
                  <ServerOverviewTab
                    server={server}
                    discoveryStatus={discoveryStatus}
                    onRescan={handleRescan}
                    rescanning={discoveryScanning}
                    onEdit={() => setEditOpen(true)}
                    active
                  />
                ) : null,
            },
            {
              key: "monitor",
              label: t("servers.detail.tabs.monitor"),
              children: tabKey === "monitor" ? (
                <ServerMonitorChecklist
                  serverId={server.id}
                  discoveryStatus={discoveryStatus}
                  onRescan={handleRescan}
                  rescanning={discoveryScanning}
                />
              ) : null,
            },
            {
              key: "dependencies",
              label: t("servers.detail.tabs.dependencies"),
              children:
                tabKey === "dependencies" ? (
                  <ServerDependenciesTab serverId={server.id} active />
                ) : null,
            },
            {
              key: "settings",
              label: t("servers.detail.tabs.settings"),
              children:
                tabKey === "settings" ? (
                  <ServerTerminalPanel server={server} active />
                ) : null,
            },
          ]}
        />
      </ModulePageShell>
      <ServerFormDrawer
        open={editOpen}
        server={server}
        groups={[]}
        onOpenChange={setEditOpen}
        onFinish={async (values, { isEdit }) => handleSubmit(values)}
      />
    </>
  );
}