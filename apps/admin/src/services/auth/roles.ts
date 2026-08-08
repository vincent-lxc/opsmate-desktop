import { isDesktopRuntime } from "../../desktop/tauri-bridge";
import {
  buildLogtoSignOutUrl,
  type LogtoPublicConfig,
} from "./logto-pkce";

export type AdminRole =
  | "platform_superadmin"
  | "workspace_owner"
  | "admin"
  | "operator"
  | "viewer"
  | "oncall_intervene";

const TOKEN_KEY = "opsmate_token";
const ROLE_KEY = "opsmate_role";
const USERNAME_KEY = "opsmate_username";
const MUST_CHANGE_PASSWORD_KEY = "opsmate_must_change_password";
/** Non-secret desktop session present flag (never a bearer). */
const DESKTOP_AUTH_FLAG_KEY = "opsmate_desktop_authenticated";

/**
 * P2 #44 —— 认证会话变更通知事件。setAuthSession/clearAuthSession 写完
 * localStorage 后派发该事件，EntitlementsProvider 监听它刷新套餐权限，
 * 这样登录/邀请兑换/退出在 SPA 导航（无整页刷新）下也能立刻拿到真实权限，
 * 不再停留在挂载时的 fail-open FULL_ENTITLEMENTS（企业版）。
 */
const AUTH_SESSION_EVENT = "opsmate:auth-session";

export function setAuthSession(
  token: string,
  role: AdminRole,
  username?: string,
  mustChangePassword?: boolean,
) {
  // Desktop never persists JWT in WebView storage.
  if (!isDesktopRuntime()) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.setItem(DESKTOP_AUTH_FLAG_KEY, "1");
  }
  localStorage.setItem(ROLE_KEY, role);
  if (username) {
    localStorage.setItem(USERNAME_KEY, username);
  } else if (!isDesktopRuntime()) {
    const fromJwt = parseUsernameFromJWT(token);
    if (fromJwt) localStorage.setItem(USERNAME_KEY, fromJwt);
  }
  if (mustChangePassword) {
    localStorage.setItem(MUST_CHANGE_PASSWORD_KEY, "1");
  } else {
    localStorage.removeItem(MUST_CHANGE_PASSWORD_KEY);
  }
  window.dispatchEvent(new CustomEvent(AUTH_SESSION_EVENT));
}

/**
 * Apply secret-free desktop session fields from Rust (no token argument).
 */
export function applyDesktopSessionStatus(input: {
  role: AdminRole;
  username: string | null;
  mustChangePassword: boolean;
}) {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.setItem(DESKTOP_AUTH_FLAG_KEY, "1");
  localStorage.setItem(ROLE_KEY, input.role);
  if (input.username) {
    localStorage.setItem(USERNAME_KEY, input.username);
  } else {
    localStorage.removeItem(USERNAME_KEY);
  }
  if (input.mustChangePassword) {
    localStorage.setItem(MUST_CHANGE_PASSWORD_KEY, "1");
  } else {
    localStorage.removeItem(MUST_CHANGE_PASSWORD_KEY);
  }
  window.dispatchEvent(new CustomEvent(AUTH_SESSION_EVENT));
}

export function clearAuthSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(USERNAME_KEY);
  localStorage.removeItem(MUST_CHANGE_PASSWORD_KEY);
  localStorage.removeItem(DESKTOP_AUTH_FLAG_KEY);
  window.dispatchEvent(new CustomEvent(AUTH_SESSION_EVENT));
}

export function getToken(): string | null {
  if (isDesktopRuntime()) return null;
  return localStorage.getItem(TOKEN_KEY);
}

/** Browser: JWT present. Desktop: non-secret auth flag from native session. */
export function hasActiveSession(): boolean {
  if (isDesktopRuntime()) {
    return localStorage.getItem(DESKTOP_AUTH_FLAG_KEY) === "1";
  }
  return Boolean(localStorage.getItem(TOKEN_KEY));
}

