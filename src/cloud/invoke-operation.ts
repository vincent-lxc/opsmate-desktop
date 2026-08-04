/**
 * React → Rust allowlisted cloud adapter (Task 6B2B).
 *
 * - Exactly one Tauri command: `cloud_call`
 * - Wire shape: `{ args: { operationId, input } }`
 * - No URL/method/header/bearer/token/tenant/subject/workspace fields
 * - No browser network or storage primitives (only Tauri invoke/listen)
 * - Operation ids restricted to contract ipc_via_rust + available
 * - Does not log or stringify business input
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  IPC_CALLABLE_OPERATION_IDS,
  type IpcCallableOperationId,
} from "./generated-operations";
import {
  CloudInvokeError,
  LOCAL_INVALID_INPUT,
  LOCAL_UNKNOWN_OPERATION,
  RUST_PUBLIC_TRANSPORT_CODES,
  type JsonObject,
} from "./types";

export {
  CloudInvokeError,
  LOCAL_INVALID_INPUT,
  LOCAL_UNKNOWN_OPERATION,
  RUST_PUBLIC_TRANSPORT_CODES,
  type IpcCallableOperationId,
  type JsonObject,
  type JsonValue,
} from "./types";
export { IPC_CALLABLE_OPERATION_IDS } from "./generated-operations";

/** Private membership state — not exported, cannot be widened by callers. */
const ALLOWED_OPERATION_IDS: ReadonlySet<string> = new Set(
  IPC_CALLABLE_OPERATION_IDS,
);

/** Runtime defense-in-depth: true only for generated IPC-callable ids. */
export function isIpcCallableOperationId(
  id: string,
): id is IpcCallableOperationId {
  return ALLOWED_OPERATION_IDS.has(id);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isFiniteNumber(n: number): boolean {
  return Number.isFinite(n);
}

/**
 * Recursively validate JSON-compatible values.
 * Allows plain objects, arrays, string/boolean/null, finite numbers.
 * Rejects Date/class instances, undefined/function/symbol/bigint,
 * NaN/Infinity, and cycles.
 *
 * `stack` is the active recursion path only (add before descending, delete
 * on exit). Shared acyclic object references across sibling fields are OK;
 * only true cycles fail.
 */
function isJsonValue(value: unknown, stack: WeakSet<object>): boolean {
  if (value === null) {
    return true;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return isFiniteNumber(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return false;
    case "object": {
      if (value instanceof Date) {
        return false;
      }
      if (Array.isArray(value)) {
        if (stack.has(value)) {
          return false;
        }
        stack.add(value);
        try {
          for (const item of value) {
            if (!isJsonValue(item, stack)) {
              return false;
            }
          }
          return true;
        } finally {
          stack.delete(value);
        }
      }
      if (!isPlainObject(value)) {
        return false;
      }
      if (stack.has(value)) {
        return false;
      }
      stack.add(value);
      try {
        for (const key of Object.keys(value)) {
          if (!isJsonValue(value[key], stack)) {
            return false;
          }
        }
        return true;
      } finally {
        stack.delete(value);
      }
    }
    default:
      return false;
  }
}

/**
 * True when value is a plain JSON object (business input root).
 * Catches throws from getters/Proxies/getPrototypeOf so callers only see
 * CloudInvokeError invalid_input — never a raw exception.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  try {
    if (!isPlainObject(value)) {
      return false;
    }
    return isJsonValue(value, new WeakSet());
  } catch {
    return false;
  }
}

/**
 * Map Tauri/Rust errors to a fixed public code without echoing payloads.
 * Only exact Rust TransportError public codes pass through; everything else → transport.
 */
function toPublicErrorCode(err: unknown): string {
  if (typeof err === "string") {
    const t = err.trim();
    if (
      (RUST_PUBLIC_TRANSPORT_CODES as readonly string[]).includes(t)
    ) {
      return t;
    }
    return "transport";
  }
  if (err instanceof CloudInvokeError) {
    if (
      (RUST_PUBLIC_TRANSPORT_CODES as readonly string[]).includes(err.code) ||
      err.code === LOCAL_UNKNOWN_OPERATION ||
      err.code === LOCAL_INVALID_INPUT
    ) {
      return err.code;
    }
    return "transport";
  }
  if (err && typeof err === "object") {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") {
      return toPublicErrorCode(msg);
    }
  }
  return "transport";
}

/**
 * Invoke an allowlisted business operation via Rust `cloud_call`.
 *
 * Production signature accepts only `IpcCallableOperationId` (compile-time).
 * Runtime still rejects unexpected values if a caller bypasses typing.
 *
 * @param input - JSON object only (default `{}`)
 */
export async function invokeOperation(
  operationId: IpcCallableOperationId,
  input: JsonObject = {},
): Promise<unknown> {
  // Defense in depth if a non-allowlisted string is forced past the type system.
  if (
    typeof operationId !== "string" ||
    !isIpcCallableOperationId(operationId)
  ) {
    throw new CloudInvokeError(LOCAL_UNKNOWN_OPERATION);
  }
  if (!isJsonObject(input)) {
    throw new CloudInvokeError(LOCAL_INVALID_INPUT);
  }

  try {
    return await invoke<unknown>("cloud_call", {
      args: {
        operationId,
        input,
      },
    });
  } catch (err) {
    throw new CloudInvokeError(toPublicErrorCode(err));
  }
}

/**
 * Subscribe to secret-free `session-invalidated` events from Rust.
 * Payload is ignored. Returns the unlisten function.
 * Integration hook for a later AuthGate — does not own auth state itself.
 */
export async function subscribeSessionInvalidated(
  callback: () => void,
): Promise<() => void> {
  return listen("session-invalidated", () => {
    callback();
  });
}
