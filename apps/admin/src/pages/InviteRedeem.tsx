import { useEffect, useState } from "react";
import { Alert, Button, Card, Form, Input, Space, Spin, Typography, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { OpsMateLogo } from "../components/OpsMateLogo";
import { HeaderActions } from "../components/HeaderActions";
import { roleFromToken, setAuthSession } from "../services/auth/roles";

type InviteInfo = {
  valid: boolean;
  reason?: string;
  role?: string;
  display_name?: string | null;
  expires_at?: string;
  bot_username?: string;
};

export function InviteRedeemPage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return;
    api<InviteInfo>(`/api/auth/invites/${token}`)
      .then(setInvite)
      .catch(() => setInvite({ valid: false, reason: "not_found" }))
      .finally(() => setLoading(false));
  }, [token]);

  const onFinish = async (values: {
    username: string;
    password?: string;
    display_name?: string;
  }) => {
    if (!token) return;
    setSubmitting(true);
    try {
      const data = await api<{
        token: string;
        username: string;
        role: string;
        must_change_password?: boolean;
      }>(`/api/auth/invites/${token}/redeem`, {
        method: "POST",
        body: JSON.stringify(values),
      });
      setAuthSession(
        data.token,
        (data.role as "admin" | "operator" | "viewer") ?? roleFromToken(data.token),
        data.username,
        data.must_change_password,
      );
      message.success(t("invite.success"));
      navigate("/dashboard/overview", { replace: true });
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("invite.failed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--ant-color-bg-layout)" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 24px" }}>
        <HeaderActions />
      </div>
      <div style={{ display: "flex", justifyContent: "center", padding: "48px 16px" }}>
        <Card style={{ width: 480, maxWidth: "100%" }}>
          {loading ? (
            <Spin />
          ) : (
            <Space direction="vertical" size="large" style={{ width: "100%" }}>
              <Space>
                <OpsMateLogo size={32} />
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {t("invite.title")}
                </Typography.Title>
              </Space>
              {!invite?.valid ? (
                <Alert type="error" showIcon message={t("invite.invalid")} />
              ) : (
                <>
                  <Alert
                    type="info"
                    showIcon
                    message={t("invite.role", { role: invite.role })}
                    description={invite.display_name ?? undefined}
                  />
                  <Form
                    form={form}
                    layout="vertical"
                    initialValues={{ display_name: invite.display_name ?? undefined }}
                    onFinish={onFinish}
                  >
                    <Form.Item
                      name="username"
                      label={t("invite.username")}
                      rules={[{ required: true, min: 2 }]}
                    >
                      <Input />
                    </Form.Item>
                    <Form.Item name="display_name" label={t("invite.displayName")}>
                      <Input />
                    </Form.Item>
                    <Form.Item name="password" label={t("invite.passwordOptional")}>
                      <Input.Password />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" loading={submitting} block>
                      {t("invite.submit")}
                    </Button>
                  </Form>
                </>
              )}
            </Space>
          )}
        </Card>
      </div>
    </div>
  );
}

export default InviteRedeemPage;