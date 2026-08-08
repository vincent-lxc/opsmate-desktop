import {
  EditableProTable,
  ProForm,
  ProFormSelect,
  ProFormSwitch,
  ProFormText,
  ProTable,
} from "@ant-design/pro-components";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { PlusOutlined, SafetyOutlined } from "@ant-design/icons";
import { Button, Popconfirm, Space, Tabs, Tag, Typography, message } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, proTableRequest } from "../../api/client";
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

const RISK_TIERS = ["L1", "L2", "L3"] as const;
type RiskTier = (typeof RISK_TIERS)[number];

type RiskRuleForm = {
  match_kind: "command" | "action_type" | "regex";
  match_pattern: string;
  tier: RiskTier;
  requires_approval?: boolean;
  enabled?: boolean;
};

type RiskRuleRow = RiskRuleForm & { rowKey: string };

function createRuleRow(rule?: Partial<RiskRuleForm>): RiskRuleRow {
  return {
    rowKey: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    match_kind: rule?.match_kind ?? "command",
    match_pattern: rule?.match_pattern ?? "",
    tier: rule?.tier ?? "L2",
    requires_approval: rule?.requires_approval ?? false,
    enabled: rule?.enabled ?? true,
  };
}

function toRuleRows(rules: RiskRuleForm[]): RiskRuleRow[] {
  return rules.map((rule, index) => ({
    ...rule,
    rowKey: `rule-${index}-${rule.match_kind}-${rule.match_pattern}`,
  }));
}

function fromRuleRows(rows: RiskRuleRow[]): RiskRuleForm[] {
  return rows.map(({ rowKey: _rowKey, ...rule }) => rule);
}

function rulesForTier(rules: RiskRuleForm[], tier: RiskTier): RiskRuleForm[] {
  return rules.filter((rule) => rule.tier === tier);
}

function tierTabLabel(tier: RiskTier, count: number, t: (key: string) => string): string {
  return `${t(`security.riskPolicies.tabs.${tier}`)} (${count})`;
}

