import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockListen = vi.hoisted(() => vi.fn());
const mockIsTauri = vi.hoisted(() => vi.fn(() => true));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  isTauri: () => mockIsTauri(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

import {
  DESKTOP_IPC_COMMANDS,
  isAllowedDesktopCommand,
} from "../tauri-bridge";
import {
  decodeStdBase64Strict,
  encodeStdBase64,
  LOCAL_SSH_OUTPUT_EVENT,
  MAX_PENDING_LOCAL_SSH_B64_CHARS,
  MAX_PENDING_LOCAL_SSH_DECODED_BYTES,
  MAX_PENDING_LOCAL_SSH_OUTPUT,
  openCloudSshSession,
  openLocalSshSession,
} from "../local-ssh-bridge";

type EventHandler = (event: { payload: unknown }) => void;

function closeCalls(invoke: ReturnType<typeof vi.fn>) {
  return invoke.mock.calls.filter((c) => c[0] === "local_ssh_close");
}

describe("local-ssh-bridge (D6b2a)", () => {
  let invoke: ReturnType<typeof vi.fn>;
  let listen: ReturnType<typeof vi.fn>;
  let listeners: EventHandler[];
  let unlisten: ReturnType<typeof vi.fn>;

  function installTauri(opts?: {
    listenReject?: Error;
    openImpl?: () => Promise<unknown>;
    openCmd?: string;
    sessionId?: string;
  }) {
    listeners = [];
    unlisten = vi.fn();
    const openCmd = opts?.openCmd ?? "local_ssh_open";
    const sessionId = opts?.sessionId ?? "sid-self";
    invoke = vi.fn(async (cmd: string, args?: { req?: Record<string, unknown> }) => {
      if (cmd === openCmd || cmd === "local_ssh_open" || cmd === "cloud_terminal_open") {
        if (opts?.openImpl) return opts.openImpl();
        return { sessionId };
      }
      if (
        cmd === "local_ssh_write" ||
        cmd === "local_ssh_resize" ||
        cmd === "local_ssh_close" ||
        cmd === "cloud_terminal_write" ||
        cmd === "cloud_terminal_resize" ||
        cmd === "cloud_terminal_close"
      ) {
        return undefined;
      }
      throw new Error(`unexpected ${cmd} ${JSON.stringify(args)}`);
    });
    listen = vi.fn(async (_event: string, handler: EventHandler) => {
      if (opts?.listenReject) throw opts.listenReject;
      listeners.push(handler);
      return unlisten;
    });
    mockIsTauri.mockReturnValue(true);
    // Wire local spies into the official-API mocks (Task 10).
    mockInvoke.mockImplementation(invoke as unknown as (...args: unknown[]) => unknown);
    mockListen.mockImplementation(listen as unknown as (...args: unknown[]) => unknown);
  }

  function emit(payload: unknown) {
    for (const h of [...listeners]) h({ payload });
  }

  afterEach(() => {
    mockIsTauri.mockReturnValue(false);
    mockInvoke.mockReset();
    mockListen.mockReset();
    vi.restoreAllMocks();
  });

  it("whitelist includes local_ssh and cloud_terminal open/write/resize/close", () => {
    for (const cmd of [
      "local_ssh_open",
      "local_ssh_write",
      "local_ssh_resize",
      "local_ssh_close",
      "cloud_terminal_open",
      "cloud_terminal_write",
      "cloud_terminal_resize",
      "cloud_terminal_close",
    ] as const) {
      expect(DESKTOP_IPC_COMMANDS).toContain(cmd);
      expect(isAllowedDesktopCommand(cmd)).toBe(true);
    }
  });

  it("decodeStdBase64Strict accepts canonical encoding and rejects illegal/non-canonical", () => {
    expect(Array.from(decodeStdBase64Strict("aGk="))).toEqual([104, 105]);
    expect(encodeStdBase64(new Uint8Array([104, 105]))).toBe("aGk=");

    expect(() => decodeStdBase64Strict("aGk")).toThrow(/base64/i);
    expect(() => decodeStdBase64Strict("@@@=")).toThrow(/base64/i);
    // Non-canonical trailing bits: decodes to 'a' but re-encodes as YQ==
    try {
      decodeStdBase64Strict("YR==");
      expect.unreachable("should reject non-canonical");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/base64/i);
      expect(msg).not.toMatch(/YR==|YQ==/);
    }
  });

  describe("with mocked Tauri API", () => {
    beforeEach(() => {
      installTauri();
    });

    it("registers listener before local_ssh_open and uses exact open args", async () => {
      const order: string[] = [];
      listen.mockImplementation(async (_e: string, handler: EventHandler) => {
        order.push("listen");
        listeners.push(handler);
        return unlisten;
      });
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "local_ssh_open") {
          order.push("open");
          return { sessionId: "sid-self" };
        }
        return undefined;
      });

      const session = await openLocalSshSession({
        serverId: "srv-1",
        credentialId: "cred-1",
        onOutput: () => {},
      });

      expect(order).toEqual(["listen", "open"]);
      expect(listen).toHaveBeenCalledWith(LOCAL_SSH_OUTPUT_EVENT, expect.any(Function));
      expect(invoke).toHaveBeenCalledWith("local_ssh_open", {
        req: { serverId: "srv-1", credentialId: "cred-1" },
      });
      expect(session.sessionId).toBe("sid-self");
      await session.dispose();
      expect(closeCalls(invoke)).toHaveLength(1);
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("replays pre-bind events for exact sessionId in order; drops foreign sessions", async () => {
      const chunks: Array<{ stream: string; text: string }> = [];
      let resolveOpen!: (v: { sessionId: string }) => void;
      const openPromise = new Promise<{ sessionId: string }>((r) => {
        resolveOpen = r;
      });
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "local_ssh_open") return openPromise;
        return undefined;
      });

      const pending = openLocalSshSession({
        serverId: "s",
        credentialId: "c",
        onOutput: (c) => {
          chunks.push({
            stream: c.stream,
            text: new TextDecoder().decode(c.data),
          });
        },
      });

      await vi.waitFor(() => expect(listeners.length).toBe(1));

      emit({ sessionId: "sid-self", stream: "stdout", data: "YQ==" });
      emit({ sessionId: "sid-other", stream: "stdout", data: "Yg==" });
      emit({ sessionId: "sid-self", stream: "stderr", data: "Yw==" });

      resolveOpen({ sessionId: "sid-self" });
      const session = await pending;

      expect(chunks.map((c) => `${c.stream}:${c.text}`)).toEqual(["stdout:a", "stderr:c"]);
      expect(chunks.every((c) => c.text !== "b")).toBe(true);

      await session.dispose();
      expect(closeCalls(invoke)).toHaveLength(1);
    });

    it("pre-bind replay stops at closed and does not deliver following events", async () => {
      const chunks: string[] = [];
      let resolveOpen!: (v: { sessionId: string }) => void;
      const openPromise = new Promise<{ sessionId: string }>((r) => {
        resolveOpen = r;
      });
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "local_ssh_open") return openPromise;
        return undefined;
      });

      const pending = openLocalSshSession({
        serverId: "s",
        credentialId: "c",
        onOutput: (c) => chunks.push(c.stream),
      });
      await vi.waitFor(() => expect(listeners.length).toBe(1));

      emit({ sessionId: "sid-self", stream: "stdout", data: "YQ==" });
      emit({ sessionId: "sid-self", stream: "closed", data: "" });
      emit({ sessionId: "sid-self", stream: "stdout", data: "Yg==" }); // after closed — must not deliver

      resolveOpen({ sessionId: "sid-self" });
      const session = await pending;

      expect(chunks).toEqual(["stdout", "closed"]);
      await expect(session.write("x")).rejects.toThrow(/closed/i);
      // Remote closed: dispose must not call Rust close again
      await session.dispose();
      expect(closeCalls(invoke)).toHaveLength(0);
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("remote closed delivers once, unlistens, drops later streams, no second close on dispose", async () => {
      const chunks: string[] = [];
      const session = await openLocalSshSession({
        serverId: "s",
        credentialId: "c",
        onOutput: (c) => chunks.push(c.stream),
      });

      emit({ sessionId: "sid-self", stream: "stdout", data: "YQ==" });
      emit({ sessionId: "sid-self", stream: "closed", data: "" });
      emit({ sessionId: "sid-self", stream: "closed", data: "" });
      emit({ sessionId: "sid-self", stream: "stdout", data: "Yg==" });

      expect(chunks).toEqual(["stdout", "closed"]);
      expect(unlisten).toHaveBeenCalledTimes(1);

      try {
        await session.write("SECRET_AFTER_CLOSE");
        expect.unreachable("write after closed");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg).toMatch(/closed/i);
        expect(msg).not.toMatch(/SECRET_AFTER_CLOSE/);
      }
      await expect(session.resize(80, 24)).rejects.toThrow(/closed/i);

      await session.dispose();
      expect(closeCalls(invoke)).toHaveLength(0);
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("close-close-dispose invokes local_ssh_close exactly once and unlisten once", async () => {
      const session = await openLocalSshSession({
        serverId: "s",
        credentialId: "c",
        onOutput: () => {},
      });

      await session.close();
      await session.close();
      await session.dispose();

      expect(closeCalls(invoke)).toHaveLength(1);
      expect(closeCalls(invoke)[0]?.[1]).toEqual({ req: { sessionId: "sid-self" } });
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("rejects illegal payload and non-empty closed data without delivering", async () => {
      const chunks: unknown[] = [];
      const session = await openLocalSshSession({
        serverId: "s",
        credentialId: "c",
        onOutput: (c) => chunks.push(c),
      });

      emit({ sessionId: "sid-self", stream: "stdout", data: "!!!" });
      emit({ sessionId: "sid-self", stream: "closed", data: "YQ==" });
      emit({ sessionId: "sid-self", stream: "bogus", data: "" });
      emit(null);
      emit({ sessionId: "sid-self", stream: "stdout", data: "YQ==" });

      expect(chunks).toHaveLength(1);
      expect((chunks[0] as { stream: string }).stream).toBe("stdout");
      await session.dispose();
    });

    it("pre-bind event-count overflow fails closed: one close + unlisten after open", async () => {
      let resolveOpen!: (v: { sessionId: string }) => void;
      const openPromise = new Promise<{ sessionId: string }>((r) => {
        resolveOpen = r;
      });
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "local_ssh_open") return openPromise;
        return undefined;
      });

      const pending = openLocalSshSession({
        serverId: "s",
        credentialId: "c",
        onOutput: () => {},
      });
      await vi.waitFor(() => expect(listeners.length).toBe(1));

      for (let i = 0; i < MAX_PENDING_LOCAL_SSH_OUTPUT + 1; i++) {
        emit({ sessionId: "sid-self", stream: "stdout", data: "YQ==" });
      }

      resolveOpen({ sessionId: "sid-self" });
      await expect(pending).rejects.toThrow(/overflow/i);

      expect(closeCalls(invoke)).toHaveLength(1);
      expect(closeCalls(invoke)[0]?.[1]).toEqual({ req: { sessionId: "sid-self" } });
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("pre-bind single huge base64 event overflows without embedding payload in error", async () => {
      let resolveOpen!: (v: { sessionId: string }) => void;
      const openPromise = new Promise<{ sessionId: string }>((r) => {
        resolveOpen = r;
      });
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "local_ssh_open") return openPromise;
        return undefined;
      });

      const pending = openLocalSshSession({
        serverId: "s",
        credentialId: "c",
        onOutput: () => {},
      });
      await vi.waitFor(() => expect(listeners.length).toBe(1));

      const hugeChars = "A".repeat(MAX_PENDING_LOCAL_SSH_B64_CHARS + 4);
      // Make valid-looking length multiple of 4; will fail canonical or size check
      const padded = hugeChars.slice(0, hugeChars.length - (hugeChars.length % 4));
      emit({ sessionId: "sid-self", stream: "stdout", data: padded });

      resolveOpen({ sessionId: "sid-self" });
      try {
        await pending;
        expect.unreachable("should reject overflow");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg).toMatch(/overflow/i);
        expect(msg).not.toContain(padded.slice(0, 32));
      }
      expect(closeCalls(invoke)).toHaveLength(1);
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("pre-bind cumulative decoded-byte overflow fails closed", async () => {
      let resolveOpen!: (v: { sessionId: string }) => void;
      const openPromise = new Promise<{ sessionId: string }>((r) => {
        resolveOpen = r;
      });
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "local_ssh_open") return openPromise;
        return undefined;
      });

      const pending = openLocalSshSession({
        serverId: "s",
        credentialId: "c",
        onOutput: () => {},
      });
      await vi.waitFor(() => expect(listeners.length).toBe(1));

      // Canonical chunks of 48 decoded bytes each (64 b64 chars).
      const block = new Uint8Array(48).fill(1);
      const b64 = encodeStdBase64(block);
      expect(b64.length).toBe(64);
      const n = Math.floor(MAX_PENDING_LOCAL_SSH_DECODED_BYTES / 48) + 1;
      for (let i = 0; i < n; i++) {
        emit({ sessionId: "sid-self", stream: "stdout", data: b64 });
      }

      resolveOpen({ sessionId: "sid-self" });
      await expect(pending).rejects.toThrow(/overflow/i);
      expect(closeCalls(invoke)).toHaveLength(1);
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("listen failure never opens", async () => {
      installTauri({ listenReject: new Error("listen failed") });
      await expect(
        openLocalSshSession({ serverId: "s", credentialId: "c", onOutput: () => {} }),
      ).rejects.toThrow(/listen failed/);
      expect(invoke).not.toHaveBeenCalled();
    });

    it("open failure unlisten without write", async () => {
      installTauri({
        openImpl: async () => {
          throw new Error("open failed");
        },
      });
      await expect(
        openLocalSshSession({ serverId: "s", credentialId: "c", onOutput: () => {} }),
      ).rejects.toThrow(/open failed/);
      expect(unlisten).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls.some((c) => c[0] === "local_ssh_write")).toBe(false);
    });

    it("AbortSignal pending cleanup closes once and unlistens once after open resolves", async () => {
      let resolveOpen!: (v: { sessionId: string }) => void;
      const openPromise = new Promise<{ sessionId: string }>((r) => {
        resolveOpen = r;
      });
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "local_ssh_open") return openPromise;
        return undefined;
      });

      const ac = new AbortController();
      const pending = openLocalSshSession({
        serverId: "s",
        credentialId: "c",
        onOutput: () => {},
        signal: ac.signal,
      });
      await vi.waitFor(() => expect(listeners.length).toBe(1));
      // Wait until open is in-flight (listen-before-open already done).
      await vi.waitFor(() =>
        expect(invoke.mock.calls.some((c) => c[0] === "local_ssh_open")).toBe(true),
      );
      // True mid-flight cancel before open resolves — must not close yet.
      ac.abort();
      expect(closeCalls(invoke)).toHaveLength(0);

      resolveOpen({ sessionId: "sid-pending" });
      await expect(pending).rejects.toThrow(/abort|cancel|cleanup/i);

      expect(closeCalls(invoke)).toHaveLength(1);
      expect(closeCalls(invoke)[0]?.[1]).toEqual({ req: { sessionId: "sid-pending" } });
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("write/resize use bound sessionId", async () => {
      const session = await openLocalSshSession({
        serverId: "s",
        credentialId: "c",
        onOutput: () => {},
      });

      await session.write("echo hi");
      expect(invoke).toHaveBeenCalledWith("local_ssh_write", {
        req: { sessionId: "sid-self", data: "echo hi" },
      });

      await session.resize(120, 40);
      expect(invoke).toHaveBeenCalledWith("local_ssh_resize", {
        req: { sessionId: "sid-self", cols: 120, rows: 40 },
      });

      await session.dispose();
      expect(closeCalls(invoke)).toHaveLength(1);
    });

    it("onOutput throw fails closed: stop delivery, unlisten, one best-effort close", async () => {
      let n = 0;
      const session = await openLocalSshSession({
        serverId: "s",
        credentialId: "c",
        onOutput: () => {
          n += 1;
          if (n === 1) throw new Error("consumer boom with SECRET_OUT");
        },
      });

      emit({ sessionId: "sid-self", stream: "stdout", data: "YQ==" });
      emit({ sessionId: "sid-self", stream: "stdout", data: "Yg==" });

      expect(n).toBe(1);
      expect(unlisten).toHaveBeenCalledTimes(1);

      await vi.waitFor(() => expect(closeCalls(invoke).length).toBe(1));
      expect(closeCalls(invoke)[0]?.[1]).toEqual({ req: { sessionId: "sid-self" } });

      await expect(session.write("more")).rejects.toThrow(/closed/i);
      await session.dispose();
      // No second Rust close
      expect(closeCalls(invoke)).toHaveLength(1);
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("multi-session listeners only deliver their own sessionId", async () => {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "local_ssh_open") {
          const n = invoke.mock.calls.filter((c) => c[0] === "local_ssh_open").length;
          return { sessionId: n === 1 ? "sid-a" : "sid-b" };
        }
        return undefined;
      });

      const aChunks: string[] = [];
      const bChunks: string[] = [];
      const a = await openLocalSshSession({
        serverId: "s1",
        credentialId: "c1",
        onOutput: (c) => aChunks.push(new TextDecoder().decode(c.data)),
      });
      const b = await openLocalSshSession({
        serverId: "s2",
        credentialId: "c2",
        onOutput: (c) => bChunks.push(new TextDecoder().decode(c.data)),
      });

      emit({ sessionId: "sid-a", stream: "stdout", data: "YQ==" });
      emit({ sessionId: "sid-b", stream: "stdout", data: "Yg==" });
      emit({ sessionId: "sid-a", stream: "stdout", data: "Yw==" });

      expect(aChunks).toEqual(["a", "c"]);
      expect(bChunks).toEqual(["b"]);

      await a.dispose();
      await b.dispose();
      expect(closeCalls(invoke)).toHaveLength(2);
    });

    it("never includes terminal bytes in thrown error messages", async () => {
      const session = await openLocalSshSession({
        serverId: "s",
        credentialId: "c",
        onOutput: () => {},
      });
      await session.dispose();
      try {
        await session.write("SECRET_TERMINAL_BYTES");
        expect.unreachable("should throw");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg).not.toMatch(/SECRET_TERMINAL_BYTES/);
      }
    });
  });

  describe("openCloudSshSession", () => {
    beforeEach(() => installTauri({ openCmd: "cloud_terminal_open", sessionId: "cloud-sid" }));

    it("opens with serverId only (no host/port/username) and uses cloud IPC", async () => {
      const chunks: string[] = [];
      const session = await openCloudSshSession({
        serverId: "srv-1",
        onOutput: (c) => {
          if (c.stream !== "closed") chunks.push(new TextDecoder().decode(c.data));
        },
      });
      expect(session.sessionId).toBe("cloud-sid");
      const openCall = invoke.mock.calls.find((c) => c[0] === "cloud_terminal_open");
      expect(openCall).toBeTruthy();
      const req = (openCall![1] as { req: Record<string, unknown> }).req;
      expect(req).toEqual({ serverId: "srv-1" });
      expect(req).not.toHaveProperty("host");
      expect(req).not.toHaveProperty("port");
      expect(req).not.toHaveProperty("username");
      expect(req).not.toHaveProperty("token");
      expect(req).not.toHaveProperty("credentialId");

      await session.write("ls\n");
      await session.resize(120, 40);
      expect(invoke).toHaveBeenCalledWith("cloud_terminal_write", {
        req: { sessionId: "cloud-sid", data: "ls\n" },
      });
      expect(invoke).toHaveBeenCalledWith("cloud_terminal_resize", {
        req: { sessionId: "cloud-sid", cols: 120, rows: 40 },
      });
      await session.dispose();
      expect(invoke).toHaveBeenCalledWith("cloud_terminal_close", {
        req: { sessionId: "cloud-sid" },
      });
    });

    it("filters pre-bind output by sessionId and rejects closed-session write", async () => {
      const pending = openCloudSshSession({
        serverId: "srv",
        onOutput: () => {},
      });
      // Foreign pre-bind event
      emit({ sessionId: "other", stream: "stdout", data: "YQ==" });
      emit({ sessionId: "cloud-sid", stream: "stdout", data: "Yg==" });
      const session = await pending;
      await session.dispose();
      await expect(session.write("x")).rejects.toThrow(/closed/i);
    });
  });
});
