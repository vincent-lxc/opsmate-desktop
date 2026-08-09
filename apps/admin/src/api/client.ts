import i18n from "../i18n";
import { MODULE_TABLE_DEFAULT_PAGE_SIZE } from "../components/module-table-styles";
import { isDesktopRuntime } from "../desktop/tauri-bridge";
import { clearAuthSession, getToken, setAuthSession, roleFromToken } from "../services/auth/roles";
import type { AdminRole } from "../services/auth/roles";
import { resolveApiBaseUrl, resolveApiUrl } from "./api-base";

const BASE = resolveApiBaseUrl();

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** Generic fetch wrapper with JSON parsing and error handling. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Desktop: single branch — Rust owns bearer/origin/allowlist (never page-level rewrites).
  // Dynamic import avoids client ↔ cloud-api cycle at module load.
  if (isDesktopRuntime()) {
    const { desktopApi } = await import("../desktop/cloud-api");
    return desktopApi<T>(path, init ?? {});
  }

  const headers = new Headers(init?.headers);
  const hasBody = init?.body != null && init.body !== "";
  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!headers.has("X-App-Locale") && i18n.language) {
    headers.set("X-App-Locale", i18n.language);
  }
  const token = getToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  let res: Response;
  try {
    res = await fetch(resolveApiUrl(path, BASE), {
      ...init,
      headers,
    });
  } catch (error) {
    throw new ApiError(0, "Failed to fetch", { cause: error });
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.includes("/api/auth/login") && !path.includes("/api/auth/status")) {
      clearAuthSession();
      if (!window.location.pathname.startsWith("/login") && !window.location.pathname.startsWith("/invite/")) {
        window.location.href = "/login";
      }
    }
    const rawError = (body as { error?: string | { message?: string; code?: string } }).error;
    const message =
      typeof rawError === "string"
        ? rawError
        : rawError && typeof rawError === "object" && typeof rawError.message === "string"
          ? rawError.message
          : res.statusText;
    throw new ApiError(res.status, message, body);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

export type AuthSession = {
  token: string;
  username: string;
  role: AdminRole;
  tenant_id?: string;
  must_change_password?: boolean;
};

export async function login(username: string, password: string): Promise<AuthSession> {
  const data = await api<AuthSession>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  setAuthSession(
    data.token,
    data.role ?? roleFromToken(data.token),
    data.username,
    data.must_change_password,
  );
  return data;
}

/** Normalize ProForm date/dayjs values for API datetime fields. */
export function toIsoDateTime(value: unknown): string | null {
  if (value == null || value === "") return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * ProTable request adapter.
 *
 * ProTable expects: (params, sort, filter) => Promise<{ data: T[]; total: number; success: boolean }>
 *
 * This adapter calls the given endpoint with page/page_size query params
 * and maps the backend's { items, total } response to ProTable's expected shape.
 */
export interface ProTableRequestParams {
  current?: number;
  pageSize?: number;
  [key: string]: unknown;
}

export interface ProTableRequestResult<T> {
  data: T[];
  total: number;
  success: boolean;
}

export async function proTableRequest<T>(
  endpoint: string,
  params: ProTableRequestParams,
  sort: Record<string, string | null> = {},
  filter: Record<string, (string | number)[] | null> = {},
): Promise<ProTableRequestResult<T>> {
  const query = new URLSearchParams();

  // Pagination
  query.set("page", String(params.current ?? 1));
  query.set("page_size", String(params.pageSize ?? MODULE_TABLE_DEFAULT_PAGE_SIZE));

  // Other params (filters from ProTable search form)
  for (const [key, value] of Object.entries(params)) {
    if (
      key !== "current" &&
      key !== "pageSize" &&
      key !== "locale" &&
      key !== "preset" &&
      !key.startsWith("_") &&
      value != null &&
      value !== ""
    ) {
      query.set(key, String(value));
    }
  }

  // Sort
  const sortEntries = Object.entries(sort).filter(
    ([, v]) => v != null,
  ) as [string, string][];
  if (sortEntries.length > 0) {
    query.set(
      "sort",
      sortEntries
        .map(([k, v]) => `${v === "descend" ? "-" : ""}${k}`)
        .join(","),
    );
  }

  // ProTable column filters
  for (const [key, values] of Object.entries(filter)) {
    if (values?.length) query.set(key, values.join(","));
  }

  const res = await api<{ items: T[]; total: number }>(
    `${endpoint}?${query.toString()}`,
  );

  return { data: res.items, total: res.total, success: true };
}
