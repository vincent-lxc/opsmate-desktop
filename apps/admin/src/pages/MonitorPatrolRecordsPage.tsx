import { ProTable } from "@ant-design/pro-components";
import type { ProColumns } from "@ant-design/pro-components";
import { FileSearchOutlined } from "@ant-design/icons";
import { Alert, Button, Select, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { PatrolStepsModal, type PatrolStepsModalFilter } from "../components/PatrolStepsModal";
import { ModulePageShell } from "../components/ModulePageShell";
import { ModuleTableCard } from "../components/ModuleTableCard";
import {
  moduleFilterBarStyle,
  moduleNestedTableProps,
  moduleProTableProps,
  moduleSectionStackStyle,
  moduleTableDetailIndent,
  moduleTableExpandable,
  moduleTablePagination,
} from "../components/module-table-styles";
import type {
  InternalPatrolTask,
  PatrolRecord,
  PatrolRoundRecordGroup,
} from "../utils/monitoring-types";
import { roundStatusTag, verdictTag } from "../utils/patrol-display";
import { formatDateTime } from "../utils/datetime";

const EXPANDED_DETAIL_CLASS = "module-table-detail-panel";
const EXPANDED_DETAIL_STYLE = { paddingLeft: moduleTableDetailIndent } as const;

type StepsModalState = {
  open: boolean;
  roundId: string | null;
  serverId: string | null;
  serverName: string;
  filter: PatrolStepsModalFilter;
};

function groupRecordsByRound(records: PatrolRecord[]): PatrolRoundRecordGroup[] {
  const map = new Map<string, PatrolRoundRecordGroup>();
  for (const record of records) {
    const existing = map.get(record.round_id);
    if (existing) {
      existing.records.push(record);
      continue;
    }
    map.set(record.round_id, {
      round_id: record.round_id,
      task_id: record.task_id,
      task_title: record.task_title ?? "",
      server_group_name: record.server_group_name ?? "",
      round_started_at: record.round_started_at ?? record.created_at,
      round_status: record.round_status,
      round_trigger_kind: record.round_trigger_kind,
      records: [record],
    });
  }
  return [...map.values()].sort(
    (a, b) => new Date(b.round_started_at).getTime() - new Date(a.round_started_at).getTime(),
  );
}

type PatrolRoundServersExpandProps = {
  group: PatrolRoundRecordGroup;
  onOpenSteps: (record: PatrolRecord, filter: PatrolStepsModalFilter) => void;
};

function PatrolRoundServersExpand({ group, onOpenSteps }: PatrolRoundServersExpandProps) {
  const { t } = useTranslation();

  const columns: ProColumns<PatrolRecord>[] = useMemo(
    () => [
      {
        title: t("monitoring.patrolRecords.columns.server"),
        dataIndex: "server_name",
        width: 150,
        render: (_, row) => (
          <Link to={`/servers/${row.server_id}?tab=monitor`}>{row.server_name}</Link>
        ),
      },
      {
        title: t("monitoring.patrolRecords.columns.verdict"),
        dataIndex: "verdict",
        width: 100,
        render: (_, row) => verdictTag(row.verdict),
      },
      {
        title: t("monitoring.patrolRecords.columns.summary"),
        dataIndex: "summary",
        ellipsis: true,
        render: (_, row) => row.summary || row.problem_statement || "—",
      },
      {
        title: t("monitoring.patrolRecords.columns.stepTotal"),
        dataIndex: "step_total",
        width: 110,
        align: "center",
        render: (_, row) => {
          const total = row.step_total ?? 0;
          return (
            <Button
              type="link"
              size="small"
              disabled={total === 0}
              onClick={() => onOpenSteps(row, "all")}
            >
              {total}
            </Button>
          );
        },
      },
      {
        title: t("monitoring.patrolRecords.columns.stepAnomaly"),
        dataIndex: "step_anomaly_count",
        width: 110,
        align: "center",
        render: (_, row) => {
          const count = row.step_anomaly_count ?? 0;
          return (
            <Button
              type="link"
              size="small"
              danger={count > 0}
              disabled={count === 0}
              onClick={() => onOpenSteps(row, "anomaly")}
            >
              {count}
            </Button>
          );
        },
      },
      {
        title: t("common.actions"),
        valueType: "option",
        width: 120,
        render: (_, row) =>
          row.verdict === "anomaly" && row.problem_event_id ? (
            <Link to={`/problems?event_id=${row.problem_event_id}`}>
              {t("monitoring.patrolRecords.viewProblem")}
            </Link>
          ) : (
            "—"
          ),
      },
    ],
    [onOpenSteps, t],
  );

  return (
    <div className={EXPANDED_DETAIL_CLASS} style={EXPANDED_DETAIL_STYLE}>
      <ProTable<PatrolRecord>
        {...moduleNestedTableProps}
        rowKey="id"
        headerTitle={t("monitoring.patrolRecords.serverSummaryTitle")}
        dataSource={group.records}
        columns={columns}
      />
    </div>
  );
}

export function MonitorPatrolRecordsPage() {
  const { t, i18n } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const taskIdParam = searchParams.get("task_id") ?? undefined;
  const [verdictFilter, setVerdictFilter] = useState<string | undefined>();
  const [stepsModal, setStepsModal] = useState<StepsModalState>({
    open: false,
    roundId: null,
    serverId: null,
    serverName: "",
    filter: "all",
  });

  const { data: tasksData } = useQuery({
    queryKey: ["patrol-tasks"],
    queryFn: () => api<{ items: InternalPatrolTask[] }>("/api/monitoring/patrol-tasks"),
  });

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (taskIdParam) p.set("task_id", taskIdParam);
    if (verdictFilter) p.set("verdict", verdictFilter);
    p.set("limit", "100");
    return p.toString();
  }, [taskIdParam, verdictFilter]);

  const { data: recordsData, isLoading } = useQuery({
    queryKey: ["patrol-records", queryString, i18n.language],
    queryFn: () =>
      api<{ items: PatrolRecord[]; total: number }>(`/api/monitoring/patrol-records?${queryString}`),
  });

  const roundGroups = useMemo(
    () => groupRecordsByRound(recordsData?.items ?? []),
    [recordsData?.items],
  );

  const runningWithoutRecords = useMemo(() => {
    const running = (tasksData?.items ?? []).filter((x) => x.status === "running");
    if (recordsData?.items?.length) return [];
    return running.filter((x) => !x.last_round_at);
  }, [tasksData?.items, recordsData?.items?.length]);

  const openStepsModal = (record: PatrolRecord, filter: PatrolStepsModalFilter) => {
    setStepsModal({
      open: true,
      roundId: record.round_id,
      serverId: record.server_id,
      serverName: record.server_name,
      filter,
    });
  };

  const roundColumns: ProColumns<PatrolRoundRecordGroup>[] = useMemo(
    () => [
      {
        title: t("monitoring.patrolRecords.columns.time"),
        dataIndex: "round_started_at",
        width: 170,
        render: (_, row) => formatDateTime(row.round_started_at),
      },
      {
        title: t("monitoring.patrolRecords.columns.task"),
        dataIndex: "task_title",
        width: 180,
        ellipsis: true,
      },
      {
        title: t("monitoring.patrolRecords.columns.group"),
        dataIndex: "server_group_name",
        width: 120,
      },
      {
        title: t("monitoring.patrolRecords.columns.serverCount"),
        width: 100,
        align: "center",
        render: (_, row) => row.records.length,
      },
      {
        title: t("monitoring.patrolRecords.columns.anomalyServerCount"),
        width: 110,
        align: "center",
        render: (_, row) =>
          row.records.filter((r) => r.verdict === "anomaly" || r.verdict === "watch").length,
      },
      {
        title: t("monitoring.patrolRecords.columns.roundStatus"),
        dataIndex: "round_status",
        width: 110,
        render: (_, row) =>
          row.round_status ? roundStatusTag(row.round_status, t) : "—",
      },
      {
        title: t("monitoring.patrolRecords.columns.trigger"),
        dataIndex: "round_trigger_kind",
        width: 90,
        render: (_, row) =>
          row.round_trigger_kind
            ? t(`monitoring.patrolRecords.trigger.${row.round_trigger_kind}`, {
                defaultValue: row.round_trigger_kind,
              })
            : "—",
      },
    ],
    [t],
  );

  return (
    <ModulePageShell
      icon={<FileSearchOutlined style={{ fontSize: 20 }} />}
      title={t("menu.patrolRecords")}
      subtitle={t("monitoring.patrolRecords.subtitle")}
    >
      <div style={moduleSectionStackStyle}>
        {runningWithoutRecords.length > 0 && (
          <Alert
            type="info"
            showIcon
            message={t("monitoring.patrolRecords.waitingFirstRun")}
            description={
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {runningWithoutRecords.map((task) => (
                  <Link key={task.id} to="/monitoring/tasks">
                    {task.title} — {t("monitoring.patrolTasks.statusRunning")}
                  </Link>
                ))}
              </div>
            }
          />
        )}

        <ModuleTableCard>
          <div style={moduleFilterBarStyle}>
            <Typography.Text type="secondary">{t("monitoring.patrolRecords.filterLabel")}</Typography.Text>
            <Select
              allowClear
              placeholder={t("monitoring.patrolRecords.filterTask")}
              style={{ minWidth: 220 }}
              value={taskIdParam}
              options={(tasksData?.items ?? []).map((task) => ({
                label: task.title,
                value: task.id,
              }))}
              onChange={(v) => {
                const next = new URLSearchParams(searchParams);
                if (v) next.set("task_id", v);
                else next.delete("task_id");
                setSearchParams(next);
              }}
            />
            <Select
              allowClear
              placeholder={t("monitoring.patrolRecords.filterVerdict")}
              style={{ width: 140 }}
              value={verdictFilter}
              options={[
                { label: "normal", value: "normal" },
                { label: "watch", value: "watch" },
                { label: "anomaly", value: "anomaly" },
              ]}
              onChange={setVerdictFilter}
            />
          </div>

          <ProTable<PatrolRoundRecordGroup>
            {...moduleProTableProps}
            rowKey="round_id"
            bordered
            tableLayout="fixed"
            loading={isLoading}
            columns={roundColumns}
            dataSource={roundGroups}
            pagination={{
              ...moduleTablePagination,
              total: roundGroups.length,
            }}
            search={false}
            expandable={{
              ...moduleTableExpandable,
              expandedRowRender: (group) => (
                <PatrolRoundServersExpand group={group} onOpenSteps={openStepsModal} />
              ),
            }}
          />
        </ModuleTableCard>
      </div>

      <PatrolStepsModal
        open={stepsModal.open}
        roundId={stepsModal.roundId}
        serverId={stepsModal.serverId}
        serverName={stepsModal.serverName}
        filter={stepsModal.filter}
        onClose={() =>
          setStepsModal({
            open: false,
            roundId: null,
            serverId: null,
            serverName: "",
            filter: "all",
          })
        }
      />
    </ModulePageShell>
  );
}