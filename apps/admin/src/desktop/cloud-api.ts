/**
 * Task 5 — desktop Admin API transport.
 *
 * WebView only supplies method/path/JSON body/locale. Rust injects bearer,
 * fixed origin, allowlist, and 401 cutoff. Never pass token/headers/origin.
 */
import { ApiError } from "../api/client";
import i18n from "../i18n";
import { clearAuthSession } from "../services/auth/roles";
import { isDesktopApiRequestAllowed } from "./generated-api-routes";
import { desktopInvoke } from "./tauri-bridge";

/** Matches Rust `CloudResponse` (camelCase). */
export type CloudResponse = {
  status: number;
  body: unknown | null;
};

function isRelativeApiPath(path: string): boolean {
  // Relative allowlisted API paths only — never absolute/protocol-relative URLs.
  if (!path.startsWith("/api/")) return false;
  if (path.includes("://") || path.startsWith("//")) return false;
  if (path.includes("\\") || path.includes("#")) return false;
  return true;
}

function normalizeJsonBody(body: BodyInit | null | undefined): unknown {
  if (body == null || body === "") return null;
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    throw new ApiError(400, "invalid_body", { reason: "formdata_not_allowed" });
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    throw new ApiError(400, "invalid_body", { reason: "blob_not_allowed" });
  }
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    throw new ApiError(400, "invalid_body", { reason: "binary_not_allowed" });
  }
  if (typeof body !== "string") {
    throw new ApiError(400, "invalid_body", { reason: "unsupported_body" });
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiError(400, "invalid_body", { reason: "invalid_json" });
  }
}

function messageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const rawError = (body as { error?: string | { message?: string } }).error;
  if (typeof rawError === "string") return rawError;
  if (
    rawError &&
    typeof rawError === "object" &&
    typeof rawError.message === "string"
  ) {
    return rawError.message;
  }
  return fallback;
}

export function apiErrorFromDesktopResponse(result: CloudResponse): ApiError {
  const message = messageFromBody(result.body, `HTTP ${result.status}`);
  return new ApiError(result.status, message, result.body ?? undefined);
}

function apiErrorFromDesktopIpc(code: string): ApiError {
  const c = code.trim() || "desktop_api_error";
  switch (c) {
    case "session_invalidated":
    case "unauthenticated":
      return new ApiError(401, c);
    case "route_not_allowed":
    case "path_smuggling":
      return new ApiError(403, c);
    case "request_too_large":
    case "response_too_large":
      return new ApiError(413, c);
    case "cancelled":
      return new ApiError(499, c);
    case "http_status":
      return new ApiError(502, c);
    case "transport":
      return new ApiError(0, c);
    case "invalid_input":
    case "invalid_response":
      return new ApiError(400, c);
    default:
      return new ApiError(500, c);
  }
}

function handleUnauthorizedNavigation(path: string): void {
  if (path.includes("/api/auth/login") || path.includes("/api/auth/status")) {
    return;
  }
  clearAuthSession();
  if (
    !window.location.pathname.startsWith("/login") &&
    !window.location.pathname.startsWith("/invite/")
  ) {
    window.location.href = "/login";
  }
}

function extractIpcErrorCode(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; error?: unknown };
    if (typeof o.message === "string") return o.message;
    if (typeof o.error === "string") return o.error;
  }
  return "desktop_api_error";
}

/**
 * Desktop JSON API via Rust `cloud_request`.
 * Only relative `/api/...` paths and JSON-safe bodies are accepted.
 */
export async function desktopApi<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!isRelativeApiPath(path)) {
    throw new ApiError(400, "invalid_path", { path: "<redacted>" });
  }

  const method = String(init.method ?? "GET").toUpperCase();
  // Generated route catalog — fail closed before native invoke (controls / smuggling / blocked).
  if (!isDesktopApiRequestAllowed(method, path)) {
    throw new ApiError(403, "route_not_allowed");
  }

  const body = normalizeJsonBody(init.body ?? null);
  const locale = i18n.language || null;

  let result: CloudResponse;
  try {
    result = await desktopInvoke<CloudResponse>("cloud_request", {
      req: { method, path, body, locale },
    });
  } catch (err) {
    const code = extractIpcErrorCode(err);
    const apiErr = apiErrorFromDesktopIpc(code);
    if (apiErr.status === 401) {
      handleUnauthorizedNavigation(path);
    }
    throw apiErr;
  }

  if (result.status < 200 || result.status >= 300) {
    if (result.status === 401) {
      handleUnauthorizedNavigation(path);
    }
    throw apiErrorFromDesktopResponse(result);
  }

  if (result.status === 204) {
    return undefined as T;
  }
  if (result.body == null) {
    return undefined as T;
  }
  return result.body as T;
}
