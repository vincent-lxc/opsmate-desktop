import { Button, Space, Switch, Tag, Typography } from "antd";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { MonitorTarget } from "../utils/discovery-types";
import {
  getCredentialEnvKeys,
  getTargetAppName,
  getTargetImage,
  getTargetPorts,
  getTargetStatus,
  isContainerRunning,
  isCredentialFromEnv,
  getComposeProject,
  isDockerTarget,
  isNoAuthTarget,
} from "../utils/target-display";

type MonitorTargetRowProps = {
  target: MonitorTarget;
  canWrite?: boolean;
  confirmingTargetId?: string | null;
  ignoringTargetId?: string | null;
  onConfirm: (target: MonitorTarget) => void;
  onIgnore: (target: MonitorTarget) => void;
  onToggle: (target: MonitorTarget, active: boolean) => void;
  onAddCredential: (target: MonitorTarget) => void;
  onSkipCredential: (target: MonitorTarget) => void;
  onReclassifyFoundation?: (target: MonitorTarget) => void;
  reclassifyingTargetId?: string | null;
  onReclassifyDeployment?: (target: MonitorTarget) => void;
  reclassifyingDeploymentTargetId?: string | null;
};

export function MonitorTargetRow({
  target,
  canWrite = true,
  confirmingTargetId,
  ignoringTargetId,
  onConfirm,
  onIgnore,
  onToggle,
  onAddCredential,
  onSkipCredential,
  onReclassifyFoundation,
  reclassifyingTargetId,
  onReclassifyDeployment,
  reclassifyingDeploymentTargetId,
}: MonitorTargetRowProps) {
  const { t } = useTranslation();
  const isActive = target.activation_state === "active";
  const appName = getTargetAppName(target);
  const image = getTargetImage(target);
  const ports = getTargetPorts(target);
  const status = getTargetStatus(target);
  const running = isContainerRunning(status);
  const showAppName = appName !== target.name;
  const needsCredential = target.credential_status === "needs_secret";
  const hasCredential = target.credential_status === "configured";
  const credentialFromEnv = hasCredential && isCredentialFromEnv(target);
  const credentialEnvKeys = getCredentialEnvKeys(target);
  const noAuth = isNoAuthTarget(target);
  const isDocker = isDockerTarget(target);
  const composeProject = getComposeProject(target);

  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 0",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
      }}
      onClick={stop}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <Typography.Text strong>{showAppName ? appName : target.name}</Typography.Text>
        {showAppName ? (
          <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            {target.name}
          </Typography.Text>
        ) : null}
        {target.category === "host_resources" && target.name === "host" ? (
          <>
            <Typography.Text type="secondary" style={{ display: "block", fontSize: 12, marginTop: 4 }}>
              {t("servers.discovery.hostTargetHint")}
            </Typography.Text>
            {(() => {
              const system = target.connection_hints.system as
                | { os?: string; kernel?: string; hostname?: string }
                | undefined;
              const docker = target.connection_hints.docker as
                | {
                    installed?: boolean;
                    version?: string | null;
                    containers_running?: number;
                    containers_total?: number;
                  }
                | undefined;
              return (
                <>
                  {system?.os ? (
                    <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                      {t("servers.discovery.hostOsSummary", { os: system.os })}
                    </Typography.Text>
                  ) : null}
                  {!docker?.installed ? (
                    <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                      {t("servers.discovery.dockerNotDetected")}
                    </Typography.Text>
                  ) : (
                    <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                      {t("servers.discovery.dockerRuntimeSummary", {
                        version: docker.version ?? "—",
                        running: docker.containers_running ?? 0,
                        total: docker.containers_total ?? 0,
                      })}
                    </Typography.Text>
                  )}
                </>
              );
            })()}
          </>
        ) : null}
        <div style={{ marginTop: 4 }}>
          {image ? (
            <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
              {t("servers.discovery.image")}: {image}
            </Typography.Text>
          ) : null}
          {ports.length > 0 ? (
            <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
              {t("servers.discovery.ports")}: {ports.join(", ")}
            </Typography.Text>
          ) : null}
          {composeProject ? (
            <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
              {t("servers.discovery.composeProject")}: {composeProject}
            </Typography.Text>
          ) : null}
        </div>
        <div style={{ marginTop: 4 }}>
          {isDocker ? (
            <Tag color="geekblue">{t("servers.discovery.dockerContainer")}</Tag>
          ) : target.category !== "host_resources" ? (
            <Tag color="purple">{t("servers.discovery.hostNative")}</Tag>
          ) : null}
          <Tag>{target.confidence}</Tag>
          {running !== null ? (
            <Tag color={running ? "success" : "default"}>
              {running ? t("servers.overview.running") : t("servers.overview.stopped")}
            </Tag>
          ) : null}
          {needsCredential ? (
            <Tag color="orange">{t("servers.discovery.needsCredential")}</Tag>
          ) : null}
          {hasCredential ? (
            <Tag color="green">{t("servers.discovery.credentialConfigured")}</Tag>
          ) : null}
          {noAuth ? (
            <Tag color="default">{t("servers.discovery.noAuthRequired")}</Tag>
          ) : null}
          {credentialFromEnv ? (
            <Tag color="cyan">
              {t("servers.discovery.credentialFromEnv", {
                keys: credentialEnvKeys.join(", ") || "env",
              })}
            </Tag>
          ) : null}
          {target.activation_state === "suggested" ? (
            <Tag color="blue">{t("servers.discovery.suggested")}</Tag>
          ) : null}
        </div>
      </div>
      {canWrite ? (
      <Space onClick={stop} onMouseDown={stop}>
        {needsCredential ? (
          <>
            <Button
              size="small"
              type="link"
              htmlType="button"
              onClick={(e) => {
                stop(e);
                onSkipCredential(target);
              }}
            >
              {t("servers.discovery.skipCredential")}
            </Button>
            <Button
              size="small"
              type="link"
              htmlType="button"
              onClick={(e) => {
                stop(e);
                onAddCredential(target);
              }}
            >
              {t("servers.discovery.addCredential")}
            </Button>
          </>
        ) : null}
        {hasCredential ? (
          <Button
            size="small"
            type="link"
            htmlType="button"
            onClick={(e) => {
              stop(e);
              onAddCredential(target);
            }}
          >
            {t("servers.discovery.editCredential")}
          </Button>
        ) : null}
        {target.category === "application" && onReclassifyDeployment ? (
          <Button
            size="small"
            type="link"
            htmlType="button"
            loading={reclassifyingDeploymentTargetId === target.id}
            onClick={(e) => {
              stop(e);
              onReclassifyDeployment(target);
            }}
          >
            {t("servers.discovery.reclassifyDeployment")}
          </Button>
        ) : null}
        {target.category === "application" && onReclassifyFoundation ? (
          <Button
            size="small"
            type="link"
            htmlType="button"
            loading={reclassifyingTargetId === target.id}
            onClick={(e) => {
              stop(e);
              onReclassifyFoundation(target);
            }}
          >
            {t("servers.discovery.reclassifyFoundation")}
          </Button>
        ) : null}
        {target.activation_state === "suggested" ? (
          <>
            <Button
              size="small"
              htmlType="button"
              loading={confirmingTargetId === target.id}
              onClick={(e) => {
                stop(e);
                onConfirm(target);
              }}
            >
              {t("servers.discovery.confirm")}
            </Button>
            <Button
              size="small"
              htmlType="button"
              loading={ignoringTargetId === target.id}
              onClick={(e) => {
                stop(e);
                onIgnore(target);
              }}
            >
              {t("servers.discovery.ignore")}
            </Button>
          </>
        ) : (
          <Switch
            checked={isActive}
            onChange={(checked) => onToggle(target, checked)}
          />
        )}
      </Space>
      ) : null}
    </div>
  );
}
