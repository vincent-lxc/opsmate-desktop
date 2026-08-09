import {
  DrawerForm,
  ProFormDependency,
  ProFormDigit,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
} from "@ant-design/pro-components";
import { Collapse } from "antd";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { PemCredentialField } from "./PemCredentialField";
import { DEFAULT_SERVER_GROUP, formatGroupLabel } from "../utils/server-groups";

export type ServerRecord = {
  id: string;
  name: string;
  ip: string;
  group_name: string;
  description: string | null;
  ssh_user: string | null;
  ssh_port: number;
  ssh_private_key?: string | null;
  ssh_private_key_set?: boolean;
  ssh_key_passphrase_set: boolean;
  ssh_credential_id?: string | null;
  ssh_credential_name?: string | null;
  /** Linked credential has a cloud-hosted secret (false for local-only / inline / none). */
  ssh_credential_has_cloud_secret?: boolean;
  setup_status?: "scanning" | "pending_review" | "ready";
  created_at: string;
};

export type ServerFormValues = {
  name: string;
  ip: string;
  group_name?: string | string[];
  description?: string;
  ssh_user?: string;
  ssh_port?: number;
  ssh_key_mode?: "saved" | "new";
  ssh_credential_id?: string;
  ssh_credential_name?: string;
  ssh_private_key?: string;
  ssh_key_passphrase?: string;
};

type ServerFormDrawerProps = {
  open: boolean;
  server: ServerRecord | null;
  groups: string[];
  onOpenChange: (open: boolean) => void;
  onFinish: (values: ServerFormValues, options: { isEdit: boolean }) => Promise<boolean>;
};

function normalizeGroupValue(value?: string | string[]): string {
  if (Array.isArray(value)) {
    return value[0]?.trim() || DEFAULT_SERVER_GROUP;
  }
  return value?.trim() || DEFAULT_SERVER_GROUP;
}

