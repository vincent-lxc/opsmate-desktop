import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import {
  isDesktopRuntime,
  vaultListMeta,
  vaultStatus,
} from "../desktop/tauri-bridge";
import {
  openCloudSshSession,
  openLocalSshSession,
  type LocalSshSessionHandle,
} from "../desktop/local-ssh-bridge";
import { buildServerTerminalWsUrl } from "../utils/terminal-url";

export type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "error"; message: string }
  | { type: "ready" };

type WebSocketTokenResponse = {
  token: string;
  expires_in_seconds: number;
};

export type UseServerTerminalOptions = {
  serverId: string;
  /** Compat: true when server reports a key (inline or credential). */
  hasSshKey: boolean;
  /** Linked vault credential id (desktop local SSH). */
  credentialId?: string | null;
  /**
   * From D6b1 DTO. `true` → cloud fallback allowed when local missing;
   * `false` → never cloud; `undefined` → rolling deploy: use hasSshKey.
   */
  sshCredentialHasCloudSecret?: boolean;
  active?: boolean;
};

/**
 * Whether WebSocket cloud terminal may be used when local vault path is unavailable.
 *
 * - Linked credential (`credentialId` present): `ssh_credential_has_cloud_secret`
 *   is authoritative — explicit `false` never uses cloud; `true` allows;
 *   `undefined` falls back to `hasSshKey` (rolling deploy).
 * - No linked credential: legacy inline server key path — only `hasSshKey`
 *   matters. Backend emits `has_cloud_secret=false` with null credential id
 *   for inline keys; that must not block WebSocket.
 */
export function cloudTerminalFallbackAllowed(
  sshCredentialHasCloudSecret: boolean | undefined,
  hasSshKey: boolean,
  credentialId?: string | null,
): boolean {
  const linked = Boolean(credentialId?.trim());
  if (!linked) {
    return hasSshKey;
  }
  if (sshCredentialHasCloudSecret === true) return true;
  if (sshCredentialHasCloudSecret === false) return false;
  return hasSshKey;
}

