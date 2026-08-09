import { ProTable } from "@ant-design/pro-components";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { ClockCircleOutlined } from "@ant-design/icons";
import { Alert, Badge, Button, Tabs, Tag, Typography } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, proTableRequest } from "../api/client";
import { ModulePageShell } from "../components/ModulePageShell";
import { ModuleTableCard } from "../components/ModuleTableCard";
import {
  moduleTablePagination,
  moduleTableSearch,
  moduleTableStyle,
} from "../components/module-table-styles";
import { useEventTypeLabel, useSeverityLabel } from "../locales/labels";
import { formatDateTime } from "../utils/datetime";

type EventPreset = "all" | "anomalies" | "human";

interface HealthEvent {
  id: string;
  server_id: string;
  server_name: string | null;
  server_ip: string | null;
  event_type: string;
  timestamp: string;
  payload: Record<string, unknown>;
  human_involved: boolean;
  root_cause_signature: string | null;
  metric_key: string | null;
  error_pattern: string | null;
  occurrence_count: number;
  last_occurrence_at: string;
  resolution: Record<string, unknown> | null;
}

const TABLE_SCROLL_X = 140 + 180 + 180 + 130 + 200 + 130 + 80;

function isEventPreset(value: string | null): value is EventPreset {
  return value === "all" || value === "anomalies" || value === "human";
}

