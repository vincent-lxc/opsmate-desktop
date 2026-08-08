import { useState } from "react";
import { Alert, Button, Card, Form, Input, Space, Typography, message } from "antd";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { login } from "../api/client";
import { OpsMateLogo } from "../components/OpsMateLogo";
import { HeaderActions } from "../components/HeaderActions";
import { mustChangePassword } from "../services/auth/roles";

/**
 * Internal / bootstrap password login.
 * Not linked from marketing CTAs — only for ops via direct URL `/login/internal`.
 */
export function InternalLoginPage() {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    setSubmitting(true);
    try {
      await login(values.username, values.password);
      message.success(t("login.success"));
      window.location.href = mustChangePassword()
        ? "/account?tab=security"
        : "/dashboard/overview";
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("login.failed"));
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
        <Card style={{ width: 420, maxWidth: "100%" }}>
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Space align="center">
              <OpsMateLogo size={36} />
              <Typography.Title level={3} style={{ margin: 0 }}>
                {t("login.internalTitle")}
              </Typography.Title>
            </Space>

            <Alert type="info" showIcon message={t("login.passwordAdvancedHint")} />

            <Form form={form} layout="vertical" onFinish={onFinish}>
              <Form.Item
                name="username"
                label={t("login.username")}
                rules={[{ required: true, message: t("login.usernameRequired") }]}
              >
                <Input autoComplete="username" size="large" />
              </Form.Item>
              <Form.Item
                name="password"
                label={t("login.password")}
                rules={[{ required: true, message: t("login.passwordRequired") }]}
              >
                <Input.Password autoComplete="current-password" size="large" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
                {t("login.submit")}
              </Button>
            </Form>

            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, textAlign: "center" }}>
              <Link to="/login">{t("login.backToPublicLogin")}</Link>
            </Typography.Paragraph>
          </Space>
        </Card>
      </div>
    </div>
  );
}

export default InternalLoginPage;
