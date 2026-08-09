import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Form, Input, Modal, Select, Space, Switch, Table, Tag, message } from "antd";
import { UserOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { ModulePageShell } from "../components/ModulePageShell";
import { getUsername, isAdmin, type AdminRole } from "../services/auth/roles";
import { formatDateTime } from "../utils/datetime";

type AdminUserRow = {
  id: number;
  username: string;
  role: AdminRole;
  telegram_user_id?: number;
  is_active: boolean;
  last_login_at?: string;
  invited_by?: string;
  has_password: boolean;
};

const ROLE_OPTIONS: AdminRole[] = ["admin", "operator", "viewer"];

export function UsersPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<AdminUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [form] = Form.useForm();
  const currentUser = getUsername();

  const roleOptions = useMemo(
    () => ROLE_OPTIONS.map((role) => ({ value: role, label: t(`role.${role}`, { defaultValue: role }) })),
    [t],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ items: AdminUserRow[]; total: number }>(
        `/api/auth/users?page=${page}&page_size=${pageSize}`,
      );
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, t]);

  useEffect(() => {
    if (!isAdmin()) return;
    void load();
  }, [load]);

  const createInvite = async (values: {
    role: AdminRole;
    display_name?: string;
    expires_in_hours?: number;
  }) => {
    try {
      const res = await api<{ invite_url: string }>("/api/auth/users/invites", {
        method: "POST",
        body: JSON.stringify(values),
      });
      const absolute = `${window.location.origin}${res.invite_url}`;
      setInviteUrl(absolute);
      message.success(t("users.inviteCreated"));
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const patchUser = async (row: AdminUserRow, patch: { role?: AdminRole; is_active?: boolean }) => {
    try {
      await api(`/api/auth/users/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      message.success(t("users.updated"));
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  if (!isAdmin()) {
    return (
      <ModulePageShell icon={<UserOutlined style={{ fontSize: 20 }} />} title={t("users.title")}>
        {t("users.adminOnly")}
      </ModulePageShell>
    );
  }

  return (
    <ModulePageShell
      icon={<UserOutlined style={{ fontSize: 20 }} />}
      title={t("users.title")}
      subtitle={t("users.subtitle")}
    >
      <div style={{ marginBottom: 16, display: "flex", justifyContent: "flex-end" }}>
        <Button type="primary" onClick={() => setInviteOpen(true)}>
          {t("users.createInvite")}
        </Button>
      </div>
      <Table<AdminUserRow>
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
        columns={[
          { title: t("users.columns.username"), dataIndex: "username" },
          {
            title: t("users.columns.role"),
            dataIndex: "role",
            render: (role: AdminRole) => t(`role.${role}`, { defaultValue: role }),
          },
          {
            title: t("users.columns.telegram"),
            dataIndex: "telegram_user_id",
            render: (id?: number) =>
              id ? <Tag color="success">{id}</Tag> : <Tag>{t("users.notBound")}</Tag>,
          },
          {
            title: t("users.columns.active"),
            dataIndex: "is_active",
            render: (active: boolean, row) => (
              <Switch
                checked={active}
                disabled={row.username === currentUser}
                onChange={(checked) => void patchUser(row, { is_active: checked })}
              />
            ),
          },
          {
            title: t("users.columns.lastLogin"),
            dataIndex: "last_login_at",
            render: (v?: string) => formatDateTime(v),
          },
          {
            title: t("common.actions"),
            render: (_, row) => (
              <Select
                value={row.role}
                style={{ width: 120 }}
                options={roleOptions}
                disabled={row.username === currentUser}
                onChange={(role) => void patchUser(row, { role })}
              />
            ),
          },
        ]}
      />

      <Modal
        title={t("users.inviteModalTitle")}
        open={inviteOpen}
        onCancel={() => {
          setInviteOpen(false);
          setInviteUrl("");
          form.resetFields();
        }}
        footer={null}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ role: "operator", expires_in_hours: 72 }}
          onFinish={createInvite}
        >
          <Form.Item name="role" label={t("users.inviteRole")} rules={[{ required: true }]}>
            <Select options={roleOptions} />
          </Form.Item>
          <Form.Item name="display_name" label={t("users.inviteDisplayName")}>
            <Input />
          </Form.Item>
          <Form.Item name="expires_in_hours" label={t("users.inviteExpiresHours")}>
            <Input type="number" min={1} max={168} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            {t("users.createInvite")}
          </Button>
        </Form>
        {inviteUrl ? (
          <Space direction="vertical" style={{ marginTop: 16, width: "100%" }}>
            <Input.TextArea value={inviteUrl} readOnly rows={2} />
            <Button onClick={() => void navigator.clipboard.writeText(inviteUrl)}>
              {t("users.copyInvite")}
            </Button>
          </Space>
        ) : null}
      </Modal>
    </ModulePageShell>
  );
}

export default UsersPage;