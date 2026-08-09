import type { ServerFormValues } from "../components/ServerFormDrawer";

function optionalText(value?: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildServerPayload(
  values: ServerFormValues,
  isEdit: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: values.name.trim(),
    ip: values.ip.trim(),
    group_name: values.group_name,
    description: optionalText(values.description),
    ssh_port: values.ssh_port ?? 22,
  };

  const sshUser = optionalText(values.ssh_user);
  if (sshUser !== null || !isEdit) {
    payload.ssh_user = sshUser;
  }

  if (values.ssh_key_mode === "saved") {
    payload.ssh_credential_id = values.ssh_credential_id ?? null;
    payload.ssh_private_key = null;
  } else {
    const inlineKey = optionalText(values.ssh_private_key);
    if (inlineKey) {
      payload.ssh_private_key = inlineKey;
    } else if (!isEdit) {
      payload.ssh_private_key = null;
    }
    const saveAs = optionalText(values.ssh_credential_name);
    if (saveAs) {
      payload.ssh_credential_name = saveAs;
    }
    const passphrase = optionalText(values.ssh_key_passphrase);
    if (!isEdit || passphrase) {
      payload.ssh_key_passphrase = passphrase;
    }
  }

  return payload;
}