import { ProTable } from "@ant-design/pro-components";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { AlertOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { externalRiskApi, type ExternalRiskFinding } from "../../api/external-risk";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";
import {
  confidenceTag,
  findingStatusTag,
  severityTag,
} from "../../utils/external-risk-display";
import { ExternalRiskFindingDrawer } from "./ExternalRiskFindingDrawer";

export function ExternalRiskFindingsPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const actionRef = useRef<ActionType>(null);
  const [detailFinding, setDetailFinding] = useState<ExternalRiskFinding | null>(null);
  const componentFilter = searchParams.get("component_name") ?? undefined;

  useEffect(() => {
    if (componentFilter) {
      void actionRef.current?.reload();
    }
  }, [componentFilter]);

  const columns = useMemo<ProColumns<ExternalRiskFinding>[]>(
    () => [
      {
        title: t("externalRisk.findings.columns.detectedAt"),
        dataIndex: "created_at",
        valueType: "dateTime",
        width: 170,
        search: false,
      },
      {
        title: t("externalRisk.findings.columns.target"),
        dataIndex: "component_name",
        ellipsis: true,
        initialValue: componentFilter,
      },
      {
        title: t("externalRisk.findings.columns.type"),
        dataIndex: "finding_type",
        width: 140,
      },
      {
        title: t("externalRisk.findings.columns.severity"),
        dataIndex: "severity",
        width: 90,
        valueType: "select",
        valueEnum: {
          P1: { text: "P1" },
          P2: { text: "P2" },
          P3: { text: "P3" },
        },
        render: (_, row) => severityTag(row.severity),
      },
      {
        title: t("externalRisk.findings.columns.confidence"),
        dataIndex: "confidence",
        width: 110,
        search: false,
        render: (_, row) => confidenceTag(row.confidence, t),
      },
      {
        title: t("externalRisk.findings.columns.impact"),
        dataIndex: "ecosystem",
        ellipsis: true,
        search: false,
        render: (_, row) =>
          [row.ecosystem, row.current_version].filter(Boolean).join(" @ ") || "—",
      },
      {
        title: t("externalRisk.findings.columns.status"),
        dataIndex: "status",
        width: 120,
        valueType: "select",
        valueEnum: {
          new: { text: t("externalRisk.findings.status.new") },
          acknowledged: { text: t("externalRisk.findings.status.acknowledged") },
          in_progress: { text: t("externalRisk.findings.status.in_progress") },
          resolved: { text: t("externalRisk.findings.status.resolved") },
          ignored: { text: t("externalRisk.findings.status.ignored") },
          false_positive: { text: t("externalRisk.findings.status.false_positive") },
          superseded: { text: t("externalRisk.findings.status.superseded") },
        },
        render: (_, row) => findingStatusTag(row.status, t),
      },
      {
        title: t("externalRisk.findings.columns.aiSummary"),
        dataIndex: "ai_summary",
        ellipsis: true,
        search: false,
      },
      {
        title: t("externalRisk.findings.columns.nextAction"),
        dataIndex: "recommended_action",
        ellipsis: true,
        search: false,
      },
      {
        title: t("common.actions"),
        valueType: "option",
        width: 100,
        fixed: "right",
        search: false,
        render: (_, row) => [
          <Button
            key="detail"
            type="link"
            size="small"
            onClick={() => setDetailFinding(row)}
          >
            {t("externalRisk.findings.actions.detail")}
          </Button>,
        ],
      },
    ],
    [t, componentFilter],
  );

  return (
    <>
      <ModulePageShell
        icon={<AlertOutlined style={{ fontSize: 20 }} />}
        title={t("externalRisk.findings.title")}
        subtitle={t("externalRisk.findings.subtitle")}
      >
        <ModuleTableCard>
          <ProTable<ExternalRiskFinding>
            {...moduleProTableProps}
            actionRef={actionRef}
            rowKey="id"
            columns={columns}
            request={(params, sort, filter) => externalRiskApi.listFindings(params, sort, filter)}
            search={moduleTableSearch()}
            pagination={moduleTablePagination}
            locale={{ emptyText: t("externalRisk.findings.empty") }}
          />
        </ModuleTableCard>
      </ModulePageShell>

      <ExternalRiskFindingDrawer
        finding={detailFinding}
        open={Boolean(detailFinding)}
        onClose={() => setDetailFinding(null)}
        onUpdated={() => {
          void actionRef.current?.reload();
        }}
      />
    </>
  );
}