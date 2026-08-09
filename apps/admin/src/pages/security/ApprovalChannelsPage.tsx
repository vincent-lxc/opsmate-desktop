import { ProForm, ProFormRadio, ProFormSwitch, ProFormText } from "@ant-design/pro-components";
import type { ProFormInstance } from "@ant-design/pro-components";
import { NotificationOutlined, SendOutlined, SettingOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, List, Row, Space, Tag, Typography, message, type RadioChangeEvent } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { useEntitlements } from "../../providers/EntitlementsProvider";
import {
  ApprovalChannelConfigFields,
  buildConfigFromForm,
  configToFormValues,
  IM_CHANNEL_TYPES,
  type ApprovalChannelType,
  type NotificationPurpose,
} from "./ApprovalChannelConfigFields";

type BotMode = "opsmate_managed" | "customer_owned" | "enterprise_dedicated";

type ApprovalChannelRow = {
  id: string;
  name: string;
  type: string;
  config_json: Record<string, unknown>;
  enabled: boolean;
  tenant_id?: string;
  bot_mode?: BotMode | null;
};

type ApprovalChannelFormValues = {
  name?: string;
  type: ApprovalChannelType;
  enabled: boolean;
  bot_mode?: BotMode;
  purposes?: NotificationPurpose[];
  [key: string]: unknown;
};

type OfficialBinding = {
  id: string;
  tenant_id: string;
  chat_id: string;
  bot_mode: "opsmate_managed";
  bound_by: number | null;
  bound_at: string;
  updated_at: string;
};

type OfficialStatus = {
  enabled: boolean;
  bot_username: string | null;
  bindings: OfficialBinding[];
};

const NS = "security.notificationChannels";

