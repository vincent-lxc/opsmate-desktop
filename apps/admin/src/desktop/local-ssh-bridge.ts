/**
 * D6b2a / Task 7 — Admin Tauri local + cloud SSH session bridge (no terminal UI/hooks).
 *
 * Matches Rust IPC:
 * - local_ssh_open  { req: { serverId, credentialId } } → { sessionId }
 * - local_ssh_write/resize/close { req: { sessionId, ... } }
 * - cloud_terminal_open { req: { serverId } } → { sessionId }  (no host/port/user)
 * - cloud_terminal_write/resize/close { req: { sessionId, ... } }
 * - event "local-ssh-output" payload: sessionId, stream, standard base64 data
 *   (shared by local and cloud native transports)
 *
 * Listen before open; pre-bind queue with event + byte caps; exact sessionId
 * filter; local close at most once; remote closed unlisten without second close;
 * never log terminal bytes.
 */

import {
  desktopInvoke,
  desktopListen,
  isDesktopRuntime,
} from "./tauri-bridge";

/** Matches Rust `LOCAL_SSH_OUTPUT_EVENT`. */
export const LOCAL_SSH_OUTPUT_EVENT = "local-ssh-output";

/** Matches Rust `MAX_PENDING_SSH_OUTPUT` / `MAX_TRANSPORT_RECORD_EVENTS`. */
export const MAX_PENDING_LOCAL_SSH_OUTPUT = 64;

/** Cap pre-bind base64 character volume (single event or cumulative). */
export const MAX_PENDING_LOCAL_SSH_B64_CHARS = 256 * 1024;

/** Cap pre-bind decoded byte volume (single event or cumulative). */
export const MAX_PENDING_LOCAL_SSH_DECODED_BYTES = 192 * 1024;

export type LocalSshOutputStream = "stdout" | "stderr" | "closed";

export type LocalSshDecodedOutput = {
  stream: LocalSshOutputStream;
  /** Empty when stream is `closed`. */
  data: Uint8Array;
};

export type LocalSshSessionHandle = {
  readonly sessionId: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  /** Local close at most once for the handle lifetime (does not unlisten). */
  close(): Promise<void>;
  /**
   * Ends the handle: local close at most once (skipped if remote already closed),
   * unlisten at most once.
   */
  dispose(): Promise<void>;
};

export type OpenLocalSshSessionOptions = {
  serverId: string;
  credentialId: string;
  onOutput: (chunk: LocalSshDecodedOutput) => void;
  /** When aborted during open, close any resulting session and reject. */
  signal?: AbortSignal;
};

export type OpenCloudSshSessionOptions = {
  serverId: string;
  onOutput: (chunk: LocalSshDecodedOutput) => void;
  /** When aborted during open, close any resulting session and reject. */
  signal?: AbortSignal;
};

type NativeTransportCommands = {
  open: DesktopIpcCommand;
  write: DesktopIpcCommand;
  resize: DesktopIpcCommand;
  close: DesktopIpcCommand;
  openArgs: Record<string, unknown>;
  label: string;
};

// Avoid circular type import — narrow to string command names validated by bridge.
type DesktopIpcCommand =
  | "local_ssh_open"
  | "local_ssh_write"
  | "local_ssh_resize"
  | "local_ssh_close"
  | "cloud_terminal_open"
  | "cloud_terminal_write"
  | "cloud_terminal_resize"
  | "cloud_terminal_close";

type ParsedEvent = {
  sessionId: string;
  stream: LocalSshOutputStream;
  dataB64: string;
  decodedBytes: number;
};

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const B64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Standard base64 (RFC 4648 with padding). Used for canonical round-trip checks.
 * Does not include input content in errors.
 */
export function encodeStdBase64(input: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i + 3 <= input.length) {
    const n = (input[i]! << 16) | (input[i + 1]! << 8) | input[i + 2]!;
    out += B64_TABLE[(n >> 18) & 63];
    out += B64_TABLE[(n >> 12) & 63];
    out += B64_TABLE[(n >> 6) & 63];
    out += B64_TABLE[n & 63];
    i += 3;
  }
  const rem = input.length - i;
  if (rem === 1) {
    const n = input[i]! << 16;
    out += B64_TABLE[(n >> 18) & 63];
    out += B64_TABLE[(n >> 12) & 63];
    out += "==";
  } else if (rem === 2) {
    const n = (input[i]! << 16) | (input[i + 1]! << 8);
    out += B64_TABLE[(n >> 18) & 63];
    out += B64_TABLE[(n >> 12) & 63];
    out += B64_TABLE[(n >> 6) & 63];
    out += "=";
  }
  return out;
}

/**
 * Strict standard base64 → bytes.
 * Rejects illegal alphabet, bad length, and non-canonical encodings
 * (decode then re-encode must equal input). Errors never include the input.
 */
