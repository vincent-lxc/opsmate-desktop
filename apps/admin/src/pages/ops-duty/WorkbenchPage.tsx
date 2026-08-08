import { PageContainer } from "@ant-design/pro-components";
import {
  AlertOutlined,
  CheckCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Input,
  List,
  Modal,
  Progress,
  Row,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { formatDateTime } from "../../utils/datetime";
import { useStateLabel } from "../../locales/labels";

type WorkbenchProblem = {
  id: string;
  group_key: string;
  server_id: string;
  server_name: string | null;
  problem_state: string;
  severity: string | null;
  problem_statement: string | null;
  timestamp: string;
  latest_occurrence_at: string | null;
  needs_intervention: boolean;
  source: "patrol" | "business";
};

type DutyTaskItem = {
  title: string;
  description?: string | null;
  source_ref?: {
    kind: "problem" | "event" | "patrol_record";
    id: string;
    label?: string | null;
  } | null;
};

type WorkbenchSnapshot = {
  shift: {
    assignee: string;
    backup_assignee: string | null;
  } | null;
  problems: {
    patrol: { count: number; items: WorkbenchProblem[] };
    business: { count: number; items: WorkbenchProblem[] };
  };
  patrol_summary: {
    total: number;
    normal_count: number;
    watch_count: number;
    anomaly_count: number;
    latest_at: string | null;
  };
  remediation_queue: {
    count: number;
    items: Array<{
      id: string;
      problem_event_id: string;
      failure_reason: string;
      exit_status: string;
    }>;
  };
  l2_in_progress: {
    count: number;
    items: Array<{
      id: string;
      status: string;
      event_id: string | null;
      title: string | null;
      created_at: string;
    }>;
  };
  today_tasks: {
    total: number;
    completed: number;
    completion_rate: number;
    from: string;
    to: string;
    items: Array<{
      id: string;
      title: string;
      status: string;
      due_at: string | null;
      assignee: string | null;
    }>;
  };
};

type DutyTaskDraft = {
  title: string;
  cadence: string;
  due_at: string;
  status: string;
  ai_draft: boolean;
  source_problem_id: string;
  items: DutyTaskItem[];
};

function PanelCard({
  title,
  extra,
  loading,
  error,
  onRetry,
  empty,
  children,
}: {
  title: string;
  extra?: React.ReactNode;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  empty?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <Card
      variant="borderless"
      title={title}
      extra={extra}
      style={{ marginBottom: 24, height: "100%" }}
    >
      {loading ? (
        <div style={{ textAlign: "center", padding: 24 }}>
          <Spin />
        </div>
      ) : error ? (
        <Empty description={t("opsDuty.workbench.loadError")}>
          <Button onClick={onRetry}>{t("opsDuty.workbench.retry")}</Button>
        </Empty>
      ) : empty ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        children
      )}
    </Card>
  );
}

