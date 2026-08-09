import {
  CloudServerOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  KeyOutlined,
  SettingOutlined,
  UserOutlined,
  GlobalOutlined,
  ApiOutlined,
} from "@ant-design/icons";
import { Tag } from "antd";
import {
  Button,
  Card,
  Dropdown,
  Popconfirm,
  Tooltip,
  Typography,
  theme,
} from "antd";
import type { MenuProps } from "antd";
import { formatDateTime } from "../utils/datetime";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import type { ServerRecord } from "./ServerFormDrawer";
import { ServerGroupTag } from "./ServerGroupTag";
import { TerminalPromptIcon } from "./TerminalPromptIcon";

type ServerCardProps = {
  server: ServerRecord;
  groups: string[];
  canWrite?: boolean;
  onEdit: (server: ServerRecord) => void;
  onDelete: (server: ServerRecord) => void;
  onOpenDetail: (server: ServerRecord) => void;
  onOpenTerminal: (server: ServerRecord) => void;
  onChangeGroup: (server: ServerRecord, groupName: string) => void;
};

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  const { token } = theme.useToken();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 13,
        color: token.colorTextSecondary,
        lineHeight: "22px",
      }}
    >
      <span style={{ color: token.colorTextTertiary, fontSize: 14 }}>{icon}</span>
      <span>
        {label}: <Typography.Text style={{ color: token.colorText }}>{value}</Typography.Text>
      </span>
    </div>
  );
}

export function ServerCard({
  server,
  groups,
  canWrite = true,
  onEdit,
  onDelete,
  onOpenDetail,
  onOpenTerminal,
  onChangeGroup,
}: ServerCardProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const menuItems: MenuProps["items"] = canWrite
    ? [
        {
          key: "edit",
          icon: <EditOutlined />,
          label: t("common.edit"),
          onClick: () => onEdit(server),
        },
      ]
    : [];

  const createdLabel = formatDateTime(server.created_at);
  const hasSshKey = Boolean(server.ssh_private_key_set ?? server.ssh_private_key);
  const setupStatus = server.setup_status ?? "pending_review";

  const setupTag =
    setupStatus === "ready" ? (
      <Tag color="green">{t("servers.discovery.statusReady")}</Tag>
    ) : setupStatus === "scanning" ? (
      <Tag color="processing">{t("servers.discovery.statusScanning")}</Tag>
    ) : (
      <Tag color="warning">{t("servers.discovery.statusPending")}</Tag>
    );

  return (
    <Card
      hoverable
      variant="outlined"
      style={{
        height: "100%",
        border: `1px solid ${token.colorBorder}`,
      }}
      styles={{
        body: {
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          height: "100%",
        },
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: token.colorFillSecondary,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <CloudServerOutlined style={{ fontSize: 18, color: token.colorText }} />
          </div>
          <Typography.Text
            strong
            ellipsis={{ tooltip: server.name }}
            style={{ fontSize: 15, maxWidth: "100%" }}
          >
            {server.name}
          </Typography.Text>
        </div>
        {canWrite ? (
          <Dropdown menu={{ items: menuItems }} trigger={["click"]}>
            <Button
              type="text"
              size="small"
              icon={<EllipsisOutlined />}
              style={{ color: token.colorTextSecondary }}
            />
          </Dropdown>
        ) : null}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <ServerGroupTag
          server={server}
          groups={groups}
          canWrite={canWrite}
          onChangeGroup={onChangeGroup}
        />
        {setupTag}
      </div>

      {server.description ? (
        <Typography.Paragraph
          type="secondary"
          ellipsis={{ rows: 2, tooltip: server.description }}
          style={{ margin: 0, fontSize: 13 }}
        >
          {server.description}
        </Typography.Paragraph>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
        <DetailRow
          icon={<GlobalOutlined />}
          label={t("servers.card.ip")}
          value={server.ip}
        />
        <DetailRow
          icon={<ApiOutlined />}
          label={t("servers.card.port")}
          value={server.ssh_port}
        />
        <DetailRow
          icon={<UserOutlined />}
          label={t("servers.card.user")}
          value={server.ssh_user ?? "-"}
        />
        <DetailRow
          icon={<KeyOutlined />}
          label={t("servers.card.sshKey")}
          value={
            hasSshKey
              ? server.ssh_key_passphrase_set
                ? t("servers.card.sshKeyEncrypted")
                : t("servers.card.sshKeyYes")
              : t("servers.card.sshKeyNo")
          }
        />
      </div>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <ClockCircleOutlined style={{ marginRight: 6 }} />
        {t("servers.card.created", { date: createdLabel })}
      </Typography.Text>

      <Button type="primary" block onClick={() => onOpenDetail(server)}>
        {setupStatus === "ready" ? t("servers.card.openDetail") : t("servers.card.setup")}
        <SettingOutlined style={{ marginLeft: 8 }} />
      </Button>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `1px solid ${token.colorSplit}`,
          paddingTop: 12,
        }}
      >
        <Tooltip title={t("servers.card.terminal")}>
          <Button
            type="text"
            size="small"
            onClick={() => onOpenTerminal(server)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              padding: 0,
            }}
            aria-label={t("servers.card.terminal")}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                borderRadius: 6,
                background: token.colorFillSecondary,
              }}
            >
              <TerminalPromptIcon size={12} />
            </span>
          </Button>
        </Tooltip>
        {canWrite ? (
          <Popconfirm
            title={t("servers.confirmDelete")}
            onConfirm={() => onDelete(server)}
          >
            <Tooltip title={t("common.delete")}>
              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        ) : null}
      </div>
    </Card>
  );
}