export function decodeStdBase64Strict(b64: string): Uint8Array {
  if (typeof b64 !== "string") {
    throw new Error("invalid base64");
  }
  if (b64.length === 0) {
    return new Uint8Array(0);
  }
  if (b64.length % 4 !== 0 || !B64_RE.test(b64)) {
    throw new Error("invalid base64");
  }
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new Error("invalid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  // Canonical: trailing bits / alternate padding must re-encode identically.
  if (encodeStdBase64(out) !== b64) {
    throw new Error("invalid base64");
  }
  return out;
}

function parseOutputPayload(raw: unknown): ParsedEvent {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid local-ssh output payload");
  }
  const o = raw as Record<string, unknown>;
  const sessionId = o.sessionId;
  const stream = o.stream;
  const data = o.data;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("invalid local-ssh output payload");
  }
  if (stream !== "stdout" && stream !== "stderr" && stream !== "closed") {
    throw new Error("invalid local-ssh output payload");
  }
  if (typeof data !== "string") {
    throw new Error("invalid local-ssh output payload");
  }
  if (stream === "closed") {
    if (data.length !== 0) {
      throw new Error("invalid local-ssh output payload");
    }
    return { sessionId, stream, dataB64: "", decodedBytes: 0 };
  }
  const bytes = decodeStdBase64Strict(data);
  return {
    sessionId,
    stream,
    dataB64: data,
    decodedBytes: bytes.length,
  };
}

function decodeEvent(ev: ParsedEvent): LocalSshDecodedOutput {
  if (ev.stream === "closed") {
    return { stream: "closed", data: new Uint8Array(0) };
  }
  return { stream: ev.stream, data: decodeStdBase64Strict(ev.dataB64) };
}

async function invokeClose(
  closeCmd: DesktopIpcCommand,
  sessionId: string,
): Promise<void> {
  try {
    await desktopInvoke<void>(closeCmd, {
      req: { sessionId },
    });
  } catch {
    // Best-effort; never rethrow with payload content.
  }
}

/**
 * Shared open path for local vault SSH and native cloud terminal.
 * Listen first, open, replay pre-bind queue with exact sessionId filter.
 */
