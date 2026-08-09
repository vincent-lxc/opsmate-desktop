import { ReloadOutlined, SafetyOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { ModulePageShell } from "../../components/ModulePageShell";
import { formatDateTime } from "../../utils/datetime";

type ConfigHealthStatus = "ok" | "warning" | "degraded" | "unavailable";

type TelegramChannelHealth = {
  channel_id: string;
  name: string;
  enabled: boolean;
  webhook_secret_configured: boolean;
  allowlist_configured: boolean;
  allowlist_size: number;
};

type WebhookConfigHealth = {
  status: ConfigHealthStatus;
  telegram_channels: TelegramChannelHealth[];
  receiver_secret_configured: boolean;
  receiver_ip_allowlist_configured: boolean;
  receiver_ip_allowlist_size: number;
  error?: string;
};

type AuthConfigHealth = {
  status: ConfigHealthStatus;
  auth_enabled: boolean;
  auth_disabled_flag: boolean;
  jwt_secret_configured: boolean;
  node_env: string;
  production_fail_closed: boolean;
  error?: string;
};

type AnonymousPayloadSummary = {
  status: ConfigHealthStatus;
  count_24h: number;
  latest_timestamp: string | null;
  error?: string;
};

type ConfigHealthFinding = {
  scope: string;
  severity: "P1" | "P2" | "P3";
  code: string;
  message: string;
  detail?: Record<string, unknown>;
};

type ConfigHealthReport = {
  status: ConfigHealthStatus;
  generated_at: string;
  subsystems: {
    webhook: WebhookConfigHealth;
    auth: AuthConfigHealth;
    anonymous_payloads: AnonymousPayloadSummary;
  };
  findings: ConfigHealthFinding[];
};

const STATUS_TAG: Record<ConfigHealthStatus, "success" | "warning" | "error" | "default"> = {
  ok: "success",
  warning: "warning",
  degraded: "error",
  unavailable: "default",
};

export function ConfigHealthPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["security-config-health"],
    queryFn: () => api<ConfigHealthReport>("/api/security/config-health"),
  });

  const ns = "security.configHealth";
  const statusLabel = (status: ConfigHealthStatus) => t(`${ns}.status${cap(status)}`);

  return (
    <ModulePageShell
      icon={<SafetyOutlined style={{ fontSize: 20 }} />}
      title={t(`${ns}.title`)}
      subtitle={t(`${ns}.subtitle`)}
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
          <Space align="center">
            <Tag color={STATUS_TAG[data?.status ?? "unavailable"]}>
              {t(`${ns}.overallStatus`)}: {statusLabel(data?.status ?? "unavailable")}
            </Tag>
            {data?.generated_at && (
              <Typography.Text type="secondary">
                {t(`${ns}.generatedAt`)}: {formatDateTime(data.generated_at)}
              </Typography.Text>
            )}
          </Space>
          <Button
            icon={<ReloadOutlined />}
            loading={isFetching}
            onClick={() => queryClient.invalidateQueries({ queryKey: ["security-config-health"] })}
          >
            {t(`${ns}.refresh`)}
          </Button>
        </Space>

        {data && data.findings.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`${data.findings.length} ${t(`${ns}.findings`)}`}
          />
        )}

        <Card variant="outlined" title={t(`${ns}.webhook`)} loading={isLoading}>
          <WebhookCard health={data?.subsystems.webhook} ns={ns} statusLabel={statusLabel} />
        </Card>

        <Card variant="outlined" title={t(`${ns}.auth`)} loading={isLoading}>
          <AuthCard health={data?.subsystems.auth} ns={ns} statusLabel={statusLabel} />
        </Card>

        <Card variant="outlined" title={t(`${ns}.anonymous`)} loading={isLoading}>
          <AnonymousCard
            health={data?.subsystems.anonymous_payloads}
            ns={ns}
            statusLabel={statusLabel}
          />
        </Card>

        <Card variant="outlined" title={t(`${ns}.findings`)} loading={isLoading}>
          {data && data.findings.length === 0 ? (
            <Typography.Text type="secondary">{t(`${ns}.noFindings`)}</Typography.Text>
          ) : (
            <Table<ConfigHealthFinding>
              rowKey={(row) => `${row.scope}:${row.code}`}
              dataSource={data?.findings ?? []}
              pagination={false}
              size="small"
              columns={[
                {
                  title: "Severity",
                  dataIndex: "severity",
                  width: 90,
                  render: (s: ConfigHealthFinding["severity"]) => (
                    <Tag color={s === "P1" ? "error" : s === "P2" ? "warning" : "default"}>{s}</Tag>
                  ),
                },
                { title: "Scope", dataIndex: "scope", width: 220 },
                { title: "Code", dataIndex: "code", width: 260 },
                { title: "Message", dataIndex: "message" },
              ]}
            />
          )}
        </Card>
      </Space>
    </ModulePageShell>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function StatusTag({
  status,
  label,
}: {
  status: ConfigHealthStatus;
  label: string;
}) {
  return <Tag color={STATUS_TAG[status]}>{label}</Tag>;
}

