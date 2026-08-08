import {
  ProForm,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProFormTextArea,
  ProTable,
} from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { AlertOutlined, PlusOutlined } from "@ant-design/icons";
import { App, Button, Drawer, List, Space, Table, Tabs, Tag, Typography } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import {
  useAnomalyRules,
  useTestAnomalyRule,
  useUpdateAnomalyRule,
  type AnomalyRule,
  type AnomalyRuleListStatus,
  type AnomalyRuleTestRun,
  type AnomalyRuleType,
  type RuleCreatedBy,
} from "../../api/anomaly-rules";
import { api } from "../../api/client";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleNestedTableProps,
  moduleProTableProps,
  moduleTableDetailIndent,
  moduleTableExpandable,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";
import { canWrite, getRole } from "../../services/auth/roles";
import { formatDateTime } from "../../utils/datetime";

type RuleTabKey = AnomalyRuleListStatus;

type RuleVersionRow = {
  id: string;
  version: number;
  query_text: string;
  created_at: string;
};

type TestState = { rule: AnomalyRule; run: AnomalyRuleTestRun } | null;

const EXPANDED_DETAIL_CLASS = "module-table-detail-panel";
const EXPANDED_DETAIL_STYLE = { paddingLeft: moduleTableDetailIndent } as const;

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

function tierTag(tier: string) {
  const color = tier === "L1" ? "green" : tier === "L2" ? "orange" : "red";
  return <Tag color={color}>{tier}</Tag>;
}

function provenanceTag(created_by: RuleCreatedBy | null) {
  if (created_by === "ai_recommendation") return <Tag color="purple">AI</Tag>;
  if (created_by === "rule_recommendation") return <Tag color="blue">Library</Tag>;
  return created_by ? <Tag>{created_by}</Tag> : null;
}

function testRunPassed(run: AnomalyRuleTestRun | undefined): boolean {
  if (!run || run.status !== "completed") return false;
  return typeof run.result_json?.matched === "boolean";
}

function AnomalyRuleVersionsExpand({ ruleId }: { ruleId: string }) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<RuleVersionRow[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingVersions(true);
    void api<{ items: RuleVersionRow[]; total: number }>(
      `/api/monitoring/anomaly-rules/${ruleId}/versions`,
    )
      .then((result) => {
        if (!cancelled) setVersions(result.items);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingVersions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ruleId]);

  return (
    <div className={EXPANDED_DETAIL_CLASS} style={EXPANDED_DETAIL_STYLE}>
      <ProTable<RuleVersionRow>
        {...moduleNestedTableProps}
        rowKey="id"
        loading={loadingVersions}
        dataSource={versions}
        locale={{ emptyText: t("monitoring.anomalyRules.versions.empty") }}
        columns={[
          { title: t("monitoring.anomalyRules.versions.version"), dataIndex: "version", width: 80 },
          {
            title: t("monitoring.anomalyRules.versions.query"),
            dataIndex: "query_text",
            ellipsis: true,
          },
          {
            title: t("monitoring.anomalyRules.versions.createdAt"),
            dataIndex: "created_at",
            width: 170,
            render: (_, row) => formatDateTime(row.created_at),
          },
        ]}
      />
    </div>
  );
}

