import { CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Modal, Progress, Space, Typography } from "antd";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { PatrolRound } from "../utils/monitoring-types";
import { roundStatusTag } from "../utils/patrol-display";

const TERMINAL_ROUND_STATUSES = new Set(["completed", "partial", "failed"]);
const AUTO_CLOSE_MS = 1500;

type PatrolRunProgressModalProps = {
  open: boolean;
  taskId: string | null;
  taskTitle: string;
  roundId: string | null;
  onClose: () => void;
  onComplete?: () => void;
};

function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

export function PatrolRunProgressModal({
  open,
  taskId,
  taskTitle,
  roundId,
  onClose,
  onComplete,
}: PatrolRunProgressModalProps) {
  const { t } = useTranslation();
  const completionHandled = useRef(false);

  const { data: round, isError } = useQuery({
    queryKey: ["patrol-round-progress", roundId],
    queryFn: () => api<PatrolRound>(`/api/monitoring/patrol-rounds/${roundId}`),
    enabled: open && Boolean(roundId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status || TERMINAL_ROUND_STATUSES.has(status)) return false;
      return 1000;
    },
  });

  const status = round?.status ?? (roundId ? "running" : "pending");
  const serverCount = round?.server_count ?? 0;
  const completedCount = round?.completed_count ?? 0;
  const stepTotal = round?.step_total_count ?? 0;
  const stepCompleted = round?.step_completed_count ?? 0;
  const serverPercent = progressPercent(completedCount, serverCount);
  const stepPercent = progressPercent(stepCompleted, stepTotal);
  const combinedPercent =
    serverCount > 0 && stepTotal > 0
      ? Math.min(
          100,
          Math.round(((completedCount / serverCount) * 0.35 + (stepCompleted / stepTotal) * 0.65) * 100),
        )
      : serverCount > 0
        ? serverPercent
        : stepPercent;
  const isRunning = status === "running";
  const isDone = TERMINAL_ROUND_STATUSES.has(status);

  useEffect(() => {
    if (!open) {
      completionHandled.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!isDone || !open || completionHandled.current) return;
    completionHandled.current = true;
    onComplete?.();
    const timer = window.setTimeout(() => onClose(), AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [isDone, open, onComplete, onClose]);

  const statusIcon = isRunning ? (
    <LoadingOutlined style={{ color: "#1677ff" }} />
  ) : status === "completed" ? (
    <CheckCircleOutlined style={{ color: "#52c41a" }} />
  ) : (
    <CloseCircleOutlined style={{ color: status === "partial" ? "#faad14" : "#ff4d4f" }} />
  );

  return (
    <Modal
      title={t("monitoring.patrolTasks.runProgress.title")}
      open={open}
      onCancel={onClose}
      footer={null}
      closable={isDone || isError || !roundId}
      maskClosable={isDone}
      width={480}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <div>
          <Typography.Text type="secondary">{t("monitoring.patrolTasks.runProgress.task")}</Typography.Text>
          <Typography.Paragraph style={{ margin: "4px 0 0" }}>{taskTitle}</Typography.Paragraph>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {statusIcon}
          <Typography.Text>
            {isError
              ? t("monitoring.patrolTasks.runProgress.pollFailed")
              : t(`monitoring.patrolTasks.runProgress.status.${status}`, {
                  defaultValue: status,
                })}
          </Typography.Text>
          {round ? roundStatusTag(round.status, t) : null}
        </div>

        <Progress
          percent={isRunning ? combinedPercent : 100}
          status={
            isRunning ? "active" : status === "completed" ? "success" : "exception"
          }
        />

        <Space direction="vertical" size={4} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {serverCount > 0
              ? t("monitoring.patrolTasks.runProgress.servers", {
                  done: completedCount,
                  total: serverCount,
                })
              : t("monitoring.patrolTasks.runProgress.serversPending")}
          </Typography.Text>
          <Typography.Text type="secondary">
            {stepTotal > 0
              ? t("monitoring.patrolTasks.runProgress.steps", {
                  done: stepCompleted,
                  total: stepTotal,
                })
              : roundId
                ? t("monitoring.patrolTasks.runProgress.stepsPending")
                : t("monitoring.patrolTasks.runProgress.stepsUnknown")}
          </Typography.Text>
        </Space>

        {round && isDone ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t("monitoring.patrolTasks.runProgress.summary", {
              anomalies: round.anomaly_count ?? 0,
            })}
            {taskId ? (
              <>
                {" "}
                <Link to={`/monitoring/patrol-records?task_id=${taskId}`}>
                  {t("monitoring.patrolTasks.viewRecords")}
                </Link>
              </>
            ) : null}
          </Typography.Paragraph>
        ) : (
          <Typography.Text type="secondary">
            {t("monitoring.patrolTasks.runProgress.hint")}
          </Typography.Text>
        )}
      </Space>
    </Modal>
  );
}