function EventReportLink({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const [reportId, setReportId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<{ id: string }>(`/api/incident-reports/by-event/${eventId}`)
      .then((row) => {
        if (!cancelled) setReportId(row.id);
      })
      .catch(() => {
        if (!cancelled) setReportId(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (loading) return null;
  if (!reportId) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <Link to={`/incident-reports/${reportId}`}>
        <Button type="link" size="small" style={{ padding: 0 }}>
          {t("eventCenter.viewIncidentReport")}
        </Button>
      </Link>
    </div>
  );
}

function EventDetailPanel({ record }: { record: HealthEvent }) {
  const { t } = useTranslation();
  const payload = record.payload ?? {};

  if (record.event_type === "human_intervention") {
    const summary = String(payload.playbook_summary ?? "").trim();
    const steps = Array.isArray(payload.playbook_steps)
      ? (payload.playbook_steps as string[])
      : [];
    const dialogue = Array.isArray(payload.dialogue) ? payload.dialogue : [];

    return (
      <div style={{ padding: "4px 0" }}>
        <EventReportLink eventId={record.id} />
        {summary ? (
          <Typography.Paragraph style={{ marginBottom: 12 }}>{summary}</Typography.Paragraph>
        ) : null}
        {steps.length > 0 ? (
          <>
            <Typography.Text strong>{t("eventCenter.detail.steps")}</Typography.Text>
            <ul style={{ margin: "8px 0 12px", paddingLeft: 20 }}>
              {steps.map((step) => (
                <li key={step}>
                  <Typography.Text code>{step}</Typography.Text>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {dialogue.length > 0 ? (
          <>
            <Typography.Text strong>{t("eventCenter.detail.dialogue")}</Typography.Text>
            <pre
              style={{
                maxHeight: 240,
                overflow: "auto",
                padding: 12,
                marginTop: 8,
                background: "rgba(0,0,0,0.02)",
                borderRadius: 6,
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {dialogue
                .map((item) => {
                  const row = item as { role?: string; content?: string };
                  return `${row.role ?? "?"}: ${row.content ?? ""}`;
                })
                .join("\n")}
            </pre>
          </>
        ) : (
          <pre
            style={{
              maxHeight: 300,
              overflow: "auto",
              padding: 12,
              background: "rgba(0,0,0,0.02)",
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            {JSON.stringify(payload, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div>
      <EventReportLink eventId={record.id} />
      <pre
        style={{
          maxHeight: 300,
          overflow: "auto",
          padding: 12,
          background: "rgba(0,0,0,0.02)",
          borderRadius: 6,
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  );
}

export default function TimelineBrowser() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const actionRef = useRef<ActionType>(null);
  const eventTypeLabel = useEventTypeLabel();
  const severityLabel = useSeverityLabel();

  const presetParam = searchParams.get("preset");
  const eventIdParam = searchParams.get("event_id");
  const preset: EventPreset = isEventPreset(presetParam) ? presetParam : "anomalies";
  const [tableKey, setTableKey] = useState(0);
  const [highlightEvent, setHighlightEvent] = useState<HealthEvent | null>(null);

  useEffect(() => {
    if (!eventIdParam) {
      setHighlightEvent(null);
      return;
    }
    let cancelled = false;
    api<HealthEvent>(`/api/events/${eventIdParam}`)
      .then((row) => {
        if (!cancelled) setHighlightEvent(row);
      })
      .catch(() => {
        if (!cancelled) setHighlightEvent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [eventIdParam]);

  const switchPreset = useCallback(
    (next: EventPreset) => {
      const params = new URLSearchParams(searchParams);
      if (next === "all") {
        params.delete("preset");
      } else {
        params.set("preset", next);
      }
      navigate({ pathname: "/timeline", search: params.toString() }, { replace: true });
      setTableKey((k) => k + 1);
    },
    [navigate, searchParams],
  );

  const columns: ProColumns<HealthEvent>[] = useMemo(() => {
    const eventTypeEnum = Object.fromEntries(
      [
        "anomaly_detected",
        "anomaly_updated",
        "human_intervention",
        "ai_action",
        "resolution",
        "state_transition",
      ].map((key) => [key, { text: eventTypeLabel(key).text }]),
    );

    const severityEnum = Object.fromEntries(
      ["P1", "P2", "P3"].map((key) => {
        const meta = severityLabel(key);
        return [
          key,
          {
            text: meta.text,
            status:
              meta.status === "error"
                ? "Error"
                : meta.status === "warning"
                  ? "Warning"
                  : "Processing",
          },
        ];
      }),
    );

    const base: ProColumns<HealthEvent>[] = [
      {
        title: t("eventCenter.columns.eventType"),
        dataIndex: "event_type",
        width: 140,
        valueType: "select",
        valueEnum: eventTypeEnum,
        search: preset === "all",
        render: (_, record) => {
          const meta = eventTypeLabel(record.event_type);
          return <Tag color={meta.color}>{meta.text}</Tag>;
        },
      },
      {
        title: t("eventCenter.columns.server"),
        dataIndex: "server_name",
        width: 180,
        ellipsis: true,
        render: (_, row) => (
          <div>
            <Typography.Text ellipsis>{row.server_name ?? row.server_id}</Typography.Text>
            {row.server_ip ? (
              <Typography.Text
                type="secondary"
                ellipsis
                style={{ display: "block", fontSize: 12 }}
              >
                {row.server_ip}
              </Typography.Text>
            ) : null}
          </div>
        ),
      },
      {
        title: t("eventCenter.columns.timestamp"),
        dataIndex: "timestamp",
        width: 180,
        valueType: "dateTime",
        sorter: true,
        defaultSortOrder: "descend",
        sortDirections: ["descend", "ascend"],
        search: false,
      },
      {
        title: t("eventCenter.columns.severity"),
        dataIndex: ["payload", "severity"],
        width: 130,
        valueType: "select",
        valueEnum: severityEnum,
        search: preset !== "all",
        render: (_, record) => {
          const severity = record.payload?.severity as string | undefined;
          if (!severity) return <Typography.Text type="secondary">—</Typography.Text>;
          const meta = severityLabel(severity);
          return <Badge status={meta.status} text={meta.text} />;
        },
      },
    ];

    if (preset === "all") {
      base.push({
        title: t("eventCenter.columns.humanInvolved"),
        dataIndex: "human_involved",
        width: 130,
        valueType: "select",
        valueEnum: {
          true: { text: t("common.yes"), status: "Warning" },
          false: { text: t("common.no"), status: "Default" },
        },
        render: (_, record) => (
          <Badge
            status={record.human_involved ? "warning" : "default"}
            text={record.human_involved ? t("common.yes") : t("common.no")}
          />
        ),
      });
    }

    if (preset === "human") {
      base.push(
        {
          title: t("eventCenter.columns.signature"),
          dataIndex: "root_cause_signature",
          width: 200,
          ellipsis: true,
          render: (text) =>
            text ? (
              <Typography.Text code ellipsis style={{ maxWidth: 180 }}>
                {text as string}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary">—</Typography.Text>
            ),
        },
        {
          title: t("eventCenter.columns.keyword"),
          dataIndex: "keyword",
          hideInTable: true,
        },
      );
    }

    base.push({
      title: t("eventCenter.columns.count"),
      dataIndex: "occurrence_count",
      width: 80,
      search: false,
      sorter: true,
    });

    return base;
  }, [preset, t, eventTypeLabel, severityLabel]);

  const requestEvents = useCallback(
    async (
      params: Record<string, unknown>,
      sort: Record<string, string | null>,
      filter: Record<string, (string | number)[] | null>,
    ) => {
      const endpoint = preset === "human" ? "/api/knowledge-base" : "/api/events";
      const queryParams =
        preset === "anomalies" ? { ...params, category: "anomalies" } : params;
      const hasSort = Object.values(sort).some((dir) => dir != null);
      const effectiveSort = hasSort ? sort : { timestamp: "descend" };
      return proTableRequest<HealthEvent>(endpoint, queryParams, effectiveSort, filter);
    },
    [preset],
  );

  return (
    <ModulePageShell
      icon={<ClockCircleOutlined style={{ fontSize: 20 }} />}
      title={t("eventCenter.title")}
      subtitle={t("eventCenter.subtitle")}
    >
      {highlightEvent ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={t("eventCenter.highlightEvent", {
            type: eventTypeLabel(highlightEvent.event_type).text,
            time: formatDateTime(highlightEvent.timestamp),
          })}
          description={<EventDetailPanel record={highlightEvent} />}
        />
      ) : null}
      <ModuleTableCard>
        <Tabs
          activeKey={preset}
          onChange={(key) => switchPreset(key as EventPreset)}
          style={{ padding: "0 16px", marginBottom: 0 }}
          items={[
            { key: "all", label: t("eventCenter.presets.all") },
            { key: "anomalies", label: t("eventCenter.presets.anomalies") },
            { key: "human", label: t("eventCenter.presets.human") },
          ]}
        />
        <ProTable<HealthEvent>
          key={`${preset}-${tableKey}`}
          actionRef={actionRef}
          rowKey="id"
          ghost
          cardProps={false}
          options={false}
          style={{ maxWidth: "100%" }}
          scroll={{ x: TABLE_SCROLL_X }}
          search={moduleTableSearch()}
          tableStyle={moduleTableStyle}
          pagination={{
            ...moduleTablePagination,
            hideOnSinglePage: false,
            showTotal: (total, range) =>
              t("eventCenter.pagination.total", {
                start: range[0],
                end: range[1],
                total,
              }),
          }}
          params={{ preset }}
          request={requestEvents}
          columns={columns}
          expandable={{
            expandedRowRender: (record) => <EventDetailPanel record={record} />,
          }}
          toolBarRender={() => []}
        />
      </ModuleTableCard>
    </ModulePageShell>
  );
}