export function AnomalyRulesPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const writable = canWrite(getRole());
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get("tab");
  const activeTab: RuleTabKey =
    tabParam === "draft" || tabParam === "enabled" || tabParam === "all" ? tabParam : "draft";
  const highlightId = searchParams.get("highlight") ?? undefined;

  const { data, isLoading, refetch } = useAnomalyRules(activeTab);
  const updateMutation = useUpdateAnomalyRule();
  const testMutation = useTestAnomalyRule();

  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AnomalyRule | null>(null);
  const [testState, setTestState] = useState<TestState>(null);
  const [testResults, setTestResults] = useState<Record<string, AnomalyRuleTestRun>>({});
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [toastShown, setToastShown] = useState(false);

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

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["anomaly-rules"] });
  }, [queryClient]);

  useEffect(() => {
    if (highlightId && activeTab === "draft" && !toastShown) {
      message.info(t("monitoring.anomalyRules.draftGeneratedToast"));
      setToastShown(true);
    }
  }, [highlightId, activeTab, toastShown, message, t]);

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/monitoring/anomaly-rules", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      message.success(t("monitoring.anomalyRules.saved"));
      setFormOpen(false);
      refresh();
    },
    onError: () => message.error(t("common.error")),
  });

  const handleTest = async (rule: AnomalyRule) => {
    startPending(rule.id);
    try {
      const run = await testMutation.mutateAsync(rule.id);
      setTestResults((prev) => ({ ...prev, [rule.id]: run }));
      setTestState({ rule, run });
    } catch {
      message.error(t("common.error"));
    } finally {
      stopPending(rule.id);
    }
  };

  const handleEnable = async (rule: AnomalyRule, enable: boolean) => {
    if (enable && !rule.enabled && !testRunPassed(testResults[rule.id])) {
      message.warning(t("monitoring.anomalyRules.enableRequiresTest"));
      return;
    }
    startPending(rule.id);
    try {
      await updateMutation.mutateAsync({ id: rule.id, body: { enabled: enable } });
      message.success(
        enable
          ? t("monitoring.anomalyRuleDrafts.enabledOk")
          : t("monitoring.anomalyRuleDrafts.disabledOk"),
      );
      refresh();
    } catch {
      message.error(t("common.error"));
    } finally {
      stopPending(rule.id);
    }
  };

  const showDraftColumns = activeTab === "draft" || activeTab === "all";

  const columns = useMemo<ProColumns<AnomalyRule>[]>(() => {
    const base: ProColumns<AnomalyRule>[] = [
      { title: t("monitoring.anomalyRules.columns.name"), dataIndex: "name", ellipsis: true },
    ];

    if (showDraftColumns) {
      base.push({
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
      });
    }

    base.push(
      {
        title: t("monitoring.anomalyRules.columns.type"),
        dataIndex: "rule_type",
        width: 120,
        search: false,
      },
      {
        title: t("monitoring.anomalyRules.columns.tier"),
        dataIndex: "risk_tier",
        width: 90,
        search: false,
        render: (_, row) => tierTag(row.risk_tier),
      },
    );

    if (showDraftColumns) {
      base.push(
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
          render: (_, row) => provenanceTag(row.created_by) ?? "—",
        },
      );
    }

    base.push({
      title: t("monitoring.anomalyRules.columns.enabled"),
      dataIndex: "enabled",
      width: 90,
      valueType: "select",
      valueEnum: {
        true: { text: t("common.yes") },
        false: { text: t("common.no") },
      },
      render: (_, row) =>
        row.enabled ? <Tag color="green">{t("common.yes")}</Tag> : <Tag>{t("common.no")}</Tag>,
    });

    base.push({
      title: t("common.actions"),
      width: showDraftColumns ? 280 : 240,
      fixed: "right",
      search: false,
      render: (_, row) => {
        const canEnable = row.enabled || testRunPassed(testResults[row.id]);
        return (
          <Space size={4} wrap>
            <Button
              size="small"
              disabled={!writable || isPending(row.id)}
              loading={isPending(row.id)}
              onClick={() => void handleTest(row)}
            >
              {t("monitoring.anomalyRules.actions.test")}
            </Button>
            {showDraftColumns ? (
              <Button
                size="small"
                disabled={!writable || isPending(row.id)}
                onClick={() => setEditTarget(row)}
              >
                {t("monitoring.anomalyRuleDrafts.actions.edit")}
              </Button>
            ) : null}
            <Button
              size="small"
              type={row.enabled ? "default" : "primary"}
              disabled={!writable || isPending(row.id) || (!row.enabled && !canEnable)}
              loading={isPending(row.id)}
              onClick={() => void handleEnable(row, !row.enabled)}
            >
              {row.enabled
                ? t("monitoring.anomalyRules.actions.disable")
                : t("monitoring.anomalyRules.actions.enable")}
            </Button>
          </Space>
        );
      },
    });

    return base;
  }, [t, writable, showDraftColumns, testResults, testState, pendingIds]);

  const testVerdict = useMemo(() => {
    if (!testState) return null;
    const matched = testState.run.result_json?.matched;
    if (matched === true) {
      return { type: "warning" as const, label: t("monitoring.anomalyRuleDrafts.test.breach") };
    }
    if (matched === false) {
      return { type: "success" as const, label: t("monitoring.anomalyRuleDrafts.test.pass") };
    }
    return { type: "error" as const, label: t("monitoring.anomalyRules.testFailed") };
  }, [testState, t]);

  const testRows = useMemo(() => {
    if (!testState) return [];
    const r = testState.run.result_json;
    return [
      {
        key: "value",
        label: t("monitoring.anomalyRuleDrafts.test.currentValue"),
        value: r?.sample_value ?? "—",
      },
      {
        key: "evaluation",
        label: t("monitoring.anomalyRuleDrafts.test.evaluation"),
        value: r?.evaluation ?? r?.message ?? "—",
      },
    ];
  }, [testState, t]);

  const tabItems = useMemo(
    () => [
      { key: "draft", label: t("monitoring.anomalyRules.tabs.draft") },
      { key: "enabled", label: t("monitoring.anomalyRules.tabs.enabled") },
      { key: "all", label: t("monitoring.anomalyRules.tabs.all") },
    ],
    [t],
  );

  const drawerEnableDisabled =
    !testState ||
    !writable ||
    testState.rule.enabled ||
    !testRunPassed(testState.run) ||
    isPending(testState.rule.id);

  return (
    <ModulePageShell
      icon={<AlertOutlined style={{ fontSize: 20 }} />}
      title={t("monitoring.anomalyRules.title")}
      subtitle={t("monitoring.anomalyRules.subtitleMerged")}
      action={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setFormOpen(true)}>
          {t("monitoring.anomalyRules.add")}
        </Button>
      }
    >
      <Tabs
        activeKey={activeTab}
        items={tabItems}
        onChange={(key) => {
          const next = new URLSearchParams(searchParams);
          next.set("tab", key);
          if (key !== "draft") next.delete("highlight");
          setSearchParams(next, { replace: true });
        }}
        style={{ marginBottom: 16 }}
        data-testid="anomaly-rules-tabs"
      />

      <ModuleTableCard>
        <ProTable<AnomalyRule>
          {...moduleProTableProps}
          rowKey="id"
          columns={columns}
          loading={isLoading}
          dataSource={data?.items ?? []}
          search={activeTab === "enabled" ? moduleTableSearch() : false}
          pagination={moduleTablePagination}
          locale={{
            emptyText:
              activeTab === "draft"
                ? t("monitoring.anomalyRuleDrafts.empty")
                : t("monitoring.anomalyRules.empty"),
          }}
          rowClassName={(row) => (row.id === highlightId ? "ant-table-row-selected" : "")}
          options={{ reload: () => void refetch().catch(() => {}) }}
          expandable={{
            ...moduleTableExpandable,
            expandedRowRender: (row) => <AnomalyRuleVersionsExpand ruleId={row.id} />,
          }}
        />
      </ModuleTableCard>

      <ModuleFormDrawer
        title={t("monitoring.anomalyRules.add")}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        width={560}
      >
        <ProForm
          initialValues={{ rule_type: "threshold", risk_tier: "L2", enabled: false }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
          onFinish={async (values) => {
            await createMutation.mutateAsync({
              ...values,
              threshold_json: values.threshold_json
                ? JSON.parse(String(values.threshold_json))
                : {},
            });
            return true;
          }}
        >
          <ProFormText
            name="name"
            label={t("monitoring.anomalyRules.form.name")}
            rules={[{ required: true }]}
          />
          <ProFormSelect
            name="rule_type"
            label={t("monitoring.anomalyRules.form.type")}
            options={RULE_TYPE_OPTIONS}
          />
          <ProFormSelect
            name="risk_tier"
            label={t("monitoring.anomalyRules.form.tier")}
            options={TIER_OPTIONS}
          />
          <ProFormTextArea
            name="query_text"
            label={t("monitoring.anomalyRules.form.query")}
            rules={[{ required: true }]}
            fieldProps={{ rows: 4 }}
          />
          <ProFormText
            name="threshold_json"
            label={t("monitoring.anomalyRules.form.threshold")}
            placeholder='{"value":0.1}'
          />
          <ProFormSwitch name="enabled" label={t("monitoring.anomalyRules.form.enabled")} />
        </ProForm>
      </ModuleFormDrawer>

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
              refresh();
            } catch {
              message.error(t("common.error"));
            } finally {
              stopPending(editTarget.id);
            }
            return true;
          }}
        >
          <ProFormText
            name="name"
            label={t("monitoring.anomalyRuleDrafts.form.name")}
            rules={[{ required: true }]}
          />
          <ProFormSelect
            name="rule_type"
            label={t("monitoring.anomalyRuleDrafts.form.type")}
            options={RULE_TYPE_OPTIONS}
          />
          <ProFormSelect
            name="risk_tier"
            label={t("monitoring.anomalyRuleDrafts.form.tier")}
            options={TIER_OPTIONS}
          />
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

      <Drawer
        open={Boolean(testState)}
        title={
          testState
            ? t("monitoring.anomalyRuleDrafts.test.title", { name: testState.rule.name })
            : ""
        }
        width={560}
        onClose={() => setTestState(null)}
        data-testid="anomaly-rule-test-drawer"
        footer={
          testState ? (
            <Space>
              <Button onClick={() => setTestState(null)}>{t("common.cancel")}</Button>
              <Button
                type="primary"
                disabled={drawerEnableDisabled}
                loading={isPending(testState.rule.id)}
                onClick={() => void handleEnable(testState.rule, true)}
              >
                {t("monitoring.anomalyRules.actions.enable")}
              </Button>
            </Space>
          ) : null
        }
      >
        {testVerdict ? (
          <Typography.Paragraph
            data-testid="anomaly-rule-test-verdict"
            style={{ marginBottom: 16 }}
          >
            <Tag color={testVerdict.type === "success" ? "green" : testVerdict.type === "warning" ? "orange" : "red"}>
              {testVerdict.label}
            </Tag>
            {!testRunPassed(testState?.run) ? (
              <Typography.Text type="secondary">
                {" "}
                {t("monitoring.anomalyRules.enableRequiresTest")}
              </Typography.Text>
            ) : null}
          </Typography.Paragraph>
        ) : null}
        <Table
          size="small"
          pagination={false}
          dataSource={testRows}
          columns={[
            { title: t("monitoring.anomalyRuleDrafts.test.field"), dataIndex: "label", width: 140 },
            { title: t("monitoring.anomalyRuleDrafts.test.result"), dataIndex: "value" },
          ]}
        />
        {testState?.run.result_json?.matched === true ? (
          <List
            style={{ marginTop: 16 }}
            size="small"
            header={t("monitoring.anomalyRules.testHits")}
            dataSource={[
              {
                key: "sample",
                timestamp: testState.run.created_at,
                source: testState.rule.source_name ?? "—",
                value: testState.run.result_json.sample_value,
              },
            ]}
            renderItem={(item) => (
              <List.Item>
                <Space direction="vertical" size={0}>
                  <Typography.Text>
                    {formatDateTime(item.timestamp)} · {item.source}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t("monitoring.anomalyRuleDrafts.test.currentValue")}: {String(item.value ?? "—")}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        ) : testState && testRunPassed(testState.run) && testState.run.result_json.matched === false ? (
          <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
            {t("monitoring.anomalyRules.testZeroHits")}
          </Typography.Paragraph>
        ) : null}
      </Drawer>
    </ModulePageShell>
  );
}