async function openNativeTerminalSession(
  opts: {
    onOutput: (chunk: LocalSshDecodedOutput) => void;
    signal?: AbortSignal;
  },
  cmds: NativeTransportCommands,
): Promise<LocalSshSessionHandle> {
  if (!isDesktopRuntime()) {
    throw new Error("desktop IPC unavailable outside Tauri");
  }

  let sessionId: string | null = null;
  let bound = false;
  /** Session no longer accepts write/resize/output. */
  let inactive = false;
  let disposed = false;
  /** Local IPC close sent at most once for this handle. */
  let localCloseSent = false;
  /** Remote emitted matching `closed` — registry already cleaned. */
  let remoteClosed = false;
  let overflowed = false;
  let cancelled = Boolean(opts.signal?.aborted);
  let callbackFailed = false;
  const prebind: ParsedEvent[] = [];
  let prebindB64Chars = 0;
  let prebindDecodedBytes = 0;
  let unlistenFn: (() => void) | null = null;

  const onAbort = () => {
    cancelled = true;
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const safeUnlisten = () => {
    if (unlistenFn) {
      try {
        unlistenFn();
      } catch {
        // ignore
      }
      unlistenFn = null;
    }
  };

  const sendLocalCloseOnce = (): void => {
    if (localCloseSent || remoteClosed || !sessionId) return;
    localCloseSent = true;
    const sid = sessionId;
    void invokeClose(cmds.close, sid);
  };

  const sendLocalCloseOnceAsync = async (): Promise<void> => {
    if (localCloseSent || remoteClosed || !sessionId) return;
    localCloseSent = true;
    await invokeClose(cmds.close, sessionId);
  };

  const markRemoteClosed = () => {
    inactive = true;
    remoteClosed = true;
    safeUnlisten();
  };

  const deliver = (ev: ParsedEvent): "continue" | "stop" => {
    if (inactive || disposed || callbackFailed) return "stop";
    try {
      opts.onOutput(decodeEvent(ev));
    } catch {
      callbackFailed = true;
      inactive = true;
      safeUnlisten();
      if (bound && sessionId) {
        sendLocalCloseOnce();
      }
      return "stop";
    }
    if (ev.stream === "closed") {
      markRemoteClosed();
      return "stop";
    }
    return "continue";
  };

  const notePrebindSize = (ev: ParsedEvent): boolean => {
    if (
      ev.dataB64.length > MAX_PENDING_LOCAL_SSH_B64_CHARS ||
      ev.decodedBytes > MAX_PENDING_LOCAL_SSH_DECODED_BYTES
    ) {
      return false;
    }
    const nextB64 = prebindB64Chars + ev.dataB64.length;
    const nextDecoded = prebindDecodedBytes + ev.decodedBytes;
    if (
      nextB64 > MAX_PENDING_LOCAL_SSH_B64_CHARS ||
      nextDecoded > MAX_PENDING_LOCAL_SSH_DECODED_BYTES
    ) {
      return false;
    }
    prebindB64Chars = nextB64;
    prebindDecodedBytes = nextDecoded;
    return true;
  };

  const onPayload = (raw: unknown) => {
    if (disposed || inactive || callbackFailed) return;
    let parsed: ParsedEvent;
    try {
      parsed = parseOutputPayload(raw);
    } catch {
      return;
    }

    if (!bound) {
      if (overflowed) return;
      if (prebind.length >= MAX_PENDING_LOCAL_SSH_OUTPUT || !notePrebindSize(parsed)) {
        overflowed = true;
        prebind.length = 0;
        prebindB64Chars = 0;
        prebindDecodedBytes = 0;
        return;
      }
      prebind.push(parsed);
      return;
    }

    if (sessionId && parsed.sessionId === sessionId) {
      deliver(parsed);
    }
  };

  try {
    unlistenFn = await desktopListen(LOCAL_SSH_OUTPUT_EVENT, onPayload);
  } catch (e) {
    opts.signal?.removeEventListener("abort", onAbort);
    throw e instanceof Error ? e : new Error("desktop event listen failed");
  }

  let openResult: { sessionId: string };
  try {
    openResult = await desktopInvoke<{ sessionId: string }>(cmds.open, {
      req: cmds.openArgs,
    });
  } catch (e) {
    safeUnlisten();
    opts.signal?.removeEventListener("abort", onAbort);
    throw e instanceof Error ? e : new Error(`${cmds.label} open failed`);
  }

  const sid =
    openResult && typeof openResult.sessionId === "string"
      ? openResult.sessionId
      : "";
  if (!sid) {
    safeUnlisten();
    opts.signal?.removeEventListener("abort", onAbort);
    throw new Error(`${cmds.label} open returned no sessionId`);
  }
  sessionId = sid;

  if (overflowed || cancelled || opts.signal?.aborted) {
    await sendLocalCloseOnceAsync();
    safeUnlisten();
    opts.signal?.removeEventListener("abort", onAbort);
    if (overflowed) {
      throw new Error(`${cmds.label} pre-bind output queue overflow`);
    }
    throw new Error(`${cmds.label} open cancelled during pending cleanup`);
  }

  bound = true;
  for (const ev of prebind) {
    if (ev.sessionId !== sid) continue;
    if (deliver(ev) === "stop") break;
  }
  prebind.length = 0;

  opts.signal?.removeEventListener("abort", onAbort);

  const ensureActive = () => {
    if (inactive || disposed || !sessionId) {
      throw new Error(`${cmds.label} session is closed`);
    }
  };

  const handle: LocalSshSessionHandle = {
    get sessionId() {
      return sid;
    },
    async write(_data: string) {
      ensureActive();
      await desktopInvoke<void>(cmds.write, {
        req: { sessionId: sid, data: _data },
      });
    },
    async resize(cols: number, rows: number) {
      ensureActive();
      await desktopInvoke<void>(cmds.resize, {
        req: { sessionId: sid, cols, rows },
      });
    },
    async close() {
      if (inactive && (localCloseSent || remoteClosed)) {
        inactive = true;
        return;
      }
      if (localCloseSent || remoteClosed) {
        inactive = true;
        return;
      }
      inactive = true;
      await sendLocalCloseOnceAsync();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      inactive = true;
      await sendLocalCloseOnceAsync();
      safeUnlisten();
    },
  };

  return handle;
}

/**
 * Open a local vault SSH session: listen first, then open, replay pre-bind queue.
 */
export async function openLocalSshSession(
  opts: OpenLocalSshSessionOptions,
): Promise<LocalSshSessionHandle> {
  return openNativeTerminalSession(opts, {
    open: "local_ssh_open",
    write: "local_ssh_write",
    resize: "local_ssh_resize",
    close: "local_ssh_close",
    openArgs: {
      serverId: opts.serverId,
      credentialId: opts.credentialId,
    },
    label: "local-ssh",
  });
}

/**
 * Open a native cloud terminal session (Rust owns WSS token + connection).
 * WebView supplies only serverId — never host/port/username/token.
 */
export async function openCloudSshSession(
  opts: OpenCloudSshSessionOptions,
): Promise<LocalSshSessionHandle> {
  return openNativeTerminalSession(opts, {
    open: "cloud_terminal_open",
    write: "cloud_terminal_write",
    resize: "cloud_terminal_resize",
    close: "cloud_terminal_close",
    openArgs: {
      serverId: opts.serverId,
    },
    label: "cloud-ssh",
  });
}
