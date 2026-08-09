import { ProForm, ProFormDateTimePicker, ProFormSelect, ProFormTextArea } from "@ant-design/pro-components";
import { App, Button, Descriptions, List, Space, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  externalRiskApi,
  type ExternalRiskFinding,
} from "../../api/external-risk";
import { toIsoDateTime } from "../../api/client";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import {
  confidenceTag,
  findingStatusTag,
  riskFlagTags,
  severityTag,
} from "../../utils/external-risk-display";
import { formatDateTime } from "../../utils/datetime";

type ExternalRiskFindingDrawerProps = {
  finding: ExternalRiskFinding | null;
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
};

const ACK_DEFAULT = "admin";

type TicketEvidence = {
  provider?: string;
  ticket_id?: string | null;
  ticket_url?: string | null;
};

function readLinkedTicket(finding: ExternalRiskFinding): TicketEvidence | null {
  const closure = finding.ai_evidence_json?.closure;
  if (!closure || typeof closure !== "object") return null;
  const ticket = (closure as { ticket?: TicketEvidence }).ticket;
  return ticket?.ticket_id ? ticket : null;
}

export function ExternalRiskFindingDrawer({
  finding,
  open,
  onClose,
  onUpdated,
}: ExternalRiskFindingDrawerProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [ignoreOpen, setIgnoreOpen] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const findingId = finding?.id;

  const { data: liveFinding } = useQuery({
    queryKey: ["external-risk-finding", findingId],
    queryFn: () => externalRiskApi.getFinding(findingId!),
    enabled: open && Boolean(findingId),
    initialData: finding ?? undefined,
  });

  const displayFinding = liveFinding ?? finding;

  const { data: eventsData } = useQuery({
    queryKey: ["external-risk-finding-events", findingId],
    queryFn: () => externalRiskApi.listFindingEvents(findingId!),
    enabled: open && Boolean(findingId),
  });

  const { data: ticketProvidersData } = useQuery({
    queryKey: ["workflow-ticket-providers"],
    queryFn: () => externalRiskApi.listTicketProviders(),
    enabled: open && ticketOpen,
  });

  const refresh = (updated?: ExternalRiskFinding) => {
    if (findingId) {
      if (updated) {
        queryClient.setQueryData(["external-risk-finding", findingId], updated);
      } else {
        void queryClient.invalidateQueries({ queryKey: ["external-risk-finding", findingId] });
      }
      void queryClient.invalidateQueries({ queryKey: ["external-risk-finding-events", findingId] });
    }
    onUpdated();
  };

  const mutateOpts = {
    onSuccess: (row: ExternalRiskFinding) => {
      message.success(t("externalRisk.findings.actionDone"));
      refresh(row);
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  };

  const acknowledgeMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.acknowledgeFinding(id, ACK_DEFAULT),
    ...mutateOpts,
  });

  const ignoreMutation = useMutation({
    mutationFn: ({ id, reason, until }: { id: string; reason: string; until: string }) =>
      externalRiskApi.ignoreFinding(id, reason, until),
    onSuccess: (row) => {
      message.success(t("externalRisk.findings.actionDone"));
      setIgnoreOpen(false);
      refresh(row);
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const falsePositiveMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.falsePositiveFinding(id),
    ...mutateOpts,
  });

  const createProblemMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.createProblem(id),
    onSuccess: (data) => {
      message.success(t("externalRisk.findings.actionDone"));
      refresh(data.finding);
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const createTaskMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.createRecommendedTask(id),
    onSuccess: (data) => {
      message.success(t("externalRisk.findings.actionDone"));
      refresh(data.finding);
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const createTicketMutation = useMutation({
    mutationFn: ({ id, providerId }: { id: string; providerId: string }) =>
      externalRiskApi.createTicket(id, providerId),
    onSuccess: (data) => {
      message.success(t("externalRisk.findings.ticket.created"));
      setTicketOpen(false);
      refresh(data.finding);
    },
    onError: (err: Error) => message.error(err.message || t("common.error")),
  });

  const inProgressMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.inProgressFinding(id),
    ...mutateOpts,
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) => externalRiskApi.resolveFinding(id),
    ...mutateOpts,
  });

  if (!displayFinding) return null;

  const verificationSteps = Array.isArray(displayFinding.verification_steps_json)
    ? (displayFinding.verification_steps_json as string[])
    : [];

  const linkedTicket = readLinkedTicket(displayFinding);
  const ticketProviderOptions = (ticketProvidersData?.items ?? [])
    .filter((item) => item.enabled && (item.type === "jira" || item.type === "linear"))
    .map((item) => ({ label: `${item.name} (${item.type})`, value: item.id }));

  const canAct = !["resolved", "ignored", "false_positive", "superseded"].includes(displayFinding.status);

  return (
    <>
      <ModuleFormDrawer
        title={displayFinding.title}
        open={open}
        onClose={onClose}
        width={640}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space wrap>
            {severityTag(displayFinding.severity)}
            {confidenceTag(displayFinding.confidence, t)}
            {findingStatusTag(displayFinding.status, t)}
            {riskFlagTags(displayFinding, t)}
          </Space>

          {canAct && (
            <Space wrap>
              <Button
                size="small"
                loading={acknowledgeMutation.isPending}
                onClick={() => acknowledgeMutation.mutate(displayFinding.id)}
              >
                {t("externalRisk.findings.actions.acknowledge")}
              </Button>
              <Button size="small" onClick={() => setIgnoreOpen(true)}>
                {t("externalRisk.findings.actions.ignore")}
              </Button>
              <Button
                size="small"
                loading={falsePositiveMutation.isPending}
                onClick={() => falsePositiveMutation.mutate(displayFinding.id)}
              >
                {t("externalRisk.findings.actions.falsePositive")}
              </Button>
              <Button
                size="small"
                loading={inProgressMutation.isPending}
                onClick={() => inProgressMutation.mutate(displayFinding.id)}
              >
                {t("externalRisk.findings.actions.inProgress")}
              </Button>
              <Button
                size="small"
                type="primary"
                loading={createProblemMutation.isPending}
                disabled={Boolean(displayFinding.problem_id)}
                onClick={() => createProblemMutation.mutate(displayFinding.id)}
              >
                {t("externalRisk.findings.actions.createProblem")}
              </Button>
              <Button
                size="small"
                loading={createTaskMutation.isPending}
                disabled={Boolean(displayFinding.recommended_task_id)}
                onClick={() => createTaskMutation.mutate(displayFinding.id)}
              >
                {t("externalRisk.findings.actions.createRecommendedTask")}
              </Button>
              <Button
                size="small"
                loading={createTicketMutation.isPending}
                disabled={Boolean(linkedTicket?.ticket_id)}
                onClick={() => setTicketOpen(true)}
              >
                {t("externalRisk.findings.actions.createTicket")}
              </Button>
              <Button
                size="small"
                loading={resolveMutation.isPending}
                onClick={() => resolveMutation.mutate(displayFinding.id)}
              >
                {t("externalRisk.findings.actions.resolve")}
              </Button>
            </Space>
          )}

          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label={t("externalRisk.findings.detail.target")}>
              {displayFinding.component_name}
              {displayFinding.current_version ? ` @ ${displayFinding.current_version}` : ""}
            </Descriptions.Item>
            <Descriptions.Item label={t("externalRisk.findings.detail.type")}>
              {displayFinding.finding_type}
            </Descriptions.Item>
            <Descriptions.Item label={t("externalRisk.findings.detail.detectedAt")}>
              {formatDateTime(displayFinding.created_at)}
            </Descriptions.Item>
            <Descriptions.Item label={t("externalRisk.findings.detail.source")}>
              <Typography.Link href={displayFinding.source_url} target="_blank" rel="noreferrer">
                {displayFinding.source_kind}
              </Typography.Link>
            </Descriptions.Item>
            {displayFinding.cve_id && (
              <Descriptions.Item label="CVE">{displayFinding.cve_id}</Descriptions.Item>
            )}
            {displayFinding.advisory_id && (
              <Descriptions.Item label={t("externalRisk.findings.detail.advisory")}>
                {displayFinding.advisory_id}
              </Descriptions.Item>
            )}
            <Descriptions.Item label={t("externalRisk.findings.columns.aiSummary")}>
              {displayFinding.ai_summary || "—"}
            </Descriptions.Item>
            <Descriptions.Item label={t("externalRisk.findings.columns.nextAction")}>
              {displayFinding.recommended_action || "—"}
            </Descriptions.Item>
            {displayFinding.upgrade_target_version && (
              <Descriptions.Item label={t("externalRisk.findings.detail.upgradeVersion")}>
                {displayFinding.upgrade_target_version}
              </Descriptions.Item>
            )}
            {verificationSteps.length > 0 && (
              <Descriptions.Item label={t("externalRisk.findings.detail.verification")}>
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  {verificationSteps.map((step, i) => (
                    <li key={i}>{String(step)}</li>
                  ))}
                </ol>
              </Descriptions.Item>
            )}
            {displayFinding.rollback_plan && (
              <Descriptions.Item label={t("externalRisk.findings.detail.rollback")}>
                {displayFinding.rollback_plan}
              </Descriptions.Item>
            )}
            {displayFinding.risk_tier && (
              <Descriptions.Item label={t("externalRisk.findings.detail.riskTier")}>
                {displayFinding.risk_tier}
              </Descriptions.Item>
            )}
            {displayFinding.problem_id && (
              <Descriptions.Item label={t("externalRisk.findings.detail.problem")}>
                <Link to={`/problems?id=${displayFinding.problem_id}`}>{displayFinding.problem_id}</Link>
              </Descriptions.Item>
            )}
            {displayFinding.recommended_task_id && (
              <Descriptions.Item label={t("externalRisk.findings.detail.recommendedTask")}>
                {displayFinding.recommended_task_id}
              </Descriptions.Item>
            )}
            {linkedTicket?.ticket_id && (
              <Descriptions.Item label={t("externalRisk.findings.detail.ticket")}>
                {linkedTicket.ticket_url ? (
                  <Typography.Link href={linkedTicket.ticket_url} target="_blank" rel="noreferrer">
                    {linkedTicket.ticket_id}
                  </Typography.Link>
                ) : (
                  linkedTicket.ticket_id
                )}
              </Descriptions.Item>
            )}
            {displayFinding.ignored_reason && (
              <Descriptions.Item label={t("externalRisk.findings.detail.ignoreReason")}>
                {displayFinding.ignored_reason}
              </Descriptions.Item>
            )}
          </Descriptions>

          {(eventsData?.items.length ?? 0) > 0 && (
            <>
              <Typography.Text strong>{t("externalRisk.findings.detail.relatedEvents")}</Typography.Text>
              <List
                size="small"
                bordered
                dataSource={eventsData?.items ?? []}
                renderItem={(event) => (
                  <List.Item>
                    <Space direction="vertical" size={0}>
                      <Link to={`/timeline?event_id=${event.id}`}>
                        {event.event_type}
                      </Link>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {formatDateTime(event.timestamp)}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </>
          )}
        </Space>
      </ModuleFormDrawer>

      <ModuleFormDrawer
        title={t("externalRisk.findings.ignoreTitle")}
        open={ignoreOpen}
        onClose={() => setIgnoreOpen(false)}
        width={480}
      >
        <ProForm
          onFinish={async (values) => {
            const until = toIsoDateTime(values.ignore_until);
            if (!until) {
              message.error(t("externalRisk.findings.ignoreUntilRequired"));
              return false;
            }
            await ignoreMutation.mutateAsync({
              id: displayFinding.id,
              reason: String(values.ignored_reason),
              until,
            });
            return true;
          }}
          submitter={{ searchConfig: { submitText: t("common.save") } }}
        >
          <ProFormTextArea
            name="ignored_reason"
            label={t("externalRisk.findings.ignoreReason")}
            rules={[{ required: true }]}
          />
          <ProFormDateTimePicker
            name="ignore_until"
            label={t("externalRisk.findings.ignoreUntil")}
            rules={[{ required: true }]}
          />
        </ProForm>
      </ModuleFormDrawer>

      <ModuleFormDrawer
        title={t("externalRisk.findings.ticket.title")}
        open={ticketOpen}
        onClose={() => setTicketOpen(false)}
        width={480}
      >
        <ProForm
          onFinish={async (values) => {
            await createTicketMutation.mutateAsync({
              id: displayFinding.id,
              providerId: String(values.provider_id),
            });
            return true;
          }}
          submitter={{
            searchConfig: { submitText: t("externalRisk.findings.actions.createTicket") },
            submitButtonProps: { loading: createTicketMutation.isPending },
          }}
        >
          <ProFormSelect
            name="provider_id"
            label={t("externalRisk.findings.ticket.provider")}
            options={ticketProviderOptions}
            rules={[{ required: true }]}
            fieldProps={{
              notFoundContent: t("externalRisk.findings.ticket.noProviders"),
            }}
          />
        </ProForm>
      </ModuleFormDrawer>
    </>
  );
}