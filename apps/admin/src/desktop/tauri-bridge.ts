/**
 * D6a / Task 10 — strong-typed desktop IPC bridge for OpsMate Admin
 * (Tauri WebView only).
 *
 * Uses official `@tauri-apps/api` (app.withGlobalTauri=false). Browser builds
 * never invoke Rust: `isDesktopRuntime()` is false and call sites must no-op.
 * Only this `desktop/*` tree may import `@tauri-apps/*`.
 *
 * JS never sends PEM/passphrase/fingerprint secrets — only credentialId.
 * Native prompts (vault password, PEM import, UPLOAD/DELETE confirm) stay in Rust.
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Allowed vault / cloud custody / local SSH / auth command names (whitelist). */
export const DESKTOP_IPC_COMMANDS = [
  "vault_status",
  "vault_init",
  "vault_unlock",
  "vault_lock",
  "vault_reset",
  "vault_import",
  "vault_list_meta",
  "vault_delete_local",
  "request_cloud_upload",
  "request_cloud_delete",
  "local_ssh_open",
  "local_ssh_write",
  "local_ssh_resize",
  "local_ssh_close",
  /** Native cloud terminal (WSS owned by Rust; no WebView WebSocket). */
  "cloud_terminal_open",
  "cloud_terminal_write",
  "cloud_terminal_resize",
  "cloud_terminal_close",
  /** Native Logto start: Rust holds PKCE + system browser (opener stays Rust-only). */
  "auth_begin_logto",
  /** Secret-free session poll (no bearer / subject / tenant). */
  "auth_session_status",
  "auth_logout",
  "auth_on_unauthorized",
  /** Rust-owned cloud HTTP proxy (Task 3+). */
  "cloud_request",
  /**
   * Fixed external route open (Task 9). Payload is routeId only —
   * never a URL/scheme/host/path. Opener stays Rust-only.
   */
  "open_external_route",
] as const;

export type DesktopIpcCommand = (typeof DESKTOP_IPC_COMMANDS)[number];

const COMMAND_SET: ReadonlySet<string> = new Set(DESKTOP_IPC_COMMANDS);

/** Matches Rust `VaultStatus` (camelCase serde). */
export type VaultStatusDto = {
  unlocked: boolean;
  lockedReason?: string | null;
};

/** Matches Rust `VaultMetaItem`. */
export type VaultMetaItemDto = {
  credentialId: string;
  fingerprint: string;
  devicePresent: boolean;
};

/** Matches Rust `VaultImportResponse`. */
export type VaultImportResponseDto = {
  credentialId: string;
  fingerprint: string;
};

/** Matches Rust `CloudCustodyResponse`. */
export type CloudCustodyResponseDto = {
  credentialId: string;
  custodyState: string;
  ok: boolean;
};

/** Commands that take `{ req: { credentialId } }`. */
export const CREDENTIAL_ID_REQ_COMMANDS = [
  "vault_import",
  "vault_delete_local",
  "request_cloud_upload",
  "request_cloud_delete",
] as const;

export type CredentialIdReqCommand = (typeof CREDENTIAL_ID_REQ_COMMANDS)[number];

/** Build exact Tauri invoke args for credential-scoped commands. */
export function buildCredentialIdReqArgs(credentialId: string): {
  req: { credentialId: string };
} {
  return { req: { credentialId } };
}

/**
 * Subscribe to a Tauri event via official `@tauri-apps/api/event`.
 * Callers must unlisten on cleanup; never logs payload contents.
 */
export async function desktopListen(
  event: string,
  handler: (payload: unknown) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) {
    throw new Error("desktop IPC unavailable outside Tauri");
  }
  return listen(event, (e) => {
    handler(e.payload);
  });
}

/** True only when running inside Tauri (`@tauri-apps/api` isTauri). */
export function isDesktopRuntime(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

export function isAllowedDesktopCommand(cmd: string): cmd is DesktopIpcCommand {
  return COMMAND_SET.has(cmd);
}

/**
 * Low-level invoke with command whitelist. Throws if not desktop or unknown cmd.
 * Browser code paths must call `isDesktopRuntime()` first and skip entirely.
 * Uses official `invoke` — never `window.__TAURI__`.
 */
export async function desktopInvoke<T>(
  cmd: DesktopIpcCommand,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isDesktopRuntime()) {
    throw new Error("desktop IPC unavailable outside Tauri");
  }
  if (!isAllowedDesktopCommand(cmd)) {
    throw new Error(`desktop IPC command not allowed: ${cmd}`);
  }
  return invoke<T>(cmd, args ?? {});
}

export async function vaultStatus(): Promise<VaultStatusDto> {
  return desktopInvoke<VaultStatusDto>("vault_status");
}

export async function vaultInit(): Promise<VaultStatusDto> {
  return desktopInvoke<VaultStatusDto>("vault_init");
}

export async function vaultUnlock(): Promise<VaultStatusDto> {
  return desktopInvoke<VaultStatusDto>("vault_unlock");
}

export async function vaultLock(): Promise<VaultStatusDto> {
  return desktopInvoke<VaultStatusDto>("vault_lock");
}

export async function vaultReset(): Promise<VaultStatusDto> {
  return desktopInvoke<VaultStatusDto>("vault_reset");
}

export async function vaultListMeta(): Promise<VaultMetaItemDto[]> {
  return desktopInvoke<VaultMetaItemDto[]>("vault_list_meta");
}

export async function vaultImport(credentialId: string): Promise<VaultImportResponseDto> {
  return desktopInvoke<VaultImportResponseDto>(
    "vault_import",
    buildCredentialIdReqArgs(credentialId),
  );
}

export async function vaultDeleteLocal(credentialId: string): Promise<void> {
  await desktopInvoke<void>("vault_delete_local", buildCredentialIdReqArgs(credentialId));
}

export async function requestCloudUpload(
  credentialId: string,
): Promise<CloudCustodyResponseDto> {
  return desktopInvoke<CloudCustodyResponseDto>(
    "request_cloud_upload",
    buildCredentialIdReqArgs(credentialId),
  );
}

export async function requestCloudDelete(
  credentialId: string,
): Promise<CloudCustodyResponseDto> {
  return desktopInvoke<CloudCustodyResponseDto>(
    "request_cloud_delete",
    buildCredentialIdReqArgs(credentialId),
  );
}

/** Matches Rust `AuthBeginResponse` — secret-free; no PKCE/token fields. */
export type AuthBeginLogtoResponseDto = {
  started: boolean;
};

/**
 * Start native Logto login. Rust generates PKCE, opens system browser via
 * opener plugin (not exposed to WebView). Empty invoke args only.
 */
export async function authBeginLogto(): Promise<AuthBeginLogtoResponseDto> {
  return desktopInvoke<AuthBeginLogtoResponseDto>("auth_begin_logto");
}

/**
 * Map vault + local meta into device custody for a credential id.
 * Locked / not unlocked → locked; devicePresent → available; else missing.
 */
export function deviceStateFromVault(
  unlocked: boolean,
  metaById: ReadonlyMap<string, VaultMetaItemDto>,
  credentialId: string,
): "available" | "missing" | "locked" {
  if (!unlocked) return "locked";
  const m = metaById.get(credentialId);
  if (m?.devicePresent) return "available";
  return "missing";
}
