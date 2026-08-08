import { useEffect, useRef } from "react";

const DEEP_LINK_BASE = "opsmate://auth/callback";

function nonEmpty(value: string | null): value is string {
  return value != null && value.trim() !== "";
}

function safeInvalidRequest(description: string): URLSearchParams {
  const outgoing = new URLSearchParams();
  outgoing.set("error", "invalid_request");
  outgoing.set("error_description", description);
  return outgoing;
}

/**
 * Desktop Logto bridge (Task 14).
 *
 * Hosted Admin path `/login/desktop/callback` receives the OIDC redirect from Logto
 * in the system browser, then immediately deep-links into the Tauri shell.
 * No token exchange, no storage, no secrets/PEM handling.
 *
 * Validation:
 * - Success: non-empty `code` AND non-empty `state` only (allowlisted keys).
 * - Error: non-empty `error`, optional `state` / `error_description`.
 * - `code` without `state`, `error_description` alone, empty values, or
 *   simultaneous `code`+`error` → safe `invalid_request` (never forwards code
 *   or attacker-controlled error_description on those paths).
 */
export function buildDesktopAuthDeepLink(search: string): string {
  const incoming = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );

  const code = incoming.get("code");
  const state = incoming.get("state");
  const error = incoming.get("error");
  const errorDescription = incoming.get("error_description");

  const hasCode = nonEmpty(code);
  const hasState = nonEmpty(state);
  const hasError = nonEmpty(error);
  const hasErrorDescription = nonEmpty(errorDescription);

  // Ambiguous: both code and error present — do not forward either as success/error.
  if (hasCode && hasError) {
    return `${DEEP_LINK_BASE}?${safeInvalidRequest("ambiguous_code_and_error").toString()}`;
  }

  // Success: require non-empty code AND non-empty state; never forward error fields.
  if (hasCode && hasState) {
    const outgoing = new URLSearchParams();
    outgoing.set("code", code);
    outgoing.set("state", state);
    return `${DEEP_LINK_BASE}?${outgoing.toString()}`;
  }

  // code without state (or empty state) must not forward code.
  if (hasCode && !hasState) {
    return `${DEEP_LINK_BASE}?${safeInvalidRequest("missing_code_or_state").toString()}`;
  }

  // OAuth error response: error required; state and error_description optional.
  if (hasError) {
    const outgoing = new URLSearchParams();
    outgoing.set("error", error);
    if (hasState) outgoing.set("state", state);
    if (hasErrorDescription) outgoing.set("error_description", errorDescription);
    return `${DEEP_LINK_BASE}?${outgoing.toString()}`;
  }

  // error_description alone (or state-only / empty / unknown keys) is malformed.
  return `${DEEP_LINK_BASE}?${safeInvalidRequest("missing_code_or_error").toString()}`;
}

export function DesktopLogtoBridgePage() {
  const ran = useRef(false);
  const target = buildDesktopAuthDeepLink(window.location.search);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    window.location.replace(target);
  }, [target]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        fontFamily: "system-ui, sans-serif",
        color: "#666",
      }}
    >
      <span>Redirecting to OpsMate Desktop...</span>
      <a
        href={target}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 220,
          minHeight: 44,
          padding: "0 20px",
          borderRadius: 8,
          background: "#1677ff",
          color: "#fff",
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        Open OpsMate Desktop
      </a>
      <small>If the app does not open automatically, click the button.</small>
    </div>
  );
}

export default DesktopLogtoBridgePage;
