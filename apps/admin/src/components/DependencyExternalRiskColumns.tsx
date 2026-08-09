import { Button, Space, Tag } from "antd";
import type { TFunction } from "i18next";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { externalRiskApi, type ExternalRiskAssetSummary } from "../api/external-risk";
import type { ReferencedComponent } from "../utils/monitoring-types";
import { severityTag } from "../utils/external-risk-display";

function summaryKey(setId: string, name: string) {
  return `${setId}:${name}`;
}

function highestSeverity(summary: ExternalRiskAssetSummary | undefined): string | null {
  if (!summary || summary.open_total === 0) return null;
  if (summary.open_p1 > 0) return "P1";
  if (summary.open_p2 > 0) return "P2";
  if (summary.open_p3 > 0) return "P3";
  return null;
}

export function useDependencyExternalRiskSummaries(
  setId: string | null,
  components: ReferencedComponent[],
) {
  return useQuery({
    queryKey: ["external-risk-dependency-summaries", setId, components.map((c) => c.name).join(",")],
    queryFn: async () => {
      if (!setId || components.length === 0) return new Map<string, ExternalRiskAssetSummary>();
      const items = components.map((comp) => ({
        target_kind: "dependency_component",
        target_id: `${setId}:${comp.name}`,
      }));
      const res = await externalRiskApi.getAssetSummaries(items);
      const map = new Map<string, ExternalRiskAssetSummary>();
      for (const row of res.items) {
        map.set(row.target_id, row);
      }
      return map;
    },
    enabled: Boolean(setId) && components.length > 0,
  });
}

export function DependencyExternalRiskStatusCell({
  setId,
  component,
  summaryMap,
  t,
}: {
  setId: string;
  component: ReferencedComponent;
  summaryMap: Map<string, ExternalRiskAssetSummary> | undefined;
  t: TFunction;
}) {
  const summary = summaryMap?.get(summaryKey(setId, component.name));
  const severity = highestSeverity(summary);
  if (!severity) {
    return <Tag>{t("externalRisk.assetSummary.noRisk")}</Tag>;
  }
  return (
    <Space size={4}>
      {severityTag(severity)}
      <span>{summary?.open_total ?? 0}</span>
    </Space>
  );
}

export function DependencyExternalRiskFlagsCell({
  setId,
  component,
  summaryMap,
  t,
}: {
  setId: string;
  component: ReferencedComponent;
  summaryMap: Map<string, ExternalRiskAssetSummary> | undefined;
  t: TFunction;
}) {
  const summary = summaryMap?.get(summaryKey(setId, component.name));
  const tags = [];
  if ((summary?.cve_count ?? 0) > 0) tags.push(<Tag key="cve" color="red">CVE</Tag>);
  if ((summary?.bug_count ?? 0) > 0) {
    tags.push(<Tag key="bug" color="orange">{t("externalRisk.assetSummary.bug")}</Tag>);
  }
  if ((summary?.eol_count ?? 0) > 0) {
    tags.push(<Tag key="eol">{t("externalRisk.assetSummary.eol")}</Tag>);
  }
  if (component.has_known_vulnerabilities && tags.length === 0) {
    tags.push(<Tag key="known" color="volcano">{t("externalRisk.assetSummary.manifestKnownVuln")}</Tag>);
  }
  return tags.length > 0 ? <Space size={4} wrap>{tags}</Space> : "—";
}

export function DependencyExternalRiskUpgradeCell({
  setId,
  component,
  summaryMap,
}: {
  setId: string;
  component: ReferencedComponent;
  summaryMap: Map<string, ExternalRiskAssetSummary> | undefined;
}) {
  const summary = summaryMap?.get(summaryKey(setId, component.name));
  return summary?.recommended_upgrade_version ?? component.latest_version ?? "—";
}

export function DependencyExternalRiskLinkCell({
  componentName,
  t,
}: {
  componentName: string;
  t: TFunction;
}) {
  return (
    <Link to={`/external-risk/findings?component_name=${encodeURIComponent(componentName)}`}>
      <Button type="link" size="small" style={{ padding: 0 }}>
        {t("externalRisk.assetSummary.viewFindings")}
      </Button>
    </Link>
  );
}