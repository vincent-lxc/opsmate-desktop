import { ProTable } from "@ant-design/pro-components";
import { ThunderboltOutlined } from "@ant-design/icons";
import { Button, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  DependencyExternalRiskFlagsCell,
  DependencyExternalRiskLinkCell,
  DependencyExternalRiskStatusCell,
  DependencyExternalRiskUpgradeCell,
  useDependencyExternalRiskSummaries,
} from "../components/DependencyExternalRiskColumns";
import {
  ReferencedComponentKnownIssuesCell,
  ReferencedComponentUpdateRecommendationCell,
} from "../components/ReferencedComponentIssueTags";
import {
  moduleNestedTableProps,
  moduleNestedTablePagination,
} from "../components/module-table-styles";
import type { DependencyManifestSet, ReferencedComponent, UploadedManifest } from "../utils/monitoring-types";
import { sortReferencedComponentsByIssue } from "../utils/referenced-component-sort";
import { formatDateTime } from "../utils/datetime";

type MonitorDependencyManifestSetExpandProps = {
  record: DependencyManifestSet;
  onAiEnrich: (setId: string) => void;
  aiEnrichPending: boolean;
  aiEnrichSetId?: string;
};

export function MonitorDependencyManifestSetExpand({
  record,
  onAiEnrich,
  aiEnrichPending,
  aiEnrichSetId,
}: MonitorDependencyManifestSetExpandProps) {
  const { t } = useTranslation();
  const components = record.referenced_components ?? [];
  const { data: summaryMap } = useDependencyExternalRiskSummaries(record.id, components);

  return (
    <div style={{ padding: "8px 0" }}>
      <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", gap: 8 }}>
        <Typography.Text type="secondary">
          {t("monitoring.dependencyManifests.linkedAppsHint")}{" "}
          {record.profile_count > 0 ? (
            <Link to={`/monitoring/applications?manifest_set_id=${record.id}`}>
              {t("monitoring.dependencyManifests.viewLinkedApps")} ({record.profile_count})
            </Link>
          ) : (
            <Link to="/monitoring/applications">{t("menu.monitorApplications")}</Link>
          )}
        </Typography.Text>
        <Button
          size="small"
          icon={<ThunderboltOutlined />}
          loading={aiEnrichPending && aiEnrichSetId === record.id}
          onClick={() => onAiEnrich(record.id)}
        >
          {t("monitoring.dependencyManifests.aiEnrich")}
        </Button>
      </div>
      {[record.language, record.language_version].filter(Boolean).length > 0 ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {t("monitoring.applications.columns.language")}:{" "}
          {[record.language, record.language_version].filter(Boolean).join(" ")}
        </Typography.Paragraph>
      ) : null}
      <ProTable<UploadedManifest>
        {...moduleNestedTableProps}
        rowKey="filename"
        headerTitle={t("monitoring.applications.uploadedManifestsTitle")}
        dataSource={record.manifests}
        style={{ marginBottom: 16 }}
        columns={[
          { title: t("common.name"), dataIndex: "filename", width: 200 },
          {
            title: t("monitoring.applications.columns.uploadedAt"),
            dataIndex: "uploaded_at",
            render: (_, row) => formatDateTime(row.uploaded_at),
          },
        ]}
        search={false}
        pagination={false}
      />
      <ProTable<ReferencedComponent>
        {...moduleNestedTableProps}
        rowKey={(row) => `${row.name}:${row.version ?? ""}`}
        headerTitle={t("monitoring.applications.columns.referencedComponents")}
        dataSource={sortReferencedComponentsByIssue(components)}
        locale={{ emptyText: t("monitoring.applications.referencedComponentsEmpty") }}
        scroll={{ x: 1400 }}
        pagination={moduleNestedTablePagination}
        columns={[
          {
            title: t("monitoring.applications.columns.componentName"),
            dataIndex: "name",
            width: 120,
            fixed: "left",
          },
          {
            title: t("monitoring.applications.columns.componentVersion"),
            dataIndex: "version",
            width: 100,
            render: (_, row) => row.version || "—",
          },
          {
            title: t("externalRisk.assetSummary.riskStatus"),
            width: 120,
            render: (_, row) => (
              <DependencyExternalRiskStatusCell
                setId={record.id}
                component={row}
                summaryMap={summaryMap}
                t={t}
              />
            ),
          },
          {
            title: t("externalRisk.assetSummary.flags"),
            width: 140,
            render: (_, row) => (
              <DependencyExternalRiskFlagsCell
                setId={record.id}
                component={row}
                summaryMap={summaryMap}
                t={t}
              />
            ),
          },
          {
            title: t("externalRisk.assetSummary.recommendedUpgrade"),
            width: 120,
            render: (_, row) => (
              <DependencyExternalRiskUpgradeCell
                setId={record.id}
                component={row}
                summaryMap={summaryMap}
              />
            ),
          },
          {
            title: t("monitoring.dependencyManifests.linkedAppCount"),
            width: 100,
            render: () => record.profile_count,
          },
          {
            title: t("monitoring.applications.columns.componentAddress"),
            dataIndex: "address",
            width: 200,
            ellipsis: true,
            render: (_, row) =>
              row.address ? (
                <a
                  href={row.address.startsWith("http") ? row.address : undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  {row.address}
                </a>
              ) : (
                "—"
              ),
          },
          {
            title: t("monitoring.applications.columns.latestVersion"),
            dataIndex: "latest_version",
            width: 100,
            render: (_, row) => row.latest_version || "—",
          },
          {
            title: t("monitoring.applications.columns.knownIssues"),
            dataIndex: "known_issues",
            width: 220,
            render: (_, row) => <ReferencedComponentKnownIssuesCell component={row} t={t} />,
          },
          {
            title: t("monitoring.applications.columns.updateRecommendation"),
            dataIndex: "update_recommendation",
            width: 220,
            render: (_, row) => <ReferencedComponentUpdateRecommendationCell component={row} t={t} />,
          },
          {
            title: t("common.actions"),
            width: 120,
            fixed: "right",
            render: (_, row) => (
              <DependencyExternalRiskLinkCell componentName={row.name} t={t} />
            ),
          },
        ]}
        search={false}
      />
    </div>
  );
}