import { Button, Modal, Progress, Result, Space, Typography, message } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { ServerRecord } from "./ServerFormDrawer";
import type { DiscoveryStatus } from "../utils/discovery-types";

type ServerDiscoveryWizardProps = {
  open: boolean;
  server: ServerRecord | null;
  onClose: () => void;
};

export function ServerDiscoveryWizard({ open, server, onClose }: ServerDiscoveryWizardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const { data: status } = useQuery({
    queryKey: ["discovery-status", server?.id],
    queryFn: () =>
      api<DiscoveryStatus>(`/api/servers/${server!.id}/discovery/status`),
    enabled: open && Boolean(server?.id),
    refetchInterval: (query) => {
      const runStatus = query.state.data?.run?.status;
      const setup = query.state.data?.setup_status;
      if (setup === "scanning" || runStatus === "running") return 2000;
      return false;
    },
  });

  const isScanning = status?.setup_status === "scanning" || status?.run?.status === "running";
  const failed = status?.run?.status === "failed";
  const done = !isScanning && status?.run?.status === "completed";

  const handleOpenDetail = () => {
    if (!server) return;
    onClose();
    navigate(`/servers/${server.id}?tab=monitor`);
  };

  const handleComplete = async () => {
    if (!server) return;
    await api(`/api/servers/${server.id}/setup/complete`, { method: "POST" });
    onClose();
    navigate(`/servers/${server.id}`);
  };

  return (
    <Modal
      open={open}
      title={t("servers.discovery.wizardTitle", { name: server?.name ?? "" })}
      footer={null}
      onCancel={onClose}
      width={520}
      destroyOnClose
    >
      {isScanning ? (
        <Space direction="vertical" size="large" style={{ width: "100%", padding: "24px 0" }}>
          <Typography.Text>{t("servers.discovery.scanning")}</Typography.Text>
          <Progress percent={99} status="active" showInfo={false} />
        </Space>
      ) : null}

      {failed ? (
        <Result
          status="error"
          title={t("servers.discovery.failed")}
          subTitle={status?.run?.error_message ?? t("servers.discovery.failedHint")}
          extra={
            <Space>
              <Button
                type="primary"
                onClick={async () => {
                  if (!server) return;
                  await api(`/api/servers/${server.id}/discovery/run`, { method: "POST" });
                  message.info(t("servers.discovery.rescanStarted"));
                }}
              >
                {t("servers.discovery.rescan")}
              </Button>
              <Button onClick={onClose}>{t("servers.discovery.retryLater")}</Button>
            </Space>
          }
        />
      ) : null}

      {done ? (
        <Result
          status="success"
          title={t("servers.discovery.complete")}
          subTitle={t("servers.discovery.completeHint", {
            suggested: status?.target_counts.suggested ?? 0,
            total: status?.target_counts.total ?? 0,
          })}
          extra={
            <Space>
              <Button onClick={handleOpenDetail}>{t("servers.discovery.reviewTargets")}</Button>
              <Button type="primary" onClick={handleComplete}>
                {t("servers.discovery.finishSetup")}
              </Button>
            </Space>
          }
        />
      ) : null}

      {!isScanning && !failed && !done ? (
        <Typography.Text type="secondary">{t("servers.discovery.waiting")}</Typography.Text>
      ) : null}
    </Modal>
  );
}