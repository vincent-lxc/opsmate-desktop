/**
 * Public TypeScript types for the React → Rust cloud adapter.
 *
 * Operation ids are generated from contracts/desktop-operations.json
 * (available + ipc_via_rust only). Never invent ids by hand.
 */

export {
  IPC_CALLABLE_OPERATION_IDS,
  type IpcCallableOperationId,
} from "./generated-operations";

/** JSON value subset accepted as business input (no Date/class/undefined/etc.). */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Fixed public frontend error for cloud invoke failures.
 * `code` is an opaque stable string (Rust public code or local reject code).
 * Never embeds URL, body, token, or business input.
 */
export class CloudInvokeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CloudInvokeError";
    this.code = code;
  }
}

/** Local reject codes (before any Tauri invoke). */
export const LOCAL_UNKNOWN_OPERATION = "unknown_operation";
export const LOCAL_INVALID_INPUT = "invalid_input";

/**
 * Exact fixed public TransportError codes from Rust map_transport_public.
 * Any other string maps to transport without echo.
 */
export const RUST_PUBLIC_TRANSPORT_CODES = Object.freeze([
  "unknown_operation",
  "native_only",
  "not_available",
  "invalid_invocation",
  "invalid_input",
  "path_smuggling",
  "unauthenticated",
  "transport",
  "invalid_response",
  "http_status",
  "response_too_large",
  "cancelled",
  "session_invalidated",
] as const);

export type RustPublicTransportCode =
  (typeof RUST_PUBLIC_TRANSPORT_CODES)[number];
