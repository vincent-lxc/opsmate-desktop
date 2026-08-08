import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import i18n from "../../i18n";
import enUS from "../../locales/en-US";
import zhCN from "../../locales/zh-CN";
import {
  cloudTerminalFallbackAllowed,
  useServerTerminal,
} from "../useServerTerminal";
import { api } from "../../api/client";
import { isDesktopRuntime, vaultListMeta, vaultStatus } from "../../desktop/tauri-bridge";
import {
  openCloudSshSession,
  openLocalSshSession,
} from "../../desktop/local-ssh-bridge";
import type { LocalSshSessionHandle } from "../../desktop/local-ssh-bridge";

const { terminals } = vi.hoisted(() => ({
  terminals: [] as Array<{
    write: ReturnType<typeof vi.fn>;
    writeln: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onDataHandler?: (data: string) => void;
    cols: number;
    rows: number;
  }>,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    writeln = vi.fn();
    write = vi.fn();
    reset = vi.fn();
    dispose = vi.fn();
    onDataHandler?: (data: string) => void;
    onData = vi.fn((handler: (data: string) => void) => {
      this.onDataHandler = handler;
      return { dispose: vi.fn() };
    });
    constructor() {
      terminals.push(this as never);
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

vi.mock("../../api/client", () => ({
  api: vi.fn(),
}));

vi.mock("../../desktop/tauri-bridge", () => ({
  isDesktopRuntime: vi.fn(() => false),
  vaultStatus: vi.fn(),
  vaultListMeta: vi.fn(),
}));

vi.mock("../../desktop/local-ssh-bridge", () => ({
  openLocalSshSession: vi.fn(),
  openCloudSshSession: vi.fn(),
}));

function lastTerm() {
  return terminals[terminals.length - 1]!;
}

type FakeSocket = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: () => void;
};

type HarnessProps = {
  serverId?: string;
  hasSshKey?: boolean;
  credentialId?: string | null;
  sshCredentialHasCloudSecret?: boolean;
  active?: boolean;
  onReady?: (api: ReturnType<typeof useServerTerminal>) => void;
};

function Harness({
  serverId = "server-1",
  hasSshKey = true,
  credentialId = null,
  sshCredentialHasCloudSecret,
  active = true,
  onReady,
}: HarnessProps) {
  const terminal = useServerTerminal({
    serverId,
    hasSshKey,
    credentialId,
    sshCredentialHasCloudSecret,
    active,
  });
  onReady?.(terminal);
  return <div ref={terminal.containerRef} data-testid="terminal" />;
}

function renderHarness(props: HarnessProps = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <Harness {...props} />
    </I18nextProvider>,
  );
}

describe("cloudTerminalFallbackAllowed", () => {
  it("linked credential: true allows; explicit false never; undefined uses hasSshKey", () => {
    expect(cloudTerminalFallbackAllowed(true, false, "cred-1")).toBe(true);
    expect(cloudTerminalFallbackAllowed(false, true, "cred-1")).toBe(false);
    expect(cloudTerminalFallbackAllowed(undefined, true, "cred-1")).toBe(true);
    expect(cloudTerminalFallbackAllowed(undefined, false, "cred-1")).toBe(false);
  });

  it("no credentialId: legacy inline uses hasSshKey even when cloud flag is false", () => {
    expect(cloudTerminalFallbackAllowed(false, true, null)).toBe(true);
    expect(cloudTerminalFallbackAllowed(false, true, undefined)).toBe(true);
    expect(cloudTerminalFallbackAllowed(false, false, null)).toBe(false);
    expect(cloudTerminalFallbackAllowed(true, false, null)).toBe(false);
  });
});

describe("locale coverage for local terminal hints", () => {
  it("defines en and zh actionable vault messages", () => {
    expect(enUS.servers.terminal.localVaultUnavailable).toBeTruthy();
    expect(enUS.servers.terminal.localOpenFailed).toBeTruthy();
    expect(zhCN.servers.terminal.localVaultUnavailable).toBeTruthy();
    expect(zhCN.servers.terminal.localOpenFailed).toBeTruthy();
    expect(enUS.servers.terminal.localVaultUnavailable).not.toBe(
      zhCN.servers.terminal.localVaultUnavailable,
    );
  });
});

describe("useServerTerminal", () => {
  const urls: string[] = [];
  const webSockets: FakeSocket[] = [];

  beforeEach(async () => {
    urls.length = 0;
    webSockets.length = 0;
    terminals.length = 0;
    await i18n.changeLanguage("en");
    vi.mocked(isDesktopRuntime).mockReturnValue(false);
    vi.mocked(api).mockResolvedValue({ token: "short-ws-token", expires_in_seconds: 60 });
    vi.mocked(vaultStatus).mockReset();
    vi.mocked(vaultListMeta).mockReset();
    vi.mocked(openLocalSshSession).mockReset();
    vi.mocked(openCloudSshSession).mockReset();
    vi.stubGlobal(
      "WebSocket",
      class implements FakeSocket {
        static OPEN = 1;
        static CONNECTING = 0;
        static CLOSED = 3;
        readyState = 0;
        onopen: (() => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        send = vi.fn();
        close = vi.fn(() => {
          this.readyState = 3;
          this.onclose?.();
        });
        constructor(url: string) {
          urls.push(url);
          webSockets.push(this);
        }
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("browser: requests ws-token and opens WebSocket (no regression)", async () => {
    renderHarness({ hasSshKey: true });

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/auth/ws-token", { method: "POST" });
      expect(urls).toHaveLength(1);
    });
    expect(urls[0]).toContain("/api/servers/server-1/terminal");
    expect(urls[0]).toContain("token=short-ws-token");
    expect(openLocalSshSession).not.toHaveBeenCalled();
  });

  it("reconnects with a fresh token when the cloud socket closes before SSH is ready", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api).mockReset();
      vi.mocked(api)
        .mockResolvedValueOnce({ token: "token-1", expires_in_seconds: 60 })
        .mockResolvedValueOnce({ token: "token-2", expires_in_seconds: 60 })
        .mockResolvedValue({ token: "token-3", expires_in_seconds: 60 });

      renderHarness({ hasSshKey: true });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(webSockets).toHaveLength(1);

      act(() => webSockets[0].close());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(api).toHaveBeenCalledTimes(2);
      expect(webSockets).toHaveLength(2);
      expect(new URL(urls[0]).searchParams.get("token")).toBe("token-1");
      expect(new URL(urls[1]).searchParams.get("token")).toBe("token-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("desktop local-only available: opens local SSH and never calls ws-token", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: true, lockedReason: null });
    vi.mocked(vaultListMeta).mockResolvedValue([
      { credentialId: "cred-1", fingerprint: "fp", devicePresent: true },
    ]);
    const handle: LocalSshSessionHandle = {
      sessionId: "sid-1",
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    vi.mocked(openLocalSshSession).mockResolvedValue(handle);

    renderHarness({
      hasSshKey: false,
      credentialId: "cred-1",
      sshCredentialHasCloudSecret: false,
    });

    await waitFor(() => {
      expect(openLocalSshSession).toHaveBeenCalled();
    });
    expect(api).not.toHaveBeenCalledWith("/api/auth/ws-token", expect.anything());
    expect(urls).toHaveLength(0);
    expect(openLocalSshSession).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "server-1",
        credentialId: "cred-1",
      }),
    );
  });

  it("desktop local+cloud: prefers local when device present", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: true });
    vi.mocked(vaultListMeta).mockResolvedValue([
      { credentialId: "cred-1", fingerprint: "fp", devicePresent: true },
    ]);
    vi.mocked(openLocalSshSession).mockResolvedValue({
      sessionId: "sid-1",
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    });

    renderHarness({
      hasSshKey: true,
      credentialId: "cred-1",
      sshCredentialHasCloudSecret: true,
    });

    await waitFor(() => expect(openLocalSshSession).toHaveBeenCalled());
    expect(api).not.toHaveBeenCalledWith("/api/auth/ws-token", expect.anything());
  });

  it("desktop locked vault + cloud true: falls back to native cloud, never WebSocket", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: false, lockedReason: "locked" });
    vi.mocked(openCloudSshSession).mockResolvedValue({
      sessionId: "cloud-sid-1",
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    });

    renderHarness({
      hasSshKey: true,
      credentialId: "cred-1",
      sshCredentialHasCloudSecret: true,
    });

    await waitFor(() => {
      expect(openCloudSshSession).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: "server-1" }),
      );
    });
    expect(openLocalSshSession).not.toHaveBeenCalled();
    // WebView must never request ws-token or construct WebSocket on desktop.
    expect(api).not.toHaveBeenCalledWith("/api/auth/ws-token", expect.anything());
    expect(urls).toHaveLength(0);
    // Open args must not include host/port/username.
    const openArg = vi.mocked(openCloudSshSession).mock.calls[0]![0];
    expect(openArg).not.toHaveProperty("host");
    expect(openArg).not.toHaveProperty("port");
    expect(openArg).not.toHaveProperty("username");
    expect(openArg).not.toHaveProperty("token");
  });

  it("desktop without credential + hasSshKey: native cloud, never WebSocket", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(openCloudSshSession).mockResolvedValue({
      sessionId: "cloud-sid-2",
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    });

    renderHarness({ hasSshKey: true, credentialId: null });

    await waitFor(() => expect(openCloudSshSession).toHaveBeenCalled());
    expect(urls).toHaveLength(0);
    expect(api).not.toHaveBeenCalledWith("/api/auth/ws-token", expect.anything());
  });

  it("desktop cloud reconnect never re-enters WebView WebSocket path", async () => {
    // After native cloud open + remote close, fit/run must not construct WebSocket.
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: false, lockedReason: "locked" });
    let onOutput!: (c: { stream: "stdout" | "stderr" | "closed"; data: Uint8Array }) => void;
    const write = vi.fn(async () => {});
    vi.mocked(openCloudSshSession).mockImplementation(async (opts) => {
      onOutput = opts.onOutput;
      return {
        sessionId: "cloud-sid-r",
        write,
        resize: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      };
    });

    let apiRef: ReturnType<typeof useServerTerminal> | null = null;
    renderHarness({
      hasSshKey: true,
      credentialId: "cred-1",
      sshCredentialHasCloudSecret: true,
      onReady: (a) => {
        apiRef = a;
      },
    });

    await waitFor(() => expect(openCloudSshSession).toHaveBeenCalled());
    await waitFor(() => expect(apiRef!.ready).toBe(true));
    act(() => {
      onOutput({ stream: "closed", data: new Uint8Array(0) });
    });
    await waitFor(() => expect(apiRef!.ready).toBe(false));
    expect(apiRef!.runCommand("echo hi")).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(urls).toHaveLength(0);
    expect(api).not.toHaveBeenCalledWith("/api/auth/ws-token", expect.anything());
  });

  it("desktop missing local + explicit cloud false: no ws-token, shows vault tip", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: true });
    vi.mocked(vaultListMeta).mockResolvedValue([]);

    renderHarness({
      hasSshKey: true,
      credentialId: "cred-1",
      sshCredentialHasCloudSecret: false,
    });

    await waitFor(() => {
      expect(lastTerm().writeln).toHaveBeenCalled();
    });
    expect(api).not.toHaveBeenCalledWith("/api/auth/ws-token", expect.anything());
    expect(urls).toHaveLength(0);
    const written = lastTerm().writeln.mock.calls.map((c) => String(c[0])).join("\n");
    expect(written).toMatch(/vault|credential|import|unlock|保险库|凭据|导入|解锁/i);
  });

  it("local open reject does not fall back to WebSocket", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: true });
    vi.mocked(vaultListMeta).mockResolvedValue([
      { credentialId: "cred-1", fingerprint: "fp", devicePresent: true },
    ]);
    vi.mocked(openLocalSshSession).mockRejectedValue(new Error("tofu denied"));

    renderHarness({
      hasSshKey: true,
      credentialId: "cred-1",
      sshCredentialHasCloudSecret: true,
    });

    await waitFor(() => {
      expect(openLocalSshSession).toHaveBeenCalled();
      expect(lastTerm().writeln).toHaveBeenCalled();
    });
    expect(api).not.toHaveBeenCalledWith("/api/auth/ws-token", expect.anything());
    expect(urls).toHaveLength(0);
  });

  it("early pre-bind stdout preserves prompt, does not set ready until handle is live", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: true });
    vi.mocked(vaultListMeta).mockResolvedValue([
      { credentialId: "cred-1", fingerprint: "fp", devicePresent: true },
    ]);

    let resolveOpen!: (h: LocalSshSessionHandle) => void;
    const openP = new Promise<LocalSshSessionHandle>((r) => {
      resolveOpen = r;
    });
    vi.mocked(openLocalSshSession).mockImplementation(async (opts) => {
      // Early output before open resolves (pre-bind)
      opts.onOutput({ stream: "stdout", data: new TextEncoder().encode("prompt>") });
      return openP;
    });

    let apiRef: ReturnType<typeof useServerTerminal> | null = null;
    renderHarness({
      credentialId: "cred-1",
      sshCredentialHasCloudSecret: false,
      onReady: (a) => {
        apiRef = a;
      },
    });

    await waitFor(() => expect(openLocalSshSession).toHaveBeenCalled());
    await waitFor(() => {
      expect(lastTerm().write).toHaveBeenCalled();
    });
    // Not ready while open is still pending
    expect(apiRef!.ready).toBe(false);
    const resetsBefore = lastTerm().reset.mock.calls.length;

    resolveOpen({
      sessionId: "sid-1",
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    });

    await waitFor(() => {
      expect(apiRef!.ready).toBe(true);
    });
    expect(lastTerm().reset.mock.calls.length).toBe(resetsBefore);
    expect(apiRef!.getRecentOutput()).toContain("prompt>");
  });

  it("pre-bind remote closed: stays not-ready, no usable handle, no AI commands", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: true });
    vi.mocked(vaultListMeta).mockResolvedValue([
      { credentialId: "cred-1", fingerprint: "fp", devicePresent: true },
    ]);

    let resolveOpen!: (h: LocalSshSessionHandle) => void;
    const openP = new Promise<LocalSshSessionHandle>((r) => {
      resolveOpen = r;
    });
    const write = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    vi.mocked(openLocalSshSession).mockImplementation(async (opts) => {
      opts.onOutput({ stream: "stdout", data: new TextEncoder().encode("bye") });
      opts.onOutput({ stream: "closed", data: new Uint8Array(0) });
      return openP;
    });

    let apiRef: ReturnType<typeof useServerTerminal> | null = null;
    renderHarness({
      credentialId: "cred-1",
      sshCredentialHasCloudSecret: true,
      onReady: (a) => {
        apiRef = a;
      },
    });

    await waitFor(() => expect(openLocalSshSession).toHaveBeenCalled());
    resolveOpen({
      sessionId: "sid-1",
      write,
      resize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      dispose,
    });

    await waitFor(() => expect(dispose).toHaveBeenCalled());
    expect(apiRef!.ready).toBe(false);
    expect(apiRef!.runCommand("echo hi")).toBe(false);
    expect(write).not.toHaveBeenCalled();
    const waited = await apiRef!.runCommandAndWait("echo hi");
    expect(waited).toEqual({ ok: false, output: "" });
    expect(api).not.toHaveBeenCalledWith("/api/auth/ws-token", expect.anything());
  });

  it("post-open remote closed: runCommand false, no resize write, runCommandAndWait fails fast", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: true });
    vi.mocked(vaultListMeta).mockResolvedValue([
      { credentialId: "cred-1", fingerprint: "fp", devicePresent: true },
    ]);
    const write = vi.fn(async () => {});
    const resize = vi.fn(async () => {});
    let onOutput!: (c: { stream: "stdout" | "stderr" | "closed"; data: Uint8Array }) => void;
    vi.mocked(openLocalSshSession).mockImplementation(async (opts) => {
      onOutput = opts.onOutput;
      return {
        sessionId: "sid-1",
        write,
        resize,
        close: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      };
    });

    let apiRef: ReturnType<typeof useServerTerminal> | null = null;
    renderHarness({
      credentialId: "cred-1",
      onReady: (a) => {
        apiRef = a;
      },
    });

    await waitFor(() => expect(openLocalSshSession).toHaveBeenCalled());
    await waitFor(() => expect(apiRef!.ready).toBe(true));
    // Ignore scheduleFit resizes from successful open
    resize.mockClear();
    write.mockClear();

    act(() => {
      onOutput({ stream: "closed", data: new Uint8Array(0) });
    });
    await waitFor(() => expect(apiRef!.ready).toBe(false));

    expect(apiRef!.runCommand("ls")).toBe(false);
    expect(write).not.toHaveBeenCalled();
    const waited = await apiRef!.runCommandAndWait("ls");
    expect(waited).toEqual({ ok: false, output: "" });

    act(() => {
      apiRef!.fitTerminal();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(resize).not.toHaveBeenCalled();
  });

  it("browser legacy inline: null credentialId + hasSshKey + cloud false still opens WebSocket", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(false);
    renderHarness({
      hasSshKey: true,
      credentialId: null,
      sshCredentialHasCloudSecret: false,
    });

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/auth/ws-token", { method: "POST" });
      expect(urls).toHaveLength(1);
    });
    expect(urls[0]).toContain("/api/servers/server-1/terminal");
  });

  it("browser linked local-only: credentialId + cloud false never requests ws-token", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(false);
    renderHarness({
      hasSshKey: true,
      credentialId: "cred-1",
      sshCredentialHasCloudSecret: false,
    });

    await waitFor(() => {
      expect(lastTerm().writeln).toHaveBeenCalled();
    });
    expect(api).not.toHaveBeenCalledWith("/api/auth/ws-token", expect.anything());
    expect(urls).toHaveLength(0);
  });

  it("onData writes via local handle; resize calls local resize; closed sets ready false", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: true });
    vi.mocked(vaultListMeta).mockResolvedValue([
      { credentialId: "cred-1", fingerprint: "fp", devicePresent: true },
    ]);
    const write = vi.fn(async () => {});
    const resize = vi.fn(async () => {});
    let onOutput!: (c: { stream: "stdout" | "stderr" | "closed"; data: Uint8Array }) => void;
    vi.mocked(openLocalSshSession).mockImplementation(async (opts) => {
      onOutput = opts.onOutput;
      return {
        sessionId: "sid-1",
        write,
        resize,
        close: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      };
    });

    let apiRef: ReturnType<typeof useServerTerminal> | null = null;
    renderHarness({
      credentialId: "cred-1",
      onReady: (a) => {
        apiRef = a;
      },
    });

    await waitFor(() => expect(openLocalSshSession).toHaveBeenCalled());

    act(() => {
      lastTerm().onDataHandler?.("ls\n");
    });
    await waitFor(() => expect(write).toHaveBeenCalledWith("ls\n"));

    act(() => {
      apiRef!.fitTerminal();
    });
    await waitFor(() => expect(resize).toHaveBeenCalled());

    act(() => {
      onOutput({ stream: "closed", data: new Uint8Array(0) });
    });
    await waitFor(() => {
      expect(apiRef!.ready).toBe(false);
    });
  });

  it("unmount disposes active local handle", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: true });
    vi.mocked(vaultListMeta).mockResolvedValue([
      { credentialId: "cred-1", fingerprint: "fp", devicePresent: true },
    ]);
    const dispose = vi.fn(async () => {});
    vi.mocked(openLocalSshSession).mockResolvedValue({
      sessionId: "sid-1",
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      dispose,
    });

    const { unmount } = renderHarness({ credentialId: "cred-1" });
    await waitFor(() => expect(openLocalSshSession).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(dispose).toHaveBeenCalled());
  });

  it("unmount aborts pending local open via AbortSignal", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: true });
    vi.mocked(vaultListMeta).mockResolvedValue([
      { credentialId: "cred-1", fingerprint: "fp", devicePresent: true },
    ]);
    let seenSignal: AbortSignal | undefined;
    vi.mocked(openLocalSshSession).mockImplementation(
      (opts) =>
        new Promise((_resolve, reject) => {
          seenSignal = opts.signal;
          opts.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );

    const { unmount } = renderHarness({ credentialId: "cred-1" });
    await waitFor(() => expect(openLocalSshSession).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(seenSignal?.aborted).toBe(true));
  });

  it("runCommandAndWait works over local write for AI recent output", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(vaultStatus).mockResolvedValue({ unlocked: true });
    vi.mocked(vaultListMeta).mockResolvedValue([
      { credentialId: "cred-1", fingerprint: "fp", devicePresent: true },
    ]);
    let onOutput!: (c: { stream: "stdout" | "stderr" | "closed"; data: Uint8Array }) => void;
    const write = vi.fn(async (data: string) => {
      if (data.includes("echo")) {
        onOutput({ stream: "stdout", data: new TextEncoder().encode("hello-ai\n") });
      }
    });
    vi.mocked(openLocalSshSession).mockImplementation(async (opts) => {
      onOutput = opts.onOutput;
      return {
        sessionId: "sid-1",
        write,
        resize: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      };
    });

    let apiRef: ReturnType<typeof useServerTerminal> | null = null;
    renderHarness({
      credentialId: "cred-1",
      onReady: (a) => {
        apiRef = a;
      },
    });
    await waitFor(() => expect(openLocalSshSession).toHaveBeenCalled());

    // Shorten wait loop for test by using small command path
    const resultPromise = apiRef!.runCommandAndWait("echo hi");
    // Allow waitForOutput polls to see output
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/hello-ai/);
    expect(apiRef!.getRecentOutput()).toMatch(/hello-ai/);
  }, 15_000);
});
