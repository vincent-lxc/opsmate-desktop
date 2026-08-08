import {
  FullscreenExitOutlined,
  FullscreenOutlined,
} from "@ant-design/icons";
import { Button, Space, Spin, Tooltip, Typography, theme } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useElementFullscreen } from "../hooks/useElementFullscreen";
import { useServerTerminal } from "../hooks/useServerTerminal";
import { useTerminalSplitPane } from "../hooks/useTerminalSplitPane";
import type { ServerRecord } from "./ServerFormDrawer";
import { TerminalAiChat } from "./TerminalAiChat";
import { TerminalPromptIcon } from "./TerminalPromptIcon";
// xterm CSS lives with the terminal component so non-terminal routes don't
// pay for a render-blocking CSS fetch.
import "@xterm/xterm/css/xterm.css";

/** Embedded in server detail — tall enough to use space; page scrolls if needed. */
export const TERMINAL_PANEL_HEIGHT = "clamp(560px, calc(100vh - 220px), 960px)";

/** Modal body — nearly full viewport height. */
export const TERMINAL_MODAL_HEIGHT = "min(86vh, 900px)";

type ServerTerminalViewProps = {
  server: ServerRecord;
  active?: boolean;
  height?: number | string;
  showHeader?: boolean;
  problemEventId?: string;
  interventionSeedMessage?: string;
  interventionRemediationPlan?: string | null;
  onInterventionComplete?: () => void;
};

export function ServerTerminalView({
  server,
  active = true,
  height = TERMINAL_PANEL_HEIGHT,
  showHeader = true,
  problemEventId,
  interventionSeedMessage,
  interventionRemediationPlan,
  onInterventionComplete,
}: ServerTerminalViewProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [aiCollapsed, setAiCollapsed] = useState(false);
  const splitBodyRef = useRef<HTMLDivElement | null>(null);

  const hasSshKey = Boolean(server.ssh_private_key_set ?? server.ssh_private_key);
  const terminal = useServerTerminal({
    serverId: server.id,
    hasSshKey,
    credentialId: server.ssh_credential_id ?? null,
    sshCredentialHasCloudSecret: server.ssh_credential_has_cloud_secret,
    active,
  });

  const handleFullscreenChange = useCallback(() => {
    terminal.scheduleFit();
  }, [terminal.scheduleFit]);

  const { rootRef, isFullscreen, toggleFullscreen, supported } = useElementFullscreen(
    handleFullscreenChange,
  );

  const { aiSplitPct, startDrag } = useTerminalSplitPane(() => terminal.scheduleFit());

  useEffect(() => {
    terminal.scheduleFit();
  }, [aiCollapsed, aiSplitPct, isFullscreen, terminal.scheduleFit]);

  useEffect(() => {
    if (!active && document.fullscreenElement === rootRef.current) {
      void document.exitFullscreen();
    }
    return () => {
      if (document.fullscreenElement === rootRef.current) {
        void document.exitFullscreen();
      }
    };
  }, [active, rootRef]);

  const splitStyle = {
    "--ops-terminal-split-bg": token.colorFillAlter,
    "--ops-terminal-split-bg-active": token.colorFillSecondary,
    "--ops-terminal-split-border": token.colorBorderSecondary,
    "--ops-terminal-split-grip": token.colorTextQuaternary,
  } as React.CSSProperties;

  const connectionLabel = `${server.ssh_user ?? "root"}@${server.ip}:${server.ssh_port}`;

  const fullscreenButton = supported ? (
    <Tooltip
      title={isFullscreen ? t("servers.terminal.exitFullscreen") : t("servers.terminal.fullscreen")}
    >
      <Button
        type="text"
        size="small"
        aria-label={
          isFullscreen ? t("servers.terminal.exitFullscreen") : t("servers.terminal.fullscreen")
        }
        icon={isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
        onClick={() => void toggleFullscreen()}
      />
    </Tooltip>
  ) : null;

  return (
    <div
      ref={rootRef}
      className="ops-terminal-root"
      style={{
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: isFullscreen ? 0 : token.borderRadiusLG,
        overflow: "hidden",
        background: "#000000",
        display: "flex",
        flexDirection: "column",
        height: isFullscreen ? "100vh" : height,
        minHeight: isFullscreen ? "100vh" : 480,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "10px 14px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorFillAlter,
          flexShrink: 0,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {showHeader ? (
            <>
              <TerminalPromptIcon />
              <Typography.Text strong>{t("servers.terminal.panelTitle")}</Typography.Text>
            </>
          ) : (
            <Typography.Text strong ellipsis>
              {t("servers.terminal.title", { name: server.name })}
            </Typography.Text>
          )}
        </span>
        <Space size={4} style={{ flexShrink: 0 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {connectionLabel}
          </Typography.Text>
          {fullscreenButton}
        </Space>
      </div>

      <div
        ref={splitBodyRef}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            flex: aiCollapsed ? "0 0 auto" : `0 0 ${aiSplitPct}%`,
            minHeight: aiCollapsed ? undefined : 200,
            overflow: "hidden",
          }}
        >
          <TerminalAiChat
            serverId={server.id}
            ready={terminal.ready}
            collapsed={aiCollapsed}
            onToggleCollapsed={() => setAiCollapsed((v) => !v)}
            getRecentOutput={terminal.getRecentOutput}
            runCommandAndWait={terminal.runCommandAndWait}
            problemEventId={problemEventId}
            interventionSeedMessage={interventionSeedMessage}
            interventionRemediationPlan={interventionRemediationPlan}
            onInterventionComplete={onInterventionComplete}
          />
        </div>

        {!aiCollapsed ? (
          <Tooltip title={t("servers.terminal.resizeSplit")}>
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("servers.terminal.resizeSplit")}
              className="ops-terminal-split-handle"
              style={splitStyle}
              onPointerDown={(event) => startDrag(splitBodyRef.current)(event)}
            >
              <div className="ops-terminal-split-grip" />
            </div>
          </Tooltip>
        ) : null}

        <div
          style={{
            flex: "1 1 0",
            minHeight: 220,
            display: "flex",
            flexDirection: "column",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {terminal.connecting ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(0, 0, 0, 0.45)",
                zIndex: 1,
              }}
            >
              <Spin tip={t("servers.terminal.connecting")} />
            </div>
          ) : null}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              padding: "6px 10px 8px",
              boxSizing: "border-box",
              overflow: "hidden",
            }}
          >
            <div ref={terminal.containerRef} className="ops-terminal-host" />
          </div>
        </div>
      </div>
    </div>
  );
}