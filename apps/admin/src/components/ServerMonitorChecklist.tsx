import { Alert, Button, Collapse, Empty, Spin, Typography, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { getApiErrorMessage } from "../utils/api-errors";
import {
  CATEGORY_LABEL_KEYS,
  TARGET_CATEGORY_ORDER,
  type DiscoveryStatus,
  type MonitorTarget,
} from "../utils/discovery-types";

import { MonitorTargetRow } from "./MonitorTargetRow";
import { TargetCredentialModal } from "./TargetCredentialModal";
import { canWrite } from "../services/auth/roles";

type ServerMonitorChecklistProps = {
  serverId: string;
  discoveryStatus?: DiscoveryStatus;
  onRescan?: () => void;
  rescanning?: boolean;
};

export function ServerMonitorChecklist({
  serverId,
  discoveryStatus,
  onRescan,
  rescanning,
}: ServerMonitorChecklistProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [credentialTarget, setCredentialTarget] = useState<MonitorTarget | null>(null);
  const writable = canWrite();

  const { data, isLoading } = useQuery({
    queryKey: ["server-targets", serverId],
    queryFn: () =>
      api<{ items: MonitorTarget[]; total: number }>(`/api/servers/${serverId}/targets`),
  });

  const targetsKey = ["server-targets", serverId] as const;

  const patchTargetsCache = (
    updater: (items: MonitorTarget[]) => MonitorTarget[],
  ) => {
    queryClient.setQueryData(targetsKey, (old: { items: MonitorTarget[]; total: number } | undefined) => {
      if (!old) return old;
      const items = updater(old.items);
      return { items, total: items.length };
    });
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: targetsKey });
    void queryClient.invalidateQueries({ queryKey: ["discovery-status", serverId] });
  };

  const handleMutationError = (error: unknown) => {
    message.error(getApiErrorMessage(error, t));
  };

  const confirmMutation = useMutation({
    mutationFn: (targetId: string) =>
      api(`/api/servers/${serverId}/targets/${targetId}/confirm`, { method: "POST" }),
    onMutate: (targetId) => {
      patchTargetsCache((items) =>
        items.map((item) =>
          item.id === targetId ? { ...item, activation_state: "active" } : item,
        ),
      );
    },
    onSuccess: () => {
      message.success(t("servers.discovery.confirmSuccess"));
      invalidate();
    },
    onError: (error) => {
      handleMutationError(error);
      invalidate();
    },
  });

  const ignoreMutation = useMutation({
    mutationFn: (targetId: string) =>
      api(`/api/servers/${serverId}/targets/${targetId}/ignore`, { method: "POST" }),
    onMutate: (targetId) => {
      patchTargetsCache((items) =>
        items.map((item) =>
          item.id === targetId ? { ...item, activation_state: "ignored" } : item,
        ),
      );
    },
    onSuccess: () => {
      message.success(t("servers.discovery.ignoreSuccess"));
      invalidate();
    },
    onError: (error) => {
      handleMutationError(error);
      invalidate();
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ targetId, active }: { targetId: string; active: boolean }) =>
      api(`/api/servers/${serverId}/targets/${targetId}`, {
        method: "PATCH",
        body: JSON.stringify({ activation_state: active ? "active" : "ignored" }),
      }),
    onSuccess: (_data, { active }) => {
      message.success(
        t(active ? "servers.discovery.confirmSuccess" : "servers.discovery.ignoreSuccess"),
      );
      invalidate();
    },
    onError: handleMutationError,
  });

  const skipCredentialMutation = useMutation({
    mutationFn: (targetId: string) =>
      api(`/api/servers/${serverId}/targets/${targetId}`, {
        method: "PATCH",
        body: JSON.stringify({
          credential_status: "none",
          connection_hints: {
            credentials: { auth_mode: "none", source: "manual" },
          },
        }),
      }),
    onSuccess: () => {
      message.success(t("servers.discovery.noAuthMarked"));
      invalidate();
    },
    onError: handleMutationError,
  });

  const reclassifyMutation = useMutation({
    mutationFn: ({
      targetId,
      category,
    }: {
      targetId: string;
      category: "system_service" | "deployment_platform";
    }) =>
      api<{ target: MonitorTarget; rule_id: string }>(
        `/api/servers/${serverId}/targets/${targetId}/reclassify-foundation`,
        { method: "POST", body: JSON.stringify({ category }) },
      ),
    onSuccess: (_data, variables) => {
      message.success(
        t(
          variables.category === "deployment_platform"
            ? "servers.discovery.reclassifyDeploymentSuccess"
            : "servers.discovery.reclassifyFoundationSuccess",
        ),
      );
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["classification-rules"] });
    },
    onError: handleMutationError,
  });

  const credentialMutation = useMutation({
    mutationFn: async ({
      targetId,
      username,
      password,
    }: {
      targetId: string;
      username?: string;
      password?: string;
    }) =>
      api(`/api/servers/${serverId}/targets/${targetId}`, {
        method: "PATCH",
        body: JSON.stringify({
          credential_status: "configured",
          connection_hints: {
            credentials: {
              ...(username?.trim() ? { username: username.trim() } : {}),
              ...(password ? { password } : {}),
            },
          },
        }),
      }),
    onSuccess: () => {
      message.success(t("servers.discovery.credentialSaved"));
      invalidate();
    },
    onError: handleMutationError,
  });

  const grouped = useMemo(() => {
    const items = data?.items ?? [];
    const map = new Map<string, MonitorTarget[]>();
    for (const target of items) {
      const cat =
        target.confidence === "low" && target.activation_state === "suggested"
          ? "pending_review"
          : target.category;
      const list = map.get(cat) ?? [];
      list.push(target);
      map.set(cat, list);
    }
    return TARGET_CATEGORY_ORDER.filter((c) => map.has(c)).map((category) => ({
      category,
      targets: map.get(category) ?? [],
    }));
  }, [data?.items]);

  const scanStats = useMemo(() => {
    const items = data?.items ?? [];
    const containers = items.filter((item) => item.category !== "host_resources");
    const count = (category: string) =>
      items.filter((item) => item.category === category).length;
    return {
      containerCount: containers.length,
      hostCount: count("host_resources"),
      application: count("application"),
      deployment: count("deployment_platform"),
      middleware: count("middleware"),
      database: count("database"),
      cache: count("cache"),
      messageQueue: count("message_queue"),
      unclassified: count("container_runtime"),
    };
  }, [data?.items]);

  const defaultActiveKey = grouped.map((g) => g.category);

  if (isLoading) return <Spin />;

  const discoveryFailed = discoveryStatus?.run?.status === "failed";

  if (grouped.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {discoveryFailed ? (
          <Alert
            type="error"
            showIcon
            message={t("servers.discovery.failed")}
            description={
              discoveryStatus?.run?.error_message ?? t("servers.discovery.failedHint")
            }
            action={
              onRescan && writable ? (
                <Button size="small" loading={rescanning} onClick={onRescan}>
                  {t("servers.discovery.rescan")}
                </Button>
              ) : undefined
            }
          />
        ) : null}
        <Empty description={t("servers.discovery.noTargets")}>
          {onRescan && writable ? (
            <Button
              icon={<ReloadOutlined />}
              loading={rescanning}
              onClick={onRescan}
            >
              {t("servers.discovery.rescan")}
            </Button>
          ) : null}
        </Empty>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {onRescan && writable ? (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button
            icon={<ReloadOutlined />}
            loading={rescanning}
            onClick={onRescan}
          >
            {t("servers.discovery.rescan")}
          </Button>
        </div>
      ) : null}
      {discoveryFailed ? (
        <Alert
          type="warning"
          showIcon
          message={t("servers.discovery.staleScan")}
          description={discoveryStatus?.run?.error_message}
        />
      ) : (
        <Alert
          type="info"
          showIcon
          message={t("servers.discovery.scanSummaryTitle", {
            containers: scanStats.containerCount,
            host: scanStats.hostCount,
          })}
          description={t("servers.discovery.scanSummaryDetail", {
            application: scanStats.application,
            deployment: scanStats.deployment,
            middleware: scanStats.middleware,
            database: scanStats.database,
            cache: scanStats.cache,
            mq: scanStats.messageQueue,
            unclassified: scanStats.unclassified,
          })}
        />
      )}
      <Collapse
        bordered
        defaultActiveKey={defaultActiveKey}
        items={grouped.map((group) => ({
          key: group.category,
          label: (
            <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
              <Typography.Text strong>
                {t(CATEGORY_LABEL_KEYS[group.category] ?? group.category)}
              </Typography.Text>
              <Typography.Text type="secondary">{group.targets.length}</Typography.Text>
            </div>
          ),
          children: group.targets.map((target) => (
            <MonitorTargetRow
              key={target.id}
              target={target}
              canWrite={writable}
              confirmingTargetId={
                confirmMutation.isPending ? (confirmMutation.variables ?? null) : null
              }
              ignoringTargetId={
                ignoreMutation.isPending ? (ignoreMutation.variables ?? null) : null
              }
              onConfirm={(item) => confirmMutation.mutate(item.id)}
              onIgnore={(item) => ignoreMutation.mutate(item.id)}
              onToggle={(item, active) => toggleMutation.mutate({ targetId: item.id, active })}
              onAddCredential={(item) => setCredentialTarget(item)}
              onSkipCredential={(item) => skipCredentialMutation.mutate(item.id)}
              onReclassifyFoundation={(item) =>
                reclassifyMutation.mutate({ targetId: item.id, category: "system_service" })
              }
              reclassifyingTargetId={
                reclassifyMutation.isPending &&
                reclassifyMutation.variables?.category === "system_service"
                  ? (reclassifyMutation.variables?.targetId ?? null)
                  : null
              }
              onReclassifyDeployment={(item) =>
                reclassifyMutation.mutate({ targetId: item.id, category: "deployment_platform" })
              }
              reclassifyingDeploymentTargetId={
                reclassifyMutation.isPending &&
                reclassifyMutation.variables?.category === "deployment_platform"
                  ? (reclassifyMutation.variables?.targetId ?? null)
                  : null
              }
            />
          )),
        }))}
      />
      <TargetCredentialModal
        open={credentialTarget !== null}
        target={credentialTarget}
        onClose={() => setCredentialTarget(null)}
        onSubmit={async (values) => {
          if (!credentialTarget) return;
          await credentialMutation.mutateAsync({
            targetId: credentialTarget.id,
            username: values.username,
            password: values.password,
          });
        }}
      />
    </div>
  );
}
