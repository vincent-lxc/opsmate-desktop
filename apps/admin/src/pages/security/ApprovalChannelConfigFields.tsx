import {
  ProFormCheckbox,
  ProFormDependency,
  ProFormDigit,
  ProFormText,
} from "@ant-design/pro-components";
import { Alert, Button, Form, List, Modal, Space, Typography } from "antd";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";

export type ApprovalChannelType =
  | "web"
  | "telegram"
  | "wecom"
  | "lark"
  | "email"
  | "webhook";

/** One configuration slot per IM type (product rule). */
export const IM_CHANNEL_TYPES: ApprovalChannelType[] = [
  "telegram",
  "lark",
  "wecom",
  "email",
  "webhook",
  "web",
];

export type NotificationPurpose =
  | "l2_approval"
  | "alert"
  | "duty"
  | "incident"
  | "auth"
  | "admin_auth";

const CONFIG_KEYS: Record<ApprovalChannelType, string[]> = {
  web: [],
  telegram: ["bot_token", "bot_username", "chat_id", "callback_base_url", "webhook_secret"],
  wecom: ["webhook_url"],
  lark: ["webhook_url", "callback_base_url", "verification_token", "encrypt_key"],
  email: ["smtp_host", "smtp_port", "smtp_user", "smtp_password", "from_address", "to_addresses"],
  webhook: ["url", "secret"],
};

const SECRET_KEYS = new Set([
  "bot_token",
  "webhook_secret",
  "encrypt_key",
  "smtp_password",
  "secret",
]);

const PURPOSE_OPTIONS: NotificationPurpose[] = [
  "l2_approval",
  "alert",
  "duty",
  "incident",
  "auth",
  "admin_auth",
];

export function buildConfigFromForm(
  type: ApprovalChannelType,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS[type]) {
    const value = values[key];
    if (value !== undefined && value !== null && value !== "") {
      config[key] = value;
    }
  }
  const purposes = values.purposes;
  if (Array.isArray(purposes) && purposes.length > 0) {
    config.purposes = purposes;
  }
  return config;
}

export function configToFormValues(
  type: ApprovalChannelType,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS[type]) {
    if (SECRET_KEYS.has(key) && config[`${key}_set`]) {
      values[key] = "";
      continue;
    }
    if (config[key] !== undefined) {
      values[key] = config[key];
    }
  }
  if (Array.isArray(config.purposes)) {
    values.purposes = config.purposes;
  }
  return values;
}

type Props = {
  editingConfig?: Record<string, unknown>;
  channelId?: string;
  /** Telegram bot mode drives whether bot_token/callback fields are shown/required. */
  botMode?: "opsmate_managed" | "customer_owned" | "enterprise_dedicated";
};

type DiscoveredChat = {
  id: string;
  title: string;
  type: string;
  username: string | null;
};

