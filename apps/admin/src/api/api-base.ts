/**
 * API base URL resolution for Admin SPA.
 *
 * - Browser (same-origin / reverse proxy): leave `VITE_API_BASE_URL` empty → relative `/api`.
 * - Desktop Tauri privilege UI: build injects absolute `https://app.itops.sh`
 *   via `scripts/desktop-build-admin-dist.sh` (Task D1).
 */

/** Exact production API origin injected into desktop Admin dist builds. */
export const DESKTOP_API_BASE_URL = "https://app.itops.sh";

/**
 * Resolve API base from a Vite env value.
 * Empty / missing → "" (browser same-origin). Non-empty → trimmed absolute base (no trailing slash).
 */
export function resolveApiBaseUrl(
  envValue: string | undefined | null = import.meta.env.VITE_API_BASE_URL as
    | string
    | undefined,
): string {
  if (typeof envValue !== "string") return "";
  const trimmed = envValue.trim().replace(/\/+$/, "");
  return trimmed;
}

/** Join base + path for fetch (path should start with `/`). */
export function resolveApiUrl(
  path: string,
  base: string = resolveApiBaseUrl(),
): string {
  return `${base}${path}`;
}
