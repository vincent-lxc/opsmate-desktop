import { PauseCircleOutlined } from "@ant-design/icons";
import { Alert, Card, Descriptions, Input, Popconfirm, Space, Switch, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { ModulePageShell } from "../../components/ModulePageShell";
import { formatDateTime } from "../../utils/datetime";

type AutomationControlState = {
  id: string;
  ai_execution_paused: boolean;
  l1_auto_paused: boolean;
  paused_server_groups: string[];
  paused_task_ids: string[];
  reason: string | null;
  updated_at: string;
};

export function KillSwitchPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [reasonDraft, setReasonDraft] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["automation-control"],
    queryFn: () => api<AutomationControlState>("/api/security/automation-control"),
  });

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<AutomationControlState>) =>
      api<AutomationControlState>("/api/security/automation-control", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(["automation-control"], next);
      message.success(t("security.killSwitch.saved"));
    },
    onError: () => {
      message.error(t("security.killSwitch.saveError"));
    },
  });

  const paused = data?.ai_execution_paused ?? false;
  const l1Paused = data?.l1_auto_paused ?? false;

  const applyPausePatch = (patch: Partial<AutomationControlState>) => {
    updateMutation.mutate(patch);
  };

  return (
    <ModulePageShell
      icon={<PauseCircleOutlined style={{ fontSize: 20 }} />}
      title={t("security.killSwitch.title")}
      subtitle={t("security.killSwitch.subtitle")}
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        {paused ? (
          <Alert type="error" showIcon message={t("security.killSwitch.activeAlert")} />
        ) : (
          <Alert type="info" showIcon message={t("security.killSwitch.idleHint")} />
        )}

        <Card variant="outlined" title={t("security.killSwitch.globalPause")}>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Space align="center">
              <Popconfirm
                title={
                  paused
                    ? t("security.killSwitch.confirmResumeAi")
                    : t("security.killSwitch.confirmPauseAi")
                }
                okText={t("common.yes")}
                cancelText={t("common.cancel")}
                disabled={isLoading || updateMutation.isPending}
                onConfirm={() =>
                  applyPausePatch({
                    ai_execution_paused: !paused,
                    reason: !paused ? reasonDraft || data?.reason || null : null,
                  })
                }
              >
                <span>
                  <Switch checked={paused} loading={isLoading || updateMutation.isPending} />
                </span>
              </Popconfirm>
              <Typography.Text>{t("security.killSwitch.pauseAiExecution")}</Typography.Text>
            </Space>
            <Space align="center">
              <Popconfirm
                title={
                  l1Paused
                    ? t("security.killSwitch.confirmResumeL1")
                    : t("security.killSwitch.confirmPauseL1")
                }
                okText={t("common.yes")}
                cancelText={t("common.cancel")}
                disabled={isLoading || updateMutation.isPending}
                onConfirm={() => applyPausePatch({ l1_auto_paused: !l1Paused })}
              >
                <span>
                  <Switch checked={l1Paused} loading={isLoading || updateMutation.isPending} />
                </span>
              </Popconfirm>
              <Typography.Text>{t("security.killSwitch.pauseL1Auto")}</Typography.Text>
            </Space>
          </Space>
        </Card>

        <Card variant="outlined" title={t("security.killSwitch.reasonCard")}>
          <Input.TextArea
            rows={3}
            value={reasonDraft || data?.reason || ""}
            placeholder={t("security.killSwitch.reasonPlaceholder")}
            onChange={(event) => setReasonDraft(event.target.value)}
            onBlur={() => {
              const nextReason = reasonDraft || data?.reason || null;
              if (nextReason !== (data?.reason ?? null)) {
                updateMutation.mutate({ reason: nextReason });
              }
            }}
          />
        </Card>

        <Card variant="outlined" title={t("security.killSwitch.scopeCard")}>
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label={t("security.killSwitch.pausedGroups")}>
              {data?.paused_server_groups?.length
                ? data.paused_server_groups.join(", ")
                : t("security.killSwitch.none")}
            </Descriptions.Item>
            <Descriptions.Item label={t("security.killSwitch.pausedTasks")}>
              {data?.paused_task_ids?.length
                ? String(data.paused_task_ids.length)
                : t("security.killSwitch.none")}
            </Descriptions.Item>
            <Descriptions.Item label={t("security.killSwitch.updatedAt")}>
              {data?.updated_at ? formatDateTime(data.updated_at) : "—"}
            </Descriptions.Item>
          </Descriptions>
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            {t("security.killSwitch.scopeHint")}
          </Typography.Paragraph>
        </Card>
      </Space>
    </ModulePageShell>
  );
}