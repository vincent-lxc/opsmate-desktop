import { Modal } from "antd";
import { useTranslation } from "react-i18next";
import type { ServerRecord } from "./ServerFormDrawer";
import { ServerTerminalView, TERMINAL_MODAL_HEIGHT } from "./ServerTerminalView";
import { TerminalPromptIcon } from "./TerminalPromptIcon";

type ServerTerminalModalProps = {
  open: boolean;
  server: ServerRecord | null;
  onClose: () => void;
  problemEventId?: string;
  interventionSeedMessage?: string;
  interventionRemediationPlan?: string | null;
  onInterventionComplete?: () => void;
};

export function ServerTerminalModal({
  open,
  server,
  onClose,
  problemEventId,
  interventionSeedMessage,
  interventionRemediationPlan,
  onInterventionComplete,
}: ServerTerminalModalProps) {
  const { t } = useTranslation();

  return (
    <Modal
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <TerminalPromptIcon />
          <span>{t("servers.terminal.title", { name: server?.name ?? "" })}</span>
        </span>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width="min(1040px, 94vw)"
      centered
      destroyOnHidden
      styles={{
        body: {
          padding: 0,
          height: TERMINAL_MODAL_HEIGHT,
        },
      }}
    >
      {server ? (
        <ServerTerminalView
          server={server}
          active={open}
          height="100%"
          showHeader={false}
          problemEventId={problemEventId}
          interventionSeedMessage={interventionSeedMessage}
          interventionRemediationPlan={interventionRemediationPlan}
          onInterventionComplete={onInterventionComplete}
        />
      ) : null}
    </Modal>
  );
}