import { ProTable } from "@ant-design/pro-components";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { AuditOutlined } from "@ant-design/icons";
import {
  App,
  Button,
  Descriptions,
  Drawer,
  Input,
  List,
  Modal,
  Space,
  Tag,
  Timeline,
  Typography,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api, ApiError, proTableRequest } from "../../api/client";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleProTableProps,
  moduleTablePagination,
  moduleTableSearch,
} from "../../components/module-table-styles";

type L2ApprovalRow = {
  id: string;
  title: string;
  severity: string;
  finding_summary: string;
  status: string;
  source: string;
  server_id: string | null;
  problem_event_id: string | null;
  external_risk_finding_id: string | null;
  executable: boolean;
  timeout_at: string;
  created_at: string;
  resolved_at: string | null;
  reject_reason: string | null;
};

type L2CommandRunSummary = {
  id: string;
  command: string;
  risk_tier: string;
  status: string;
  exit_code?: number;
  stdout_summary?: string;
  stderr_summary?: string;
  at: string;
};

type L2InterventionSessionSummary = {
  id: string;
  status: string;
  message_count: number;
  last_message_at: string | null;
  preview: Array<{ role: string; content: string; at: string }>;
  command_runs: L2CommandRunSummary[];
};

type L2AdvisoryClosureSummary = {
  action: string;
  at: string;
  operator: string;
  source: string;
  external_risk_finding_id: string | null;
  external_risk_task_id: string | null;
  external_risk_run_id: string | null;
  internal_ticket_id: string | null;
  human_intervention_event_id: string | null;
  note: string | null;
};

type L2ApprovalDetail = L2ApprovalRow & {
  solution_summary: Record<string, unknown>;
  recommended_action: string | null;
  operation_type: string | null;
  intervention_session: L2InterventionSessionSummary | null;
  advisory_closure: L2AdvisoryClosureSummary | null;
  links: {
    problem_event_id: string | null;
    external_risk_finding_id: string | null;
    external_risk_task_id: string | null;
    patrol_record_id: string | null;
  };
  timeline: Array<{ at: string; kind: string; label: string }>;
  audit_preview: Array<{
    id: string;
    action_type: string | null;
    status: string;
    created_at: string;
  }>;
};

type L2ActionResult = {
  item: L2ApprovalRow;
  idempotent: boolean;
};

type L2ResendNotificationResult = {
  purpose: string;
  sent: number;
  failed: number;
  results: Array<{
    channel_id: string;
    channel_name: string;
    ok: boolean;
    message: string;
    detail?: string;
  }>;
};

const NS = "security.l2Approvals";

function severityTag(severity: string) {
  const color = severity === "P1" ? "red" : severity === "P2" ? "orange" : "default";
  return <Tag color={color}>{severity}</Tag>;
}

function statusTag(status: string, t: (key: string) => string) {
  const labelKey = `${NS}.status.${status}`;
  const label = t(labelKey);
  const color =
    status === "pending" || status === "intervening"
      ? "processing"
      : status === "approved" ||
          status === "auto_executed" ||
          status === "intervention_completed" ||
          status === "completed_without_execution"
        ? "success"
        : status === "rejected" || status === "intervention_cancelled" || status === "execution_failed"
          ? "error"
          : "default";
  return <Tag color={color}>{label === labelKey ? status : label}</Tag>;
}

function advisoryActionLabel(action: string, t: (key: string) => string): string {
  const key = `${NS}.detail.advisoryAction.${action}`;
  const label = t(key);
  return label === key ? action : label;
}