export function WorkbenchPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const stateLabel = useStateLabel();
  const queryClient = useQueryClient();
  const [problemTab, setProblemTab] = useState<"patrol" | "business">("patrol");
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState<DutyTaskDraft | null>(null);
  const [draftItems, setDraftItems] = useState<DutyTaskItem[]>([]);
  const [draftTitle, setDraftTitle] = useState("");

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["ops-duty-workbench"],
    queryFn: () => api<WorkbenchSnapshot>("/api/ops-duty/workbench?top_n=5"),
    refetchInterval: 60_000,
  });

  const generateDraft = useMutation({
    mutationFn: (problemEventId: string) =>
      api<{ draft: DutyTaskDraft }>("/api/ops-duty/tasks/generate-draft-from-problem", {
        method: "POST",
        body: JSON.stringify({ problem_event_id: problemEventId }),
      }),
    onSuccess: (result) => {
      setDraft(result.draft);
      setDraftTitle(result.draft.title);
      setDraftItems(result.draft.items);
      setDraftOpen(true);
    },
    onError: () => message.error(t("common.error")),
  });

  const publishDraft = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error("missing draft");
      return api("/api/ops-duty/tasks/publish-draft", {
        method: "POST",
        body: JSON.stringify({
          title: draftTitle,
          cadence: draft.cadence,
          due_at: draft.due_at,
          items_json: draftItems,
          source_problem_id: draft.source_problem_id,
          ai_draft: draft.ai_draft,
        }),
      });
    },
    onSuccess: () => {
      message.success(t("opsDuty.workbench.draftPublished"));
      setDraftOpen(false);
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["ops-duty-workbench"] });
    },
    onError: () => message.error(t("common.error")),
  });

  const activeProblems = useMemo(() => {
    if (!data) return { count: 0, items: [] as WorkbenchProblem[] };
    return problemTab === "patrol" ? data.problems.patrol : data.problems.business;
  }, [data, problemTab]);

  const viewAllProblemsHref =
    problemTab === "patrol"
      ? "/problems?source=patrol&sort=severity"
      : "/problems?source=business&sort=severity";

  const todayTasksHref = data
    ? `/ops-duty/checklists?due_from=${encodeURIComponent(data.today_tasks.from)}&due_to=${encodeURIComponent(data.today_tasks.to)}`
    : "/ops-duty/checklists";

  return (
    <PageContainer
      title={t("opsDuty.workbench.title")}
      subTitle={t("opsDuty.workbench.subtitle")}
      extra={
        <Button icon={<ReloadOutlined />} loading={isFetching} onClick={() => void refetch()}>
          {t("opsDuty.workbench.refresh")}
        </Button>
      }
    >
      {data?.shift ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("opsDuty.workbench.onCallNow", {
            assignee: data.shift.assignee,
            backup: data.shift.backup_assignee ?? t("opsDuty.workbench.noBackup"),
          })}
        />
      ) : null}

      <Row gutter={24}>
        <Col xl={12} lg={24} md={24} sm={24} xs={24}>
          <PanelCard
            title={t("opsDuty.workbench.activeProblems")}
            extra={
              <Link to={viewAllProblemsHref}>{t("opsDuty.workbench.viewAll")}</Link>
            }
            loading={isLoading}
            error={isError}
            onRetry={() => void refetch()}
          >
            <Tabs
              activeKey={problemTab}
              onChange={(key) => setProblemTab(key as "patrol" | "business")}
              items={[
                {
                  key: "patrol",
                  label: (
                    <Badge count={data?.problems.patrol.count ?? 0} size="small" offset={[8, 0]}>
                      {t("opsDuty.workbench.tabs.patrol")}
                    </Badge>
                  ),
                },
                {
                  key: "business",
                  label: (
                    <Badge count={data?.problems.business.count ?? 0} size="small" offset={[8, 0]}>
                      {t("opsDuty.workbench.tabs.business")}
                    </Badge>
                  ),
                },
              ]}
            />
            <List
              dataSource={activeProblems.items}
              locale={{ emptyText: t("opsDuty.workbench.noActiveProblems") }}
              renderItem={(item) => {
                const meta = stateLabel(item.problem_state);
                return (
                  <List.Item
                    actions={[
                      <Button
                        key="draft"
                        type="link"
                        size="small"
                        icon={<ThunderboltOutlined />}
                        loading={generateDraft.isPending}
                        onClick={() => generateDraft.mutate(item.id)}
                      >
                        {t("opsDuty.workbench.generateDraft")}
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Link to={`/problems?event_id=${item.id}`}>
                          {item.problem_statement ||
                            item.server_name ||
                            t("opsDuty.workbench.unnamedProblem")}
                        </Link>
                      }
                      description={
                        <Space size={8} wrap>
                          <Tag>{item.server_name ?? item.server_id}</Tag>
                          <span style={{ color: meta.color }}>{meta.text}</span>
                          {item.severity ? <Tag color="red">{item.severity}</Tag> : null}
                          {item.needs_intervention ? (
                            <Tag color="orange">{t("opsDuty.workbench.needsIntervention")}</Tag>
                          ) : null}
                        </Space>
                      }
                    />
                  </List.Item>
                );
              }}
            />
          </PanelCard>
        </Col>

        <Col xl={12} lg={24} md={24} sm={24} xs={24}>
          <PanelCard
            title={t("opsDuty.workbench.patrolSummary")}
            extra={
              <Link to="/monitoring/patrol-records">{t("opsDuty.workbench.viewAll")}</Link>
            }
            loading={isLoading}
            error={isError}
            onRetry={() => void refetch()}
            empty={!isLoading && !isError && (data?.patrol_summary.total ?? 0) === 0}
          >
            <Space direction="vertical" style={{ width: "100%" }} size={12}>
              <Typography.Text type="secondary">
                {t("opsDuty.workbench.patrolLatest", {
                  time: formatDateTime(data?.patrol_summary.latest_at ?? null),
                })}
              </Typography.Text>
              <div>
                <Typography.Text>
                  {t("opsDuty.workbench.patrolMix", {
                    normal: data?.patrol_summary.normal_count ?? 0,
                    watch: data?.patrol_summary.watch_count ?? 0,
                    anomaly: data?.patrol_summary.anomaly_count ?? 0,
                  })}
                </Typography.Text>
              </div>
            </Space>
          </PanelCard>
        </Col>
      </Row>

      <Row gutter={24}>
        <Col xl={8} lg={24} md={24} sm={24} xs={24}>
          <PanelCard
            title={t("opsDuty.workbench.remediationQueue")}
            extra={
              <Link to="/oncall/remediation-queue">{t("opsDuty.workbench.viewAll")}</Link>
            }
            loading={isLoading}
            error={isError}
            onRetry={() => void refetch()}
            empty={!isLoading && !isError && (data?.remediation_queue.items.length ?? 0) === 0}
          >
            <List
              size="small"
              dataSource={data?.remediation_queue.items ?? []}
              locale={{ emptyText: t("opsDuty.workbench.noQueueItems") }}
              renderItem={(item) => (
                <List.Item>
                  <Typography.Text ellipsis>
                    {item.failure_reason || item.problem_event_id}
                  </Typography.Text>
                  <Tag>{item.exit_status}</Tag>
                </List.Item>
              )}
            />
          </PanelCard>
        </Col>

        <Col xl={8} lg={24} md={24} sm={24} xs={24}>
          <PanelCard
            title={t("opsDuty.workbench.l2InProgress")}
            extra={<Link to="/security/l2-approvals">{t("opsDuty.workbench.viewAll")}</Link>}
            loading={isLoading}
            error={isError}
            onRetry={() => void refetch()}
            empty={!isLoading && !isError && (data?.l2_in_progress.items.length ?? 0) === 0}
          >
            <List
              size="small"
              dataSource={data?.l2_in_progress.items ?? []}
              locale={{ emptyText: t("opsDuty.workbench.noL2") }}
              renderItem={(item) => (
                <List.Item>
                  <Typography.Text ellipsis>
                    {item.title ?? item.event_id ?? item.id}
                  </Typography.Text>
                  <Tag color="processing">{item.status}</Tag>
                </List.Item>
              )}
            />
          </PanelCard>
        </Col>

        <Col xl={8} lg={24} md={24} sm={24} xs={24}>
          <PanelCard
            title={t("opsDuty.workbench.todayTasks")}
            extra={<Link to={todayTasksHref}>{t("opsDuty.workbench.viewAll")}</Link>}
            loading={isLoading}
            error={isError}
            onRetry={() => void refetch()}
            empty={!isLoading && !isError && (data?.today_tasks.total ?? 0) === 0}
          >
            <Space direction="vertical" style={{ width: "100%" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Progress
                  type="circle"
                  percent={data?.today_tasks.completion_rate ?? 0}
                  size={64}
                  format={(pct) => `${pct}%`}
                />
                <div>
                  <Typography.Text>
                    {t("opsDuty.workbench.taskCompletion", {
                      completed: data?.today_tasks.completed ?? 0,
                      total: data?.today_tasks.total ?? 0,
                    })}
                  </Typography.Text>
                  <div>
                    <Link to={todayTasksHref}>
                      <CheckCircleOutlined /> {t("opsDuty.workbench.openTodayTasks")}
                    </Link>
                  </div>
                </div>
              </div>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={data?.today_tasks.items ?? []}
                columns={[
                  { title: t("opsDuty.tasks.columns.title"), dataIndex: "title", ellipsis: true },
                  {
                    title: t("opsDuty.tasks.columns.status"),
                    dataIndex: "status",
                    width: 110,
                    render: (status: string) => <Tag>{status}</Tag>,
                  },
                ]}
              />
            </Space>
          </PanelCard>
        </Col>
      </Row>

      <Modal
        title={
          <Space>
            {t("opsDuty.workbench.draftTitle")}
            <Tag color="purple" icon={<ThunderboltOutlined />}>
              {t("opsDuty.workbench.aiDraftBadge")}
            </Tag>
          </Space>
        }
        open={draftOpen}
        onCancel={() => setDraftOpen(false)}
        width={720}
        footer={[
          <Button key="cancel" onClick={() => setDraftOpen(false)}>
            {t("common.cancel")}
          </Button>,
          <Button
            key="publish"
            type="primary"
            loading={publishDraft.isPending}
            onClick={() => publishDraft.mutate()}
          >
            {t("opsDuty.workbench.publishDraft")}
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: "100%" }} size={16}>
          <div>
            <Typography.Text type="secondary">{t("opsDuty.tasks.columns.title")}</Typography.Text>
            <Input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} />
          </div>
          {draftItems.map((item, index) => (
            <Card key={index} size="small" type="inner">
              <Input
                value={item.title}
                onChange={(e) => {
                  const next = [...draftItems];
                  next[index] = { ...next[index], title: e.target.value };
                  setDraftItems(next);
                }}
                style={{ marginBottom: 8 }}
              />
              <Input.TextArea
                rows={2}
                value={item.description ?? ""}
                onChange={(e) => {
                  const next = [...draftItems];
                  next[index] = { ...next[index], description: e.target.value };
                  setDraftItems(next);
                }}
              />
              {item.source_ref ? (
                <Typography.Text type="secondary" style={{ display: "block", marginTop: 8 }}>
                  <AlertOutlined /> {t("opsDuty.workbench.sourceRef")}:{" "}
                  <Link to={`/problems?event_id=${item.source_ref.id}`}>
                    {item.source_ref.label ?? item.source_ref.id}
                  </Link>
                </Typography.Text>
              ) : null}
            </Card>
          ))}
        </Space>
      </Modal>
    </PageContainer>
  );
}

export default WorkbenchPage;