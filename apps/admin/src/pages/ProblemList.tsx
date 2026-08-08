import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { AlertOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Descriptions,
  List,
  Space,
  Steps,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, proTableRequest } from "../api/client";
import type { ServerRecord } from "../components/ServerFormDrawer";
import { canWrite } from "../services/auth/roles";
import { formatDateTime } from "../utils/datetime";

const ServerTerminalModal = lazy(() =>
  import("../components/ServerTerminalModal").then((m) => ({ default: m.ServerTerminalModal })),
);
import { ModulePageShell } from "../components/ModulePageShell";
import { ModuleTableCard } from "../components/ModuleTableCard";
import { RuleTestRunChart } from "./monitoring/RuleTestRunChart";
import {
  moduleProTableProps,
  moduleTableExpandable,
  moduleTablePagination,
  moduleTableSearch,
} from "../components/module-table-styles";
import { useSeverityLabel, useStateLabel } from "../locales/labels";
import {
  monitorOwnerKindLabel,
  monitorOwnerNameLabel,
  type MonitorOwnerKind,
} from "../utils/monitor-owner-display";
import {
  problemRemediationTag,
  problemVerdictSourceTag,
  remediationExecutedLabel,
  remediationMethodLabel,
  verificationStatusTag,
} from "../utils/problem-display";

interface ProblemAnomalyItem {
  id: string;
  binding_id: string | null;
  monitor_owner_name?: string | null;
  monitor_owner_kind?: MonitorOwnerKind | null;
  monitor_step_id: string | null;
  binding_title: string | null;
  metric_key: string | null;
  status: string | null;
  raw_excerpt: string | null;
  error: string | null;
  problem_statement: string | null;
  problem_location: string | null;
  recommended_action: string | null;
  self_resolvable: boolean | null;
  follow_up_recommendations: string[];
  remediation_tier: string | null;
  remediation_status: string | null;
  remediation_method: string | null;
  remediation_summary: string | null;
  remediation_executed: boolean | null;
  verification_status: string | null;
  step_metrics?: Record<string, unknown>;
}

interface ProblemServerOccurrence {
  event_id: string;
  server_id: string;
  server_name: string | null;
  server_ip: string | null;
  timestamp: string;
  last_occurrence_at: string | null;
  occurrence_count: number;
  problem_state: string;
  remediation_status: string | null;
  verification_status: string | null;
  needs_intervention: boolean;
  recovered: boolean;
}

interface Problem {
  id: string;
  group_key?: string;
  server_id: string;
  server_name: string | null;
  server_ip: string | null;
  server_count: number;
  total_occurrence_count: number;
  latest_occurrence_at: string | null;
  server_occurrences: ProblemServerOccurrence[];
  event_type: string;
  timestamp: string;
  last_occurrence_at: string | null;
  root_cause_signature: string | null;
  occurrence_count: number;
  problem_state: string;
  severity: string | null;
  metric_key: string | null;
  binding_title: string | null;
  binding_id: string | null;
  monitor_owner_name?: string | null;
  monitor_owner_kind?: MonitorOwnerKind | null;
  monitor_step_id: string | null;
  verdict_source: string | null;
  problem_statement: string | null;
  problem_location: string | null;
  recommended_action: string | null;
  follow_up_recommendations: string[];
  remediation_tier: string | null;
  remediation_status: string | null;
  remediation_method: string | null;
  remediation_summary: string | null;
  operation_type: string | null;
  remediation_executed: boolean | null;
  verification_status: string | null;
  remediation_inconsistent: boolean;
  self_resolvable: boolean | null;
  patrol_record_id: string | null;
  anomaly_items: ProblemAnomalyItem[];
  problem_count: number;
  recovery_count: number;
  needs_intervention: boolean;
  payload: Record<string, unknown>;
}

interface ProblemEvidenceItem {
  source?: string;
  collected_at?: string;
  timeout?: boolean;
  error?: string;
  data?: Record<string, unknown> | null;
}

function anomalyItemDetail(item: ProblemAnomalyItem): string {
  return (
    item.problem_statement ||
    item.raw_excerpt ||
    item.error ||
    item.problem_location ||
    "—"
  );
}

function parseVolumeCandidates(
  value: unknown,
): Array<{ name: string; reclaimable?: boolean }> {
  if (!value) return [];

  const candidates: Array<{ name: string; reclaimable?: boolean }> = [];

  const pushCandidate = (row: unknown) => {
    if (!row || typeof row !== "object") return;
    const name = String((row as Record<string, unknown>).name ?? "").trim();
    if (!name) return;
    const reclaimable = (row as Record<string, unknown>).reclaimable;
    candidates.push({
      name,
      reclaimable: typeof reclaimable === "boolean" ? reclaimable : undefined,
    });
  };

  if (Array.isArray(value)) {
    for (const row of value) pushCandidate(row);
    return candidates;
  }

  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    for (const row of parsed) pushCandidate(row);
    return candidates;
  } catch {
    return [];
  }
}

