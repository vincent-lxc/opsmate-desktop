import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Col,
  Form,
  Input,
  Menu,
  Modal,
  Row,
  Spin,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import type { MenuProps } from "antd";
import {
  CopyOutlined,
  LinkOutlined,
  LockOutlined,
  CreditCardOutlined,
  ReloadOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { ProCard, ProDescriptions } from "@ant-design/pro-components";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { formatDateTime } from "../utils/datetime";
import { ModulePageShell } from "../components/ModulePageShell";
import { useEntitlements } from "../providers/EntitlementsProvider";
import { clearMustChangePassword, getRole, setAuthSession } from "../services/auth/roles";
import { AccountSubscriptionPanel } from "../components/AccountSubscriptionPanel";
import { isDesktopRuntime } from "../desktop/tauri-bridge";

type Profile = {
  username: string;
  role: string;
  display_name?: string;
  telegram_user_id?: number;
  has_password: boolean;
  must_change_password?: boolean;
  last_login_at?: string;
};

type BindSession = {
  session_id: string;
  qr_url: string;
  bot_username: string;
  bot_chat_url?: string;
  bind_command?: string;
  expires_at?: string;
  webhook_ready?: boolean;
  webhook_sync?: { ok: boolean; message: string; detail?: string };
};

type BindStatus = {
  status: "pending" | "consumed" | "expired";
  user?: Profile;
  session?: { token: string; username: string; role: string; must_change_password?: boolean };
};

type SettingsTab = "base" | "security" | "binding" | "subscription";

export function AccountPage() {
  const { t } = useTranslation();
  const { entitlements } = useEntitlements();
  const canUseTelegram = entitlements.features.telegram;
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const tab = searchParams.get("tab");
    if (tab === "security" || tab === "binding" || tab === "subscription") return tab;
    return "base";
  });
  const [profile, setProfile] = useState<Profile | null>(null);
  const [bindSession, setBindSession] = useState<BindSession | null>(null);
  const [bindStatus, setBindStatus] = useState<BindStatus["status"]>("pending");
  const [loading, setLoading] = useState(true);
  const [bindLoading, setBindLoading] = useState(false);
  const [pwdSubmitting, setPwdSubmitting] = useState(false);
  const [rebinding, setRebinding] = useState(false);
  const [unbindModalOpen, setUnbindModalOpen] = useState(false);
  const [unbindSubmitting, setUnbindSubmitting] = useState(false);
  const [form] = Form.useForm();
  const [unbindForm] = Form.useForm();
  const pollRef = useRef<number | null>(null);

  const showBindFlow = !profile?.telegram_user_id || rebinding;
  const menuItems: MenuProps["items"] = [
    { key: "base", icon: <UserOutlined />, label: t("account.tab.base") },
    { key: "security", icon: <LockOutlined />, label: t("account.tab.security") },
    { key: "binding", icon: <LinkOutlined />, label: t("account.tab.binding") },
    { key: "subscription", icon: <CreditCardOutlined />, label: t("account.tab.subscription") },
  ];

  const loadProfile = useCallback(
    () =>
      api<Profile>("/api/auth/me")
        .then(setProfile)
        .catch((err: Error) => message.error(err.message || t("account.loadFailed"))),
    [t],
  );

  const startBindSession = useCallback(async () => {
    setBindLoading(true);
    try {
      const data = await api<BindSession>("/api/auth/me/telegram/bind", { method: "POST" });
      setBindSession(data);
      setBindStatus("pending");
      if (!data.webhook_ready) {
        message.warning(
          data.webhook_sync?.detail ?? data.webhook_sync?.message ?? t("account.bindWebhookHint"),
        );
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("account.bindCodeFailed"));
    } finally {
      setBindLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadProfile().finally(() => setLoading(false));
  }, [loadProfile]);

  useEffect(() => {
    // A platform menu/profile may disable Telegram; only start the flow when
    // the current access profile enables it.
    if (activeTab !== "binding" || loading || !showBindFlow || !canUseTelegram) return;
    if (!bindSession) void startBindSession();
  }, [activeTab, loading, showBindFlow, canUseTelegram, bindSession, startBindSession]);

  useEffect(() => {
    if (!bindSession?.session_id || bindStatus !== "pending" || !showBindFlow) return;
    const poll = async () => {
      try {
        const data = await api<BindStatus>(`/api/auth/me/telegram/bind/${bindSession.session_id}`);
        setBindStatus(data.status);
        if (data.status === "expired") {
          setBindSession(null);
          message.warning(t("account.bindExpired"));
        } else if (data.status === "consumed" && data.user) {
          if (data.session?.token) {
            setAuthSession(
              data.session.token,
              getRole(),
              data.user.username,
              data.session.must_change_password,
            );
          }
          setProfile(data.user);
          setBindSession(null);
          setRebinding(false);
          message.success(rebinding ? t("account.rebindSuccess") : t("account.bindSuccess"));
        }
      } catch {
        // transient poll errors
      }
    };
    poll();
    pollRef.current = window.setInterval(poll, 2000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [bindSession?.session_id, bindStatus, showBindFlow, rebinding, t]);

  const onUnbind = async (values: { current_password?: string }) => {
    setUnbindSubmitting(true);
    try {
      const data = await api<{ token: string; user: Profile; message: string }>("/api/auth/me/telegram", {
        method: "DELETE",
        body: JSON.stringify({ current_password: values.current_password }),
      });
      setAuthSession(data.token, getRole(), data.user.username);
      setProfile(data.user);
      setRebinding(false);
      setBindSession(null);
      setUnbindModalOpen(false);
      unbindForm.resetFields();
      message.success(t("account.unbindSuccess"));
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("account.unbindFailed"));
    } finally {
      setUnbindSubmitting(false);
    }
  };

  const startRebind = () => {
    setRebinding(true);
    setBindSession(null);
    setBindStatus("pending");
    void startBindSession();
  };

  const cancelRebind = () => {
    setRebinding(false);
    setBindSession(null);
    setBindStatus("pending");
  };

  const onPasswordFinish = async (values: {
    current_password?: string;
    new_password: string;
    confirm_password: string;
  }) => {
    if (values.new_password !== values.confirm_password) {
      message.error(t("account.passwordMismatch"));
      return;
    }
    setPwdSubmitting(true);
    try {
      const data = await api<{ token: string; message: string; must_change_password?: boolean }>(
        "/api/auth/me/password",
        {
          method: "PATCH",
          body: JSON.stringify({
            current_password: values.current_password,
            new_password: values.new_password,
          }),
        },
      );
      setAuthSession(data.token, getRole(), profile?.username, data.must_change_password);
      clearMustChangePassword();
      message.success(t("account.passwordUpdated"));
      form.resetFields();
      await loadProfile();
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("account.passwordUpdateFailed"));
    } finally {
      setPwdSubmitting(false);
    }
  };

  return (
    <ModulePageShell icon={<UserOutlined style={{ fontSize: 20 }} />} title={t("account.title")}>
      <Row gutter={24}>
        <Col xs={24} md={6}>
          <Menu
            mode="inline"
            selectedKeys={[activeTab]}
            items={menuItems}
            onClick={({ key }) => {
              const tab = key as SettingsTab;
              setActiveTab(tab);
              const next = new URLSearchParams(searchParams);
              next.set("tab", tab);
              setSearchParams(next, { replace: true });
            }}
          />
        </Col>
        <Col xs={24} md={18}>
          {loading ? (
            <Spin />
          ) : (
            <>
              {activeTab === "base" && profile ? (
                <ProCard>
                  <ProDescriptions column={1}>
                    <ProDescriptions.Item label={t("account.username")}>
                      {profile.username}
                    </ProDescriptions.Item>
                    <ProDescriptions.Item label={t("account.role")}>
                      {t(`role.${profile.role}`, { defaultValue: profile.role })}
                    </ProDescriptions.Item>
                    <ProDescriptions.Item label={t("account.telegram")}>
                      {profile.telegram_user_id ? (
                        <Tag color="success">{profile.telegram_user_id}</Tag>
                      ) : (
                        <Tag>{t("account.notBound")}</Tag>
                      )}
                    </ProDescriptions.Item>
                    <ProDescriptions.Item label={t("account.lastLogin")}>
                      {formatDateTime(profile.last_login_at)}
                    </ProDescriptions.Item>
                  </ProDescriptions>
                </ProCard>
              ) : null}

              {activeTab === "security" ? (
                <ProCard title={t("account.changePassword")}>
                  {profile?.must_change_password ? (
                    <Alert type="warning" showIcon message={t("account.mustChangePassword")} style={{ marginBottom: 16 }} />
                  ) : null}
                  <Form form={form} layout="vertical" onFinish={onPasswordFinish}>
                    {!profile?.must_change_password ? (
                      <Form.Item name="current_password" label={t("account.currentPassword")}>
                        <Input.Password />
                      </Form.Item>
                    ) : null}
                    <Form.Item
                      name="new_password"
                      label={t("account.newPassword")}
                      rules={[{ required: true, min: 6 }]}
                    >
                      <Input.Password />
                    </Form.Item>
                    <Form.Item
                      name="confirm_password"
                      label={t("account.confirmPassword")}
                      rules={[{ required: true, min: 6 }]}
                    >
                      <Input.Password />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" loading={pwdSubmitting}>
                      {t("account.savePassword")}
                    </Button>
                  </Form>
                </ProCard>
              ) : null}

              {activeTab === "binding" ? (
                <ProCard title={t("account.bindTelegram")}>
                  <Space direction="vertical" style={{ width: "100%" }} size="middle">
                    {!canUseTelegram ? (
                      <Alert
                        type="warning"
                        showIcon
                        message={t("account.telegramLockedTitle")}
                        description={t("account.telegramLockedHint")}
                      />
                    ) : null}

                    {canUseTelegram && profile?.telegram_user_id && !rebinding ? (
                      <>
                        <Alert
                          type="success"
                          showIcon
                          message={t("account.alreadyBound")}
                          description={
                            <span>
                              {t("account.boundAs")}: <Tag color="success">{profile.telegram_user_id}</Tag>
                            </span>
                          }
                        />
                        <Space wrap>
                          <Button onClick={startRebind}>{t("account.changeBind")}</Button>
                          {profile.has_password ? (
                            <Button danger onClick={() => setUnbindModalOpen(true)}>
                              {t("account.unbindTelegram")}
                            </Button>
                          ) : (
                            <Alert type="warning" showIcon message={t("account.unbindNeedsPassword")} />
                          )}
                        </Space>
                      </>
                    ) : null}

                    {canUseTelegram && showBindFlow ? (
                      <>
                        {rebinding ? (
                          <Alert type="info" showIcon message={t("account.rebindHint")} />
                        ) : null}
                        {rebinding ? (
                          <Button onClick={cancelRebind}>{t("account.cancelChangeBind")}</Button>
                        ) : null}
                        {bindSession?.webhook_ready === false ? (
                          <Alert type="warning" showIcon message={t("account.bindWebhookHint")} />
                        ) : null}
                        <Button icon={<ReloadOutlined />} loading={bindLoading} onClick={() => void startBindSession()}>
                          {t("account.refreshBind")}
                        </Button>
                        {bindSession ? (
                          <>
                            {/*
                              Desktop: never navigate to backend qr_url (arbitrary host) and
                              never forward it to the native opener. Browser keeps existing href.
                              Start/poll/unbind stay on the native cloud proxy API paths.
                            */}
                            {isDesktopRuntime() ? (
                              <Button
                                type="primary"
                                onClick={() => {
                                  // Copy only — never open qr_url / bot_chat_url via native opener.
                                  const cmd = bindSession.bind_command?.trim();
                                  if (cmd) {
                                    void navigator.clipboard.writeText(cmd).then(() => {
                                      message.success(t("account.copyTelegramBindSuccess"));
                                    });
                                  } else {
                                    message.warning(t("account.copyTelegramBindUnavailable"));
                                  }
                                }}
                              >
                                {t("account.copyTelegramBindCommand")}
                              </Button>
                            ) : (
                              <Button
                                type="primary"
                                href={bindSession.qr_url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {t("account.openTelegramBind")}
                              </Button>
                            )}
                            {bindSession.bind_command ? (
                              <Alert
                                type="info"
                                showIcon
                                message={t("account.bindCommandTitle")}
                                description={
                                  <Space direction="vertical" size="small">
                                    <span>
                                      <code>{bindSession.bind_command}</code>
                                      <Button
                                        type="text"
                                        size="small"
                                        icon={<CopyOutlined />}
                                        onClick={() => {
                                          void navigator.clipboard.writeText(bindSession.bind_command ?? "");
                                          message.success(t("account.copied"));
                                        }}
                                      />
                                    </span>
                                    {isDesktopRuntime() ? (
                                      <Typography.Text>
                                        @{bindSession.bot_username}
                                      </Typography.Text>
                                    ) : (
                                      <Typography.Link href={bindSession.bot_chat_url} target="_blank">
                                        @{bindSession.bot_username}
                                      </Typography.Link>
                                    )}
                                  </Space>
                                }
                              />
                            ) : null}
                            {bindStatus === "pending" ? (
                              <Alert type="info" showIcon message={t("account.waitingBind")} />
                            ) : null}
                            {bindStatus === "expired" ? (
                              <Alert type="warning" showIcon message={t("account.bindExpired")} />
                            ) : null}
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </Space>

                  <Modal
                    title={t("account.unbindTitle")}
                    open={unbindModalOpen}
                    onCancel={() => {
                      setUnbindModalOpen(false);
                      unbindForm.resetFields();
                    }}
                    footer={null}
                    destroyOnClose
                  >
                    <Typography.Paragraph>{t("account.unbindConfirm")}</Typography.Paragraph>
                    <Form form={unbindForm} layout="vertical" onFinish={onUnbind}>
                      <Form.Item
                        name="current_password"
                        label={t("account.unbindPassword")}
                        rules={[{ required: true }]}
                      >
                        <Input.Password />
                      </Form.Item>
                      <Space>
                        <Button
                          onClick={() => {
                            setUnbindModalOpen(false);
                            unbindForm.resetFields();
                          }}
                        >
                          {t("common.cancel")}
                        </Button>
                        <Button type="primary" danger htmlType="submit" loading={unbindSubmitting}>
                          {t("account.unbindTelegram")}
                        </Button>
                      </Space>
                    </Form>
                  </Modal>
                </ProCard>
              ) : null}

              {activeTab === "subscription" && profile ? (
                <AccountSubscriptionPanel
                  role={profile.role}
                  checkoutSuccess={searchParams.get("checkout") === "success"}
                />
              ) : null}
            </>
          )}
        </Col>
      </Row>
    </ModulePageShell>
  );
}

export default AccountPage;
