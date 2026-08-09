import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Row,
  Spin,
  Statistic,
  Tag,
  Typography,
} from "antd";
import {
  ApiOutlined,
  CloudServerOutlined,
  ClusterOutlined,
  KeyOutlined,
  LinkOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { ServerRecord } from "./ServerFormDrawer";
import {
  CATEGORY_LABEL_KEYS,
  type DiscoveryStatus,
  type MonitorTarget,
  type TopologyEdge,
} from "../utils/discovery-types";
import { ServerHostMetricsPanel } from "./ServerHostMetricsPanel";
import {
  getTargetAppName,
  getTargetPorts,
  getTargetStatus,
  isContainerRunning,
} from "../utils/target-display";

type ServerOverviewTabProps = {
  server: ServerRecord;
  discoveryStatus?: DiscoveryStatus;
  onRescan: () => void;
  rescanning?: boolean;
  onEdit: () => void;
  active?: boolean;
};

export function ServerOverviewTab({
  server,
  discoveryStatus,
  onRescan,
  rescanning,
  onEdit,
  active = true,
}: ServerOverviewTabProps) {
  const { t } = useTranslation();

  const { data: targetsData, isLoading: targetsLoading } = useQuery({
    queryKey: ["server-targets", server.id],
    queryFn: () =>
      api<{ items: MonitorTarget[] }>(`/api/servers/${server.id}/targets`),
    enabled: active,
  });

  const { data: edgesData, isLoading: edgesLoading } = useQuery({
    queryKey: ["server-edges", server.id],
    queryFn: () =>
      api<{ items: TopologyEdge[] }>(
        `/api/servers/${server.id}/edges?include_pending=true`,
      ),
    enabled: active,
  });

  const targets = targetsData?.items ?? [];
  const edges = edgesData?.items ?? [];

  const stats = useMemo(() => {
    const containers = targets.filter((t) => t.category !== "host_resources");
    const running = containers.filter((t) => isContainerRunning(getTargetStatus(t)) === true)
      .length;
    const stopped = containers.filter((t) => isContainerRunning(getTargetStatus(t)) === false)
      .length;
    const active = targets.filter((t) => t.activation_state === "active").length;
    const suggested = targets.filter((t) => t.activation_state === "suggested").length;

    const byCategory = new Map<string, number>();
    for (const target of targets) {
      byCategory.set(target.category, (byCategory.get(target.category) ?? 0) + 1);
    }

    return { containers: containers.length, running, stopped, active, suggested, byCategory };
  }, [targets]);

  const hasSshKey = Boolean(server.ssh_private_key_set ?? server.ssh_private_key);
  const run = discoveryStatus?.run;
  const discoveryFailed = run?.status === "failed";
  const displaySetupStatus = discoveryStatus?.setup_status ?? server.setup_status;

  const setupColor =
    displaySetupStatus === "ready"
      ? "success"
      : displaySetupStatus === "scanning"
        ? "processing"
        : "warning";

  if (targetsLoading || edgesLoading) {
    return <Spin />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ServerHostMetricsPanel
        serverId={server.id}
        hasSshKey={hasSshKey}
        active={active}
      />

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button
          icon={<ReloadOutlined />}
          loading={rescanning}
          onClick={onRescan}
        >
          {t("servers.discovery.rescan")}
        </Button>
      </div>

      {discoveryFailed ? (
        <Alert
          type="error"
          showIcon
          message={t("servers.discovery.failed")}
          description={run?.error_message ?? t("servers.discovery.failedHint")}
        />
      ) : null}

      {displaySetupStatus === "pending_review" ? (
        <Alert type="warning" showIcon message={t("servers.discovery.statusPending")} description={t("servers.discovery.pendingReviewHint")} />
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t("servers.overview.setupStatus")}
              value={t(
                displaySetupStatus === "ready"
                  ? "servers.discovery.statusReady"
                  : displaySetupStatus === "scanning"
                    ? "servers.discovery.statusScanning"
                    : "servers.discovery.statusPending",
              )}
              valueStyle={{ fontSize: 18 }}
            />
            <Tag color={setupColor} style={{ marginTop: 8 }}>
              {displaySetupStatus}
            </Tag>
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t("servers.overview.sshKey")}
              value={
                hasSshKey
                  ? server.ssh_key_passphrase_set
                    ? t("servers.card.sshKeyEncrypted")
                    : t("servers.card.sshKeyYes")
                  : t("servers.card.sshKeyNo")
              }
              prefix={<KeyOutlined />}
              valueStyle={{ fontSize: 16 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t("servers.overview.containers")}
              value={stats.containers}
              prefix={<ClusterOutlined />}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t("servers.overview.containerBreakdown", {
                running: stats.running,
                stopped: stats.stopped,
              })}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t("servers.overview.monitorTargets")}
              value={targets.length}
              prefix={<ApiOutlined />}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t("servers.overview.targetBreakdown", {
                active: stats.active,
                suggested: stats.suggested,
              })}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t("servers.overview.dependencies")}
              value={edges.length}
              prefix={<LinkOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title={t("servers.discovery.lastRun")}
              value={run?.status ?? t("servers.discovery.none")}
              valueStyle={{ fontSize: 16 }}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title={
          <span>
            <CloudServerOutlined style={{ marginRight: 8 }} />
            {t("servers.overview.serverInfo")}
          </span>
        }
        size="small"
        extra={
          <Button type="link" size="small" onClick={onEdit}>
            {t("servers.detail.editSettings")}
          </Button>
        }
      >
        <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
          <Descriptions.Item label={t("common.name")}>{server.name}</Descriptions.Item>
          <Descriptions.Item label={t("servers.form.ipAddress")}>{server.ip}</Descriptions.Item>
          <Descriptions.Item label={t("servers.columns.sshPort")}>{server.ssh_port}</Descriptions.Item>
          <Descriptions.Item label={t("servers.columns.sshUser")}>
            {server.ssh_user ?? "root"}
          </Descriptions.Item>
          <Descriptions.Item label={t("servers.detail.group")}>
            {server.group_name}
          </Descriptions.Item>
          <Descriptions.Item label={t("servers.overview.description")}>
            {server.description?.trim() ? server.description : "—"}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {stats.byCategory.size > 0 ? (
        <Card title={t("servers.overview.resourcesByCategory")} size="small">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {[...stats.byCategory.entries()].map(([category, count]) => (
              <Tag key={category}>
                {t(CATEGORY_LABEL_KEYS[category] ?? category)}: {count}
              </Tag>
            ))}
          </div>
        </Card>
      ) : null}

      {targets.length > 0 ? (
        <Card title={t("servers.overview.runningServices")} size="small">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {targets
              .filter((t) => t.category !== "host_resources")
              .slice(0, 12)
              .map((target) => {
                const status = getTargetStatus(target);
                const running = isContainerRunning(status);
                const ports = getTargetPorts(target);
                return (
                  <div
                    key={target.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      alignItems: "flex-start",
                      paddingBottom: 8,
                      borderBottom: "1px solid rgba(0,0,0,0.06)",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <Typography.Text strong>{getTargetAppName(target)}</Typography.Text>
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {target.name}
                          {ports.length > 0
                            ? ` · ${t("servers.overview.ports")}: ${ports.join(", ")}`
                            : ""}
                        </Typography.Text>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      {running !== null ? (
                        <Tag color={running ? "success" : "default"}>
                          {running
                            ? t("servers.overview.running")
                            : t("servers.overview.stopped")}
                        </Tag>
                      ) : null}
                      <Tag>{target.activation_state}</Tag>
                    </div>
                  </div>
                );
              })}
          </div>
        </Card>
      ) : (
        <Alert
          type="info"
          showIcon
          message={t("servers.overview.noResources")}
          description={t("servers.overview.noResourcesHint")}
          action={
            <Button
              icon={<ReloadOutlined />}
              loading={rescanning}
              onClick={onRescan}
            >
              {t("servers.discovery.rescan")}
            </Button>
          }
        />
      )}
    </div>
  );
}