export function ApprovalChannelsPage() {
  const { t } = useTranslation();
  const { entitlements } = useEntitlements();
  const canUseTelegram = entitlements.features.telegram;
  const canDedicated = entitlements.features.dedicated_bot;
  const plan = entitlements.plan;
  const formRef = useRef<ProFormInstance<ApprovalChannelFormValues> | undefined>(undefined);
  /** Token used in a successful in-form test; persisted on save when the password field is left blank. */
  const pendingTestedTokenRef = useRef<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [activeType, setActiveType] = useState<ApprovalChannelType>("telegram");
  const [botMode, setBotMode] = useState<BotMode>("opsmate_managed");
  const [channelsByType, setChannelsByType] = useState<Partial<Record<ApprovalChannelType, ApprovalChannelRow>>>(
    {},
  );
  const [loading, setLoading] = useState(true);

  const editing = channelsByType[activeType] ?? null;

  const loadChannels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ items: ApprovalChannelRow[] }>(
        "/api/security/approval-channels?page=1&page_size=20",
      );
      const map: Partial<Record<ApprovalChannelType, ApprovalChannelRow>> = {};
      for (const row of res.items ?? []) {
        const type = row.type as ApprovalChannelType;
        if (IM_CHANNEL_TYPES.includes(type)) {
          map[type] = row;
        }
      }
      setChannelsByType(map);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  const testMutation = useMutation({
    mutationFn: (payload: {
      type: ApprovalChannelType;
      config_json: Record<string, unknown>;
      channel_id?: string;
    }) =>
      api<{ ok: boolean; message: string; detail?: string }>("/api/security/approval-channels/test", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
  });

  const testSavedMutation = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; message: string; detail?: string }>(
        `/api/security/approval-channels/${id}/test`,
        { method: "POST" },
      ),
  });

  const runTest = async (values: ApprovalChannelFormValues) => {
    const type = values.type;
    let config_json = buildConfigFromForm(type, values);
    if (editing) {
      for (const key of ["bot_token", "webhook_secret", "encrypt_key"]) {
        if (!config_json[key] && editing.config_json[`${key}_set`]) {
          delete config_json[key];
        }
      }
    }
    try {
      const result = await testMutation.mutateAsync({
        type,
        config_json,
        channel_id: editing?.id,
      });
      if (result.ok) {
        const testedToken = String(values.bot_token ?? "").trim();
        if (testedToken) {
          pendingTestedTokenRef.current = testedToken;
        }
        message.success(result.detail ? `${result.message} — ${result.detail}` : result.message);
      } else {
        message.error(result.detail ? `${result.message}: ${result.detail}` : result.message);
      }
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t(`${NS}.testFailed`));
    }
  };

  /** Public Free uses the official bot; Enterprise/private installs may own the bot. */
  const defaultBotModeFor = (type: ApprovalChannelType): BotMode => {
    if (type !== "telegram") return "opsmate_managed";
    return plan === "free" ? "opsmate_managed" : "customer_owned";
  };

  const openConfigure = (type: ApprovalChannelType) => {
    pendingTestedTokenRef.current = null;
    setActiveType(type);
    const existing = channelsByType[type];
    const mode = (existing?.bot_mode as BotMode | undefined) ?? defaultBotModeFor(type);
    setBotMode(mode);
    setFormOpen(true);
  };

  const editingConfigValues = editing
    ? configToFormValues(activeType, editing.config_json ?? {})
    : {};

  const isTelegramLocked = activeType === "telegram" && !canUseTelegram;

  return (
    <ModulePageShell
      icon={<NotificationOutlined style={{ fontSize: 20 }} />}
      title={t(`${NS}.title`)}
      subtitle={t(`${NS}.subtitle`)}
    >
      <Row gutter={[16, 16]}>
        {IM_CHANNEL_TYPES.map((type) => {
          const row = channelsByType[type];
          const purposes = row?.config_json?.purposes;
          const telegramLocked = type === "telegram" && !canUseTelegram;
          return (
            <Col key={type} xs={24} sm={12} lg={8}>
              <Card
                loading={loading}
                title={t(`${NS}.types.${type}`)}
                extra={
                  row?.enabled ? (
                    <Tag color="success">{t("common.yes")}</Tag>
                  ) : row ? (
                    <Tag>{t("common.no")}</Tag>
                  ) : (
                    <Tag color="default">{t(`${NS}.notConfigured`)}</Tag>
                  )
                }
                actions={[
                  row && !telegramLocked ? (
                    <Button
                      key="test"
                      type="link"
                      size="small"
                      icon={<SendOutlined />}
                      loading={testSavedMutation.isPending}
                      onClick={async () => {
                        try {
                          const result = await testSavedMutation.mutateAsync(row.id);
                          if (result.ok) {
                            message.success(
                              result.detail ? `${result.message} — ${result.detail}` : result.message,
                            );
                          } else {
                            message.error(
                              result.detail ? `${result.message}: ${result.detail}` : result.message,
                            );
                          }
                        } catch {
                          message.error(t(`${NS}.testFailed`));
                        }
                      }}
                    >
                      {t(`${NS}.actions.test`)}
                    </Button>
                  ) : (
                    <span key="test-placeholder" />
                  ),
                  <Button
                    key="configure"
                    type="link"
                    size="small"
                    icon={<SettingOutlined />}
                    disabled={telegramLocked}
                    onClick={() => openConfigure(type)}
                  >
                    {row ? t("common.edit") : t(`${NS}.configure`)}
                  </Button>,
                ]}
              >
                {telegramLocked ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={t(`${NS}.telegramLockedTitle`)}
                    description={t(`${NS}.telegramLockedHint`)}
                  />
                ) : Array.isArray(purposes) && purposes.length > 0 ? (
                  <Space size={[4, 4]} wrap>
                    {(purposes as NotificationPurpose[]).map((purpose) => (
                      <Tag key={purpose}>{t(`${NS}.purposes.${purpose}`)}</Tag>
                    ))}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">{t(`${NS}.cardNoPurposes`)}</Typography.Text>
                )}
              </Card>
            </Col>
          );
        })}
      </Row>

      <ModuleFormDrawer
        title={t(`${NS}.drawerTitle`, { type: t(`${NS}.types.${activeType}`) })}
        open={formOpen}
        onClose={() => {
          pendingTestedTokenRef.current = null;
          setFormOpen(false);
        }}
        width={560}
      >
        {isTelegramLocked ? (
          <Alert
            type="warning"
            showIcon
            message={t(`${NS}.telegramLockedTitle`)}
            description={t(`${NS}.telegramLockedHint`)}
          />
        ) : (
          <ProForm<ApprovalChannelFormValues>
            formRef={formRef}
            key={`${activeType}-${editing?.id ?? "new"}-${botMode}`}
            initialValues={
              editing
                ? {
                    type: activeType,
                    enabled: editing.enabled,
                    bot_mode: (editing.bot_mode as BotMode | undefined) ?? botMode,
                    ...editingConfigValues,
                  }
                : {
                    type: activeType,
                    enabled: true,
                    bot_mode: botMode,
                    purposes: ["l2_approval", "alert", "auth"],
                    smtp_port: 587,
                  }
            }
            submitter={{
              render: (_, dom) => (
                <Space style={{ width: "100%", justifyContent: "flex-end" }}>
                  {activeType === "telegram" && botMode !== "opsmate_managed" && (
                    <Button
                      icon={<SendOutlined />}
                      loading={testMutation.isPending}
                      onClick={async () => {
                        const values = await formRef.current?.validateFieldsReturnFormatValue?.();
                        if (!values) return;
                        await runTest({ ...values, type: activeType } as ApprovalChannelFormValues);
                      }}
                    >
                      {t(`${NS}.actions.test`)}
                    </Button>
                  )}
                  {dom}
                </Space>
              ),
              searchConfig: { submitText: t("common.save") },
            }}
            onFinish={async (values) => {
              const config_json = buildConfigFromForm(activeType, { ...values, type: activeType });
              if (
                activeType === "telegram" &&
                botMode !== "opsmate_managed" &&
                !config_json.bot_token &&
                pendingTestedTokenRef.current
              ) {
                config_json.bot_token = pendingTestedTokenRef.current;
              }
              const payload: {
                name: string;
                type: ApprovalChannelType;
                enabled: boolean;
                config_json: Record<string, unknown>;
                bot_mode?: BotMode;
              } = {
                name: t(`${NS}.types.${activeType}`),
                type: activeType,
                enabled: values.enabled,
                config_json,
              };
              if (activeType === "telegram" && values.bot_mode) {
                payload.bot_mode = values.bot_mode as BotMode;
              }
              try {
                type SaveResult = ApprovalChannelRow & {
                  webhook_sync?: {
                    ok: boolean;
                    message: string;
                    detail?: string;
                    bot_menu_sync?: { ok: boolean; message: string; detail?: string };
                  };
                };
                let saveResult: SaveResult;
                if (editing) {
                  saveResult = await api<SaveResult>(`/api/security/approval-channels/${editing.id}`, {
                    method: "PATCH",
                    body: JSON.stringify(payload),
                  });
                  message.success(t(`${NS}.saved`));
                } else {
                  saveResult = await api<SaveResult>("/api/security/approval-channels", {
                    method: "POST",
                    body: JSON.stringify(payload),
                  });
                  message.success(t(`${NS}.created`));
                }
                if (activeType === "telegram" && saveResult.webhook_sync && !saveResult.webhook_sync.ok) {
                  message.warning(
                    saveResult.webhook_sync.detail ?? saveResult.webhook_sync.message,
                  );
                } else if (activeType === "telegram" && saveResult.webhook_sync?.ok) {
                  const menu = saveResult.webhook_sync.bot_menu_sync;
                  const menuNote =
                    menu?.ok && menu.detail
                      ? ` · 菜单: ${menu.detail}`
                      : menu && !menu.ok
                        ? ` · 菜单同步失败: ${menu.detail ?? menu.message}`
                        : "";
                  message.info(
                    `${saveResult.webhook_sync.detail ?? saveResult.webhook_sync.message}${menuNote}`,
                  );
                }
                pendingTestedTokenRef.current = null;
                await loadChannels();
                setFormOpen(false);
                return true;
              } catch (err) {
                message.error(err instanceof ApiError ? err.message : t("common.error"));
                return false;
              }
            }}
          >
            <ProFormText name="type" hidden />
            <ProFormSwitch name="enabled" label={t(`${NS}.form.enabled`)} />

            {activeType === "telegram" && (
              <ProFormRadio.Group
                name="bot_mode"
                label={t(`${NS}.form.botMode`)}
                tooltip={t(`${NS}.form.botModeHint`)}
                options={[
                  { label: t(`${NS}.form.botModeOfficial`), value: "opsmate_managed" },
                  { label: t(`${NS}.form.botModeCustomer`), value: "customer_owned" },
                  ...(canDedicated
                    ? [{ label: t(`${NS}.form.botModeDedicated`), value: "enterprise_dedicated" as const }]
                    : []),
                ]}
                fieldProps={{
                  onChange: (e: RadioChangeEvent) => setBotMode(e.target.value as BotMode),
                }}
              />
            )}

            {activeType === "telegram" && botMode === "opsmate_managed" && (
              <OfficialTelegramBindPanel />
            )}

            <ApprovalChannelConfigFields
              editingConfig={editing?.config_json}
              channelId={editing?.id}
              botMode={botMode}
            />
          </ProForm>
        )}
      </ModuleFormDrawer>
    </ModulePageShell>
  );
}

