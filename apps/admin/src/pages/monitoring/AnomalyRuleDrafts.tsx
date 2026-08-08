import {
  ProForm,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { ExperimentOutlined } from "@ant-design/icons";
import { App, Button, Modal, Space, Table, Tag } from "antd";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAnomalyRules,
  useTestAnomalyRule,
  useUpdateAnomalyRule,
  type AnomalyRule,
  type AnomalyRuleTestRun,
  type AnomalyRuleType,
  type RuleCreatedBy,
} from "../../api/anomaly-rules";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
} from "../../components/module-table-styles";
import { canWrite, getRole } from "../../services/auth/roles";

/**
 * U8 — admin review surface for recommender-generated anomaly-rule drafts.
 *
 * Drafts are the `enabled=false` rules the U7 recommender persisted
 * (created_by = 'ai_recommendation' | 'rule_recommendation'). The page lists
 * them with their target layer + provenance, lets an operator edit the
 * PromQL/threshold/severity, trial-run the rule against its live data source
 * (POST /:id/test → current value + verdict in a table), and explicitly enable
 * it. Enable is always an explicit action — drafts are never auto-enabled.
 *
 * Test/Edit/Enable are POST/PATCH (operator/admin under the global auth guard);
 * a viewer sees the list read-only with the action buttons disabled.
 */

function tierTag(tier: string) {
  const color = tier === "L1" ? "green" : tier === "L2" ? "orange" : "red";
  return <Tag color={color}>{tier}</Tag>;
}

function provenanceTag(created_by: RuleCreatedBy | null) {
  if (created_by === "ai_recommendation") return <Tag color="purple">AI</Tag>;
  if (created_by === "rule_recommendation") return <Tag color="blue">Library</Tag>;
  return <Tag>{created_by ?? "—"}</Tag>;
}

type TestState = { ruleName: string; run: AnomalyRuleTestRun } | null;

const RULE_TYPE_OPTIONS: { label: string; value: AnomalyRuleType }[] = [
  { label: "Threshold", value: "threshold" },
  { label: "Baseline", value: "baseline" },
  { label: "Ratio", value: "ratio" },
  { label: "Absence", value: "absence" },
  { label: "Log pattern", value: "log_pattern" },
  { label: "Composite", value: "composite" },
];

const TIER_OPTIONS = [
  { label: "L1", value: "L1" },
  { label: "L2", value: "L2" },
  { label: "L3", value: "L3" },
];

