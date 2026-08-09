import { ProForm, ProFormSelect, ProFormText, ProTable } from "@ant-design/pro-components";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { DesktopOutlined, DownloadOutlined, KeyOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, App, Button, Popconfirm, Space, Tag } from "antd";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { ConfirmDeleteButton } from "../../components/ConfirmDeleteButton";
import { ModuleFormDrawer } from "../../components/ModuleFormDrawer";
import { ModulePageShell } from "../../components/ModulePageShell";
import { ModuleTableCard } from "../../components/ModuleTableCard";
import {
  moduleNestedTableProps,
  moduleProTableProps,
  moduleTableDetailIndent,
  moduleTableExpandable,
  moduleTablePagination,
} from "../../components/module-table-styles";
import {
  deviceStateFromVault,
  isDesktopRuntime,
  requestCloudDelete,
  requestCloudUpload,
  vaultDeleteLocal,
  vaultImport,
  vaultInit,
  vaultListMeta,
  vaultLock,
  vaultReset,
  vaultStatus,
  vaultUnlock,
  type VaultMetaItemDto,
  type VaultStatusDto,
} from "../../desktop/tauri-bridge";
import { formatDateTime } from "../../utils/datetime";

/** Client-derived device custody (never server authority). Browser default: missing. */
export type DeviceCredentialState = "available" | "missing" | "locked";

export type CredentialRow = {
  id: string;
  name: string;
  storage_mode: string;
  /** Backend authority: cloud holds at-rest ciphertext. */
  has_cloud_secret: boolean;
  scope_kind: string | null;
  scope_id: string | null;
  fingerprint: string | null;
  last_used_at: string | null;
  binding_count: number;
  environment_classification?: string | null;
};

type UsageLogRow = {
  id: string;
  action: string;
  server_id: string | null;
  created_at: string;
};

export const DESKTOP_OPEN_HREF = "opsmate://credentials";
export const DEFAULT_DESKTOP_DOWNLOAD_URL = "https://www.itops.sh/download";

/**
 * Safe HTTPS download URL; optional env only if it is a syntactically valid
 * absolute HTTPS URL with a non-empty hostname. Otherwise fall back.
 */
export function buildDesktopDownloadUrl(envValue?: string | null): string {
  const raw = (envValue ?? "").trim();
  if (!raw) return DEFAULT_DESKTOP_DOWNLOAD_URL;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return DEFAULT_DESKTOP_DOWNLOAD_URL;
    if (!parsed.hostname) return DEFAULT_DESKTOP_DOWNLOAD_URL;
    return parsed.toString();
  } catch {
    return DEFAULT_DESKTOP_DOWNLOAD_URL;
  }
}

export function resolveDeviceCredentialState(
  deviceState?: DeviceCredentialState | null,
): DeviceCredentialState {
  if (deviceState === "available" || deviceState === "locked" || deviceState === "missing") {
    return deviceState;
  }
  return "missing";
}

/** Backend v2 environment_classification enum (exact set). */
export const ENVIRONMENT_CLASSIFICATIONS = [
  "test",
  "staging",
  "production",
  "unknown",
] as const;

export type EnvironmentClassification = (typeof ENVIRONMENT_CLASSIFICATIONS)[number];