const TERMINAL_READY_TIMEOUT_MS = 20_000;
const TERMINAL_RECONNECT_DELAY_MS = 1_000;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export function useServerTerminal({
  serverId,
  hasSshKey,
  credentialId = null,
  sshCredentialHasCloudSecret,
  active = true,
}: UseServerTerminalOptions) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const localHandleRef = useRef<LocalSshSessionHandle | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const outputRef = useRef("");
  const [connecting, setConnecting] = useState(false);
  const [ready, setReady] = useState(false);

  const getRecentOutput = useCallback((maxChars = 12000) => {
    return stripAnsi(outputRef.current).slice(-maxChars);
  }, []);

  const fitTerminal = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
    } catch {
      // FitAddon can throw when the container has zero size during layout transitions.
    }
    const local = localHandleRef.current;
    if (local) {
      void local.resize(term.cols, term.rows).catch(() => {
        // Session may already be closed; never log payload.
      });
      return;
    }
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "resize",
          cols: term.cols,
          rows: term.rows,
        }),
      );
    }
  }, []);

  const scheduleFit = useCallback(() => {
    const run = () => fitTerminal();
    requestAnimationFrame(() => requestAnimationFrame(run));
    window.setTimeout(run, 80);
    window.setTimeout(run, 280);
  }, [fitTerminal]);

  const runCommand = useCallback((command: string) => {
    const payload = command.endsWith("\n") ? command : `${command}\n`;
    const local = localHandleRef.current;
    if (local) {
      void local.write(payload).catch(() => {
        // closed session
      });
      return true;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "input", data: payload }));
    return true;
  }, []);

  const waitForOutput = useCallback(
    async (baselineLength: number, timeoutMs = 10_000) => {
      const start = Date.now();
      let lastLen = outputRef.current.length;
      let stableSince = Date.now();

      while (Date.now() - start < timeoutMs) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        const len = outputRef.current.length;
        if (len <= baselineLength) continue;
        if (len === lastLen) {
          if (Date.now() - stableSince >= 700) break;
        } else {
          lastLen = len;
          stableSince = Date.now();
        }
      }
    },
    [],
  );

  const runCommandAndWait = useCallback(
    async (command: string) => {
      const baseline = outputRef.current.length;
      const sent = runCommand(command);
      if (!sent) return { ok: false as const, output: "" };
      await waitForOutput(baseline);
      const chunk = stripAnsi(outputRef.current.slice(baseline)).trim();
      return { ok: true as const, output: chunk };
    },
    [runCommand, waitForOutput],
  );

  useEffect(() => {
    if (!active || !containerRef.current) return;

    const container = containerRef.current;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.15,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: {
        background: "#000000",
        foreground: "#f5f5f5",
        cursor: "#f5f5f5",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;
    outputRef.current = "";
    setReady(false);

    const desktop = isDesktopRuntime();
    const credId = credentialId?.trim() || null;

    const resizeObserver = new ResizeObserver(() => scheduleFit());
    resizeObserver.observe(container);
    const parent = container.parentElement;
    if (parent) resizeObserver.observe(parent);
    const onWindowResize = () => scheduleFit();
    window.addEventListener("resize", onWindowResize);
    scheduleFit();

    let disposed = false;
    /** Bumps on each local open attempt so stale closed/output cannot re-arm a dead session. */
    let localSessionGen = 0;
    const abort = new AbortController();
    let retryAllowed = true;
    let reconnectTimer: number | null = null;
    let readyTimer: number | null = null;

    const clearReadyTimer = () => {
      if (readyTimer !== null) {
        window.clearTimeout(readyTimer);
        readyTimer = null;
      }
    };

    const scheduleBrowserReconnect = () => {
      if (disposed || !retryAllowed || reconnectTimer !== null) return;
      setConnecting(true);
      setReady(false);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void openBrowserCloudSocket();
      }, TERMINAL_RECONNECT_DELAY_MS);
    };

    setConnecting(true);

    const clearWs = () => {
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
      wsRef.current = null;
    };

    const clearLocal = async () => {
      const h = localHandleRef.current;
      localHandleRef.current = null;
      if (h) {
        try {
          await h.dispose();
        } catch {
          // ignore
        }
      }
    };

    /**
     * Browser-only cloud path: WebSocket in WebView.
     * Desktop must never call this (see openDesktopCloud + source assertion tests).
     */
    async function openBrowserCloudSocket() {
      if (desktop) {
        // Hard guard: Tauri branch never constructs WebView WebSocket.
        return;
      }
      await clearLocal();
      retryAllowed = true;
      try {
        const wsToken = await api<WebSocketTokenResponse>("/api/auth/ws-token", {
          method: "POST",
        });
        if (disposed) return;
        const ws = new WebSocket(buildServerTerminalWsUrl(serverId, wsToken.token));
        wsRef.current = ws;

        ws.onopen = () => {
          term.writeln(t("servers.terminal.connecting"));
          clearReadyTimer();
          readyTimer = window.setTimeout(() => {
            if (wsRef.current !== ws || disposed || ws.readyState !== WebSocket.OPEN) return;
            ws.close();
            scheduleBrowserReconnect();
          }, TERMINAL_READY_TIMEOUT_MS);
          scheduleFit();
        };

        ws.onmessage = (event) => {
          let message: TerminalServerMessage;
          try {
            message = JSON.parse(String(event.data)) as TerminalServerMessage;
          } catch {
            return;
          }

          if (message.type === "ready") {
            clearReadyTimer();
            setConnecting(false);
            setReady(true);
            term.reset();
            outputRef.current = "";
            scheduleFit();
            return;
          }

          if (message.type === "output") {
            setConnecting(false);
            outputRef.current += message.data;
            term.write(message.data);
            return;
          }

          if (message.type === "error") {
            retryAllowed = false;
            clearReadyTimer();
            setConnecting(false);
            setReady(false);
            term.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
          }
        };

        ws.onerror = () => {
          clearReadyTimer();
          setConnecting(true);
          setReady(false);
          term.writeln(`\r\n\x1b[31m${t("servers.terminal.connectionFailed")}\x1b[0m`);
        };

        ws.onclose = () => {
          clearReadyTimer();
          if (wsRef.current === ws) {
            wsRef.current = null;
          }
          setReady(false);
          scheduleBrowserReconnect();
        };
      } catch {
        clearReadyTimer();
        setConnecting(true);
        setReady(false);
        term.writeln(`\r\n\x1b[31m${t("servers.terminal.connectionFailed")}\x1b[0m`);
        scheduleBrowserReconnect();
      }
    }

    /**
     * Desktop cloud fallback: native Rust WSS (opaque session handle).
     * Never evaluates `new WebSocket` in the Tauri branch.
     */
    const openDesktopCloud = async () => {
      retryAllowed = false;
      clearReadyTimer();
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearWs();
      term.reset();
      outputRef.current = "";
      const decoder = new TextDecoder();
      const gen = ++localSessionGen;
      let live = false;
      let remoteClosed = false;

      try {
        const handle = await openCloudSshSession({
          serverId,
          signal: abort.signal,
          onOutput: (chunk) => {
            if (disposed || gen !== localSessionGen) return;
            if (chunk.stream === "closed") {
              try {
                outputRef.current += decoder.decode();
              } catch {
                // ignore flush errors
              }
              remoteClosed = true;
              live = false;
              localHandleRef.current = null;
              setConnecting(false);
              setReady(false);
              return;
            }
            if (chunk.stream === "stderr") {
              try {
                const msg = decoder.decode(chunk.data);
                term.writeln(`\r\n\x1b[31m${msg}\x1b[0m`);
              } catch {
                // ignore
              }
              setConnecting(false);
              return;
            }
            term.write(chunk.data);
            try {
              outputRef.current += decoder.decode(chunk.data, { stream: true });
            } catch {
              // skip bad decode for AI buffer only
            }
            setConnecting(false);
            if (live && !remoteClosed && localHandleRef.current) {
              setReady(true);
            }
          },
        });
        if (disposed || gen !== localSessionGen) {
          await handle.dispose();
          return;
        }
        if (remoteClosed) {
          localHandleRef.current = null;
          live = false;
          setConnecting(false);
          setReady(false);
          try {
            await handle.dispose();
          } catch {
            // ignore
          }
          return;
        }
        localHandleRef.current = handle;
        live = true;
        setConnecting(false);
        setReady(true);
        scheduleFit();
      } catch {
        if (disposed || abort.signal.aborted || gen !== localSessionGen) return;
        localHandleRef.current = null;
        live = false;
        setConnecting(false);
        setReady(false);
        term.writeln(`\r\n\x1b[31m${t("servers.terminal.connectionFailed")}\x1b[0m`);
      }
    };

    const showLocalUnavailable = () => {
      setConnecting(false);
      setReady(false);
      term.writeln(`\x1b[33m${t("servers.terminal.localVaultUnavailable")}\x1b[0m`);
    };

    const showNoSshKey = () => {
      setConnecting(false);
      setReady(false);
      term.writeln(`\x1b[31m${t("servers.terminal.noSshKey")}\x1b[0m`);
    };

    const tryLocalDevicePresent = async (): Promise<boolean> => {
      if (!desktop || !credId) return false;
      try {
        const status = await vaultStatus();
        if (!status.unlocked) return false;
        const meta = await vaultListMeta();
        return meta.some((m) => m.credentialId === credId && m.devicePresent);
      } catch {
        // Vault status/list failure → treat as local unavailable (may cloud-fallback).
        return false;
      }
    };

    const openLocal = async (id: string) => {
      // Clear before open so pre-bind prompt is not wiped after resolve.
      retryAllowed = false;
      clearReadyTimer();
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearWs();
      term.reset();
      outputRef.current = "";
      const decoder = new TextDecoder();
      const gen = ++localSessionGen;
      /** True once a live handle is assigned for this generation. */
      let live = false;
      /** Remote closed arrived before (or after) bind for this generation. */
      let remoteClosed = false;

      try {
        const handle = await openLocalSshSession({
          serverId,
          credentialId: id,
          signal: abort.signal,
          onOutput: (chunk) => {
            if (disposed || gen !== localSessionGen) return;
            if (chunk.stream === "closed") {
              try {
                outputRef.current += decoder.decode();
              } catch {
                // ignore flush errors
              }
              remoteClosed = true;
              live = false;
              // Clear active local session so runCommand/resize/AI cannot use it.
              localHandleRef.current = null;
              setConnecting(false);
              setReady(false);
              return;
            }
            // Binary path: write raw bytes to xterm; stream-decode for AI buffer.
            term.write(chunk.data);
            try {
              outputRef.current += decoder.decode(chunk.data, { stream: true });
            } catch {
              // Never log payload; skip bad decode for AI buffer only.
            }
            setConnecting(false);
            // Early pre-bind stdout must not mark ready until a live handle is bound.
            if (live && !remoteClosed && localHandleRef.current) {
              setReady(true);
            }
          },
        });
        if (disposed || gen !== localSessionGen) {
          await handle.dispose();
          return;
        }
        // Pre-bind remote closed: dispose returned handle; stay not-ready.
        if (remoteClosed) {
          localHandleRef.current = null;
          live = false;
          setConnecting(false);
          setReady(false);
          try {
            await handle.dispose();
          } catch {
            // ignore
          }
          return;
        }
        localHandleRef.current = handle;
        live = true;
        setConnecting(false);
        setReady(true);
        scheduleFit();
        // Do NOT reset after open — preserves pre-bind prompt already written.
      } catch {
        if (disposed || abort.signal.aborted || gen !== localSessionGen) return;
        // Once local open was chosen, never silent-fallback to cloud.
        localHandleRef.current = null;
        live = false;
        setConnecting(false);
        setReady(false);
        term.writeln(`\r\n\x1b[31m${t("servers.terminal.localOpenFailed")}\x1b[0m`);
      }
    };

    const start = async () => {
      if (desktop && credId) {
        const localPresent = await tryLocalDevicePresent();
        if (disposed) return;
        if (localPresent) {
          await openLocal(credId);
          return;
        }
        // Local missing/locked/error → native cloud only when linked credential allows it.
        if (
          cloudTerminalFallbackAllowed(
            sshCredentialHasCloudSecret,
            hasSshKey,
            credId,
          )
        ) {
          await openDesktopCloud();
          return;
        }
        showLocalUnavailable();
        return;
      }

      // Desktop without linked credential: still native cloud when allowed (no WebSocket).
      if (desktop) {
        if (
          cloudTerminalFallbackAllowed(
            sshCredentialHasCloudSecret,
            hasSshKey,
            credId,
          )
        ) {
          await openDesktopCloud();
          return;
        }
        showNoSshKey();
        return;
      }

      // Browser only: WebSocket cloud terminal.
      if (
        cloudTerminalFallbackAllowed(
          sshCredentialHasCloudSecret,
          hasSshKey,
          credId,
        )
      ) {
        await openBrowserCloudSocket();
        return;
      }
      showNoSshKey();
    };

    void start();

    const dataDisposable = term.onData((data) => {
      const local = localHandleRef.current;
      if (local) {
        void local.write(data).catch(() => {
          // closed
        });
        return;
      }
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    return () => {
      disposed = true;
      abort.abort();
      clearReadyTimer();
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      dataDisposable.dispose();
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowResize);
      clearWs();
      void clearLocal();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      outputRef.current = "";
      setConnecting(false);
      setReady(false);
    };
  }, [
    active,
    credentialId,
    hasSshKey,
    sshCredentialHasCloudSecret,
    fitTerminal,
    scheduleFit,
    serverId,
    t,
  ]);

  return {
    containerRef,
    connecting,
    ready,
    getRecentOutput,
    runCommand,
    runCommandAndWait,
    fitTerminal,
    scheduleFit,
  };
}