function WebhookCard({
  health,
  ns,
  statusLabel,
}: {
  health: WebhookConfigHealth | undefined;
  ns: string;
  statusLabel: (s: ConfigHealthStatus) => string;
}) {
  const { t } = useTranslation();
  if (!health) return null;
  if (health.status === "unavailable") {
    return (
      <Alert
        type="error"
        showIcon
        message={t(`${ns}.statusUnavailable`)}
        description={health.error}
      />
    );
  }
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Space align="center">
        <StatusTag status={health.status} label={statusLabel(health.status)} />
        <Typography.Text type="secondary">{t(`${ns}.telegramChannels`)}</Typography.Text>
      </Space>
      <Table<TelegramChannelHealth>
        rowKey="channel_id"
        dataSource={health.telegram_channels}
        pagination={false}
        size="small"
        columns={[
          { title: t(`${ns}.channelName`), dataIndex: "name" },
          {
            title: t(`${ns}.enabled`),
            dataIndex: "enabled",
            width: 80,
            render: (v: boolean) => (v ? t(`${ns}.yes`) : t(`${ns}.no`)),
          },
          {
            title: t(`${ns}.secretConfigured`),
            dataIndex: "webhook_secret_configured",
            width: 140,
            render: (v: boolean) => (v ? <Tag color="success">{t(`${ns}.yes`)}</Tag> : <Tag color="error">{t(`${ns}.no`)}</Tag>),
          },
          {
            title: t(`${ns}.allowlistConfigured`),
            dataIndex: "allowlist_configured",
            width: 140,
            render: (v: boolean) => (v ? <Tag color="success">{t(`${ns}.yes`)}</Tag> : <Tag color="error">{t(`${ns}.no`)}</Tag>),
          },
          { title: t(`${ns}.allowlistSize`), dataIndex: "allowlist_size", width: 110 },
        ]}
      />
      <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label={t(`${ns}.receiverSecret`)}>
          {health.receiver_secret_configured ? <Tag color="success">{t(`${ns}.yes`)}</Tag> : <Tag color="error">{t(`${ns}.no`)}</Tag>}
        </Descriptions.Item>
        <Descriptions.Item label={t(`${ns}.receiverAllowlist`)}>
          {health.receiver_ip_allowlist_configured
            ? `${t(`${ns}.yes`)} (${health.receiver_ip_allowlist_size})`
            : t(`${ns}.no`)}
        </Descriptions.Item>
      </Descriptions>
    </Space>
  );
}

function AuthCard({
  health,
  ns,
  statusLabel,
}: {
  health: AuthConfigHealth | undefined;
  ns: string;
  statusLabel: (s: ConfigHealthStatus) => string;
}) {
  const { t } = useTranslation();
  if (!health) return null;
  if (health.status === "unavailable") {
    return (
      <Alert type="error" showIcon message={t(`${ns}.statusUnavailable`)} description={health.error} />
    );
  }
  return (
    <Descriptions bordered size="small" column={1}>
      <Descriptions.Item label={t(`${ns}.overallStatus`)}>
        <StatusTag status={health.status} label={statusLabel(health.status)} />
      </Descriptions.Item>
      <Descriptions.Item label={t(`${ns}.authEnabled`)}>
        {health.auth_enabled ? t(`${ns}.yes`) : t(`${ns}.no`)}
      </Descriptions.Item>
      <Descriptions.Item label={t(`${ns}.jwtSecret`)}>
        {health.jwt_secret_configured ? <Tag color="success">{t(`${ns}.yes`)}</Tag> : <Tag color="error">{t(`${ns}.no`)}</Tag>}
      </Descriptions.Item>
      <Descriptions.Item label={t(`${ns}.authDisabled`)}>
        {health.auth_disabled_flag ? t(`${ns}.yes`) : t(`${ns}.no`)}
      </Descriptions.Item>
      <Descriptions.Item label={t(`${ns}.nodeEnv`)}>{health.node_env || "—"}</Descriptions.Item>
    </Descriptions>
  );
}

function AnonymousCard({
  health,
  ns,
  statusLabel,
}: {
  health: AnonymousPayloadSummary | undefined;
  ns: string;
  statusLabel: (s: ConfigHealthStatus) => string;
}) {
  const { t } = useTranslation();
  if (!health) return null;
  if (health.status === "unavailable") {
    return (
      <Alert type="error" showIcon message={t(`${ns}.statusUnavailable`)} description={health.error} />
    );
  }
  return (
    <Descriptions bordered size="small" column={1}>
      <Descriptions.Item label={t(`${ns}.overallStatus`)}>
        <StatusTag status={health.status} label={statusLabel(health.status)} />
      </Descriptions.Item>
      <Descriptions.Item label={t(`${ns}.anonCount`)}>{health.count_24h}</Descriptions.Item>
      <Descriptions.Item label={t(`${ns}.anonLatest`)}>
        {health.latest_timestamp ? formatDateTime(health.latest_timestamp) : t(`${ns}.none`)}
      </Descriptions.Item>
    </Descriptions>
  );
}