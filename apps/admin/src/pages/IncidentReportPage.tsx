import { FileSearchOutlined } from "@ant-design/icons";
import { App, Button, Descriptions, Input, Select, Space, Typography } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import {
  IncidentReportChecklistEditor,
  type IncidentChecklistItem,
} from "../components/IncidentReportChecklistEditor";
import { ModulePageShell } from "../components/ModulePageShell";
import { ModuleSectionHeader } from "../components/ModuleSectionHeader";
import { formatDateTime } from "../utils/datetime";

type IncidentReport = {
  id: string;
  problem_group_id: string | null;
  problem_event_id: string | null;
  title: string;
  draft_markdown: string;
  status: string;
  source?: "auto" | "manual";
  items_json?: IncidentChecklistItem[];
  meta_json?: { ai_draft?: boolean };
  created_at: string;
  updated_at: string;
};

export function IncidentReportPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<IncidentChecklistItem[] | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["incident-report", id],
    queryFn: () => api<IncidentReport>(`/api/incident-reports/${id}`),
    enabled: Boolean(id),
  });

  useEffect(() => {
    if (data?.items_json?.length) {
      setChecklist(data.items_json);
    }
  }, [data?.items_json]);

  const saveMutation = useMutation({
    mutationFn: (patch: {
      draft_markdown?: string;
      status?: string;
      title?: string;
      items_json?: IncidentChecklistItem[];
    }) =>
      api<IncidentReport>(`/api/incident-reports/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["incident-report", id] });
      message.success(t("incidentReports.saved"));
    },
    onError: () => message.error(t("common.error")),
  });

  const exportMutation = useMutation({
    mutationFn: (format: "markdown" | "json" | "pdf") =>
      api<{ content: string; format: string }>(`/api/incident-reports/${id}/exports`, {
        method: "POST",
        body: JSON.stringify({ format }),
      }),
    onSuccess: (row, format) => {
      let blob: Blob;
      let filename: string;
      if (format === "pdf") {
        const binary = atob(row.content);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        blob = new Blob([bytes], { type: "application/pdf" });
        filename = `incident-report-${id}.pdf`;
      } else {
        blob = new Blob([row.content], {
          type: format === "json" ? "application/json" : "text/markdown",
        });
        filename = `incident-report-${id}.${format === "json" ? "json" : "md"}`;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      message.success(t("incidentReports.exported"));
    },
    onError: () => message.error(t("common.error")),
  });

  if (isLoading || !data) {
    return (
      <ModulePageShell
        icon={<FileSearchOutlined style={{ fontSize: 20 }} />}
        title={t("incidentReports.title")}
        subtitle={t("incidentReports.loading")}
      >
        <Typography.Text type="secondary">{t("common.loading")}</Typography.Text>
      </ModulePageShell>
    );
  }

  const markdown = draft ?? data.draft_markdown ?? "";
  const checklistItems = checklist ?? data.items_json ?? [];
  const published = data.status === "finalized" || data.status === "archived";

  return (
    <ModulePageShell
      icon={<FileSearchOutlined style={{ fontSize: 20 }} />}
      title={data.title}
      subtitle={t("incidentReports.subtitle")}
      action={
        <Space>
          <Button onClick={() => exportMutation.mutate("markdown")} loading={exportMutation.isPending}>
            {t("incidentReports.exportMarkdown")}
          </Button>
          <Button onClick={() => exportMutation.mutate("json")} loading={exportMutation.isPending}>
            {t("incidentReports.exportJson")}
          </Button>
          <Button onClick={() => exportMutation.mutate("pdf")} loading={exportMutation.isPending}>
            {t("incidentReports.exportPdf")}
          </Button>
          <Button
            type="primary"
            onClick={() =>
              saveMutation.mutate({
                draft_markdown: markdown,
                status: data.status,
                items_json: checklistItems,
              })
            }
            loading={saveMutation.isPending}
          >
            {t("common.save")}
          </Button>
          {!published ? (
            <Button
              onClick={() =>
                saveMutation.mutate({
                  draft_markdown: markdown,
                  status: "finalized",
                  items_json: checklistItems,
                })
              }
              loading={saveMutation.isPending}
            >
              {t("incidentReports.publish")}
            </Button>
          ) : null}
        </Space>
      }
    >
      <ModuleSectionHeader title={t("incidentReports.sections.meta")} />
      <Descriptions bordered size="small" column={2} style={{ marginBottom: 24 }}>
        <Descriptions.Item label={t("incidentReports.fields.status")}>
          <Select
            size="small"
            value={data.status}
            style={{ width: 140 }}
            options={["draft", "reviewing", "finalized", "archived"].map((v) => ({ label: v, value: v }))}
            onChange={(status) => saveMutation.mutate({ status })}
          />
        </Descriptions.Item>
        <Descriptions.Item label={t("incidentReports.fields.updatedAt")}>
          {formatDateTime(data.updated_at)}
        </Descriptions.Item>
        <Descriptions.Item label={t("incidentReports.fields.problemGroup")}>
          {data.problem_group_id ? (
            <Typography.Text code>{data.problem_group_id}</Typography.Text>
          ) : (
            "—"
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t("incidentReports.fields.problemEvent")}>
          {data.problem_event_id ? (
            <Link to={`/problems?event_id=${data.problem_event_id}`}>{data.problem_event_id}</Link>
          ) : (
            "—"
          )}
        </Descriptions.Item>
      </Descriptions>

      <ModuleSectionHeader title={t("incidentReports.sections.checklist")} />
      <IncidentReportChecklistEditor
        items={checklistItems}
        onChange={setChecklist}
        showAiBadge={data.source === "auto" || Boolean(data.meta_json?.ai_draft)}
        published={published}
      />

      <ModuleSectionHeader title={t("incidentReports.sections.draft")} />
      <Input.TextArea
        value={markdown}
        onChange={(e) => setDraft(e.target.value)}
        rows={24}
        style={{ fontFamily: "monospace", fontSize: 13 }}
      />
    </ModulePageShell>
  );
}