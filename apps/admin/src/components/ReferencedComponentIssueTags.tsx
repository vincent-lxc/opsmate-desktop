import { Space, Tag, Typography } from "antd";
import type { TFunction } from "i18next";
import type { ReferencedComponent } from "../utils/monitoring-types";
import {
  hasDisplayableUpdateRecommendation,
  hasReferencedComponentKnownIssue,
  isReferencedComponentOutdated,
} from "../utils/referenced-component-sort";

type IssueTagProps = {
  color: "error" | "warning" | "processing" | "success";
  label: string;
  detail?: string | null;
};

function IssueTagRow({ color, label, detail }: IssueTagProps) {
  return (
    <Space size={4} style={{ maxWidth: "100%" }}>
      <Tag color={color}>{label}</Tag>
      {detail ? (
        <Typography.Text ellipsis={{ tooltip: detail }} style={{ maxWidth: 160 }}>
          {detail}
        </Typography.Text>
      ) : null}
    </Space>
  );
}

export function ReferencedComponentKnownIssuesCell({
  component,
  t,
}: {
  component: ReferencedComponent;
  t: TFunction;
}) {
  if (!hasReferencedComponentKnownIssue(component)) {
    return (
      <Tag color="success">{t("monitoring.applications.columns.noKnownIssues")}</Tag>
    );
  }

  const rows: IssueTagProps[] = [];

  if (component.has_known_vulnerabilities) {
    rows.push({
      color: "error",
      label: t("monitoring.dependencyManifests.issueTags.vulnerability"),
      detail: component.known_issues,
    });
  }

  if (isReferencedComponentOutdated(component)) {
    rows.push({
      color: "processing",
      label: t("monitoring.dependencyManifests.issueTags.outdated"),
      detail: t("monitoring.dependencyManifests.issueDetail.outdated", {
        current: component.version,
        latest: component.latest_version,
      }),
    });
  }

  if (rows.length === 1) {
    const row = rows[0]!;
    return <IssueTagRow {...row} />;
  }

  return (
    <Space direction="vertical" size={4} style={{ width: "100%" }}>
      {rows.map((row) => (
        <IssueTagRow key={row.label} {...row} />
      ))}
    </Space>
  );
}

export function ReferencedComponentUpdateRecommendationCell({
  component,
  t,
}: {
  component: ReferencedComponent;
  t: TFunction;
}) {
  const text = component.update_recommendation?.trim();
  if (!hasDisplayableUpdateRecommendation(text)) return "—";

  return (
    <IssueTagRow
      color="warning"
      label={t("monitoring.dependencyManifests.issueTags.update")}
      detail={text}
    />
  );
}

export function ReferencedComponentIssueSummaryTags({
  counts,
  t,
}: {
  counts: {
    vulnerabilities: number;
    updateRecommendations: number;
    outdatedVersions: number;
  };
  t: TFunction;
}) {
  const tags = [
    counts.vulnerabilities > 0 ? (
      <Tag key="vuln" color="error">
        {t("monitoring.dependencyManifests.issueTags.vulnerability")} {counts.vulnerabilities}
      </Tag>
    ) : null,
    counts.updateRecommendations > 0 ? (
      <Tag key="update" color="warning">
        {t("monitoring.dependencyManifests.issueTags.update")} {counts.updateRecommendations}
      </Tag>
    ) : null,
    counts.outdatedVersions > 0 ? (
      <Tag key="outdated" color="processing">
        {t("monitoring.dependencyManifests.issueTags.outdated")} {counts.outdatedVersions}
      </Tag>
    ) : null,
  ].filter(Boolean);

  if (tags.length === 0) {
    return <Tag color="success">{t("monitoring.applications.columns.noKnownIssues")}</Tag>;
  }

  return <Space size={4} wrap>{tags}</Space>;
}