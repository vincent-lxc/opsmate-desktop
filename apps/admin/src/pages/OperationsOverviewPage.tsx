import { ReloadOutlined } from "@ant-design/icons";
import { GridContent, PageContainer } from "@ant-design/pro-components";
import { Button, Card, Col, Empty, Progress, Row, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { formatDateTime } from "../utils/datetime";
import { OverviewIntroRow } from "../components/dashboard/OverviewIntroRow";
import { useStateLabel } from "../locales/labels";
import { taskStatusTag, verdictTag } from "../utils/patrol-display";

type DashboardOverview = {
  kpis: {
    server_count: number;
    active_problem_count: number;
    running_task_count: number;
    patrol_task_count: number;
    pending_remediation_count: number;
    verdict_counts: {
      normal: number;
      watch: number;
      anomaly: number;
      unknown: number;
    };
  };
  servers: Array<{
    id: string;
    name: string;
    ip: string;
    group_name: string;
    latest_verdict: "normal" | "watch" | "anomaly" | null;
    latest_patrol_at: string | null;
    latest_summary: string | null;
    task_title: string | null;
  }>;
  active_problems: Array<{
    id: string;
    server_id: string;
    server_name: string | null;
    problem_state: string;
    problem_statement: string | null;
    severity: string | null;
    timestamp: string;
    needs_intervention: boolean;
  }>;
  patrol_tasks: Array<{
    id: string;
    title: string;
    status: string;
    server_group_name: string;
    server_count: number;
    last_round_at: string | null;
    last_round_status: string | null;
  }>;
};

const VERDICT_PROGRESS: Record<string, string> = {
  normal: "#52c41a",
  watch: "#faad14",
  anomaly: "#ff4d4f",
  unknown: "#bfbfbf",
};

export function OperationsOverviewPage() {
  const { t } = useTranslation();
  const stateLabel = useStateLabel();

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["dashboard-overview"],
    queryFn: () => api<DashboardOverview>("/api/dashboard/overview"),
    refetchInterval: 60_000,
  });

  const needsInterventionCount = useMemo(
    () => data?.active_problems.filter((p) => p.needs_intervention).length ?? 0,
    [data],
  );

  const verdictRows = useMemo(() => {
    if (!data) return [];
    const total = Math.max(data.kpis.server_count, 1);
    return [
      { key: "normal", count: data.kpis.verdict_counts.normal },
      { key: "watch", count: data.kpis.verdict_counts.watch },
      { key: "anomaly", count: data.kpis.verdict_counts.anomaly },
      { key: "unknown", count: data.kpis.verdict_counts.unknown },
    ].map((row) => ({
      ...row,
      percent: Math.round((row.count / total) * 100),
    }));
  }, [data]);

  const serverColumns: ColumnsType<DashboardOverview["servers"][number]> = useMemo(
    () => [
      {
        title: t("dashboard.overview.table.server"),
        dataIndex: "name",
        render: (_, row) => <Link to={`/servers/${row.id}`}>{row.name}</Link>,
      },
      {
        title: t("dashboard.overview.table.group"),
        dataIndex: "group_name",
        width: 100,
      },
      {
        title: t("dashboard.overview.table.ip"),
        dataIndex: "ip",
        width: 130,
      },
      {
        title: t("dashboard.overview.table.verdict"),
        dataIndex: "latest_verdict",
        width: 110,
        render: (verdict: DashboardOverview["servers"][number]["latest_verdict"]) =>
          verdict ? (
            verdictTag(verdict)
          ) : (
            <Tag>{t("dashboard.overview.verdict.unknown")}</Tag>
          ),
      },
      {
        title: t("dashboard.overview.table.patrolAt"),
        dataIndex: "latest_patrol_at",
        width: 168,
        render: (value: string | null) => formatDateTime(value),
      },
      {
        title: t("dashboard.overview.table.summary"),
        dataIndex: "latest_summary",
        ellipsis: true,
        render: (value: string | null) => value ?? "—",
      },
    ],
    [t],
  );

  const problemColumns: ColumnsType<DashboardOverview["active_problems"][number]> = useMemo(
    () => [
      {
        title: t("dashboard.overview.table.problem"),
        dataIndex: "problem_statement",
        ellipsis: true,
        render: (_, row) => (
          <Link to={`/problems?event_id=${row.id}`}>
            {row.problem_statement || row.server_name || t("dashboard.overview.unnamedProblem")}
          </Link>
        ),
      },
      {
        title: t("dashboard.overview.table.server"),
        dataIndex: "server_name",
        width: 120,
        render: (value, row) => value ?? row.server_id,
      },
      {
        title: t("dashboard.overview.table.state"),
        dataIndex: "problem_state",
        width: 100,
        render: (state: string) => {
          const meta = stateLabel(state);
          return <span style={{ color: meta.color, fontWeight: 500 }}>{meta.text}</span>;
        },
      },
    ],
    [t, stateLabel],
  );

  const taskColumns: ColumnsType<DashboardOverview["patrol_tasks"][number]> = useMemo(
    () => [
      {
        title: t("dashboard.overview.table.task"),
        dataIndex: "title",
        render: (title: string) => <Link to="/monitoring/tasks">{title}</Link>,
      },
      {
        title: t("dashboard.overview.table.group"),
        dataIndex: "server_group_name",
        width: 100,
      },
      {
        title: t("dashboard.overview.table.status"),
        dataIndex: "status",
        width: 100,
        render: (status: string) => taskStatusTag(status, t),
      },
      {
        title: t("dashboard.overview.table.patrolAt"),
        dataIndex: "last_round_at",
        width: 168,
        render: (value: string | null) => formatDateTime(value),
      },
    ],
    [t],
  );

  return (
    <PageContainer
      title={t("dashboard.overview.title")}
      subTitle={t("dashboard.overview.subtitle")}
      extra={
        <Button
          icon={<ReloadOutlined />}
          loading={isFetching}
          onClick={() => void refetch()}
        >
          {t("dashboard.overview.refresh")}
        </Button>
      }
    >
      <GridContent>
        {isError ? (
          <Empty description={t("dashboard.overview.loadError")} />
        ) : (
          <>
            <OverviewIntroRow
              loading={isLoading}
              serverCount={data?.kpis.server_count ?? 0}
              normalCount={data?.kpis.verdict_counts.normal ?? 0}
              watchCount={data?.kpis.verdict_counts.watch ?? 0}
              anomalyCount={data?.kpis.verdict_counts.anomaly ?? 0}
              unknownCount={data?.kpis.verdict_counts.unknown ?? 0}
              activeProblemCount={data?.kpis.active_problem_count ?? 0}
              needsInterventionCount={needsInterventionCount}
              pendingRemediationCount={data?.kpis.pending_remediation_count ?? 0}
              runningTaskCount={data?.kpis.running_task_count ?? 0}
              patrolTaskCount={data?.kpis.patrol_task_count ?? 0}
            />

            <Row gutter={24}>
              <Col xl={16} lg={24} md={24} sm={24} xs={24}>
                <Card
                  variant="borderless"
                  loading={isLoading}
                  title={t("dashboard.overview.fleetTitle")}
                  extra={<Link to="/servers">{t("dashboard.overview.manageServers")}</Link>}
                  style={{ marginBottom: 24 }}
                >
                  {!isLoading && data?.servers.length === 0 ? (
                    <Empty description={t("dashboard.overview.noServers")}>
                      <Link to="/servers">
                        <Button type="primary">{t("dashboard.overview.addServer")}</Button>
                      </Link>
                    </Empty>
                  ) : (
                    <Table
                      rowKey="id"
                      size="small"
                      columns={serverColumns}
                      dataSource={data?.servers ?? []}
                      pagination={{
                        pageSize: 8,
                        showSizeChanger: false,
                        style: { marginBottom: 0 },
                      }}
                    />
                  )}
                </Card>
              </Col>

              <Col xl={8} lg={24} md={24} sm={24} xs={24}>
                <Card
                  variant="borderless"
                  loading={isLoading}
                  title={t("dashboard.overview.kpi.verdictMix")}
                  extra={
                    <Link to="/monitoring/patrol-records">
                      {t("dashboard.overview.viewAll")}
                    </Link>
                  }
                  style={{ marginBottom: 24, height: "100%" }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    {verdictRows.map((row) => (
                      <div key={row.key}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            marginBottom: 4,
                          }}
                        >
                          <Typography.Text>
                            {row.key === "unknown"
                              ? t("dashboard.overview.verdict.unknown")
                              : verdictTag(row.key)}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            {row.count} ({row.percent}%)
                          </Typography.Text>
                        </div>
                        <Progress
                          percent={row.percent}
                          strokeColor={VERDICT_PROGRESS[row.key]}
                          showInfo={false}
                          size="small"
                        />
                      </div>
                    ))}
                  </div>
                </Card>
              </Col>
            </Row>

            <Row gutter={24}>
              <Col xl={12} lg={24} md={24} sm={24} xs={24}>
                <Card
                  variant="borderless"
                  loading={isLoading}
                  title={t("dashboard.overview.activeProblemsTitle")}
                  extra={<Link to="/problems">{t("dashboard.overview.viewAll")}</Link>}
                  style={{ marginBottom: 24 }}
                >
                  <Table
                    rowKey="id"
                    size="small"
                    columns={problemColumns}
                    dataSource={data?.active_problems ?? []}
                    locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                    pagination={{
                      pageSize: 5,
                      showSizeChanger: false,
                      style: { marginBottom: 0 },
                      hideOnSinglePage: true,
                    }}
                  />
                </Card>
              </Col>

              <Col xl={12} lg={24} md={24} sm={24} xs={24}>
                <Card
                  variant="borderless"
                  loading={isLoading}
                  title={t("dashboard.overview.patrolTasksTitle")}
                  extra={
                    <Link to="/monitoring/tasks">{t("dashboard.overview.viewAll")}</Link>
                  }
                  style={{ marginBottom: 24 }}
                >
                  <Table
                    rowKey="id"
                    size="small"
                    columns={taskColumns}
                    dataSource={data?.patrol_tasks ?? []}
                    locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                    pagination={{
                      pageSize: 5,
                      showSizeChanger: false,
                      style: { marginBottom: 0 },
                      hideOnSinglePage: true,
                    }}
                  />
                </Card>
              </Col>
            </Row>
          </>
        )}
      </GridContent>
    </PageContainer>
  );
}

export default OperationsOverviewPage;