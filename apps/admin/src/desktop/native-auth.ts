/**
 * Task 4 — secret-free desktop auth bridge.
 *
 * Rust owns PKCE, exchange, bearer, subject, tenant, workspace.
 * WebView only receives DesktopSessionStatus (no JWT / subject / tenant).
 */
import type { AdminRole } from "../services/auth/roles";
import {
  applyDesktopSessionStatus,
  clearAuthSession,
} from "../services/auth/roles";
import { desktopInvoke, desktopListen, isDesktopRuntime } from "./tauri-bridge";

/** Fixed Tauri event name — payload is DesktopSessionStatus only. */
export const AUTH_SESSION_TAURI_EVENT = "opsmate:auth-session";

/** Exact secret-free session status from `auth_session_status` / event payload. */
export type DesktopSessionStatus = {
  authenticated: boolean;
  username: string | null;
  role: AdminRole | null;
  mustChangePassword: boolean;
  expiresAtUnix: number | null;
  reauthRequired: boolean;
};

function isAdminRole(v: unknown): v is AdminRole {
  return (
    v === "platform_superadmin" ||
    v === "workspace_owner" ||
    v === "admin" ||
    v === "operator" ||
    v === "viewer" ||
    v === "oncall_intervene"
  );
}

/** Normalize wire payload (null/undefined) into DesktopSessionStatus. */
export function normalizeDesktopSessionStatus(raw: unknown): DesktopSessionStatus {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const role = isAdminRole(o.role) ? o.role : null;
  const username = typeof o.username === "string" ? o.username : null;
  return {
    authenticated: Boolean(o.authenticated),
    username,
    role,
    mustChangePassword: Boolean(o.mustChangePassword),
    expiresAtUnix:
      typeof o.expiresAtUnix === "number" && Number.isFinite(o.expiresAtUnix)
        ? o.expiresAtUnix
        : null,
    reauthRequired: Boolean(o.reauthRequired),
  };
}

function applyStatus(status: DesktopSessionStatus): void {
  if (!status.authenticated) {
    clearAuthSession();
    return;
  }
  applyDesktopSessionStatus({
    role: status.role ?? "viewer",
    username: status.username,
    mustChangePassword: status.mustChangePassword,
  });
}

/** Poll secret-free session status and apply non-secret UI state. */
export async function refreshSessionStatus(): Promise<DesktopSessionStatus> {
  const raw = await desktopInvoke<DesktopSessionStatus>("auth_session_status");
  const status = normalizeDesktopSessionStatus(raw);
  applyStatus(status);
  return status;
}

/**
 * On desktop startup: refresh status once and subscribe to Rust
 * `opsmate:auth-session` events (secret-free payload only).
 */
export async function initNativeAuth(): Promise<() => void> {
  if (!isDesktopRuntime()) {
    return () => {};
  }
  await refreshSessionStatus();
  const unlisten = await desktopListen(AUTH_SESSION_TAURI_EVENT, (payload) => {
    applyStatus(normalizeDesktopSessionStatus(payload));
  });
  return unlisten;
}

/** Named logout IPC (Rust clears native session; no WebView token). */
export async function nativeLogout(): Promise<void> {
  await desktopInvoke<void>("auth_logout");
  clearAuthSession();
}
