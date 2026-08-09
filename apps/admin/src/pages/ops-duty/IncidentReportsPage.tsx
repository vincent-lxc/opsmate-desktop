import { ProTable } from "@ant-design/pro-components";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { FileSearchOutlined, RobotOutlined } from "@ant-design/icons";
import { App, Button, Tag } from "antd";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api, proTableRequest } from "../../api/client";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";

type IncidentReportRow = {
  id: string;
  title: string;
  status: string;
  source: "auto" | "manual";
  problem_group_id: string | null;
  problem_event_id: string | null;
  has_export: boolean;
  created_at: string;
  updated_at: string;
};

function sourceTag(source: IncidentReportRow["source"], t: (k: string) => string) {
  if (source === "auto") {
    return (
      <Tag color="purple" icon={<RobotOutlined />}>
        {t("incidentReports.list.autoBadge")}
      </Tag>
    );
  }
  return <Tag>{t("incidentReports.list.manualBadge")}</Tag>;
}

export function IncidentReportsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const actionRef = useRef<ActionType>(null);

  const columns: ProColumns<IncidentReportRow>[] = useMemo(
    () => [
      {
        title: t("incidentReports.list.columns.title"),
        dataIndex: "title",
        ellipsis: true,
        render: (_, row) => (
          <Link to={`/incident-reports/${row.id}`}>{row.title}</Link>
        ),
      },
      {
        title: t("incidentReports.list.columns.source"),
        dataIndex: "source",
        width: 120,
        valueType: "select",
        valueEnum: {
          auto: { text: t("incidentReports.list.filters.sourceAuto") },
          manual: { text: t("incidentReports.list.filters.sourceManual") },
        },
        render: (_, row) => sourceTag(row.source, t),
      },
      {
        title: t("incidentReports.list.columns.status"),
        dataIndex: "status",
        width: 120,
        valueType: "select",
        valueEnum: {
          draft: { text: t("incidentReports.list.filters.statusDraft") },
          published: { text: t("incidentReports.list.filters.statusPublished") },
          exported: { text: t("incidentReports.list.filters.statusExported") },
        },
        render: (_, row) => {
          if (row.has_export) {
            return <Tag color="green">{t("incidentReports.list.filters.statusExported")}</Tag>;
          }
          if (row.status === "draft") {
            return <Tag>{t("incidentReports.list.filters.statusDraft")}</Tag>;
          }
          return <Tag color="blue">{t("incidentReports.list.filters.statusPublished")}</Tag>;
        },
      },
      {
        title: t("incidentReports.list.columns.problemGroup"),
        dataIndex: "problem_group_id",
        width: 180,
        ellipsis: true,
        hideInSearch: true,
        render: (_, row) => row.problem_group_id ?? "—",
      },
      {
        title: t("incidentReports.list.columns.updatedAt"),
        dataIndex: "updated_at",
        width: 170,
        valueType: "dateTime",
        hideInSearch: true,
      },
      {
        title: t("common.actions"),
        valueType: "option",
        width: 100,
        render: (_, row) => [
          <Link key="open" to={`/incident-reports/${row.id}`}>
            {t("incidentReports.list.open")}
          </Link>,
        ],
      },
    ],
    [t],
  );

  return (
    <ModulePageShell
      icon={<FileSearchOutlined style={{ fontSize: 20 }} />}
      title={t("incidentReports.list.title")}
      subtitle={t("incidentReports.list.subtitle")}
    >
      <ModuleTableCard>
        <ProTable<IncidentReportRow>
          {...moduleProTableProps}
          actionRef={actionRef}
          rowKey="id"
          columns={columns}
          search={moduleTableSearch()}
          options={false}
          cardProps={false}
          ghost
          scroll={{ x: 1040 }}
          pagination={moduleTablePagination}
          request={(params, sort, filter) =>
            proTableRequest<IncidentReportRow>("/api/incident-reports", params, sort, filter)
          }
          locale={{ emptyText: t("incidentReports.list.empty") }}
          toolBarRender={() => [
            <Button
              key="retry"
              onClick={() => {
                void actionRef.current?.reload();
                message.info(t("incidentReports.list.retry"));
              }}
            >
              {t("incidentReports.list.retry")}
            </Button>,
          ]}
        />
      </ModuleTableCard>
    </ModulePageShell>
  );
}