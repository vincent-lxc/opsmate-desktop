import { Button, Descriptions, Space, Spin, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { externalRiskApi } from "../api/external-risk";
import { providerHealthTag, severityTag } from "../utils/external-risk-display";

type ExternalRiskAssetSummaryPanelProps = {
  targetKind: "foundation_component" | "dependency_component";
  targetId: string;
  componentName: string;
  fallbackVersion?: string | null;
};

export function ExternalRiskAssetSummaryPanel({
  targetKind,
  targetId,
  componentName,
  fallbackVersion,
}: ExternalRiskAssetSummaryPanelProps) {
  const { t } = useTranslation();

  const { data: summary, isLoading } = useQuery({
    queryKey: ["external-risk-asset-summary", targetKind, targetId],
    queryFn: () => externalRiskApi.getAssetSummary(targetKind, targetId),
  });

  const { data: providersData } = useQuery({
    queryKey: ["external-risk-providers"],
    queryFn: () => externalRiskApi.listProviders(),
  });

  if (isLoading) {
    return (
      <div style={{ textAlign: "center", padding: 24 }}>
        <Spin />
      </div>
    );
  }

  const providers = providersData?.items ?? [];
  const healthCounts = providers.reduce(
    (acc, p) => {
      const key = p.last_health_status ?? "unknown";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const findingsLink = `/external-risk/findings?component_name=${encodeURIComponent(componentName)}`;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label={t("externalRisk.assetSummary.severityCounts")} span={2}>
          <Space wrap>
            {severityTag("P1")}
            <span>{summary?.open_p1 ?? 0}</span>
            {severityTag("P2")}
            <span>{summary?.open_p2 ?? 0}</span>
            {severityTag("P3")}
            <span>{summary?.open_p3 ?? 0}</span>
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label={t("externalRisk.assetSummary.currentVersion")}>
          {summary?.current_version ?? fallbackVersion ?? "—"}
        </Descriptions.Item>
        <Descriptions.Item label={t("externalRisk.assetSummary.recommendedUpgrade")}>
          {summary?.recommended_upgrade_version ?? "—"}
        </Descriptions.Item>
        <Descriptions.Item label={t("externalRisk.assetSummary.providerHealth")} span={2}>
          <Space wrap>
            {Object.entries(healthCounts).map(([status, count]) => (
              <span key={status}>
                {providerHealthTag(status, t)} × {count}
              </span>
            ))}
            {providers.length === 0 && "—"}
          </Space>
        </Descriptions.Item>
        {(summary?.cve_count ?? 0) > 0 ||
        (summary?.bug_count ?? 0) > 0 ||
        (summary?.eol_count ?? 0) > 0 ? (
          <Descriptions.Item label={t("externalRisk.assetSummary.flags")} span={2}>
            <Space wrap>
              {(summary?.cve_count ?? 0) > 0 && (
                <Tag color="red">CVE × {summary?.cve_count}</Tag>
              )}
              {(summary?.bug_count ?? 0) > 0 && (
                <Tag color="orange">{t("externalRisk.assetSummary.bug")} × {summary?.bug_count}</Tag>
              )}
              {(summary?.eol_count ?? 0) > 0 && (
                <Tag>{t("externalRisk.assetSummary.eol")} × {summary?.eol_count}</Tag>
              )}
            </Space>
          </Descriptions.Item>
        ) : null}
      </Descriptions>
      <Link to={findingsLink}>
        <Button type="link" size="small" style={{ padding: 0 }}>
          {t("externalRisk.assetSummary.viewFindings")}
        </Button>
      </Link>
    </Space>
  );
}