function formatTimeoutCountdown(timeoutAt: string): string {
  const ms = new Date(timeoutAt).getTime() - Date.now();
  if (ms <= 0) return "0m";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

export function L2ApprovalsPage() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const actionRef = useRef<ActionType>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<L2ApprovalRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["l2-approval-detail", detailId],
    queryFn: () => api<L2ApprovalDetail>(`/api/security/l2-approvals/${detailId}`),
    enabled: Boolean(detailId),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["l2-approval-detail"] });
    actionRef.current?.reload();
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) =>
      api<L2ActionResult>(`/api/security/l2-approvals/${id}/approve`, { method: "POST" }),
    onSuccess: async (result) => {
      message.success(
        result.idempotent ? t(`${NS}.approveIdempotent`) : t(`${NS}.approveDone`),
      );
      await invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : t("common.error")),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api<L2ActionResult>(`/api/security/l2-approvals/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    onSuccess: async (result) => {
      message.success(
        result.idempotent ? t(`${NS}.rejectIdempotent`) : t(`${NS}.rejectDone`),
      );
      setRejectOpen(false);
      setRejectReason("");
      setRejectTarget(null);
      await invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : t("common.error")),
  });

  const snoozeMutation = useMutation({
    mutationFn: (id: string) =>
      api<L2ActionResult>(`/api/security/l2-approvals/${id}/snooze`, {
        method: "POST",
        body: JSON.stringify({ extend_minutes: 30 }),
      }),
    onSuccess: async (result) => {
      message.success(
        result.idempotent ? t(`${NS}.snoozeIdempotent`) : t(`${NS}.snoozeDone`),
      );
      await invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : t("common.error")),
  });

  const resendTelegramMutation = useMutation({
    mutationFn: (id: string) =>
      api<L2ResendNotificationResult>(
        `/api/security/l2-approvals/${id}/resend-notification`,
        { method: "POST" },
      ),
    onSuccess: async (result) => {
      if (result.sent > 0) {
        message.success(t(`${NS}.resendTelegramDone`, { count: result.sent }));
      } else {
        message.warning(t(`${NS}.resendTelegramFailed`));
      }
      await invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.message : t("common.error")),
  });

  const confirmApprove = (row: L2ApprovalRow) => {
    modal.confirm({
      title: t(`${NS}.confirmApproveTitle`),
      content: row.executable
        ? t(`${NS}.confirmApproveExecutable`)
        : t(`${NS}.confirmApproveAdvisory`),
      okText: t(`${NS}.actions.approve`),
      cancelText: t("common.cancel"),
      onOk: () => approveMutation.mutateAsync(row.id),
    });
  };

  const openReject = (row: L2ApprovalRow) => {
    setRejectTarget(row);
    setRejectReason("");
    setRejectOpen(true);
  };

  const columns = useMemo<ProColumns<L2ApprovalRow>[]>(
    () => [
      {
        title: t(`${NS}.columns.title`),
        dataIndex: "title",
        ellipsis: true,
      },
      {
        title: t(`${NS}.columns.source`),
        dataIndex: "source",
        width: 120,
        valueType: "select",
        valueEnum: {
          patrol: { text: t(`${NS}.source.patrol`) },
          external_risk: { text: t(`${NS}.source.external_risk`) },
          foundation: { text: t(`${NS}.source.foundation`) },
          unknown: { text: t(`${NS}.source.unknown`) },
        },
      },
      {
        title: t(`${NS}.columns.severity`),
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
        title: t(`${NS}.columns.status`),
        dataIndex: "status",
        width: 120,
        valueType: "select",
        valueEnum: {
          pending: { text: t(`${NS}.status.pending`) },
          approved: { text: t(`${NS}.status.approved`) },
          rejected: { text: t(`${NS}.status.rejected`) },
          auto_executed: { text: t(`${NS}.status.auto_executed`) },
        },
        render: (_, row) => statusTag(row.status, t),
      },
      {
        title: t(`${NS}.columns.server`),
        dataIndex: "server_id",
        ellipsis: true,
        search: false,
        render: (_, row) => row.server_id ?? "—",
      },
      {
        title: t(`${NS}.columns.timeout`),
        dataIndex: "timeout_at",
        width: 130,
        search: false,
        render: (_, row) =>
          row.status === "pending" ? formatTimeoutCountdown(row.timeout_at) : "—",
      },
      {
        title: t(`${NS}.columns.createdAt`),
        dataIndex: "created_at",
        valueType: "dateTime",
        width: 170,
        search: false,
      },
      {
        title: t("common.actions"),
        valueType: "option",
        width: 280,
        fixed: "right",
        search: false,
        render: (_, row) => {
          const pending = row.status === "pending";
          return [
            <Button key="detail" type="link" size="small" onClick={() => setDetailId(row.id)}>
              {t(`${NS}.actions.detail`)}
            </Button>,
            pending ? (
              <Button
                key="approve"
                type="link"
                size="small"
                onClick={() => confirmApprove(row)}
              >
                {t(`${NS}.actions.approve`)}
              </Button>
            ) : null,
            pending ? (
              <Button key="reject" type="link" size="small" danger onClick={() => openReject(row)}>
                {t(`${NS}.actions.reject`)}
              </Button>
            ) : null,
            pending ? (
              <Button
                key="snooze"
                type="link"
                size="small"
                onClick={() => snoozeMutation.mutate(row.id)}
              >
                {t(`${NS}.actions.snooze`)}
              </Button>
            ) : null,
            pending ? (
              <Button
                key="resend"
                type="link"
                size="small"
                loading={resendTelegramMutation.isPending}
                onClick={() => resendTelegramMutation.mutate(row.id)}
              >
                {t(`${NS}.actions.resendTelegram`)}
              </Button>
            ) : null,
          ].filter(Boolean);
        },
      },
    ],
    [t, snoozeMutation, resendTelegramMutation],
  );

  const activeRow = detail ?? null;

  return (
    <>
      <ModulePageShell
        icon={<AuditOutlined style={{ fontSize: 20 }} />}
        title={t(`${NS}.title`)}
        subtitle={t(`${NS}.subtitle`)}
      >
        <ModuleTableCard>
          <ProTable<L2ApprovalRow>
            {...moduleProTableProps}
            actionRef={actionRef}
            rowKey="id"
            columns={columns}
            request={(params) =>
              proTableRequest<L2ApprovalRow>("/api/security/l2-approvals", params)
            }
            search={moduleTableSearch()}
            pagination={moduleTablePagination}
            locale={{ emptyText: t(`${NS}.empty`) }}
          />
        </ModuleTableCard>
      </ModulePageShell>

      <Drawer
        title={t(`${NS}.detailTitle`)}
        width={640}
        open={Boolean(detailId)}
        onClose={() => setDetailId(null)}
        loading={detailLoading}
        extra={
          activeRow?.status === "pending" ? (
            <Space>
              <Button onClick={() => activeRow && confirmApprove(activeRow)}>
                {t(`${NS}.actions.approve`)}
              </Button>
              <Button danger onClick={() => activeRow && openReject(activeRow)}>
                {t(`${NS}.actions.reject`)}
              </Button>
              <Button onClick={() => activeRow && snoozeMutation.mutate(activeRow.id)}>
                {t(`${NS}.actions.snooze`)}
              </Button>
              <Button
                loading={resendTelegramMutation.isPending}
                onClick={() => activeRow && resendTelegramMutation.mutate(activeRow.id)}
              >
                {t(`${NS}.actions.resendTelegram`)}
              </Button>
            </Space>
          ) : null
        }
      >
        {activeRow ? (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label={t(`${NS}.columns.title`)}>{activeRow.title}</Descriptions.Item>
              <Descriptions.Item label={t(`${NS}.columns.status`)}>
                {statusTag(activeRow.status, t)}
              </Descriptions.Item>
              <Descriptions.Item label={t(`${NS}.columns.source`)}>
                {t(`${NS}.source.${activeRow.source}`)}
              </Descriptions.Item>
              <Descriptions.Item label={t(`${NS}.columns.severity`)}>
                {severityTag(activeRow.severity)}
              </Descriptions.Item>
              <Descriptions.Item label={t(`${NS}.columns.server`)}>
                {activeRow.server_id ?? "—"}
              </Descriptions.Item>
              <Descriptions.Item label={t(`${NS}.detail.executable`)}>
                {activeRow.executable ? t(`${NS}.detail.yes`) : t(`${NS}.detail.no`)}
              </Descriptions.Item>
              <Descriptions.Item label={t(`${NS}.detail.summary`)}>
                {activeRow.finding_summary}
              </Descriptions.Item>
              <Descriptions.Item label={t(`${NS}.detail.recommendedAction`)}>
                {activeRow.recommended_action ?? "—"}
              </Descriptions.Item>
              {activeRow.reject_reason ? (
                <Descriptions.Item label={t(`${NS}.detail.rejectReason`)}>
                  {activeRow.reject_reason}
                </Descriptions.Item>
              ) : null}
            </Descriptions>

            <div>
              <Typography.Title level={5}>{t(`${NS}.detail.solutionSummary`)}</Typography.Title>
              <Typography.Paragraph>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {JSON.stringify(activeRow.solution_summary, null, 2)}
                </pre>
              </Typography.Paragraph>
            </div>

            <div>
              <Typography.Title level={5}>{t(`${NS}.detail.timeline`)}</Typography.Title>
              <Timeline
                items={activeRow.timeline.map((entry) => ({
                  children: (
                    <div>
                      <div>{entry.label}</div>
                      <Typography.Text type="secondary">{entry.at}</Typography.Text>
                    </div>
                  ),
                }))}
              />
            </div>

            {activeRow.intervention_session ? (
              <div>
                <Typography.Title level={5}>{t(`${NS}.detail.interventionReplay`)}</Typography.Title>
                <Descriptions column={1} size="small" bordered>
                  <Descriptions.Item label={t(`${NS}.detail.interventionStatus`)}>
                    {statusTag(activeRow.intervention_session.status, t)}
                  </Descriptions.Item>
                  <Descriptions.Item label={t(`${NS}.detail.interventionMessages`)}>
                    {activeRow.intervention_session.message_count}
                  </Descriptions.Item>
                </Descriptions>
                {activeRow.intervention_session.preview.length > 0 ? (
                  <List
                    size="small"
                    style={{ marginTop: 12 }}
                    dataSource={activeRow.intervention_session.preview}
                    renderItem={(item) => (
                      <List.Item>
                        <List.Item.Meta
                          title={`${item.role} · ${item.at}`}
                          description={item.content}
                        />
                      </List.Item>
                    )}
                  />
                ) : null}
                {(activeRow.intervention_session.command_runs ?? []).length > 0 ? (
                  <div style={{ marginTop: 12 }}>
                    <Typography.Text strong>{t(`${NS}.detail.commandRuns`)}</Typography.Text>
                    <Descriptions column={1} size="small" bordered style={{ marginTop: 8 }}>
                      {(activeRow.intervention_session.command_runs ?? []).map((run) => (
                        <Descriptions.Item
                          key={run.id}
                          label={`${run.risk_tier} · ${run.status}`}
                        >
                          <div>{run.command}</div>
                          {run.stdout_summary ? (
                            <Typography.Text type="secondary">{run.stdout_summary}</Typography.Text>
                          ) : null}
                          {run.stderr_summary ? (
                            <Typography.Text type="danger">{run.stderr_summary}</Typography.Text>
                          ) : null}
                        </Descriptions.Item>
                      ))}
                    </Descriptions>
                  </div>
                ) : null}
              </div>
            ) : null}

            {activeRow.advisory_closure ? (
              <div>
                <Typography.Title level={5}>{t(`${NS}.detail.advisoryClosure`)}</Typography.Title>
                <Descriptions column={1} size="small" bordered>
                  <Descriptions.Item label={t(`${NS}.detail.advisoryActionField`)}>
                    {advisoryActionLabel(activeRow.advisory_closure.action, t)}
                  </Descriptions.Item>
                  <Descriptions.Item label={t(`${NS}.detail.advisoryAt`)}>
                    {activeRow.advisory_closure.at}
                  </Descriptions.Item>
                  <Descriptions.Item label={t(`${NS}.detail.advisoryOperator`)}>
                    {activeRow.advisory_closure.operator}
                  </Descriptions.Item>
                  {activeRow.advisory_closure.internal_ticket_id ? (
                    <Descriptions.Item label={t(`${NS}.detail.internalTicket`)}>
                      {activeRow.advisory_closure.internal_ticket_id}
                    </Descriptions.Item>
                  ) : null}
                  {activeRow.advisory_closure.note ? (
                    <Descriptions.Item label={t(`${NS}.detail.advisoryNote`)}>
                      {activeRow.advisory_closure.note}
                    </Descriptions.Item>
                  ) : null}
                </Descriptions>
              </div>
            ) : null}

            {activeRow.audit_preview.length > 0 ? (
              <div>
                <Typography.Title level={5}>{t(`${NS}.detail.auditPreview`)}</Typography.Title>
                <Descriptions column={1} size="small" bordered>
                  {activeRow.audit_preview.map((entry) => (
                    <Descriptions.Item
                      key={entry.id}
                      label={entry.created_at}
                    >{`${entry.action_type ?? "—"} · ${entry.status}`}</Descriptions.Item>
                  ))}
                </Descriptions>
              </div>
            ) : null}

            <Space wrap>
              {activeRow.links.problem_event_id ? (
                <Link to={`/problems?highlight=${activeRow.links.problem_event_id}`}>
                  {t(`${NS}.detail.openProblem`)}
                </Link>
              ) : null}
              {activeRow.links.external_risk_finding_id ? (
                <Link to="/external-risk/findings">
                  {t(`${NS}.detail.openExternalRisk`)}
                </Link>
              ) : null}
              <Link to="/security/audit-log">{t(`${NS}.detail.openAuditLog`)}</Link>
            </Space>
          </Space>
        ) : null}
      </Drawer>

      <Modal
        title={t(`${NS}.rejectModalTitle`)}
        open={rejectOpen}
        onCancel={() => setRejectOpen(false)}
        onOk={() =>
          rejectTarget &&
          rejectMutation.mutate({ id: rejectTarget.id, reason: rejectReason.trim() || undefined })
        }
        confirmLoading={rejectMutation.isPending}
        okText={t(`${NS}.actions.reject`)}
        cancelText={t("common.cancel")}
      >
        <Input.TextArea
          rows={4}
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder={t(`${NS}.rejectReasonPlaceholder`)}
        />
      </Modal>
    </>
  );
}