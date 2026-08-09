/**
 * Fixed external navigation for Desktop (Task 9).
 *
 * WebView never sends caller URLs/schemes/hosts/paths to Rust and never
 * `location.assign`s Stripe URLs. Only validated route IDs cross the IPC
 * boundary; Rust maps them to compile-time fixed https://app.itops.sh /
 * https://itops.sh URLs via the opener (Rust-only).
 */

import { desktopInvoke, isDesktopRuntime } from "./tauri-bridge";

export type ExternalRouteId =
  | "account_subscription"
  | "checkout"
  | "terms"
  | "privacy";

export const EXTERNAL_ROUTE_IDS: ReadonlySet<ExternalRouteId> = new Set([
  "account_subscription",
  "checkout",
  "terms",
  "privacy",
]);

export function isExternalRouteId(value: string): value is ExternalRouteId {
  return EXTERNAL_ROUTE_IDS.has(value as ExternalRouteId);
}

/**
 * Exact Tauri invoke args for `open_external_route`.
 * Matches Rust `fn open_external_route(..., req: OpenExternalRouteRequest)` —
 * top-level key must be `req` (same convention as vault/cloud credential cmds).
 * Wire body is `{ req: { routeId } }` only — never url/scheme/host/path.
 */
export function buildOpenExternalRouteArgs(routeId: ExternalRouteId): {
  req: { routeId: ExternalRouteId };
} {
  return { req: { routeId } };
}

/** Fixed public code — never interpolate caller routeId/URL/secret into errors. */
export const INVALID_EXTERNAL_ROUTE = "invalid_external_route";

/**
 * Open a fixed external route in the system browser via Rust.
 * Throws outside desktop, or when the route id is not allowlisted.
 * Payload is `{ req: { routeId } }` only — never a URL.
 * Invalid ids throw the fixed code `invalid_external_route` with no echo of input.
 */
export async function openExternalRoute(routeId: ExternalRouteId): Promise<void> {
  if (!isDesktopRuntime()) {
    throw new Error("external route open is desktop-only");
  }
  if (!isExternalRouteId(routeId)) {
    throw new Error(INVALID_EXTERNAL_ROUTE);
  }
  await desktopInvoke<void>("open_external_route", buildOpenExternalRouteArgs(routeId));
}