export function isEnvironmentClassification(
  value: unknown,
): value is EnvironmentClassification {
  return (
    typeof value === "string" &&
    (ENVIRONMENT_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

/**
 * Whitelist non-secret metadata for create/PATCH.
 * Never includes storage_mode, secrets, scope_*, has_cloud_secret, etc.
 * environment_classification only when in the backend enum.
 */
export function buildSafeCredentialMetadataBody(
  values: Record<string, unknown>,
): { name: string; environment_classification?: EnvironmentClassification } {
  const name = String(values.name ?? "").trim();
  const body: { name: string; environment_classification?: EnvironmentClassification } = {
    name,
  };
  if (isEnvironmentClassification(values.environment_classification)) {
    body.environment_classification = values.environment_classification;
  }
  return body;
}

const EXPANDED_DETAIL_CLASS = "module-table-detail-panel";
const EXPANDED_DETAIL_STYLE = { paddingLeft: moduleTableDetailIndent } as const;

/**
 * Pure custody presentation: cloud dimension from server `has_cloud_secret`,
 * this-device dimension from optional client-supplied state (Tauri later).
 */
export function CredentialCustodyPresentation({
  hasCloudSecret,
  deviceState,
  storageMode,
}: {
  hasCloudSecret: boolean;
  deviceState?: DeviceCredentialState | null;
  storageMode?: string;
}) {
  const { t } = useTranslation();
  const device = resolveDeviceCredentialState(deviceState);
  const isExternal = storageMode === "external_reference";

  const deviceLabel =
    device === "available"
      ? t("security.credentials.custody.deviceAvailable")
      : device === "locked"
        ? t("security.credentials.custody.deviceLocked")
        : t("security.credentials.custody.deviceMissing");

  const deviceColor =
    device === "available" ? "success" : device === "locked" ? "warning" : "default";

  return (
    <Space size={4} wrap orientation="vertical" style={{ rowGap: 4 }}>
      <span data-testid="custody-cloud">
        <Tag color={hasCloudSecret ? "blue" : "default"}>
          {t("security.credentials.custody.cloud")}:{" "}
          {hasCloudSecret
            ? t("security.credentials.custody.cloudYes")
            : t("security.credentials.custody.cloudNo")}
        </Tag>
      </span>
      <span data-testid="custody-device">
        <Tag color={deviceColor}>
          {t("security.credentials.custody.device")}: {deviceLabel}
        </Tag>
      </span>
      {isExternal ? (
        <span data-testid="custody-external">
          <Tag color="purple">{t("security.credentials.custody.externalCompat")}</Tag>
        </span>
      ) : null}
    </Space>
  );
}

function CredentialUsageExpand({ credentialId }: { credentialId: string }) {
  const { t } = useTranslation();

  const { data, isLoading } = useQuery({
    queryKey: ["credential-usage", credentialId],
    queryFn: () =>
      api<{ items: UsageLogRow[]; total: number }>(
        `/api/security/credentials/${credentialId}/usage`,
      ),
  });

  return (
    <div className={EXPANDED_DETAIL_CLASS} style={EXPANDED_DETAIL_STYLE}>
      <ProTable<UsageLogRow>
        {...moduleNestedTableProps}
        rowKey="id"
        loading={isLoading}
        dataSource={data?.items ?? []}
        locale={{ emptyText: t("security.credentials.usage.empty") }}
        columns={[
          {
            title: t("security.credentials.usage.columns.time"),
            dataIndex: "created_at",
            width: 170,
            render: (_, row) => formatDateTime(row.created_at),
          },
          { title: t("security.credentials.usage.columns.action"), dataIndex: "action", width: 140 },
          {
            title: t("security.credentials.usage.columns.server"),
            dataIndex: "server_id",
            ellipsis: true,
          },
        ]}
      />
    </div>
  );
}

export type CredentialsPageProps = {
  /**
   * Optional client-side device custody lookup (Tauri Stronghold).
   * Browser omits this → every row renders as device missing.
   */
  getDeviceState?: (credentialId: string) => DeviceCredentialState | undefined;
};

export function CredentialsPage({ getDeviceState }: CredentialsPageProps = {}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const actionRef = useRef<ActionType>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CredentialRow | null>(null);
  // Re-check each render so tests / late desktop runtime detection are observed.
  const desktop = isDesktopRuntime();
  const [vault, setVault] = useState<VaultStatusDto | null>(null);
  const [localMeta, setLocalMeta] = useState<Map<string, VaultMetaItemDto>>(new Map());
  const [vaultBusy, setVaultBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const downloadUrl = buildDesktopDownloadUrl(
    typeof import.meta.env.VITE_DESKTOP_DOWNLOAD_URL === "string"
      ? import.meta.env.VITE_DESKTOP_DOWNLOAD_URL
      : undefined,
  );

  const reloadTable = () => {
    actionRef.current?.reload();
  };

  const refreshLocalVault = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    try {
      const status = await vaultStatus();
      setVault(status);
      if (status.unlocked) {
        const items = await vaultListMeta();
        const map = new Map<string, VaultMetaItemDto>();
        for (const item of items) {
          map.set(item.credentialId, item);
        }
        setLocalMeta(map);
      } else {
        setLocalMeta(new Map());
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      message.error(msg || t("security.credentials.desktop.vaultError"));
    }
    // message/t intentionally omitted: antd message helpers are stable enough;
    // including them re-creates this callback every render and can loop useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- desktop-only vault refresh
  }, []);

  useEffect(() => {
    if (!desktop) return;
    void refreshLocalVault();
  }, [desktop, refreshLocalVault]);

  const resolveDevice = useCallback(
    (credentialId: string): DeviceCredentialState | undefined => {
      if (getDeviceState) return getDeviceState(credentialId);
      if (!desktop) return undefined;
      return deviceStateFromVault(Boolean(vault?.unlocked), localMeta, credentialId);
    },
    [desktop, getDeviceState, localMeta, vault?.unlocked],
  );

  const runVaultAction = async (fn: () => Promise<unknown>, okKey: string) => {
    setVaultBusy(true);
    try {
      await fn();
      message.success(t(okKey));
      await refreshLocalVault();
      reloadTable();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      message.error(msg || t("security.credentials.desktop.actionFailed"));
    } finally {
      setVaultBusy(false);
    }
  };

  const runRowAction = async (
    credentialId: string,
    fn: () => Promise<unknown>,
    okKey: string,
  ) => {
    setRowBusy(credentialId);
    try {
      await fn();
      message.success(t(okKey));
      await refreshLocalVault();
      reloadTable();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      message.error(msg || t("security.credentials.desktop.actionFailed"));
    } finally {
      setRowBusy(null);
    }
  };

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/security/credentials/metadata", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      message.success(t("security.credentials.saved"));
      setFormOpen(false);
      reloadTable();
    },
    onError: () => message.error(t("common.error")),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/api/security/credentials/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      message.success(t("security.credentials.saved"));
      setFormOpen(false);
      setEditing(null);
      reloadTable();
    },
    onError: () => message.error(t("common.error")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/api/security/credentials/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      message.success(t("security.credentials.deleted"));
      reloadTable();
    },
    onError: () => message.error(t("common.error")),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; message: string }>(`/api/security/credentials/${id}/test-connection`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      message.success(result.message);
      reloadTable();
    },
    onError: () => message.error(t("common.error")),
  });

  // Keep column defs free of mutation object identity so ProTable does not
  // re-init in a render loop under jsdom (ResizeObserver + fixed columns).
  const testPending = testMutation.isPending;
  const columns = useMemo<ProColumns<CredentialRow>[]>(
    () => [
      { title: t("security.credentials.columns.name"), dataIndex: "name", ellipsis: true },
      {
        title: t("security.credentials.columns.custody"),
        dataIndex: "has_cloud_secret",
        width: 220,
        search: false,
        render: (_, row) => (
          <CredentialCustodyPresentation
            hasCloudSecret={Boolean(row.has_cloud_secret)}
            deviceState={resolveDevice(row.id)}
            storageMode={row.storage_mode}
          />
        ),
      },
      {
        title: t("security.credentials.columns.scope"),
        dataIndex: "scope_kind",
        width: 140,
        search: false,
        render: (_, row) =>
          row.scope_kind
            ? `${t(`security.credentials.scopes.${row.scope_kind}`)}${row.scope_id ? ` / ${row.scope_id}` : ""}`
            : "—",
      },
      {
        title: t("security.credentials.columns.fingerprint"),
        dataIndex: "fingerprint",
        ellipsis: true,
        search: false,
      },
      {
        title: t("security.credentials.columns.bindings"),
        dataIndex: "binding_count",
        width: 90,
        search: false,
      },
      {
        title: t("security.credentials.columns.lastUsed"),
        dataIndex: "last_used_at",
        width: 170,
        search: false,
        render: (_, row) =>
          row.last_used_at ? formatDateTime(row.last_used_at) : "—",
      },
      {
        title: t("common.actions"),
        width: desktop ? 420 : 280,
        search: false,
        render: (_, row) => {
          const device = resolveDevice(row.id) ?? "missing";
          const busy = rowBusy === row.id;
          const canImportLocal = desktop && vault?.unlocked && device === "missing";
          const canDeleteLocal = desktop && vault?.unlocked && device === "available";
          const canUploadCloud =
            desktop && vault?.unlocked && device === "available" && !row.has_cloud_secret;
          const canDeleteCloud = desktop && Boolean(row.has_cloud_secret);

          return (
            <Space size={4} wrap>
              {row.has_cloud_secret ? (
                <Button
                  size="small"
                  data-testid={`credential-test-${row.id}`}
                  loading={testPending}
                  onClick={() => testMutation.mutate(row.id)}
                >
                  {t("security.credentials.actions.test")}
                </Button>
              ) : !desktop ? (
                <span
                  data-testid={`credential-local-guide-${row.id}`}
                  style={{ fontSize: 12, color: "rgba(0,0,0,0.45)" }}
                >
                  {t("security.credentials.cta.localOnlyGuide")}
                </span>
              ) : null}
              {canImportLocal ? (
                <Button
                  size="small"
                  data-testid={`credential-import-local-${row.id}`}
                  loading={busy}
                  onClick={() =>
                    void runRowAction(
                      row.id,
                      () => vaultImport(row.id),
                      "security.credentials.desktop.importLocalOk",
                    )
                  }
                >
                  {t("security.credentials.desktop.importLocal")}
                </Button>
              ) : null}
              {canDeleteLocal ? (
                <Popconfirm
                  title={t("security.credentials.desktop.deleteLocalConfirmTitle")}
                  description={
                    row.has_cloud_secret
                      ? t("security.credentials.desktop.deleteLocalConfirmWithCloud")
                      : t("security.credentials.desktop.deleteLocalConfirmNoCloud")
                  }
                  okText={t("common.yes")}
                  cancelText={t("common.cancel")}
                  getPopupContainer={() => document.body}
                  okButtonProps={{
                    danger: true,
                    "data-testid": `credential-delete-local-ok-${row.id}`,
                  }}
                  cancelButtonProps={{
                    "data-testid": `credential-delete-local-cancel-${row.id}`,
                  }}
                  onConfirm={() =>
                    void runRowAction(
                      row.id,
                      () => vaultDeleteLocal(row.id),
                      "security.credentials.desktop.deleteLocalOk",
                    )
                  }
                >
                  <Button
                    size="small"
                    danger
                    data-testid={`credential-delete-local-${row.id}`}
                    loading={busy}
                  >
                    {t("security.credentials.desktop.deleteLocal")}
                  </Button>
                </Popconfirm>
              ) : null}
              {canUploadCloud ? (
                <Button
                  size="small"
                  type="primary"
                  data-testid={`credential-upload-cloud-${row.id}`}
                  loading={busy}
                  onClick={() =>
                    void runRowAction(
                      row.id,
                      () => requestCloudUpload(row.id),
                      "security.credentials.desktop.uploadCloudOk",
                    )
                  }
                >
                  {t("security.credentials.desktop.uploadCloud")}
                </Button>
              ) : null}
              {canDeleteCloud ? (
                <Button
                  size="small"
                  danger
                  data-testid={`credential-delete-cloud-${row.id}`}
                  loading={busy}
                  onClick={() =>
                    void runRowAction(
                      row.id,
                      () => requestCloudDelete(row.id),
                      "security.credentials.desktop.deleteCloudOk",
                    )
                  }
                >
                  {t("security.credentials.desktop.deleteCloud")}
                </Button>
              ) : null}
              <Button
                size="small"
                data-testid={`credential-edit-${row.id}`}
                onClick={() => {
                  setEditing(row);
                  setFormOpen(true);
                }}
              >
                {t("common.edit")}
              </Button>
              <ConfirmDeleteButton
                title={t("security.credentials.deleteConfirm")}
                onConfirm={() => deleteMutation.mutate(row.id)}
              />
            </Space>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutate fns are stable; avoid ProTable thrash
    [t, testPending, resolveDevice, desktop, vault?.unlocked, rowBusy],
  );

  return (
    <ModulePageShell
      icon={<KeyOutlined style={{ fontSize: 20 }} />}
      title={t("security.credentials.title")}
      subtitle={t("security.credentials.subtitle")}
      action={
        <Space wrap>
          <Button
            href={DESKTOP_OPEN_HREF}
            icon={<DesktopOutlined />}
            data-testid="credentials-open-desktop"
          >
            {t("security.credentials.cta.openDesktop")}
          </Button>
          <Button
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            icon={<DownloadOutlined />}
            data-testid="credentials-install-desktop"
          >
            {t("security.credentials.cta.installDesktop")}
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            data-testid="credentials-add"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            {t("security.credentials.add")}
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        message={
          desktop
            ? t("security.credentials.desktop.phaseHint")
            : t("security.credentials.phaseHint")
        }
        style={{ marginBottom: 16 }}
        data-testid={desktop ? "credentials-desktop-hint" : "credentials-browser-hint"}
      />

      {desktop ? (
        <div data-testid="credentials-vault-panel" style={{ marginBottom: 16 }}>
          <Alert
            type={vault?.unlocked ? "success" : "warning"}
            showIcon
            message={
              vault?.unlocked
                ? t("security.credentials.desktop.vaultUnlocked")
                : vault?.lockedReason === "not_initialized"
                  ? t("security.credentials.desktop.vaultNotInitialized")
                  : t("security.credentials.desktop.vaultLocked")
            }
            description={
              <Space wrap data-testid="credentials-vault-actions">
                {vault && !vault.unlocked && vault.lockedReason === "not_initialized" ? (
                  <Button
                    size="small"
                    type="primary"
                    data-testid="credentials-vault-init"
                    loading={vaultBusy}
                    onClick={() =>
                      void runVaultAction(vaultInit, "security.credentials.desktop.initOk")
                    }
                  >
                    {t("security.credentials.desktop.init")}
                  </Button>
                ) : null}
                {vault && !vault.unlocked && vault.lockedReason !== "not_initialized" ? (
                  <Button
                    size="small"
                    type="primary"
                    data-testid="credentials-vault-unlock"
                    loading={vaultBusy}
                    onClick={() =>
                      void runVaultAction(vaultUnlock, "security.credentials.desktop.unlockOk")
                    }
                  >
                    {t("security.credentials.desktop.unlock")}
                  </Button>
                ) : null}
                {vault?.unlocked ? (
                  <Button
                    size="small"
                    data-testid="credentials-vault-lock"
                    loading={vaultBusy}
                    onClick={() =>
                      void runVaultAction(vaultLock, "security.credentials.desktop.lockOk")
                    }
                  >
                    {t("security.credentials.desktop.lock")}
                  </Button>
                ) : null}
                {vault && vault.lockedReason !== "not_initialized" ? (
                  <Popconfirm
                    title={t("security.credentials.desktop.resetConfirmTitle")}
                    description={t("security.credentials.desktop.resetConfirmDescription")}
                    okText={t("security.credentials.desktop.resetConfirmAction")}
                    cancelText={t("common.cancel")}
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      void runVaultAction(vaultReset, "security.credentials.desktop.resetOk")
                    }
                  >
                    <Button
                      danger
                      size="small"
                      data-testid="credentials-vault-reset"
                      loading={vaultBusy}
                    >
                      {t("security.credentials.desktop.reset")}
                    </Button>
                  </Popconfirm>
                ) : null}
                <Button
                  size="small"
                  data-testid="credentials-vault-refresh"
                  loading={vaultBusy}
                  onClick={() => void refreshLocalVault()}
                >
                  {t("security.credentials.desktop.refresh")}
                </Button>
              </Space>
            }
          />
        </div>
      ) : null}

      <ModuleTableCard>
        <ProTable<CredentialRow>
          {...moduleProTableProps}
          actionRef={actionRef}
          rowKey="id"
          columns={columns}
          request={async () => {
            const result = await api<{ items: CredentialRow[]; total: number }>(
              "/api/security/credentials",
            );
            return { data: result.items, total: result.total, success: true };
          }}
          search={false}
          pagination={moduleTablePagination}
          locale={{ emptyText: t("security.credentials.empty") }}
          expandable={{
            ...moduleTableExpandable,
            expandedRowRender: (row) => <CredentialUsageExpand credentialId={row.id} />,
          }}
        />
      </ModuleTableCard>

      <ModuleFormDrawer
        title={editing ? t("security.credentials.editTitle") : t("security.credentials.addTitle")}
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        width={480}
      >
        <Alert
          type="info"
          showIcon
          message={t("security.credentials.metadataOnlyHint")}
          style={{ marginBottom: 16 }}
        />
        <ProForm
          key={editing?.id ?? "new"}
          initialValues={
            editing
              ? {
                  name: editing.name,
                  environment_classification: isEnvironmentClassification(
                    editing.environment_classification,
                  )
                    ? editing.environment_classification
                    : "unknown",
                }
              : { environment_classification: "unknown" }
          }
          submitter={{
            searchConfig: {
              submitText: editing ? t("common.save") : t("security.credentials.add"),
            },
          }}
          onFinish={async (values) => {
            const body = buildSafeCredentialMetadataBody(values as Record<string, unknown>);
            if (!body.name) return false;
            if (editing) {
              await updateMutation.mutateAsync({ id: editing.id, body });
            } else {
              await createMutation.mutateAsync(body);
            }
            return true;
          }}
        >
          <ProFormText
            name="name"
            label={t("security.credentials.form.name")}
            rules={[{ required: true }]}
            fieldProps={{ "data-testid": "credential-name-input" }}
          />
          <ProFormSelect
            name="environment_classification"
            label={t("security.credentials.form.environmentClassification")}
            rules={[{ required: true }]}
            fieldProps={{ "data-testid": "credential-env-select" }}
            options={ENVIRONMENT_CLASSIFICATIONS.map((value) => ({
              value,
              label: t(`security.credentials.environments.${value}`),
            }))}
          />
        </ProForm>
      </ModuleFormDrawer>
    </ModulePageShell>
  );
}