export function mustChangePassword(): boolean {
  return localStorage.getItem(MUST_CHANGE_PASSWORD_KEY) === "1";
}

export function clearMustChangePassword() {
  localStorage.removeItem(MUST_CHANGE_PASSWORD_KEY);
}

export async function logout() {
  // Desktop: Rust owns bearer/vault/SSH cutoff via auth_logout; never browser-only clear.
  if (isDesktopRuntime()) {
    try {
      // Dynamic import avoids roles ↔ native-auth cycle at module load.
      const { nativeLogout } = await import("../../desktop/native-auth");
      await nativeLogout();
    } catch {
      // Fail closed for UI even if IPC fails mid-cutoff.
      clearAuthSession();
    }
    window.location.assign("/login");
    return;
  }

  clearAuthSession();
  try {
    const response = await fetch("/api/auth/logto/config");
    if (response.ok) {
      const config = (await response.json()) as LogtoPublicConfig;
      if (config.enabled) {
        window.location.assign(buildLogtoSignOutUrl(config));
        return;
      }
    }
  } catch {
    // Fall back to the local login page when Logto is unavailable.
  }
  window.location.assign("/login");
}

function parseJWT(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function roleFromToken(token: string): AdminRole {
  const json = parseJWT(token);
  const role = json?.role;
  if (
    role === "platform_superadmin" ||
    role === "workspace_owner" ||
    role === "admin" ||
    role === "operator" ||
    role === "viewer" ||
    role === "oncall_intervene"
  ) {
    return role;
  }
  return "viewer";
}

function parseUsernameFromJWT(token: string): string | null {
  const json = parseJWT(token);
  const username = json?.username;
  return typeof username === "string" && username ? username : null;
}

export function getRole(): AdminRole {
  const stored = localStorage.getItem(ROLE_KEY);
  if (
    stored === "platform_superadmin" ||
    stored === "workspace_owner" ||
    stored === "admin" ||
    stored === "operator" ||
    stored === "viewer" ||
    stored === "oncall_intervene"
  ) {
    return stored;
  }
  const token = getToken();
  if (token) {
    const fromJwt = roleFromToken(token);
    localStorage.setItem(ROLE_KEY, fromJwt);
    return fromJwt;
  }
  return "admin";
}

export function getUsername(): string | null {
  const stored = localStorage.getItem(USERNAME_KEY);
  if (stored) return stored;
  const token = getToken();
  if (!token) return null;
  const fromJwt = parseUsernameFromJWT(token);
  if (fromJwt) {
    localStorage.setItem(USERNAME_KEY, fromJwt);
    return fromJwt;
  }
  return null;
}

export function isAdmin(role?: AdminRole | null): boolean {
  const resolved = role ?? getRole();
  return (
    resolved === "platform_superadmin" ||
    resolved === "workspace_owner" ||
    resolved === "admin"
  );
}

/** Platform AI config: tenant_id === "default" && role === admin (matches backend requirePlatformAdmin). */
export function getTenantIdFromToken(): string | null {
  const token = getToken();
  if (!token) return null;
  const json = parseJWT(token);
  const tid = json?.tenant_id;
  return typeof tid === "string" && tid ? tid : null;
}

export function isPlatformAdmin(role?: AdminRole | null): boolean {
  const resolved = role ?? getRole();
  if (resolved !== "platform_superadmin" && resolved !== "admin") return false;
  const tid = getTenantIdFromToken();
  // Fail-closed: without JWT tenant claim, do not expose platform AI menus.
  return tid === "default";
}

export function canWrite(role?: AdminRole | null): boolean {
  return (role ?? getRole()) !== "viewer";
}

export function canOncallIntervene(role?: AdminRole | null): boolean {
  const resolved = role ?? getRole();
  return (
    resolved === "platform_superadmin" ||
    resolved === "workspace_owner" ||
    resolved === "admin" ||
    resolved === "oncall_intervene"
  );
}

export function isReadOnly(role?: AdminRole | null): boolean {
  return !canWrite(role);
}

export function isLocalDevHost(): boolean {
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
}