function RiskRulesEditor({
  value,
  onChange,
}: {
  value: RiskRuleForm[];
  onChange: (rules: RiskRuleForm[]) => void;
}) {
  const { t } = useTranslation();
  const [dataSource, setDataSource] = useState<RiskRuleRow[]>(() => toRuleRows(value));
  const [editableKeys, setEditableKeys] = useState<React.Key[]>([]);

  useEffect(() => {
    setDataSource(toRuleRows(value));
    setEditableKeys([]);
  }, [value]);

  const replaceTierRules = (tier: RiskTier, tierRows: RiskRuleRow[]) => {
    const other = dataSource.filter((item) => item.tier !== tier);
    const next = [...other, ...tierRows];
    setDataSource(next);
    onChange(fromRuleRows(next));
  };

  const columns = useMemo<ProColumns<RiskRuleRow>[]>(
    () => [
      {
        title: t("security.riskPolicies.form.matchKind"),
        dataIndex: "match_kind",
        width: 130,
        valueType: "select",
        valueEnum: {
          command: { text: t("security.riskPolicies.match.command") },
          action_type: { text: t("security.riskPolicies.match.actionType") },
          regex: { text: t("security.riskPolicies.match.regex") },
        },
        formItemProps: { rules: [{ required: true }] },
      },
      {
        title: t("security.riskPolicies.form.matchPattern"),
        dataIndex: "match_pattern",
        ellipsis: true,
        formItemProps: { rules: [{ required: true }] },
      },
      {
        title: t("security.riskPolicies.form.requiresApproval"),
        dataIndex: "requires_approval",
        width: 96,
        valueType: "switch",
        render: (_, row) => (row.requires_approval ? t("common.yes") : t("common.no")),
      },
      {
        title: t("common.actions"),
        valueType: "option",
        width: 120,
        fixed: "right",
        render: (_, row, __, action) => [
          <Button
            key="edit"
            type="link"
            size="small"
            onClick={() => action?.startEditable?.(row.rowKey)}
          >
            {t("common.edit")}
          </Button>,
          <Popconfirm
            key="delete"
            title={t("security.riskPolicies.form.deleteRuleConfirm")}
            onConfirm={() => {
              const next = dataSource.filter((item) => item.rowKey !== row.rowKey);
              setDataSource(next);
              onChange(fromRuleRows(next));
            }}
          >
            <Button type="link" size="small" danger>
              {t("common.delete")}
            </Button>
          </Popconfirm>,
        ],
      },
    ],
    [dataSource, onChange, t],
  );

  return (
    <Tabs
      size="small"
      items={RISK_TIERS.map((tier) => {
        const tierRows = dataSource.filter((item) => item.tier === tier);
        return {
          key: tier,
          label: tierTabLabel(tier, tierRows.length, t),
          children: (
            <EditableProTable<RiskRuleRow>
              rowKey="rowKey"
              headerTitle={t("security.riskPolicies.form.rules")}
              value={tierRows}
              onChange={(rows) => replaceTierRules(tier, [...(rows ?? [])])}
              recordCreatorProps={{
                position: "bottom",
                record: () => createRuleRow({ tier }),
                creatorButtonText: t("security.riskPolicies.form.addRule"),
              }}
              editable={{
                type: "single",
                editableKeys,
                onChange: setEditableKeys,
                onSave: async (_key, row) => {
                  const next = dataSource.map((item) =>
                    item.rowKey === row.rowKey ? { ...item, ...row, tier } : item,
                  );
                  setDataSource(next);
                  onChange(fromRuleRows(next));
                },
                actionRender: (_row, _config, defaultDom) => [defaultDom.save, defaultDom.cancel],
              }}
              columns={columns}
              pagination={{ pageSize: 5, showSizeChanger: false }}
              scroll={{ x: "max-content", y: 240 }}
              size="small"
              toolBarRender={false}
              search={false}
              cardBordered={false}
            />
          ),
        };
      })}
    />
  );
}

type RiskPolicyRow = {
  id: string;
  name: string;
  scope_kind: string;
  scope_id: string | null;
  default_tier: string;
  enabled: boolean;
  is_system?: boolean;
  rules?: RiskRuleForm[];
};

type RiskPolicyFormValues = {
  name: string;
  scope_kind: "global" | "server_group" | "server" | "task";
  scope_id?: string;
  default_tier: "L1" | "L2" | "L3";
  enabled: boolean;
  rules?: RiskRuleForm[];
};

const EXPANDED_DETAIL_CLASS = "module-table-detail-panel";
const EXPANDED_DETAIL_STYLE = { paddingLeft: moduleTableDetailIndent } as const;

function tierTag(tier: string) {
  const color = tier === "L1" ? "green" : tier === "L2" ? "orange" : "red";
  return <Tag color={color}>{tier}</Tag>;
}

function RiskPolicyRulesExpand({ rules }: { rules: RiskRuleForm[] }) {
  const { t } = useTranslation();

  const ruleColumns: ProColumns<RiskRuleForm>[] = [
    {
      title: t("security.riskPolicies.form.matchKind"),
      dataIndex: "match_kind",
      width: 120,
      render: (_, row) =>
        t(
          `security.riskPolicies.match.${row.match_kind === "action_type" ? "actionType" : row.match_kind}`,
        ),
    },
    {
      title: t("security.riskPolicies.form.matchPattern"),
      dataIndex: "match_pattern",
      ellipsis: true,
    },
    {
      title: t("security.riskPolicies.form.requiresApproval"),
      dataIndex: "requires_approval",
      width: 100,
      render: (_, row) => (row.requires_approval ? t("common.yes") : t("common.no")),
    },
  ];

  return (
    <div className={EXPANDED_DETAIL_CLASS} style={EXPANDED_DETAIL_STYLE}>
      <Tabs
        size="small"
        items={RISK_TIERS.map((tier) => ({
          key: tier,
          label: tierTabLabel(tier, rulesForTier(rules, tier).length, t),
          children: (
            <ProTable<RiskRuleForm>
              {...moduleNestedTableProps}
              rowKey={(row) => `${row.match_kind}-${row.match_pattern}`}
              dataSource={rulesForTier(rules, tier)}
              locale={{ emptyText: t("security.riskPolicies.rulesEmpty") }}
              columns={ruleColumns}
            />
          ),
        }))}
      />
    </div>
  );
}

