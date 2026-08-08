import { ProTable } from "@ant-design/pro-components";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { SafetyOutlined } from "@ant-design/icons";
import { Alert, Button, Space, Tag } from "antd";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { externalRiskApi, isSlaBreached, type ExternalRiskFinding } from "../../api/external-risk";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";
import {
  findingStatusTag,
  riskFlagTags,
  severityTag,
} from "../../utils/external-risk-display";
import { ExternalRiskFindingDrawer } from "./ExternalRiskFindingDrawer";

export function ExternalRiskCriticalPage() {
  const { t } = useTranslation();
  const actionRef = useRef<ActionType>(null);
  const [detailFinding, setDetailFinding] = useState<ExternalRiskFinding | null>(null);

  const columns = useMemo<ProColumns<ExternalRiskFinding>[]>(
    () => [
      {
        title: t("externalRisk.critical.columns.detectedAt"),
        dataIndex: "created_at",
        valueType: "dateTime",
        width: 170,
        search: false,
      },
      {
        title: t("externalRisk.critical.columns.target"),
        dataIndex: "component_name",
        ellipsis: true,
        render: (_, row) => (
          <Space direction="vertical" size={0}>
            <span>{row.component_name}</span>
            <Space size={4} wrap>
              {riskFlagTags(row, t)}
            </Space>
          </Space>
        ),
      },
      {
        title: t("externalRisk.critical.columns.severity"),
        dataIndex: "severity",
        width: 90,
        valueType: "select",
        valueEnum: {
          P1: { text: "P1" },
          P2: { text: "P2" },
        },
        render: (_, row) => severityTag(row.severity),
      },
      {
        title: t("externalRisk.critical.columns.type"),
        dataIndex: "finding_type",
        width: 140,
      },
      {
        title: t("externalRisk.critical.columns.sla"),
        dataIndex: "created_at",
        width: 110,
        search: false,
        render: (_, row) =>
          isSlaBreached(row) ? (
            <Tag color="red">{t("externalRisk.critical.sla.breached")}</Tag>
          ) : (
            <Tag>{t("externalRisk.critical.sla.ok")}</Tag>
          ),
      },
      {
        title: t("externalRisk.critical.columns.status"),
        dataIndex: "status",
        width: 120,
        render: (_, row) => findingStatusTag(row.status, t),
      },
      {
        title: t("externalRisk.critical.columns.aiSummary"),
        dataIndex: "ai_summary",
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
    [t],
  );

  return (
    <>
      <ModulePageShell
        icon={<SafetyOutlined style={{ fontSize: 20 }} />}
        title={t("externalRisk.critical.title")}
        subtitle={t("externalRisk.critical.subtitle")}
      >
        <Alert
          type="warning"
          showIcon
          message={t("externalRisk.critical.hint")}
          style={{ marginBottom: 16 }}
        />
        <ModuleTableCard>
          <ProTable<ExternalRiskFinding>
            {...moduleProTableProps}
            actionRef={actionRef}
            rowKey="id"
            columns={columns}
            request={(params, sort, filter) => externalRiskApi.listCritical(params, sort, filter)}
            search={moduleTableSearch()}
            pagination={moduleTablePagination}
            locale={{ emptyText: t("externalRisk.critical.empty") }}
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