export function ServerFormDrawer({
  open,
  server,
  groups,
  onOpenChange,
  onFinish,
}: ServerFormDrawerProps) {
  const { t } = useTranslation();
  const isEdit = server !== null;

  const { data: credentialsData } = useQuery({
    queryKey: ["ssh-credentials"],
    queryFn: () => api<{ items: { id: string; name: string }[] }>("/api/ssh-credentials"),
    enabled: open,
  });

  const groupOptions = useMemo(() => {
    const names = new Set(groups);
    if (server?.group_name) names.add(server.group_name);
    names.add(DEFAULT_SERVER_GROUP);

    return Array.from(names)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        label: formatGroupLabel(name, t),
        value: name,
      }));
  }, [groups, server?.group_name, t]);

  const credentialOptions = useMemo(
    () =>
      (credentialsData?.items ?? []).map((item) => ({
        label: item.name,
        value: item.id,
      })),
    [credentialsData?.items],
  );

  const defaultKeyMode =
    server?.ssh_credential_id || (!isEdit && credentialOptions.length > 0) ? "saved" : "new";

  const initialValues = useMemo(
    () =>
      isEdit
        ? {
            name: server.name,
            ip: server.ip,
            group_name: server.group_name,
            description: server.description ?? undefined,
            ssh_user: server.ssh_user ?? undefined,
            ssh_port: server.ssh_port,
            ssh_key_mode: server.ssh_credential_id ? "saved" : "new",
            ssh_credential_id: server.ssh_credential_id ?? undefined,
            ssh_private_key: server.ssh_private_key ?? undefined,
          }
        : {
            group_name: DEFAULT_SERVER_GROUP,
            ssh_port: 22,
            ssh_key_mode: defaultKeyMode,
          },
    [defaultKeyMode, isEdit, server],
  );

  const collapseItems = useMemo(
    () => [
      {
        key: "basic",
        label: t("servers.sections.basic"),
        children: (
          <>
            <ProFormText
              name="name"
              label={t("common.name")}
              placeholder="prod-web-1"
              rules={[{ required: true }]}
            />
            <ProFormText
              name="ip"
              label={t("servers.form.ipAddress")}
              placeholder="192.168.1.100"
              rules={[{ required: true }]}
            />
            <ProFormSelect
              name="group_name"
              label={t("servers.form.group")}
              options={groupOptions}
              fieldProps={{
                showSearch: true,
                mode: "tags",
                maxCount: 1,
                tokenSeparators: [],
                placeholder: t("servers.form.groupPlaceholder"),
              }}
              rules={[{ required: true }]}
              transform={(value) => normalizeGroupValue(value)}
            />
            <ProFormTextArea
              name="description"
              label={t("servers.form.description")}
              placeholder={t("servers.form.descriptionPlaceholder")}
              fieldProps={{ rows: 3, maxLength: 2000, showCount: true }}
            />
          </>
        ),
      },
      {
        key: "ssh",
        label: t("servers.sections.ssh"),
        children: (
          <>
            <ProFormText
              name="ssh_user"
              label={t("servers.columns.sshUser")}
              placeholder="root"
            />
            <ProFormDigit
              name="ssh_port"
              label={t("servers.columns.sshPort")}
              min={1}
              max={65535}
            />
            <ProFormSelect
              name="ssh_key_mode"
              label={t("servers.form.sshKeyMode")}
              options={[
                { label: t("servers.form.sshKeyModeSaved"), value: "saved" },
                { label: t("servers.form.sshKeyModeNew"), value: "new" },
              ]}
            />
            <ProFormDependency name={["ssh_key_mode"]}>
              {({ ssh_key_mode }) =>
                ssh_key_mode === "saved" ? (
                  <ProFormSelect
                    name="ssh_credential_id"
                    label={t("servers.form.sshCredentialSelect")}
                    options={credentialOptions}
                    rules={[{ required: true, message: t("servers.form.sshCredentialRequired") }]}
                    fieldProps={{
                      showSearch: true,
                      placeholder: t("servers.form.sshCredentialPlaceholder"),
                    }}
                  />
                ) : (
                  <>
                    <PemCredentialField
                      name="ssh_private_key"
                      label={t("servers.form.sshKey")}
                      placeholder={t("servers.form.sshKeyPlaceholder")}
                    />
                    <ProFormText
                      name="ssh_credential_name"
                      label={t("servers.form.sshCredentialName")}
                      placeholder={t("servers.form.sshCredentialNamePlaceholder")}
                      extra={t("servers.form.sshCredentialNameHint")}
                    />
                    <ProFormText.Password
                      name="ssh_key_passphrase"
                      label={t("servers.form.sshKeyPassphrase")}
                      placeholder={
                        isEdit && server.ssh_key_passphrase_set
                          ? t("servers.form.sshKeyPassphraseKeep")
                          : t("servers.form.sshKeyPassphrasePlaceholder")
                      }
                      extra={t("servers.form.sshKeyPassphraseHint")}
                      fieldProps={{ autoComplete: "new-password" }}
                    />
                  </>
                )
              }
            </ProFormDependency>
          </>
        ),
      },
    ],
    [credentialOptions, groupOptions, isEdit, server?.ssh_key_passphrase_set, t],
  );

  return (
    <DrawerForm<ServerFormValues>
      key={server?.id ?? "new"}
      title={isEdit ? t("servers.drawer.edit") : t("servers.drawer.add")}
      width={520}
      open={open}
      onOpenChange={onOpenChange}
      initialValues={initialValues}
      drawerProps={{ destroyOnHidden: true }}
      autoFocusFirstInput
      onFinish={async (values) =>
        onFinish(
          {
            ...values,
            group_name: normalizeGroupValue(values.group_name),
          },
          { isEdit },
        )
      }
      submitter={{
        searchConfig: {
          submitText: t("common.save"),
          resetText: t("common.cancel"),
        },
      }}
    >
      <Collapse accordion defaultActiveKey="basic" items={collapseItems} />
    </DrawerForm>
  );
}