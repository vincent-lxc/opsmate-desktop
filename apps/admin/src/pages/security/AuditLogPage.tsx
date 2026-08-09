import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { DownloadOutlined, FileProtectOutlined } from "@ant-design/icons";
import { App, Button, Space, Tag } from "antd";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { proTableRequest } from "../../api/client";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";

type AuditLogRow = {
  id: string;
  actor_kind: string;
  actor_id: string | null;
  server_id: string | null;
  risk_tier: string | null;
  action_type: string | null;
  command_text: string | null;
  status: string;
  created_at: string;
};

function riskTierTag(tier: string | null) {
  if (!tier) return "—";
  const color = tier === "L1" ? "green" : tier === "L2" ? "orange" : "red";
  return <Tag color={color}>{tier}</Tag>;
}

export function AuditLogPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();

  const downloadExport = async (format: "json" | "csv") => {
    try {
      const base = import.meta.env.VITE_API_BASE_URL ?? "";
      const res = await fetch(
        `${base}/api/security/audit-log/export?redacted=true&format=${format}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-log-redacted.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      message.success(t("security.auditLog.exported"));
    } catch {
      message.error(t("common.error"));
    }
  };

  const columns = useMemo<ProColumns<AuditLogRow>[]>(
    () => [
      {
        title: t("security.auditLog.columns.createdAt"),
        dataIndex: "created_at",
        valueType: "dateTime",
        width: 170,
        search: false,
      },
      {
        title: t("security.auditLog.columns.actor"),
        dataIndex: "actor_kind",
        width: 100,
        valueType: "select",
        valueEnum: {
          user: { text: t("security.auditLog.actor.user") },
          ai: { text: t("security.auditLog.actor.ai") },
          system: { text: t("security.auditLog.actor.system") },
        },
      },
      {
        title: t("security.auditLog.columns.server"),
        dataIndex: "server_id",
        ellipsis: true,
      },
      {
        title: t("security.auditLog.columns.riskTier"),
        dataIndex: "risk_tier",
        width: 90,
        valueType: "select",
        valueEnum: {
          L1: { text: "L1" },
          L2: { text: "L2" },
          L3: { text: "L3" },
        },
        render: (_, row) => riskTierTag(row.risk_tier),
      },
      {
        title: t("security.auditLog.columns.action"),
        dataIndex: "action_type",
        ellipsis: true,
        search: false,
      },
      {
        title: t("security.auditLog.columns.command"),
        dataIndex: "command_text",
        ellipsis: true,
        search: false,
      },
      {
        title: t("security.auditLog.columns.status"),
        dataIndex: "status",
        width: 110,
        valueType: "select",
        valueEnum: {
          pending: { text: t("security.auditLog.status.pending") },
          approved: { text: t("security.auditLog.status.approved") },
          rejected: { text: t("security.auditLog.status.rejected") },
          executed: { text: t("security.auditLog.status.executed") },
          failed: { text: t("security.auditLog.status.failed") },
          blocked: { text: t("security.auditLog.status.blocked") },
        },
      },
    ],
    [t],
  );

  return (
    <ModulePageShell
      icon={<FileProtectOutlined style={{ fontSize: 20 }} />}
      title={t("security.auditLog.title")}
      subtitle={t("security.auditLog.subtitle")}
      action={
        <Space>
          <Button icon={<DownloadOutlined />} onClick={() => void downloadExport("json")}>
            {t("security.auditLog.exportRedactedJson")}
          </Button>
          <Button onClick={() => void downloadExport("csv")}>
            {t("security.auditLog.exportRedactedCsv")}
          </Button>
        </Space>
      }
    >
      <ModuleTableCard>
        <ProTable<AuditLogRow>
          {...moduleProTableProps}
          rowKey="id"
          columns={columns}
          request={(params) => proTableRequest<AuditLogRow>("/api/security/audit-log", params)}
          search={moduleTableSearch()}
          pagination={moduleTablePagination}
          locale={{ emptyText: t("security.auditLog.empty") }}
        />
      </ModuleTableCard>
    </ModulePageShell>
  );
}