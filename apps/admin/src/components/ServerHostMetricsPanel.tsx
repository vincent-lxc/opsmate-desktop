import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Progress,
  Row,
  Spin,
  Typography,
} from "antd";
import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  DesktopOutlined,
  HddOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import {
  formatBytes,
  formatUptime,
  type HostMetrics,
  usageProgressStatus,
} from "../utils/host-metrics-types";
import { formatDateTime } from "../utils/datetime";

type ServerHostMetricsPanelProps = {
  serverId: string;
  hasSshKey: boolean;
  active?: boolean;
};

export function ServerHostMetricsPanel({
  serverId,
  hasSshKey,
  active = true,
}: ServerHostMetricsPanelProps) {
  const { t } = useTranslation();

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["server-metrics", serverId],
    queryFn: () => api<HostMetrics>(`/api/servers/${serverId}/metrics`),
    enabled: active && hasSshKey,
    refetchInterval: active && hasSshKey ? 30_000 : false,
    retry: false,
    staleTime: 15_000,
  });

  if (!hasSshKey) {
    return (
      <Alert
        type="warning"
        showIcon
        message={t("servers.overview.metricsNoSsh")}
        description={t("servers.overview.metricsNoSshHint")}
      />
    );
  }

  if (isLoading && !data) {
    return (
      <Card size="small">
        <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
          <Spin tip={t("servers.overview.metricsLoading")} />
        </div>
      </Card>
    );
  }

  if (error && !data) {
    const message = error instanceof Error ? error.message : t("servers.overview.metricsFailed");
    return (
      <Alert
        type="error"
        showIcon
        message={t("servers.overview.metricsFailed")}
        description={message}
        action={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void refetch()}>
            {t("servers.overview.metricsRefresh")}
          </Button>
        }
      />
    );
  }

  if (!data) return null;

  return (
    <Card
      title={t("servers.overview.hostMetrics")}
      size="small"
      extra={
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined />}
          loading={isFetching}
          onClick={() => void refetch()}
        >
          {t("servers.overview.metricsRefresh")}
        </Button>
      }
    >
      <Row gutter={[24, 24]} align="middle">
        <Col xs={12} sm={6}>
          <MetricGauge
            title={t("servers.overview.cpu")}
            percent={Math.round(data.cpu.usage_pct)}
            icon={<DesktopOutlined />}
            detail={t("servers.overview.cpuDetail", {
              cores: data.cpu.cores,
              load: data.cpu.load.map((v) => v.toFixed(2)).join(" / "),
            })}
          />
        </Col>
        <Col xs={12} sm={6}>
          <MetricGauge
            title={t("servers.overview.memory")}
            percent={Math.round(data.memory.usage_pct)}
            icon={<DatabaseOutlined />}
            detail={`${formatBytes(data.memory.used_bytes)} / ${formatBytes(data.memory.total_bytes)}`}
          />
        </Col>
        <Col xs={12} sm={6}>
          <MetricGauge
            title={t("servers.overview.disk")}
            percent={Math.round(data.disk.usage_pct)}
            icon={<HddOutlined />}
            detail={`${formatBytes(data.disk.used_bytes)} / ${formatBytes(data.disk.total_bytes)} (${data.disk.mount})`}
          />
        </Col>
        <Col xs={12} sm={6}>
          <div style={{ textAlign: "center" }}>
            <Typography.Text type="secondary">{t("servers.overview.network")}</Typography.Text>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <Typography.Text>
                <CloudDownloadOutlined style={{ marginRight: 6 }} />
                {t("servers.overview.netRx")}: {formatBytes(data.network.rx_bytes)}
              </Typography.Text>
              <Typography.Text>
                <CloudUploadOutlined style={{ marginRight: 6 }} />
                {t("servers.overview.netTx")}: {formatBytes(data.network.tx_bytes)}
              </Typography.Text>
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
              {t("servers.overview.netSinceBoot")}
            </Typography.Text>
          </div>
        </Col>
      </Row>

      <Descriptions
        size="small"
        column={{ xs: 1, sm: 2, md: 4 }}
        style={{ marginTop: 20 }}
        title={t("servers.overview.systemInfo")}
      >
        <Descriptions.Item label={t("servers.overview.hostname")}>
          {data.system.hostname}
        </Descriptions.Item>
        <Descriptions.Item label={t("servers.overview.os")}>{data.system.os}</Descriptions.Item>
        <Descriptions.Item label={t("servers.overview.kernel")}>
          {data.system.kernel}
        </Descriptions.Item>
        <Descriptions.Item label={t("servers.overview.uptime")}>
          {formatUptime(data.system.uptime_seconds)}
        </Descriptions.Item>
        <Descriptions.Item label={t("servers.overview.collectedAt")}>
          {formatDateTime(data.collected_at)}
        </Descriptions.Item>
        {data.docker?.installed ? (
          <>
            <Descriptions.Item label={t("servers.overview.dockerVersion")}>
              {data.docker.version ?? "—"}
            </Descriptions.Item>
            <Descriptions.Item label={t("servers.overview.dockerApi")}>
              {data.docker.api_version ?? "—"}
            </Descriptions.Item>
            <Descriptions.Item label={t("servers.overview.dockerContainers")}>
              {t("servers.overview.dockerContainerCounts", {
                running: data.docker.containers_running,
                total: data.docker.containers_total,
              })}
            </Descriptions.Item>
            <Descriptions.Item label={t("servers.overview.dockerStorage")}>
              {data.docker.storage_driver ?? "—"}
            </Descriptions.Item>
          </>
        ) : (
          <Descriptions.Item label={t("servers.overview.dockerEngine")}>
            {t("servers.overview.dockerNotInstalled")}
          </Descriptions.Item>
        )}
      </Descriptions>
    </Card>
  );
}

function MetricGauge({
  title,
  percent,
  icon,
  detail,
}: {
  title: string;
  percent: number;
  icon: ReactNode;
  detail: string;
}) {
  return (
    <div style={{ textAlign: "center" }}>
      <Typography.Text type="secondary">
        {icon} {title}
      </Typography.Text>
      <Progress
        type="dashboard"
        percent={percent}
        status={usageProgressStatus(percent)}
        size={120}
        style={{ margin: "8px auto" }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {detail}
      </Typography.Text>
    </div>
  );
}