export function RiskPoliciesPage() {
  const { t } = useTranslation();
  const actionRef = useRef<ActionType>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RiskPolicyRow | null>(null);
  const [draftRules, setDraftRules] = useState<RiskRuleForm[]>([]);

  const columns = useMemo<ProColumns<RiskPolicyRow>[]>(
    () => [
      {
        title: t("security.riskPolicies.columns.name"),
        dataIndex: "name",
        ellipsis: true,
        render: (_, row) => (
          <Space size={4}>
            <span>{row.name}</span>
            {row.is_system ? (
              <Tag color="blue">{t("security.riskPolicies.systemDefault")}</Tag>
            ) : null}
          </Space>
        ),
      },
      {
        title: t("security.riskPolicies.columns.scope"),
        dataIndex: "scope_kind",
        width: 140,
        valueType: "select",
        valueEnum: {
          global: { text: t("security.riskPolicies.scope.global") },
          server_group: { text: t("security.riskPolicies.scope.serverGroup") },
          server: { text: t("security.riskPolicies.scope.server") },
          task: { text: t("security.riskPolicies.scope.task") },
        },
        render: (_, row) =>
          row.scope_kind === "global"
            ? t("security.riskPolicies.scope.global")
            : `${row.scope_kind}${row.scope_id ? `: ${row.scope_id}` : ""}`,
      },
      {
        title: t("security.riskPolicies.columns.tier"),
        dataIndex: "default_tier",
        width: 100,
        search: false,
        render: (_, row) => tierTag(row.default_tier),
      },
      {
        title: t("security.riskPolicies.columns.rules"),
        dataIndex: "rules",
        width: 80,
        search: false,
        render: (_, row) => row.rules?.length ?? 0,
      },
      {
        title: t("security.riskPolicies.columns.enabled"),
        dataIndex: "enabled",
        width: 90,
        valueType: "select",
        valueEnum: {
          true: { text: t("common.yes") },
          false: { text: t("common.no") },
        },
      },
      {
        title: t("common.actions"),
        valueType: "option",
        width: 140,
        fixed: "right",
        search: false,
        render: (_, row) => [
          <Button
            key="edit"
            type="link"
            size="small"
            onClick={() => {
              setEditing(row);
              setDraftRules(row.rules ?? []);
              setFormOpen(true);
            }}
          >
            {t("common.edit")}
          </Button>,
          row.is_system ? null : (
            <Popconfirm
              key="delete"
              title={t("security.riskPolicies.deleteConfirm")}
              onConfirm={async () => {
                try {
                  await api(`/api/security/risk-policies/${row.id}`, { method: "DELETE" });
                  message.success(t("security.riskPolicies.deleted"));
                  actionRef.current?.reload();
                } catch {
                  message.error(t("common.error"));
                }
              }}
            >
              <Button type="link" size="small" danger>
                {t("common.delete")}
              </Button>
            </Popconfirm>
          ),
        ],
      },
    ],
    [t],
  );

  const openCreate = () => {
    setEditing(null);
    setDraftRules([]);
    setFormOpen(true);
  };

  const formInitialValues: RiskPolicyFormValues = editing
    ? {
        name: editing.name,
        scope_kind: editing.scope_kind as RiskPolicyFormValues["scope_kind"],
        scope_id: editing.scope_id ?? undefined,
        default_tier: editing.default_tier as RiskPolicyFormValues["default_tier"],
        enabled: editing.enabled,
        rules: editing.rules ?? [],
      }
    : {
        name: "",
        scope_kind: "global",
        default_tier: "L2",
        enabled: true,
        rules: [],
      };

  return (
    <ModulePageShell
      icon={<SafetyOutlined style={{ fontSize: 20 }} />}
      title={t("security.riskPolicies.title")}
      subtitle={t("security.riskPolicies.subtitle")}
      action={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t("security.riskPolicies.create")}
        </Button>
      }
    >
      <ModuleTableCard>
        <ProTable<RiskPolicyRow>
          {...moduleProTableProps}
          actionRef={actionRef}
          rowKey="id"
          columns={columns}
          request={(params) =>
            proTableRequest<RiskPolicyRow>("/api/security/risk-policies", params)
          }
          search={moduleTableSearch()}
          pagination={moduleTablePagination}
          locale={{ emptyText: t("security.riskPolicies.empty") }}
          expandable={{
            ...moduleTableExpandable,
            rowExpandable: (row) => (row.rules?.length ?? 0) > 0,
            expandedRowRender: (row) => (
              <RiskPolicyRulesExpand rules={row.rules ?? []} />
            ),
          }}
        />
      </ModuleTableCard>

      <ModuleFormDrawer
        title={
          editing
            ? t("security.riskPolicies.editTitle")
            : t("security.riskPolicies.createTitle")
        }
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
          setDraftRules([]);
        }}
        width={760}
      >
        <ProForm<RiskPolicyFormValues>
          key={editing?.id ?? "new"}
          initialValues={formInitialValues}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
          onFinish={async (values) => {
            if (draftRules.some((rule) => !rule.match_pattern?.trim())) {
              message.error(t("security.riskPolicies.form.rulesInvalid"));
              return false;
            }

            const payload = {
              ...values,
              scope_id: values.scope_kind === "global" ? null : values.scope_id ?? null,
              rules: draftRules,
            };
            try {
              if (editing) {
                await api(`/api/security/risk-policies/${editing.id}`, {
                  method: "PATCH",
                  body: JSON.stringify(payload),
                });
                message.success(t("security.riskPolicies.saved"));
              } else {
                await api("/api/security/risk-policies", {
                  method: "POST",
                  body: JSON.stringify(payload),
                });
                message.success(t("security.riskPolicies.created"));
              }
              actionRef.current?.reload();
              setFormOpen(false);
              setEditing(null);
              setDraftRules([]);
              return true;
            } catch {
              message.error(t("common.error"));
              return false;
            }
          }}
        >
          <ProFormText
            name="name"
            label={t("security.riskPolicies.form.name")}
            rules={[{ required: true }]}
          />
          <ProFormSelect
            name="scope_kind"
            label={t("security.riskPolicies.form.scopeKind")}
            options={[
              { label: t("security.riskPolicies.scope.global"), value: "global" },
              { label: t("security.riskPolicies.scope.serverGroup"), value: "server_group" },
              { label: t("security.riskPolicies.scope.server"), value: "server" },
              { label: t("security.riskPolicies.scope.task"), value: "task" },
            ]}
          />
          <ProFormText
            name="scope_id"
            label={t("security.riskPolicies.form.scopeId")}
            placeholder={t("security.riskPolicies.form.scopeIdPlaceholder")}
          />
          <ProFormSelect
            name="default_tier"
            label={t("security.riskPolicies.form.defaultTier")}
            options={[
              { label: "L1", value: "L1" },
              { label: "L2", value: "L2" },
              { label: "L3", value: "L3" },
            ]}
          />
          <ProFormSwitch name="enabled" label={t("security.riskPolicies.form.enabled")} />
          <Typography.Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
            {t("security.riskPolicies.form.rulesHintTabs")}
          </Typography.Text>
          <RiskRulesEditor
            key={editing?.id ?? "new"}
            value={draftRules}
            onChange={setDraftRules}
          />
        </ProForm>
      </ModuleFormDrawer>
    </ModulePageShell>
  );
}