export function ApprovalChannelConfigFields({ editingConfig, channelId, botMode }: Props) {
  const { t } = useTranslation();
  const NS = "security.notificationChannels.config";
  const form = Form.useFormInstance();
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discoverHint, setDiscoverHint] = useState<string | null>(null);
  const [discoveredChats, setDiscoveredChats] = useState<DiscoveredChat[]>([]);
  const isManagedTelegram = botMode === "opsmate_managed";

  const syncBotMenuMutation = useMutation({
    mutationFn: (payload: { bot_token?: string; channel_id?: string }) =>
      api<{ ok: boolean; message: string; detail?: string }>(
        "/api/security/approval-channels/telegram/sync-bot-menu",
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      ),
  });

  const discoverMutation = useMutation({
    mutationFn: (payload: { bot_token?: string; channel_id?: string }) =>
      api<{
        ok: boolean;
        chats?: DiscoveredChat[];
        hint?: string;
        message?: string;
        detail?: string;
      }>("/api/security/approval-channels/telegram/discover-chats", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
  });

  return (
    <>
      <ProFormCheckbox.Group
        name="purposes"
        label={t("security.notificationChannels.form.purposes")}
        rules={[
          {
            required: true,
            message: t("security.notificationChannels.form.purposesRequired"),
          },
        ]}
        options={PURPOSE_OPTIONS.map((purpose) => ({
          label: t(`security.notificationChannels.purposes.${purpose}`),
          value: purpose,
        }))}
        initialValue={["l2_approval", "alert"]}
      />

      <ProFormDependency name={["type", "callback_base_url"]}>
        {({ type, callback_base_url: callbackBase }) => {
          const channelType = (type ?? "web") as ApprovalChannelType;
          const callbackBaseUrl = String(callbackBase ?? editingConfig?.callback_base_url ?? "");
          const callbackPath =
            channelId && callbackBaseUrl
              ? `${callbackBaseUrl.replace(/\/+$/, "")}/api/webhooks/${channelType}/${channelId}`
              : channelId
                ? `/api/webhooks/${channelType}/${channelId}`
                : `/api/webhooks/${channelType}/{channelId}`;

          if (channelType === "web") {
            return (
              <Alert
                type="info"
                showIcon
                message={t(`${NS}.webHint`)}
                style={{ marginBottom: 16 }}
              />
            );
          }

          return (
            <>
              <Typography.Text type="secondary" style={{ display: "block", marginBottom: 12 }}>
                {t(`${NS}.sectionTitle`)}
              </Typography.Text>

              {channelType === "telegram" && (
                <>
                  {isManagedTelegram ? (
                    <Alert
                      type="info"
                      showIcon
                      message={t(`${NS}.officialBotTitle`)}
                      description={
                        <Typography.Paragraph style={{ marginBottom: 0 }}>
                          {t(`${NS}.officialBotHint`)}
                        </Typography.Paragraph>
                      }
                      style={{ marginBottom: 16 }}
                    />
                  ) : (
                    <>
                      <ProFormText.Password
                        name="bot_token"
                        label={t(`${NS}.botToken`)}
                        extra={t(`${NS}.botTokenHint`)}
                        placeholder={
                          editingConfig?.bot_token_set ? t(`${NS}.secretKeep`) : undefined
                        }
                        rules={
                          editingConfig?.bot_token_set
                            ? []
                            : [{ required: true, message: t(`${NS}.required`) }]
                        }
                      />
                      <ProFormText
                        name="bot_username"
                        label={t(`${NS}.botUsername`)}
                        placeholder={t(`${NS}.botUsernamePlaceholder`)}
                        extra={t(`${NS}.botUsernameHint`)}
                      />
                      <ProFormDependency name={["bot_token"]}>
                        {({ bot_token: botToken }) => {
                          const hasToken = Boolean(botToken) || Boolean(editingConfig?.bot_token_set);
                          return (
                            <>
                              <ProFormText
                                name="chat_id"
                                label={t(`${NS}.testChatId`)}
                                placeholder={t(`${NS}.testChatIdPlaceholder`)}
                                extra={t(`${NS}.testChatIdHint`)}
                                disabled={!hasToken}
                                rules={
                                  hasToken
                                    ? [{ required: true, message: t(`${NS}.required`) }]
                                    : []
                                }
                                addonAfter={
                                  <Button
                                    type="link"
                                    size="small"
                                    disabled={!hasToken}
                                    loading={discoverMutation.isPending}
                                    onClick={async () => {
                                      const token = String(botToken ?? "").trim();
                                      const payload =
                                        token.length > 0
                                          ? { bot_token: token }
                                          : channelId
                                            ? { channel_id: channelId }
                                            : null;
                                      if (!payload) return;
                                      try {
                                        const result = await discoverMutation.mutateAsync(payload);
                                        if (!result.ok) {
                                          Modal.error({
                                            title: t(`${NS}.discoverFailed`),
                                            content: result.detail ?? result.message,
                                          });
                                          return;
                                        }
                                        setDiscoveredChats(result.chats ?? []);
                                        setDiscoverHint(result.hint ?? null);
                                        setDiscoverOpen(true);
                                      } catch (err) {
                                        Modal.error({
                                          title: t(`${NS}.discoverFailed`),
                                          content: err instanceof Error ? err.message : String(err),
                                        });
                                      }
                                    }}
                                  >
                                    {t(`${NS}.discoverChats`)}
                                  </Button>
                                }
                              />
                              <ProFormText
                                name="callback_base_url"
                                label={t(`${NS}.callbackBaseUrl`)}
                                placeholder={t(`${NS}.callbackBaseUrlPlaceholder`)}
                                extra={t(`${NS}.telegramCallbackHint`, { path: callbackPath })}
                                disabled={!hasToken}
                                rules={
                                  hasToken
                                    ? [
                                        { required: true, message: t(`${NS}.required`) },
                                        { type: "url", message: t(`${NS}.invalidUrl`) },
                                      ]
                                    : []
                                }
                              />
                              <ProFormText.Password
                                name="webhook_secret"
                                label={t(`${NS}.telegramWebhookSecret`)}
                                placeholder={
                                  editingConfig?.webhook_secret_set
                                    ? t(`${NS}.secretKeep`)
                                    : t(`${NS}.telegramWebhookSecretHint`)
                                }
                                extra={t(`${NS}.telegramWebhookSecretExtra`)}
                                disabled={!hasToken}
                              />
                              <div style={{ marginBottom: 16 }}>
                                <Button
                                  disabled={!hasToken}
                                  loading={syncBotMenuMutation.isPending}
                                  onClick={async () => {
                                    const token = String(botToken ?? "").trim();
                                    const payload =
                                      token.length > 0
                                        ? { bot_token: token }
                                        : channelId
                                          ? { channel_id: channelId }
                                          : null;
                                    if (!payload) return;
                                    try {
                                      const result = await syncBotMenuMutation.mutateAsync(payload);
                                      if (!result.ok) {
                                        Modal.error({
                                          title: t(`${NS}.syncBotMenuFailed`),
                                          content: result.detail ?? result.message,
                                        });
                                        return;
                                      }
                                      Modal.success({
                                        title: t(`${NS}.syncBotMenuSuccess`),
                                        content: result.detail ?? result.message,
                                      });
                                    } catch (err) {
                                      Modal.error({
                                        title: t(`${NS}.syncBotMenuFailed`),
                                        content: err instanceof Error ? err.message : String(err),
                                      });
                                    }
                                  }}
                                >
                                  {t(`${NS}.syncBotMenu`)}
                                </Button>
                                <Typography.Paragraph
                                  type="secondary"
                                  style={{ marginTop: 8, marginBottom: 0 }}
                                >
                                  {t(`${NS}.syncBotMenuHint`)}
                                </Typography.Paragraph>
                              </div>
                            </>
                          );
                        }}
                      </ProFormDependency>
                    </>
                  )}
                </>
              )}

              {channelType === "wecom" && (
                <ProFormText
                  name="webhook_url"
                  label={t(`${NS}.wecomWebhook`)}
                  rules={[
                    { required: true, message: t(`${NS}.required`) },
                    { type: "url", message: t(`${NS}.invalidUrl`) },
                  ]}
                />
              )}

              {channelType === "lark" && (
                <>
                  <Typography.Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
                    {t(`${NS}.larkSendSection`)}
                  </Typography.Text>
                  <ProFormText
                    name="webhook_url"
                    label={t(`${NS}.larkWebhook`)}
                    extra={t(`${NS}.larkWebhookHint`)}
                    rules={[
                      { required: true, message: t(`${NS}.required`) },
                      { type: "url", message: t(`${NS}.invalidUrl`) },
                    ]}
                  />
                  <Typography.Text type="secondary" style={{ display: "block", margin: "12px 0 8px" }}>
                    {t(`${NS}.larkReceiveSection`)}
                  </Typography.Text>
                  <ProFormText
                    name="callback_base_url"
                    label={t(`${NS}.callbackBaseUrl`)}
                    placeholder={t(`${NS}.callbackBaseUrlPlaceholder`)}
                    extra={t(`${NS}.larkCallbackHint`, { path: callbackPath })}
                    rules={[{ type: "url", message: t(`${NS}.invalidUrl`) }]}
                  />
                  <ProFormText
                    name="verification_token"
                    label={t(`${NS}.larkVerificationToken`)}
                    extra={t(`${NS}.larkVerificationTokenHint`)}
                  />
                  <ProFormText.Password
                    name="encrypt_key"
                    label={t(`${NS}.larkEncryptKey`)}
                    placeholder={
                      editingConfig?.encrypt_key_set
                        ? t(`${NS}.secretKeep`)
                        : t(`${NS}.larkEncryptKeyHint`)
                    }
                  />
                </>
              )}

              {channelType === "email" && (
                <>
                  <ProFormText
                    name="smtp_host"
                    label={t(`${NS}.smtpHost`)}
                    rules={[{ required: true, message: t(`${NS}.required`) }]}
                  />
                  <ProFormDigit
                    name="smtp_port"
                    label={t(`${NS}.smtpPort`)}
                    min={1}
                    max={65535}
                    fieldProps={{ precision: 0 }}
                    initialValue={587}
                    rules={[{ required: true, message: t(`${NS}.required`) }]}
                  />
                  <ProFormText
                    name="smtp_user"
                    label={t(`${NS}.smtpUser`)}
                    rules={[{ required: true, message: t(`${NS}.required`) }]}
                  />
                  <ProFormText.Password
                    name="smtp_password"
                    label={t(`${NS}.smtpPassword`)}
                    placeholder={
                      editingConfig?.smtp_password_set ? t(`${NS}.secretKeep`) : undefined
                    }
                    rules={
                      editingConfig?.smtp_password_set
                        ? []
                        : [{ required: true, message: t(`${NS}.required`) }]
                    }
                  />
                  <ProFormText
                    name="from_address"
                    label={t(`${NS}.fromAddress`)}
                    rules={[
                      { required: true, message: t(`${NS}.required`) },
                      { type: "email", message: t(`${NS}.invalidEmail`) },
                    ]}
                  />
                  <ProFormText
                    name="to_addresses"
                    label={t(`${NS}.toAddresses`)}
                    extra={t(`${NS}.toAddressesHint`)}
                    rules={[{ required: true, message: t(`${NS}.required`) }]}
                  />
                </>
              )}

              {channelType === "webhook" && (
                <>
                  <ProFormText
                    name="url"
                    label={t(`${NS}.webhookUrl`)}
                    rules={[
                      { required: true, message: t(`${NS}.required`) },
                      { type: "url", message: t(`${NS}.invalidUrl`) },
                    ]}
                  />
                  <ProFormText.Password
                    name="secret"
                    label={t(`${NS}.webhookSecret`)}
                    placeholder={
                      editingConfig?.secret_set
                        ? t(`${NS}.secretKeep`)
                        : t(`${NS}.webhookSecretHint`)
                    }
                  />
                </>
              )}
            </>
          );
        }}
      </ProFormDependency>

      <Modal
        title={t(`${NS}.discoverTitle`)}
        open={discoverOpen}
        onCancel={() => setDiscoverOpen(false)}
        footer={null}
        destroyOnClose
      >
        {discoverHint ? (
          <Alert type="info" showIcon message={discoverHint} style={{ marginBottom: 12 }} />
        ) : null}
        <List
          dataSource={discoveredChats}
          locale={{ emptyText: t(`${NS}.discoverEmpty`) }}
          renderItem={(chat) => (
            <List.Item
              actions={[
                <Button
                  key="use"
                  type="link"
                  onClick={() => {
                    form?.setFieldValue?.("chat_id", chat.id);
                    setDiscoverOpen(false);
                  }}
                >
                  {t(`${NS}.useChatId`)}
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space size={8}>
                    <span>{chat.title}</span>
                    <Typography.Text type="secondary">({chat.type})</Typography.Text>
                  </Space>
                }
                description={
                  <>
                    <div>ID: {chat.id}</div>
                    {chat.username ? <div>@{chat.username}</div> : null}
                  </>
                }
              />
            </List.Item>
          )}
        />
      </Modal>
    </>
  );
}