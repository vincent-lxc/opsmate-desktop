import { SwapOutlined } from "@ant-design/icons";
import { Dropdown, Input, Tag, Tooltip, Typography, theme } from "antd";
import type { MenuProps } from "antd";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ServerRecord } from "./ServerFormDrawer";
import {
  DEFAULT_SERVER_GROUP,
  formatGroupLabel,
} from "../utils/server-groups";

type ServerGroupTagProps = {
  server: ServerRecord;
  groups: string[];
  canWrite?: boolean;
  onChangeGroup: (server: ServerRecord, groupName: string) => void;
};

export function ServerGroupTag({
  server,
  groups,
  canWrite = true,
  onChangeGroup,
}: ServerGroupTagProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [newGroup, setNewGroup] = useState("");

  const groupOptions = useMemo(() => {
    const names = new Set(groups);
    names.add(server.group_name);
    names.add(DEFAULT_SERVER_GROUP);
    return Array.from(names).sort((left, right) => {
      if (left === DEFAULT_SERVER_GROUP) return 1;
      if (right === DEFAULT_SERVER_GROUP) return -1;
      return left.localeCompare(right);
    });
  }, [groups, server.group_name]);

  const menuItems: MenuProps["items"] = groupOptions.map((name) => ({
    key: name,
    label: formatGroupLabel(name, t),
    disabled: name === server.group_name,
    onClick: () => onChangeGroup(server, name),
  }));

  const submitNewGroup = () => {
    const trimmed = newGroup.trim();
    if (!trimmed || trimmed === server.group_name) return;
    onChangeGroup(server, trimmed);
    setNewGroup("");
  };

  if (!canWrite) {
    return <Tag style={{ alignSelf: "flex-start", margin: 0 }}>{formatGroupLabel(server.group_name, t)}</Tag>;
  }

  return (
    <Dropdown
      trigger={["click"]}
      menu={{ items: menuItems }}
      dropdownRender={(menu) => (
        <div
          style={{
            background: token.colorBgElevated,
            borderRadius: token.borderRadiusLG,
            boxShadow: token.boxShadowSecondary,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {menu}
          <div
            style={{
              padding: "8px 12px",
              borderTop: `1px solid ${token.colorSplit}`,
            }}
          >
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, display: "block", marginBottom: 8 }}
            >
              {t("servers.changeGroup.newHint")}
            </Typography.Text>
            <Input
              size="small"
              placeholder={t("servers.changeGroup.newPlaceholder")}
              value={newGroup}
              onChange={(event) => setNewGroup(event.target.value)}
              onPressEnter={submitNewGroup}
            />
          </div>
        </div>
      )}
    >
      <Tooltip title={t("servers.changeGroup.tooltip")}>
        <Tag
          style={{
            alignSelf: "flex-start",
            margin: 0,
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          {formatGroupLabel(server.group_name, t)}
          <SwapOutlined style={{ marginLeft: 4, fontSize: 10 }} />
        </Tag>
      </Tooltip>
    </Dropdown>
  );
}