function buildVolumeCandidateSummary(item: ProblemAnomalyItem): string {
  if (item.metric_key !== "docker_hygiene") return "";

  const metrics = item.step_metrics ?? {};
  const countValue = Number(metrics.volume_candidates_count);
  const rawCandidates = parseVolumeCandidates(metrics.volume_candidates);
  const countValueInt = Number.isFinite(countValue)
    ? Math.trunc(countValue)
    : rawCandidates.length;

  if (!Number.isFinite(countValueInt) || countValueInt <= 0) {
    return "";
  }

  const names = rawCandidates.map((row) => row.name).slice(0, 3);
  const suffix =
    rawCandidates.length > 3 ? `等 ${rawCandidates.length - 3} 项` : "";
  const list =
    names.length > 0
      ? names.join("；") + (suffix ? `；${suffix}` : "")
      : "无可回收候选";
  return `候选回收卷：共 ${countValueInt} 个，优先：${list}`;
}

function buildInterventionRemediationPlan(problem: Problem | null): string | null {
  if (!problem) return null;
  const parts: string[] = [];
  const statement =
    problem.problem_statement?.trim() ||
    String(problem.payload.error_pattern ?? "").trim();
  if (statement) {
    parts.push(`问题描述：${statement}`);
  }
  if (problem.problem_location?.trim()) {
    parts.push(`问题位置：${problem.problem_location.trim()}`);
  }
  if (problem.recommended_action?.trim()) {
    parts.push(`推荐处置：\n${problem.recommended_action.trim()}`);
  }
  if (problem.remediation_summary?.trim()) {
    parts.push(`自动执行摘要：\n${problem.remediation_summary.trim()}`);
  }
  if (parts.length === 0 && problem.follow_up_recommendations.length > 0) {
    parts.push(problem.follow_up_recommendations.join("\n"));
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function ServerOccurrencesPanel({
  row,
  onHumanIntervention,
  onGenerateReport,
  generatingReportId,
}: {
  row: Problem;
  onHumanIntervention: (occurrence: ProblemServerOccurrence) => void;
  onGenerateReport: (eventId: string) => void;
  generatingReportId: string | null;
}) {
  const { t } = useTranslation();
  const stateLabel = useStateLabel();
  const occurrences = row.server_occurrences ?? [];

  if (occurrences.length === 0) {
    return (
      <Typography.Text type="secondary">
        {t("problems.serverOccurrences.empty")}
      </Typography.Text>
    );
  }

  return (
    <Table<ProblemServerOccurrence>
      size="small"
      bordered
      pagination={false}
      rowKey="event_id"
      dataSource={occurrences}
      columns={[
        {
          title: t("problems.serverOccurrences.server"),
          dataIndex: "server_name",
          width: 120,
          ellipsis: true,
          render: (_, item) => item.server_name ?? item.server_id,
        },
        {
          title: t("problems.serverOccurrences.serverIp"),
          dataIndex: "server_ip",
          width: 130,
          ellipsis: true,
          render: (_, item) => item.server_ip ?? "—",
        },
        {
          title: t("problems.serverOccurrences.lastOccurred"),
          dataIndex: "last_occurrence_at",
          width: 170,
          render: (_, item) =>
            formatDateTime(item.last_occurrence_at ?? item.timestamp),
        },
        {
          title: t("problems.serverOccurrences.occurrences"),
          dataIndex: "occurrence_count",
          width: 90,
          align: "center",
        },
        {
          title: t("problems.columns.state"),
          dataIndex: "problem_state",
          width: 100,
          render: (_, item) => {
            const meta = stateLabel(item.problem_state);
            return (
              <span style={{ color: meta.color, fontWeight: 500 }}>{meta.text}</span>
            );
          },
        },
        {
          title: t("problems.serverOccurrences.remediation"),
          dataIndex: "remediation_status",
          width: 130,
          render: (_, item) =>
            item.remediation_status
              ? problemRemediationTag(null, item.remediation_status, t)
              : "—",
        },
        {
          title: t("common.actions"),
          width: 200,
          render: (_, item) => (
            <Space size={4} wrap>
              <Button
                size="small"
                type="link"
                loading={generatingReportId === item.event_id}
                onClick={() => onGenerateReport(item.event_id)}
              >
                {t("problems.generateReport")}
              </Button>
              {item.needs_intervention ? (
                <Button
                  size="small"
                  type="link"
                  onClick={() => onHumanIntervention(item)}
                >
                  {t("problems.detail.humanIntervention")}
                </Button>
              ) : null}
            </Space>
          ),
        },
      ]}
    />
  );
}

function AnomalyItemsPanel({ row }: { row: Problem }) {
  const { t } = useTranslation();
  const items = row.anomaly_items.length > 0 ? row.anomaly_items : [];

  if (items.length === 0) {
    return (
      <Typography.Text type="secondary">{t("problems.anomalyItems.empty")}</Typography.Text>
    );
  }

  return (
    <Table<ProblemAnomalyItem>
      size="small"
      bordered
      pagination={false}
      rowKey="id"
      dataSource={items}
      columns={[
        {
          title: t("monitoring.patrolRecords.stepColumns.ownerName"),
          dataIndex: "monitor_owner_name",
          width: 120,
          ellipsis: true,
          render: (_, item) => monitorOwnerNameLabel(item.monitor_owner_name, t),
        },
        {
          title: t("monitoring.patrolRecords.stepColumns.ownerKind"),
          dataIndex: "monitor_owner_kind",
          width: 72,
          render: (_, item) => monitorOwnerKindLabel(item.monitor_owner_kind, t),
        },
        {
          title: t("problems.anomalyItems.step"),
          dataIndex: "binding_title",
          width: 160,
          ellipsis: true,
          render: (_, item) => item.binding_title ?? item.metric_key ?? "—",
        },
        {
          title: t("problems.anomalyItems.detail"),
          dataIndex: "problem_statement",
          width: 220,
          ellipsis: true,
          render: (_, item) => (
            <Typography.Text ellipsis={{ tooltip: anomalyItemDetail(item) }}>
              {anomalyItemDetail(item)}
            </Typography.Text>
          ),
        },
        {
          title: "候选清单",
          dataIndex: "step_metrics",
          width: 240,
          ellipsis: true,
          render: (_, item) => {
            const summary = buildVolumeCandidateSummary(item);
            return summary || "—";
          },
        },
        {
          title: t("problems.anomalyItems.recommendedAction"),
          dataIndex: "recommended_action",
          ellipsis: true,
          render: (_, item) =>
            item.recommended_action ? (
              <Typography.Text ellipsis={{ tooltip: item.recommended_action }}>
                {item.recommended_action}
              </Typography.Text>
            ) : (
              "—"
            ),
        },
        {
          title: t("problems.anomalyItems.remediation"),
          dataIndex: "remediation_status",
          width: 130,
          render: (_, item) =>
            problemRemediationTag(item.remediation_tier, item.remediation_status, t),
        },
        {
          title: t("problems.anomalyItems.verification"),
          dataIndex: "verification_status",
          width: 120,
          render: (_, item) => verificationStatusTag(item.verification_status, t),
        },
      ]}
    />
  );
}

function getEvidenceItems(row: Problem): ProblemEvidenceItem[] {
  const evidence = row.payload?.evidence as { items?: ProblemEvidenceItem[] } | undefined;
  return Array.isArray(evidence?.items) ? evidence.items : [];
}
function EvidencePanel({
  row,
  onRecollectEvidence,
  recollectingEvidenceId,
}: {
  row: Problem;
  onRecollectEvidence: (eventId: string) => void;
  recollectingEvidenceId: string | null;
}) {
  const items = getEvidenceItems(row);
  const writable = canWrite();
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Space>
        {writable ? (
          <Button
            size="small"
            onClick={() => onRecollectEvidence(row.id)}
            loading={recollectingEvidenceId === row.id}
          >
            重新采集证据
          </Button>
        ) : null}
        {items.some((item) => item.data?._stub) ? <Tag color="warning">含旧占位证据</Tag> : null}
      </Space>
      {items.length === 0 ? (
        <Typography.Text type="secondary">暂无证据</Typography.Text>
      ) : (
        <List
          size="small"
          bordered
          dataSource={items}
          renderItem={(item) => {
            const data = (item.data ?? {}) as Record<string, unknown>;
            const metricsObj = data.metrics as Record<string, unknown> | undefined;
            const digest = String(
              data.evidence_digest ?? metricsObj?.fault_evidence_digest ?? "",
            ).trim();
            const note = digest || String(data.note ?? item.error ?? data.raw_excerpt ?? "—");
            const metricsRaw =
              metricsObj && typeof metricsObj === "object"
                ? { ...metricsObj }
                : null;
            if (metricsRaw) {
              delete metricsRaw.fault_evidence_digest;
              delete metricsRaw.fault_narrative;
            }
            const metrics =
              metricsRaw && Object.keys(metricsRaw).length > 0
                ? JSON.stringify(metricsRaw, null, 2)
                : null;
            return (
              <List.Item>
                <Space direction="vertical" size={4} style={{ width: "100%" }}>
                  <Space wrap>
                    <Typography.Text strong>{item.source ?? "unknown"}</Typography.Text>
                    {data.status ? <Tag>{String(data.status)}</Tag> : null}
                    {data.fault_signature ? (
                      <Tag color="volcano">{String(data.fault_signature)}</Tag>
                    ) : null}
                    {item.timeout ? <Tag color="error">timeout</Tag> : null}
                    {data._stub ? <Tag color="warning">legacy _stub</Tag> : null}
                    <Typography.Text type="secondary">{formatDateTime(item.collected_at)}</Typography.Text>
                  </Space>
                  <Typography.Paragraph className="problem-detail-text">
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{note}</pre>
                  </Typography.Paragraph>
                  {metrics ? (
                    <Typography.Paragraph className="problem-detail-text" type="secondary">
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{metrics}</pre>
                    </Typography.Paragraph>
                  ) : null}
                </Space>
              </List.Item>
            );
          }}
        />
      )}
    </Space>
  );
}

/**
 * U11 — Problem detail embedded metric trend (PRD F5/F6 "Problem 详情嵌入指标图表").
 *
 * When the Problem was produced by an anomaly rule (payload carries `rule_id`),
 * embed the rule's metric chart — the same `RuleTestRunChart` the U10 rule view
 * renders — so the operator sees the pre/post-window curve + threshold + breach
 * band inline with the problem, without leaving the detail. Reuses the U9
 * `/dashboards/business-metrics/query` endpoint (`widget_id = "rule:<id>"`), so
 * the chart degrades to an UnavailableCard when `query_range` is unavailable —
 * never a blank panel, and no Prometheus coupling here.
 *
 * Problems without a rule link (patrol/log problems not tied to a rule) render
 * an explanatory Empty state rather than a fabricated chart.
 */
function MetricTrendPanel({ row }: { row: Problem }) {
  const { t } = useTranslation();
  const ruleId = String(row.payload?.rule_id ?? "").trim();
  const ruleName =
    String(row.payload?.rule_name ?? "").trim() || row.binding_title || undefined;

  if (!ruleId) {
    return (
      <Typography.Text type="secondary">
        {t("problems.detail.metricTrendEmpty")}
      </Typography.Text>
    );
  }

  return (
    <div data-testid="problem-metric-trend">
      <RuleTestRunChart ruleId={ruleId} ruleName={ruleName} height={280} />
    </div>
  );
}

type ProblemSnoozeState = {
  active: boolean;
  snooze_until: string | null;
  snoozed_at: string | null;
  remaining_ms: number;
};

type ConvergenceTimelineStep = {
  key: string;
  label: string;
  status: "pending" | "current" | "done" | "failed";
  at: string | null;
  detail: string | null;
  patrol_record_id?: string | null;
  patrol_round_id?: string | null;
};

function isSnoozeActiveFromPayload(payload: Record<string, unknown>): boolean {
  const until = String(payload.snooze_until ?? "").trim();
  if (!until) return false;
  if (payload.snooze_active === false) return false;
  return new Date(until).getTime() > Date.now();
}

function formatSnoozeRemaining(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function SnoozeCountdownBadge({
  payload,
  refreshKey,
}: {
  payload: Record<string, unknown>;
  refreshKey?: number;
}) {
  const { t } = useTranslation();
  const [remainingMs, setRemainingMs] = useState(0);

  useEffect(() => {
    const until = String(payload.snooze_until ?? "").trim();
    const tick = () => {
      if (!until || payload.snooze_active === false) {
        setRemainingMs(0);
        return;
      }
      setRemainingMs(Math.max(0, new Date(until).getTime() - Date.now()));
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [payload, refreshKey]);

  if (!isSnoozeActiveFromPayload(payload) && remainingMs <= 0) return null;

  return (
    <Tag color="gold" data-testid="problem-snooze-badge">
      {t("problems.closure.snoozeBadge", {
        remaining: formatSnoozeRemaining(remainingMs),
      })}
    </Tag>
  );
}

function AutoIncidentReportBanner({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["incident-report-by-event", eventId],
    queryFn: async () => {
      try {
        return await api<{ id: string; source?: string }>(`/api/incident-reports/by-event/${eventId}`);
      } catch {
        return null;
      }
    },
  });

  if (!data || data.source !== "auto") return null;

  return (
    <Alert
      type="info"
      showIcon
      data-testid="auto-incident-report-banner"
      message={t("incidentReports.autoBanner.title")}
      description={
        <Link to={`/incident-reports/${data.id}`}>{t("incidentReports.autoBanner.cta")}</Link>
      }
      style={{ marginBottom: 12 }}
    />
  );
}

function ConvergenceTimelinePanel({
  eventId,
  row,
  onChanged,
}: {
  eventId: string;
  row: Problem;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const writable = canWrite();
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [timeline, setTimeline] = useState<{
    steps: ConvergenceTimelineStep[];
    latest_patrol_record_id: string | null;
    latest_patrol_summary: string | null;
  } | null>(null);
  const [snooze, setSnooze] = useState<ProblemSnoozeState | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [timelineRes, snoozeRes] = await Promise.all([
        api<{
          steps: ConvergenceTimelineStep[];
          latest_patrol_record_id: string | null;
          latest_patrol_summary: string | null;
        }>(`/api/problems/${eventId}/convergence-timeline`),
        api<ProblemSnoozeState>(`/api/problems/${eventId}/snooze`),
      ]);
      setTimeline(timelineRes);
      setSnooze(snoozeRes);
      setRefreshKey((v) => v + 1);
    } catch {
      message.error(t("common.error"));
    } finally {
      setLoading(false);
    }
  }, [eventId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (path: string, successKey: string) => {
    setActing(true);
    try {
      await api(`/api/problems/${eventId}${path}`, { method: "POST" });
      message.success(t(successKey));
      await load();
      onChanged();
    } catch {
      message.error(t("common.error"));
    } finally {
      setActing(false);
    }
  };

  const stepStatus = (status: ConvergenceTimelineStep["status"]) => {
    if (status === "done") return "finish";
    if (status === "current") return "process";
    if (status === "failed") return "error";
    return "wait";
  };

  const recovered = row.problem_state === "healthy" || Boolean(row.payload?.resolution);

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }} data-testid="convergence-timeline">
      <Space wrap>
        <SnoozeCountdownBadge payload={row.payload} refreshKey={refreshKey} />
        {snooze?.active ? (
          <>
            <Button
              size="small"
              disabled={!writable || acting}
              onClick={() => void runAction("/snooze/renew", "problems.closure.snoozeRenewed")}
            >
              {t("problems.closure.renewSnooze")}
            </Button>
            <Button
              size="small"
              disabled={!writable || acting}
              onClick={() => void runAction("/snooze/cancel", "problems.closure.snoozeCancelled")}
            >
              {t("problems.closure.cancelSnooze")}
            </Button>
          </>
        ) : !recovered ? (
          <>
            <Button
              type="primary"
              size="small"
              disabled={!writable || acting}
              onClick={() => void runAction("/resolve", "problems.closure.resolveDone")}
            >
              {t("problems.closure.manualResolve")}
            </Button>
            <Button
              size="small"
              disabled={!writable || acting}
              onClick={() => void runAction("/snooze", "problems.closure.snoozeDone")}
            >
              {t("problems.closure.snooze24h")}
            </Button>
          </>
        ) : null}
      </Space>
      {loading || !timeline ? (
        <Typography.Text type="secondary">{t("common.loading")}</Typography.Text>
      ) : (
        <>
          <Steps
            size="small"
            direction="vertical"
            items={timeline.steps.map((step) => ({
              title: step.label,
              status: stepStatus(step.status),
              description: [
                step.at ? formatDateTime(step.at) : null,
                step.detail,
                step.key === "pending_patrol" && timeline.latest_patrol_summary
                  ? timeline.latest_patrol_summary
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || undefined,
            }))}
          />
          {timeline.latest_patrol_record_id ? (
            <Link
              to={`/monitoring/patrol-records?task_id=${String(row.payload.patrol_task_id ?? "")}`}
            >
              {t("problems.viewPatrolRecord")}
            </Link>
          ) : null}
        </>
      )}
    </Space>
  );
}

function ProblemDetailExpand({
  row,
  onHumanIntervention,
  onGenerateReport,
  generatingReportId,
  onRecollectEvidence,
  recollectingEvidenceId,
  onClosureChanged,
}: {
  row: Problem;
  onHumanIntervention: (occurrence: ProblemServerOccurrence) => void;
  onGenerateReport: (eventId: string) => void;
  generatingReportId: string | null;
  onRecollectEvidence: (eventId: string) => void;
  recollectingEvidenceId: string | null;
  onClosureChanged: () => void;
}) {
  const { t } = useTranslation();
  const severityLabel = useSeverityLabel();
  const summary =
    row.problem_statement ||
    String(row.payload.error_pattern ?? "").trim() ||
    "—";
  const location =
    row.problem_location ||
    [row.binding_title, row.metric_key, row.severity].filter(Boolean).join(" · ") ||
    "—";

  return (
    <div className="module-table-detail-panel problem-detail-panel">
      <AutoIncidentReportBanner eventId={row.id} />
      <Tabs
        size="small"
        items={[
          {
            key: "serverOccurrences",
            label: t("problems.tabs.serverOccurrences"),
            children: (
              <ServerOccurrencesPanel
                row={row}
                onHumanIntervention={onHumanIntervention}
                onGenerateReport={onGenerateReport}
                generatingReportId={generatingReportId}
              />
            ),
          },
          {
            key: "anomalyItems",
            label: t("problems.tabs.anomalyItems"),
            children: <AnomalyItemsPanel row={row} />,
          },
          {
            key: "diagnosis",
            label: t("problems.tabs.diagnosis"),
            children: (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <div className="problem-detail-tags">
                  {row.severity ? (
                    <Tag color={severityLabel(row.severity).status}>
                      {severityLabel(row.severity).text}
                    </Tag>
                  ) : null}
                  {row.binding_title ? (
                    <Tag>{`${t("problems.detail.binding")}: ${row.binding_title}`}</Tag>
                  ) : null}
                  {row.metric_key ? (
                    <Tag>{`${t("problems.detail.metricKey")}: ${row.metric_key}`}</Tag>
                  ) : null}
                  {problemVerdictSourceTag(row.verdict_source, t)}
                </div>
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label={t("problems.detail.problemStatement")}>
                    <Typography.Paragraph className="problem-detail-text">
                      {summary}
                    </Typography.Paragraph>
                  </Descriptions.Item>
                  <Descriptions.Item label={t("problems.detail.problemLocation")}>
                    <Typography.Paragraph className="problem-detail-text">
                      {location}
                    </Typography.Paragraph>
                  </Descriptions.Item>
                </Descriptions>
              </Space>
            ),
          },
          {
            key: "evidence",
            label: "证据",
            children: (
              <EvidencePanel
                row={row}
                onRecollectEvidence={onRecollectEvidence}
                recollectingEvidenceId={recollectingEvidenceId}
              />
            ),
          },
          {
            key: "metricTrend",
            label: t("problems.tabs.metricTrend"),
            children: <MetricTrendPanel row={row} />,
          },
          {
            key: "convergence",
            label: t("problems.tabs.convergence"),
            children: (
              <ConvergenceTimelinePanel
                eventId={row.id}
                row={row}
                onChanged={onClosureChanged}
              />
            ),
          },
          {
            key: "remediation",
            label: t("problems.tabs.remediation"),
            children: (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                {row.remediation_inconsistent ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={t("problems.detail.inconsistentTitle")}
                    description={t("problems.detail.inconsistentDesc")}
                  />
                ) : null}
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label={t("problems.columns.recommendedAction")}>
                    <Typography.Paragraph className="problem-detail-text">
                      {row.recommended_action || "—"}
                    </Typography.Paragraph>
                  </Descriptions.Item>
                  <Descriptions.Item label={t("problems.detail.aiSelfResolvable")}>
                    {row.self_resolvable == null
                      ? "—"
                      : row.self_resolvable
                        ? t("common.yes")
                        : t("common.no")}
                    <Typography.Text type="secondary" style={{ display: "block", marginTop: 4 }}>
                      {t("problems.detail.aiSelfResolvableHint")}
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label={t("problems.detail.remediationExecuted")}>
                    {remediationExecutedLabel(row.remediation_executed, t)}
                  </Descriptions.Item>
                  <Descriptions.Item label={t("problems.detail.remediationResult")}>
                    {problemRemediationTag(
                      row.remediation_tier,
                      row.remediation_status,
                      t,
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item label={t("problems.detail.verificationStatus")}>
                    {verificationStatusTag(row.verification_status, t)}
                    <Typography.Text type="secondary" style={{ display: "block", marginTop: 4 }}>
                      {t("problems.detail.verificationHint")}
                    </Typography.Text>
                  </Descriptions.Item>
                  {row.remediation_method ? (
                    <Descriptions.Item label={t("problems.detail.remediationMethod")}>
                      {remediationMethodLabel(row.remediation_method, t)}
                    </Descriptions.Item>
                  ) : null}
                  {row.operation_type ? (
                    <Descriptions.Item label={t("problems.detail.operationType")}>
                      {row.operation_type}
                    </Descriptions.Item>
                  ) : null}
                  {row.remediation_summary ? (
                    <Descriptions.Item label={t("problems.detail.remediationSummary")}>
                      <Typography.Paragraph className="problem-detail-text" type="secondary">
                        {row.remediation_summary}
                      </Typography.Paragraph>
                    </Descriptions.Item>
                  ) : null}
                  {row.remediation_status === "needs_human_intervention" ||
                  row.remediation_method === "human_intervention_required" ? (
                    <Descriptions.Item label={t("problems.detail.humanIntervention")}>
                      <Space direction="vertical" size={8}>
                        <Typography.Text type="secondary">
                          {t("problems.detail.humanInterventionHint")}
                        </Typography.Text>
                        <Button
                          type="primary"
                          onClick={() => {
                            const target =
                              row.server_occurrences.find((o) => o.needs_intervention) ??
                              row.server_occurrences[0];
                            if (target) onHumanIntervention(target);
                          }}
                        >
                          {t("problems.detail.humanIntervention")}
                        </Button>
                      </Space>
                    </Descriptions.Item>
                  ) : null}
                  {row.patrol_record_id ? (
                    <Descriptions.Item label={t("problems.viewPatrolRecord")}>
                      <Link
                        to={`/monitoring/patrol-records?task_id=${String(row.payload.patrol_task_id ?? "")}`}
                      >
                        {t("problems.viewPatrolRecord")}
                      </Link>
                    </Descriptions.Item>
                  ) : null}
                </Descriptions>
              </Space>
            ),
          },
          {
            key: "followup",
            label: t("problems.tabs.followUp"),
            children:
              row.follow_up_recommendations.length > 0 ? (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <Alert type="info" showIcon message={t("problems.detail.followUpHint")} />
                  <List
                    size="small"
                    bordered
                    dataSource={row.follow_up_recommendations}
                    renderItem={(item, index) => (
                      <List.Item>
                        <Typography.Text>
                          {index + 1}. {item}
                        </Typography.Text>
                      </List.Item>
                    )}
                  />
                </Space>
              ) : (
                <Typography.Text type="secondary">
                  {t("problems.detail.followUpEmpty")}
                </Typography.Text>
              ),
          },
        ]}
      />
    </div>
  );
}

export function ProblemList() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const stateLabel = useStateLabel();
  const [searchParams] = useSearchParams();
  const [generatingReportId, setGeneratingReportId] = useState<string | null>(null);
  const highlightEventId = searchParams.get("event_id") ?? undefined;
  const [interventionOpen, setInterventionOpen] = useState(false);
  const [interventionProblem, setInterventionProblem] = useState<Problem | null>(null);
  const [interventionServer, setInterventionServer] = useState<ServerRecord | null>(null);
  const [tableReloadKey, setTableReloadKey] = useState(0);
  const [recollectingEvidenceId, setRecollectingEvidenceId] = useState<string | null>(null);

  const generateIncidentReport = useCallback(async (eventId: string) => {
    setGeneratingReportId(eventId);
    try {
      const report = await api<{ id: string }>("/api/incident-reports", {
        method: "POST",
        body: JSON.stringify({ problem_event_id: eventId }),
      });
      message.success(t("problems.generateReportSuccess"));
      navigate(`/incident-reports/${report.id}`);
    } catch {
      message.error(t("common.error"));
    } finally {
      setGeneratingReportId(null);
    }
  }, [navigate, t]);

  const openHumanIntervention = useCallback(
    async (occurrence: ProblemServerOccurrence, row: Problem) => {
      try {
        const server = await api<ServerRecord>(`/api/servers/${occurrence.server_id}`);
        setInterventionProblem({ ...row, id: occurrence.event_id, server_id: occurrence.server_id });
        setInterventionServer(server);
        setInterventionOpen(true);
      } catch {
        message.error(t("common.error"));
      }
    },
    [t],
  );

  const recollectEvidence = useCallback(async (eventId: string) => {
    setRecollectingEvidenceId(eventId);
    try {
      await api(`/api/problems/${eventId}/recollect-evidence`, { method: "POST" });
      message.success("证据已重新采集");
      setTableReloadKey((v) => v + 1);
    } catch {
      message.error(t("common.error"));
    } finally {
      setRecollectingEvidenceId(null);
    }
  }, [t]);

  const renderDetailExpand = useCallback(
    (record: Problem) => (
      <ProblemDetailExpand
        row={record}
        onHumanIntervention={(occurrence) => openHumanIntervention(occurrence, record)}
        onGenerateReport={generateIncidentReport}
        generatingReportId={generatingReportId}
        onRecollectEvidence={recollectEvidence}
        recollectingEvidenceId={recollectingEvidenceId}
        onClosureChanged={() => setTableReloadKey((v) => v + 1)}
      />
    ),
    [
      openHumanIntervention,
      generateIncidentReport,
      generatingReportId,
      recollectEvidence,
      recollectingEvidenceId,
    ],
  );

  const columns: ProColumns<Problem>[] = useMemo(() => {
    const stateEnum = Object.fromEntries(
      ["anomaly_detected", "degraded", "critical", "recovering"].map((key) => [
        key,
        { text: stateLabel(key).text },
      ]),
    );

    return [
      {
        title: t("monitoring.patrolRecords.stepColumns.ownerName"),
        dataIndex: "monitor_owner_name",
        width: 120,
        ellipsis: true,
        search: false,
        render: (_, row) => (
          <Typography.Text ellipsis={{ tooltip: monitorOwnerNameLabel(row.monitor_owner_name, t) }}>
            {monitorOwnerNameLabel(row.monitor_owner_name, t)}
          </Typography.Text>
        ),
      },
      {
        title: t("monitoring.patrolRecords.stepColumns.ownerKind"),
        dataIndex: "monitor_owner_kind",
        width: 72,
        search: false,
        render: (_, row) => monitorOwnerKindLabel(row.monitor_owner_kind, t),
      },
      {
        title: t("problems.columns.component"),
        dataIndex: "binding_title",
        width: 140,
        ellipsis: true,
        search: false,
        render: (_, row) => row.binding_title ?? row.metric_key ?? "—",
      },
      {
        title: t("problems.columns.problemStatement"),
        dataIndex: "problem_statement",
        width: 240,
        ellipsis: true,
        search: false,
        render: (_, row) => {
          const text =
            row.problem_statement ||
            String(row.payload.error_pattern ?? "").trim() ||
            "—";
          return (
            <Typography.Text ellipsis={{ tooltip: text }}>{text}</Typography.Text>
          );
        },
      },
      {
        title: t("problems.columns.state"),
        dataIndex: "problem_state",
        width: 100,
        valueType: "select",
        valueEnum: stateEnum,
        render: (_, row) => {
          const meta = stateLabel(row.problem_state);
          return (
            <Space size={4} wrap>
              <span style={{ color: meta.color, fontWeight: 500 }}>{meta.text}</span>
              <SnoozeCountdownBadge payload={row.payload} />
            </Space>
          );
        },
      },
      {
        title: t("problems.columns.remediation"),
        dataIndex: "remediation_tier",
        width: 130,
        search: false,
        render: (_, row) =>
          problemRemediationTag(row.remediation_tier, row.remediation_status, t),
      },
      {
        title: t("problems.columns.serverCount"),
        dataIndex: "server_count",
        width: 100,
        search: false,
        align: "center",
        render: (_, row) => row.server_count ?? row.problem_count ?? 1,
      },
      {
        title: t("problems.columns.recoveryCount"),
        dataIndex: "recovery_count",
        width: 90,
        search: false,
        align: "center",
        render: (_, row) => {
          const total = row.server_count ?? row.problem_count ?? 1;
          const text = `${row.recovery_count}/${total}`;
          const recovered = row.recovery_count >= total;
          return (
            <Typography.Text type={recovered ? "success" : undefined}>{text}</Typography.Text>
          );
        },
      },
      {
        title: t("problems.columns.latestOccurred"),
        dataIndex: "latest_occurrence_at",
        width: 170,
        search: false,
        render: (_, row) =>
          formatDateTime(row.latest_occurrence_at ?? row.last_occurrence_at ?? row.timestamp),
      },
      {
        title: t("problems.columns.server"),
        dataIndex: "server_name",
        hideInTable: true,
      },
      {
        title: t("problems.columns.serverIp"),
        dataIndex: "server_ip",
        hideInTable: true,
      },
    ];
  }, [t, stateLabel]);

  return (
    <ModulePageShell
      icon={<AlertOutlined style={{ fontSize: 20 }} />}
      title={t("problems.title")}
      subtitle={t("problems.subtitleOpenFilter")}
    >
      <ModuleTableCard>
        <ProTable<Problem>
          {...moduleProTableProps}
          rowKey="id"
          bordered
          tableLayout="fixed"
          search={moduleTableSearch()}
          pagination={{
            ...moduleTablePagination,
            hideOnSinglePage: false,
            showTotal: (total, range) =>
              t("problems.pagination.total", {
                start: range[0],
                end: range[1],
                total,
              }),
          }}
          dateFormatter="string"
          columns={columns}
          params={{
            event_id: highlightEventId,
            locale: i18n.language,
            filter_preset: "open",
            _reload: tableReloadKey,
          }}
          form={{
            initialValues: { filter_preset: "open" },
          }}
          data-testid="problem-list-table"
          rowClassName={(row) => (row.id === highlightEventId ? "ant-table-row-selected" : "")}
          request={async (params, sort, filter) =>
            proTableRequest<Problem>("/api/problems", params, sort, filter)
          }
          expandable={{
            ...moduleTableExpandable,
            expandedRowRender: renderDetailExpand,
          }}
        />
      </ModuleTableCard>
      <Suspense fallback={null}>
        <ServerTerminalModal
          open={interventionOpen}
          server={interventionServer}
          problemEventId={interventionProblem?.id}
          interventionRemediationPlan={buildInterventionRemediationPlan(interventionProblem)}
          interventionSeedMessage={t("problems.intervention.seedMessage")}
          onInterventionComplete={() => {
            message.success(t("problems.intervention.complete"));
            setInterventionOpen(false);
            setTableReloadKey((k) => k + 1);
          }}
          onClose={() => setInterventionOpen(false)}
        />
      </Suspense>
    </ModulePageShell>
  );
}