/**
 * Official-bot bind panel for opsmate_managed telegram channels. Fetches the
 * tenant's official-bot status (deep link + bound chats) and lets the user
 * unbind a chat. The chat→tenant binding itself is recorded by the official
 * webhook when the user completes /bind in-DM — this panel only displays state
 * and initiates the deep link (R14: tenant claim never trusted from client).
 */
function OfficialTelegramBindPanel() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<OfficialStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<OfficialStatus>(
        "/api/security/approval-channels/telegram/official/status",
      );
      setStatus(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const unbind = async (chatId: string) => {
    try {
      await api("/api/security/approval-channels/telegram/official/bind", {
        method: "DELETE",
        body: JSON.stringify({ chat_id: chatId }),
      });
      message.success(t(`${NS}.officialUnbound`));
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : t("common.error"));
    }
  };

  if (loading) {
    return <Typography.Text type="secondary">{t(`${NS}.officialLoading`)}</Typography.Text>;
  }
  if (error) {
    return <Alert type="error" showIcon message={error} />;
  }
  if (!status?.enabled) {
    return (
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message={t(`${NS}.officialUnavailableTitle`)}
        description={t(`${NS}.officialUnavailableHint`)}
      />
    );
  }

  const deepLink = status.bot_username
    ? `https://t.me/${status.bot_username}?start=bind`
    : null;

  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 16 }}
      message={t(`${NS}.officialBindTitle`)}
      description={
        <div>
          <Typography.Paragraph style={{ marginBottom: 8 }}>
            {t(`${NS}.officialBindHint`)}
          </Typography.Paragraph>
          {deepLink && (
            <Space direction="vertical" size={4} style={{ marginBottom: 8 }}>
              <Typography.Text type="secondary">
                @{status.bot_username} · {t(`${NS}.officialBindCommand`)}: /bind
              </Typography.Text>
              <a href={deepLink} target="_blank" rel="noreferrer">
                {deepLink}
              </a>
            </Space>
          )}
          {status.bindings.length > 0 ? (
            <List
              size="small"
              dataSource={status.bindings}
              renderItem={(binding) => (
                <List.Item
                  actions={[
                    <Button
                      key="unbind"
                      type="link"
                      size="small"
                      danger
                      onClick={() => void unbind(binding.chat_id)}
                    >
                      {t(`${NS}.officialUnbind`)}
                    </Button>,
                  ]}
                >
                  <Typography.Text>
                    {t(`${NS}.officialBoundChat`)}: {binding.chat_id}
                  </Typography.Text>
                </List.Item>
              )}
            />
          ) : (
            <Typography.Text type="secondary">{t(`${NS}.officialNoBindings`)}</Typography.Text>
          )}
        </div>
      }
    />
  );
}
