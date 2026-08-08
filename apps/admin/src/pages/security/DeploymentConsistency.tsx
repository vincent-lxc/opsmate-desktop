import { useState } from "react";
import { ReloadOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { ModulePageShell } from "../../components/ModulePageShell";
import { formatDateTime } from "../../utils/datetime";

type CredentialItem = {
  id: string;
  name: string;
  kind: string;
};

type DeployFinding = {
  id: string;
  project: string;
  scope: string;
  code: string;
  severity: "P1" | "P2" | "P3";
  message: string;
  detail: Record<string, unknown>;
  status: string;
  created_at: string;
  resolved_at: string | null;
};

type CheckReport = {
  generated_at: string;
  credential_id: string;
  metadata: {
    projects: { name: string; source: string | null; composeFile: string | null }[];
    domains: { host: string; serviceName: string; port: number | null; path: string | null }[];
    deployments: { projectName: string; status: string; createdAt: string | null; version: string | null; commit: string | null }[];
    field_skipped: number;
  } | null;
  runtime: unknown;
  findings: { project: string; scope: string; code: string; severity: "P1" | "P2" | "P3"; message: string; detail?: Record<string, unknown> }[];
};

export function DeploymentConsistencyPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [credentialId, setCredentialId] = useState<string | undefined>();
  const ns = "security.deploymentConsistency";

  const credentialsQuery = useQuery({
    queryKey: ["deploy-consistency-credentials"],
    queryFn: () => api<{ items: CredentialItem[] }>("/api/security/credentials"),
  });
  const connectionStringCreds = (credentialsQuery.data?.items ?? []).filter(
    (c) => c.kind === "connection_string",
  );

  const findingsQuery = useQuery({
    queryKey: ["deploy-consistency-findings"],
    queryFn: () => api<{ items: DeployFinding[]; total: number }>("/api/deployment-consistency/findings"),
  });

  const checkMutation = useMutation({
    mutationFn: (credId: string) =>
      api<CheckReport>("/api/deployment-consistency/check", {
        method: "POST",
        body: JSON.stringify({ credential_id: credId }),
      }),
    onSuccess: (report) => {
      message.success(t(`${ns}.checkDone`, { count: report.findings.length }));
      queryClient.invalidateQueries({ queryKey: ["deploy-consistency-findings"] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : t(`${ns}.checkFailed`);
      message.error(msg);
    },
  });

  const runCheck = () => {
    if (!credentialId) {
      message.warning(t(`${ns}.selectCredentialFirst`));
      return;
    }
    checkMutation.mutate(credentialId);
  };

  const lastReport = checkMutation.data;
  const openFindings = findingsQuery.data?.items ?? [];

  return (
    <ModulePageShell
      icon={<SafetyCertificateOutlined style={{ fontSize: 20 }} />}
      title={t(`${ns}.title`)}
      subtitle={t(`${ns}.subtitle`)}
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Alert type="info" showIcon message={t(`${ns}.safetyNote`)} />

        <Card variant="outlined" title={t(`${ns}.runCheck`)}>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Select
              style={{ width: 420 }}
              placeholder={t(`${ns}.selectCredential`)}
              value={credentialId}
              onChange={setCredentialId}
              loading={credentialsQuery.isLoading}
              options={connectionStringCreds.map((c) => ({ value: c.id, label: c.name }))}
              notFoundContent={<Empty description={t(`${ns}.noConnectionCredentials`)} image={Empty.PRESENTED_IMAGE_SIMPLE} />}
            />
            <Space>
              <Button
                type="primary"
                icon={<ReloadOutlined />}
                loading={checkMutation.isPending}
                onClick={runCheck}
              >
                {t(`${ns}.runCheckButton`)}
              </Button>
              <Button
                onClick={() => queryClient.invalidateQueries({ queryKey: ["deploy-consistency-findings"] })}
                loading={findingsQuery.isFetching}
              >
                {t(`${ns}.refreshFindings`)}
              </Button>
            </Space>

            {lastReport && (
              <Descriptions bordered size="small" column={1}>
                <Descriptions.Item label={t(`${ns}.generatedAt`)}>
                  {formatDateTime(lastReport.generated_at)}
                </Descriptions.Item>
                <Descriptions.Item label={t(`${ns}.fieldSkipped`)}>
                  {lastReport.metadata?.field_skipped ?? "—"}
                </Descriptions.Item>
                <Descriptions.Item label={t(`${ns}.projectsScanned`)}>
                  {lastReport.metadata?.projects.length ?? 0}
                </Descriptions.Item>
                <Descriptions.Item label={t(`${ns}.findingsCount`)}>
                  {lastReport.findings.length}
                </Descriptions.Item>
              </Descriptions>
            )}
          </Space>
        </Card>

        <Card variant="outlined" title={t(`${ns}.findings`)} loading={findingsQuery.isLoading}>
          {openFindings.length === 0 ? (
            <Typography.Text type="secondary">{t(`${ns}.noFindings`)}</Typography.Text>
          ) : (
            <Table<DeployFinding>
              rowKey="id"
              dataSource={openFindings}
              pagination={false}
              size="small"
              columns={[
                {
                  title: "Severity",
                  dataIndex: "severity",
                  width: 90,
                  render: (s: DeployFinding["severity"]) => (
                    <Tag color={s === "P1" ? "error" : s === "P2" ? "warning" : "default"}>{s}</Tag>
                  ),
                },
                { title: t(`${ns}.project`), dataIndex: "project", width: 160 },
                { title: t(`${ns}.code`), dataIndex: "code", width: 240 },
                { title: t(`${ns}.message`), dataIndex: "message" },
                {
                  title: t(`${ns}.status`),
                  dataIndex: "status",
                  width: 90,
                  render: (s: string) => <Tag color={s === "open" ? "warning" : "default"}>{s}</Tag>,
                },
              ]}
            />
          )}
        </Card>
      </Space>
    </ModulePageShell>
  );
}