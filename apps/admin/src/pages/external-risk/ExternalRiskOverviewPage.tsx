import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { RadarChartOutlined } from "@ant-design/icons";
import { Col, Row, Spin, Statistic } from "antd";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { externalRiskApi, isToday, type ExternalRiskFinding, type ExternalRiskProvider } from "../../api/external-risk";
import { ExternalRiskDistributionCharts } from "../../components/ExternalRiskDistributionCharts";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleSectionHeader } from "../../components/ModuleSectionHeader";
import { ModuleSectionStack } from "../../components/ModuleSectionStack";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
} from "../../components/module-table-styles";
import { providerHealthTag, severityTag } from "../../utils/external-risk-display";

export function ExternalRiskOverviewPage() {
  const { t } = useTranslation();

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["external-risk-summary"],
    queryFn: () => externalRiskApi.getSummary(),
  });

  const { data: distributions } = useQuery({
    queryKey: ["external-risk-distributions"],
    queryFn: () => externalRiskApi.getDistributions(),
  });

  const { data: tasksData } = useQuery({
    queryKey: ["external-risk-tasks"],
    queryFn: () => externalRiskApi.listTasks(),
  });

  const { data: findingsSample } = useQuery({
    queryKey: ["external-risk-findings-sample"],
    queryFn: () => externalRiskApi.listFindings({ current: 1, pageSize: 100 }),
  });

  const { data: criticalData, isLoading: criticalLoading } = useQuery({
    queryKey: ["external-risk-critical-recent"],
    queryFn: () => externalRiskApi.listCritical({ current: 1, pageSize: 8 }),
  });

  const { data: providersData, isLoading: providersLoading } = useQuery({
    queryKey: ["external-risk-providers"],
    queryFn: () => externalRiskApi.listProviders(),
  });

  const tasksToday = useMemo(
    () => (tasksData?.items ?? []).filter((task) => isToday(task.last_run_at)).length,
    [tasksData?.items],
  );

  const openFindings = findingsSample?.data ?? [];
  const highConfidence = openFindings.filter(
    (f) =>
      f.confidence === "high" &&
      !["resolved", "ignored", "false_positive", "superseded"].includes(f.status),
  ).length;
  const linkedActions = openFindings.filter(
    (f) => f.problem_id || f.recommended_task_id,
  ).length;

  const recentColumns = useMemo<ProColumns<ExternalRiskFinding>[]>(
    () => [
      {
        title: t("externalRisk.overview.recentColumns.title"),
        dataIndex: "title",
        ellipsis: true,
      },
      {
        title: t("externalRisk.overview.recentColumns.severity"),
        dataIndex: "severity",
        width: 100,
        render: (_, row) => severityTag(row.severity),
      },
      {
        title: t("externalRisk.overview.recentColumns.detectedAt"),
        dataIndex: "created_at",
        valueType: "dateTime",
        width: 170,
      },
    ],
    [t],
  );

  const providerColumns = useMemo<ProColumns<ExternalRiskProvider>[]>(
    () => [
      { title: t("externalRisk.providers.columns.name"), dataIndex: "name", ellipsis: true },
      {
        title: t("externalRisk.providers.columns.kind"),
        dataIndex: "kind",
        width: 140,
      },
      {
        title: t("externalRisk.providers.columns.health"),
        dataIndex: "last_health_status",
        width: 120,
        render: (_, row) => providerHealthTag(row.last_health_status, t),
      },
      {
        title: t("externalRisk.providers.columns.lastChecked"),
        dataIndex: "last_checked_at",
        valueType: "dateTime",
        width: 170,
      },
    ],
    [t],
  );

  const kpiItems = [
    { key: "tasksToday", value: tasksToday },
    { key: "newFindings", value: summary?.new_today ?? 0 },
    { key: "openCritical", value: summary?.open_critical ?? 0 },
    { key: "highConfidence", value: highConfidence },
    { key: "linkedActions", value: linkedActions },
    { key: "providerFailures", value: summary?.provider_failures ?? 0 },
  ] as const;

  return (
    <ModulePageShell
      icon={<RadarChartOutlined style={{ fontSize: 20 }} />}
      title={t("externalRisk.overview.title")}
      subtitle={t("externalRisk.overview.subtitle")}
    >
      <Spin spinning={summaryLoading}>
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          {kpiItems.map(({ key, value }) => (
            <Col key={key} xs={12} sm={8} md={4}>
              <Statistic title={t(`externalRisk.overview.kpi.${key}`)} value={value} />
            </Col>
          ))}
        </Row>
      </Spin>

      <div style={{ marginBottom: 16, padding: "16px 16px 4px", border: "1px solid #f0f0f0", borderRadius: 8 }}>
        <ExternalRiskDistributionCharts data={distributions} />
      </div>

      <ModuleSectionStack>
        <ModuleTableCard>
          <ModuleSectionHeader title={t("externalRisk.overview.recentCritical")} />
          <ProTable<ExternalRiskFinding>
            {...moduleProTableProps}
            rowKey="id"
            loading={criticalLoading}
            columns={recentColumns}
            dataSource={criticalData?.data ?? []}
            search={false}
            pagination={false}
            locale={{ emptyText: t("externalRisk.overview.emptyRecent") }}
          />
        </ModuleTableCard>

        <ModuleTableCard>
          <ModuleSectionHeader title={t("externalRisk.overview.providerHealth")} />
          <ProTable<ExternalRiskProvider>
            {...moduleProTableProps}
            rowKey="id"
            loading={providersLoading}
            columns={providerColumns}
            dataSource={providersData?.items ?? []}
            search={false}
            pagination={moduleTablePagination}
            locale={{ emptyText: t("externalRisk.overview.emptyProviders") }}
          />
        </ModuleTableCard>
      </ModuleSectionStack>
    </ModulePageShell>
  );
}