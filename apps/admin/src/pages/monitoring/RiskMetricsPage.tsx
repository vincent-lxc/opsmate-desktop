import { ProForm, ProFormSelect, ProTable } from "@ant-design/pro-components";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { FundProjectionScreenOutlined } from "@ant-design/icons";
import { Alert, App, Button, Space, Tag } from "antd";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import {
  useDraftRulesForProfile,
  useUpdateBusinessMetricProfile,
  type BusinessMetricProfile,
} from "../../api/business-metric-profiles";
import { api } from "../../api/client";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";
import { canWrite, getRole } from "../../services/auth/roles";

const TIER_OPTIONS = [
  { label: "L1", value: "L1" },
  { label: "L2", value: "L2" },
  { label: "L3", value: "L3" },
] as const;

function tierTag(tier: string) {
  const color = tier === "L1" ? "green" : tier === "L2" ? "orange" : "red";
  return <Tag color={color}>{tier}</Tag>;
}

export function RiskMetricsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const writable = canWrite(getRole());
  const actionRef = useRef<ActionType>(null);
  const updateMutation = useUpdateBusinessMetricProfile();
  const draftMutation = useDraftRulesForProfile();
  const [editTarget, setEditTarget] = useState<BusinessMetricProfile | null>(null);
  const [selectedRows, setSelectedRows] = useState<BusinessMetricProfile[]>([]);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [batchPending, setBatchPending] = useState(false);

  const startPending = (id: string) =>
    setPendingIds((s) => {
      const next = new Set(s);
      next.add(id);
      return next;
    });
  const stopPending = (id: string) =>
    setPendingIds((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  const isPending = useCallback((id: string) => pendingIds.has(id), [pendingIds]);

  const runDraftRules = useCallback(
    async (rows: BusinessMetricProfile[]) => {
      if (rows.length === 0) return;
      let createdTotal = 0;
      let existingTotal = 0;
      let failed = 0;
      let lastRuleId: string | undefined;

      for (const row of rows) {
        startPending(row.id);
        try {
          const result = await draftMutation.mutateAsync({
            id: row.id,
            target_kind: row.target_kind ?? undefined,
          });
          if (result.created) createdTotal += result.total;
          else existingTotal += result.total;
          if (!lastRuleId && result.items[0]?.id) {
            lastRuleId = result.items[0].id;
          }
        } catch {
          failed += 1;
        } finally {
          stopPending(row.id);
        }
      }

      if (failed > 0 && createdTotal + existingTotal === 0) {
        message.error(t("monitoring.riskMetrics.draftRulesFailed", { reason: t("common.error") }));
      } else if (createdTotal > 0) {
        message.success(t("monitoring.riskMetrics.draftRulesCreated", { count: createdTotal }));
      } else if (existingTotal > 0) {
        message.success(t("monitoring.riskMetrics.draftRulesExisting", { count: existingTotal }));
      }

      if (lastRuleId) {
        navigate(`/monitoring/anomaly-rules?tab=draft&highlight=${lastRuleId}`);
      }

      setSelectedRows([]);
      actionRef.current?.reload();
    },
    [draftMutation, message, navigate, t],
  );

  const handleDraftRules = useCallback(
    async (row: BusinessMetricProfile) => {
      await runDraftRules([row]);
    },
    [runDraftRules],
  );

  const handleBatchDraftRules = useCallback(async () => {
    if (selectedRows.length === 0) return;
    setBatchPending(true);
    try {
      await runDraftRules(selectedRows);
    } finally {
      setBatchPending(false);
    }
  }, [runDraftRules, selectedRows]);

  const columns = useMemo<ProColumns<BusinessMetricProfile>[]>(
    () => [
      { title: t("monitoring.riskMetrics.columns.name"), dataIndex: "name", width: 200, ellipsis: true },
      {
        title: t("common.actions"),
        width: 220,
        search: false,
        render: (_, row) => (
          <Space size={4} wrap>
            <Button
              size="small"
              disabled={!writable || isPending(row.id)}
              onClick={() => setEditTarget(row)}
            >
              {t("monitoring.riskMetrics.actions.editTier")}
            </Button>
            <Button
              size="small"
              type="primary"
              disabled={!writable || isPending(row.id)}
              loading={isPending(row.id)}
              onClick={() => void handleDraftRules(row)}
            >
              {t("monitoring.riskMetrics.actions.draftRules")}
            </Button>
          </Space>
        ),
      },
      {
        title: t("monitoring.riskMetrics.columns.source"),
        dataIndex: "source_name",
        width: 140,
        search: false,
        render: (_, row) => row.source_name ?? "—",
      },
      {
        title: t("monitoring.riskMetrics.columns.tier"),
        dataIndex: "risk_tier",
        width: 90,
        valueType: "select",
        valueEnum: {
          L1: { text: "L1" },
          L2: { text: "L2" },
          L3: { text: "L3" },
        },
        render: (_, row) => tierTag(row.risk_tier),
      },
      { title: t("monitoring.riskMetrics.columns.unit"), dataIndex: "unit", width: 90, search: false },
      {
        title: t("monitoring.riskMetrics.columns.status"),
        dataIndex: "risk_tier",
        width: 120,
        search: false,
        render: (_, row) => t(`monitoring.riskMetrics.statusByTier.${row.risk_tier}`),
      },
    ],
    [t, writable, handleDraftRules, isPending, pendingIds],
  );

  const selectedCount = selectedRows.length;

  return (
    <ModulePageShell
      icon={<FundProjectionScreenOutlined style={{ fontSize: 20 }} />}
      title={t("monitoring.riskMetrics.title")}
      subtitle={t("monitoring.riskMetrics.subtitle")}
      action={
        <Space wrap>
          <Button
            type="primary"
            disabled={!writable || selectedCount === 0}
            loading={batchPending}
            onClick={() => void handleBatchDraftRules()}
          >
            {selectedCount > 0
              ? t("monitoring.riskMetrics.actions.draftRulesSelected", { count: selectedCount })
              : t("monitoring.riskMetrics.actions.draftRules")}
          </Button>
          <Link to="/monitoring/anomaly-rules?tab=draft">
            <Button>{t("monitoring.riskMetrics.viewDrafts")}</Button>
          </Link>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        message={t("monitoring.riskMetrics.hint")}
        style={{ marginBottom: 16 }}
      />
      <ModuleTableCard>
        <ProTable<BusinessMetricProfile>
          {...moduleProTableProps}
          actionRef={actionRef}
          rowKey="id"
          columns={columns}
          rowSelection={
            writable
              ? {
                  selectedRowKeys: selectedRows.map((r) => r.id),
                  onChange: (_keys, rows) => setSelectedRows(rows),
                }
              : false
          }
          tableAlertOptionRender={({ onCleanSelected }) => (
            <Space size={12}>
              <Button
                type="primary"
                size="small"
                loading={batchPending}
                onClick={() => void handleBatchDraftRules()}
              >
                {t("monitoring.riskMetrics.actions.draftRulesSelected", { count: selectedCount })}
              </Button>
              <Button type="link" size="small" onClick={onCleanSelected}>
                {t("monitoring.riskMetrics.clearSelection")}
              </Button>
            </Space>
          )}
          request={async (params) => {
            const query = new URLSearchParams();
            query.set("curated", "true");
            if (params.risk_tier) query.set("risk_tier", String(params.risk_tier));
            const result = await api<{ items: BusinessMetricProfile[]; total: number }>(
              `/api/monitoring/business-metrics/profiles?${query.toString()}`,
            );
            return { data: result.items, total: result.total, success: true };
          }}
          search={moduleTableSearch()}
          pagination={moduleTablePagination}
          locale={{ emptyText: t("monitoring.riskMetrics.empty") }}
        />
      </ModuleTableCard>

      <ModuleFormDrawer
        title={t("monitoring.riskMetrics.editTierTitle")}
        open={editTarget !== null}
        width={420}
        onClose={() => setEditTarget(null)}
      >
        {editTarget ? (
          <ProForm
            key={editTarget.id}
            initialValues={{ risk_tier: editTarget.risk_tier }}
            submitter={{ searchConfig: { submitText: t("common.save") } }}
            onFinish={async (values) => {
              try {
                await updateMutation.mutateAsync({
                  id: editTarget.id,
                  body: { risk_tier: values.risk_tier as "L1" | "L2" | "L3" },
                });
                message.success(t("monitoring.riskMetrics.tierSaved"));
                setEditTarget(null);
                actionRef.current?.reload();
                return true;
              } catch (err) {
                const reason = err instanceof Error ? err.message : t("common.error");
                message.error(reason);
                return false;
              }
            }}
          >
            <ProFormSelect
              name="risk_tier"
              label={t("monitoring.riskMetrics.columns.tier")}
              options={[...TIER_OPTIONS]}
              rules={[{ required: true }]}
            />
          </ProForm>
        ) : null}
      </ModuleFormDrawer>
    </ModulePageShell>
  );
}

export default RiskMetricsPage;