export function AnomalyRuleDraftsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const writable = canWrite(getRole());
  const { data, isLoading, refetch } = useAnomalyRules();
  const updateMutation = useUpdateAnomalyRule();
  const testMutation = useTestAnomalyRule();
  const [editTarget, setEditTarget] = useState<AnomalyRule | null>(null);
  const [testState, setTestState] = useState<TestState>(null);
  // Per-row pending set: only the row(s) with an in-flight mutation show a
  // spinner / have their action buttons disabled. react-query keeps a single
  // isPending per mutation instance, so gating on the shared boolean lights up
  // every row's button at once (review C1/R-1). Tracking the in-flight ids lets
  // independent rows stay interactive while the clicked one is busy, and blocks
  // the same-row Enable+Edit overlap that could race the backend update.
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
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
  const isPending = (id: string) => pendingIds.has(id);

  // Drafts = recommender-generated rules (created_by set). They start
  // enabled=false; the list still shows any a user already enabled so the
  // reviewer can see the full lifecycle, but enable is always explicit.
  const drafts = useMemo(
    () => (data?.items ?? []).filter((r) => r.created_by !== null),
    [data?.items],
  );

  const handleEnable = async (rule: AnomalyRule, enable: boolean) => {
    startPending(rule.id);
    try {
      await updateMutation.mutateAsync({ id: rule.id, body: { enabled: enable } });
      message.success(
        enable ? t("monitoring.anomalyRuleDrafts.enabledOk") : t("monitoring.anomalyRuleDrafts.disabledOk"),
      );
    } catch {
      message.error(t("common.error"));
    } finally {
      stopPending(rule.id);
    }
  };

  const handleTest = async (rule: AnomalyRule) => {
    startPending(rule.id);
    try {
      const run = await testMutation.mutateAsync(rule.id);
      setTestState({ ruleName: rule.name, run });
    } catch {
      message.error(t("common.error"));
    } finally {
      stopPending(rule.id);
    }
  };

  const columns = useMemo<ProColumns<AnomalyRule>[]>(
    () => [
      { title: t("monitoring.anomalyRuleDrafts.columns.name"), dataIndex: "name", ellipsis: true },
      {
        title: t("monitoring.anomalyRuleDrafts.columns.target"),
        dataIndex: "target_kind",
        width: 120,
        search: false,
        render: (_, row) => (
          <Space size={4}>
            <span>{row.target_kind ?? "—"}</span>
            {row.target_ref ? <Tag>{row.target_ref}</Tag> : null}
          </Space>
        ),
      },
      {
        title: t("monitoring.anomalyRuleDrafts.columns.tier"),
        dataIndex: "risk_tier",
        width: 90,
        search: false,
        render: (_, row) => tierTag(row.risk_tier),
      },
      {
        title: t("monitoring.anomalyRuleDrafts.columns.source"),
        dataIndex: "source_name",
        width: 140,
        search: false,
        render: (_, row) => row.source_name ?? "—",
      },
      {
        title: t("monitoring.anomalyRuleDrafts.columns.provenance"),
        dataIndex: "created_by",
        width: 110,
        search: false,
        render: (_, row) => provenanceTag(row.created_by),
      },
      {
        title: t("monitoring.anomalyRuleDrafts.columns.enabled"),
        dataIndex: "enabled",
        width: 90,
        valueType: "select",
        valueEnum: {
          true: { text: t("common.yes") },
          false: { text: t("common.no") },
        },
        render: (_, row) =>
          row.enabled ? <Tag color="green">{t("common.yes")}</Tag> : <Tag>{t("common.no")}</Tag>,
      },
      {
        title: t("common.actions"),
        width: 260,
        fixed: "right",
        search: false,
        render: (_, row) => (
          <Space size={4} wrap>
            <Button
              size="small"
              disabled={!writable || isPending(row.id)}
              loading={isPending(row.id)}
              onClick={() => handleTest(row)}
            >
              {t("monitoring.anomalyRuleDrafts.actions.test")}
            </Button>
            <Button
              size="small"
              disabled={!writable || isPending(row.id)}
              onClick={() => setEditTarget(row)}
            >
              {t("monitoring.anomalyRuleDrafts.actions.edit")}
            </Button>
            <Button
              size="small"
              type={row.enabled ? "default" : "primary"}
              disabled={!writable || isPending(row.id)}
              loading={isPending(row.id)}
              onClick={() => handleEnable(row, !row.enabled)}
            >
              {row.enabled
                ? t("monitoring.anomalyRuleDrafts.actions.disable")
                : t("monitoring.anomalyRuleDrafts.actions.enable")}
            </Button>
          </Space>
        ),
      },
    ],
    [t, writable, pendingIds],
  );

  // Test-run verdict table: current value + verdict (pass/breach) per PRD §9 P0-a.
  // `matched` is a strict boolean — a missing/empty result_json (backend `?? {}`
  // fallback when Prometheus is down) yields `matched === undefined`, which we
  // render as "—" rather than a false-green "pass" (review ADV-02 / C-residual).
  const testRows = useMemo(() => {
    if (!testState) return [];
    const r = testState.run.result_json;
    const matched = r?.matched;
    return [
      {
        key: "value",
        label: t("monitoring.anomalyRuleDrafts.test.currentValue"),
        value: r?.sample_value ?? "—",
      },
      {
        key: "verdict",
        label: t("monitoring.anomalyRuleDrafts.test.verdict"),
        value:
          matched === true
            ? t("monitoring.anomalyRuleDrafts.test.breach")
            : matched === false
              ? t("monitoring.anomalyRuleDrafts.test.pass")
              : "—",
      },
      {
        key: "evaluation",
        label: t("monitoring.anomalyRuleDrafts.test.evaluation"),
        value: r?.evaluation ?? r?.message ?? "—",
      },
    ];
  }, [testState, t]);

  return (
    <ModulePageShell
      icon={<ExperimentOutlined style={{ fontSize: 20 }} />}
      title={t("monitoring.anomalyRuleDrafts.title")}
      subtitle={t("monitoring.anomalyRuleDrafts.subtitle")}
    >
      <ModuleTableCard>
        <ProTable<AnomalyRule>
          {...moduleProTableProps}
          rowKey="id"
          columns={columns}
          loading={isLoading}
          dataSource={drafts}
          // search disabled: this page uses a client `dataSource` (no `request`
          // adapter), so the ProTable search form would collect params but never
          // filter — a misleading no-op control. Filter happens client-side via
          // the drafts memo. (review C2)
          search={false}
          pagination={moduleTablePagination}
          locale={{ emptyText: t("monitoring.anomalyRuleDrafts.empty") }}
          options={{ reload: () => void refetch().catch(() => {}) }}
        />
      </ModuleTableCard>

      <ModuleFormDrawer
        title={t("monitoring.anomalyRuleDrafts.editTitle")}
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        width={560}
      >
        <ProForm
          initialValues={
            editTarget
              ? {
                  name: editTarget.name,
                  rule_type: editTarget.rule_type,
                  query_text: editTarget.query_text,
                  threshold_json: JSON.stringify(editTarget.threshold_json ?? {}, null, 2),
                  risk_tier: editTarget.risk_tier,
                }
              : {}
          }
          key={editTarget?.id ?? "none"}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
          onFinish={async (values) => {
            if (!editTarget) return false;
            startPending(editTarget.id);
            try {
              await updateMutation.mutateAsync({
                id: editTarget.id,
                body: {
                  name: String(values.name),
                  rule_type: values.rule_type as AnomalyRuleType,
                  query_text: String(values.query_text),
                  threshold_json: values.threshold_json
                    ? JSON.parse(String(values.threshold_json))
                    : {},
                  risk_tier: values.risk_tier as "L1" | "L2" | "L3",
                },
              });
              message.success(t("monitoring.anomalyRuleDrafts.saved"));
              setEditTarget(null);
            } catch {
              message.error(t("common.error"));
            } finally {
              stopPending(editTarget.id);
            }
            return true;
          }}
        >
          <ProFormText name="name" label={t("monitoring.anomalyRuleDrafts.form.name")} rules={[{ required: true }]} />
          <ProFormSelect
            name="rule_type"
            label={t("monitoring.anomalyRuleDrafts.form.type")}
            options={RULE_TYPE_OPTIONS}
          />
          <ProFormSelect name="risk_tier" label={t("monitoring.anomalyRuleDrafts.form.tier")} options={TIER_OPTIONS} />
          <ProFormTextArea
            name="query_text"
            label={t("monitoring.anomalyRuleDrafts.form.query")}
            rules={[{ required: true }]}
            fieldProps={{ rows: 4 }}
          />
          <ProFormText
            name="threshold_json"
            label={t("monitoring.anomalyRuleDrafts.form.threshold")}
            placeholder='{"value":0.1,"operator":"gt"}'
          />
        </ProForm>
      </ModuleFormDrawer>

      <Modal
        open={Boolean(testState)}
        title={
          testState
            ? t("monitoring.anomalyRuleDrafts.test.title", { name: testState.ruleName })
            : ""
        }
        footer={null}
        onCancel={() => setTestState(null)}
        width={520}
      >
        <Table
          size="small"
          pagination={false}
          dataSource={testRows}
          columns={[
            { title: t("monitoring.anomalyRuleDrafts.test.field"), dataIndex: "label", width: 140 },
            {
              title: t("monitoring.anomalyRuleDrafts.test.result"),
              dataIndex: "value",
              render: (value: unknown, record: { key: string }) => {
                // Color the verdict row from the boolean `matched`, not from
                // matching the rendered localized string (fragile to i18n /
                // restructure). Only an explicit true/false gets a colored tag;
                // an unknown verdict (missing result_json) stays plain.
                if (record.key !== "verdict") return String(value);
                const matched = testState?.run.result_json?.matched;
                if (matched === true) return <Tag color="red">{String(value)}</Tag>;
                if (matched === false) return <Tag color="green">{String(value)}</Tag>;
                return String(value);
              },
            },
          ]}
        />
      </Modal>
    </ModulePageShell>
  );
}

export default AnomalyRuleDraftsPage;