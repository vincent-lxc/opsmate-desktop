/**
 * Task 8 — Terminal AI execution loop behavior (desktop secure runtime).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { MAX_COMMAND_ROUNDS, TerminalAiChat } from "../TerminalAiChat";

const mocks = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
      public readonly body?: unknown,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return { api: vi.fn(), ApiError: MockApiError };
});

vi.mock("../../api/client", () => ({
  api: mocks.api,
  ApiError: mocks.ApiError,
}));

type RunResult = { ok: boolean; output: string };

function renderChat(opts: {
  ready?: boolean;
  serverId?: string;
  getRecentOutput?: () => string;
  runCommandAndWait?: (cmd: string) => Promise<RunResult>;
  onReadyChange?: (setReady: (v: boolean) => void) => void;
  onServerIdChange?: (setServerId: (v: string) => void) => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const runCommandAndWait =
    opts.runCommandAndWait ?? vi.fn(async () => ({ ok: true, output: "ok" }));
  const getRecentOutput = opts.getRecentOutput ?? (() => "recent-term-out");

  function Harness() {
    const [ready, setReady] = useState(opts.ready ?? true);
    const [serverId, setServerId] = useState(opts.serverId ?? "server-a");
    opts.onReadyChange?.(setReady);
    opts.onServerIdChange?.(setServerId);
    return (
      <TerminalAiChat
        serverId={serverId}
        ready={ready}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        getRecentOutput={getRecentOutput}
        runCommandAndWait={runCommandAndWait}
      />
    );
  }

  const utils = render(
    <AntApp>
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>
      </MemoryRouter>
    </AntApp>,
  );
  return { ...utils, runCommandAndWait, getRecentOutput };
}

describe("TerminalAiChat execution loop (Task 8)", () => {
  beforeEach(async () => {
    mocks.api.mockReset();
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports MAX_COMMAND_ROUNDS = 3", () => {
    expect(MAX_COMMAND_ROUNDS).toBe(3);
  });

  it("auto-runs commands and sends terminal_output for analysis", async () => {
    const runCommandAndWait = vi.fn(async (cmd: string) => ({
      ok: true,
      output: `out:${cmd}`,
    }));
    let aiCalls = 0;
    mocks.api.mockImplementation(async (path: string, init?: { body?: string }) => {
      if (String(path).includes("/terminal/ai")) {
        aiCalls += 1;
        const body = init?.body ? JSON.parse(init.body) : {};
        if (aiCalls === 1) {
          expect(body.terminal_output).toBe("recent-term-out");
          return { reply: "r1", commands: ["echo one", "echo two"] };
        }
        // Analysis after commands
        expect(body.terminal_output).toBe("recent-term-out");
        return { reply: "done", commands: [] };
      }
      if (String(path).includes("/commands/record")) return {};
      throw new Error(`unexpected ${path}`);
    });

    renderChat({ runCommandAndWait });

    fireEvent.change(screen.getByPlaceholderText(/例如：查看 Docker/), {
      target: { value: "检查服务" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    await waitFor(() => {
      expect(runCommandAndWait).toHaveBeenCalledWith("echo one");
      expect(runCommandAndWait).toHaveBeenCalledWith("echo two");
    });
    await waitFor(() => expect(aiCalls).toBeGreaterThanOrEqual(2));
  });

  it("shows localized round N/3 and current command while running", async () => {
    let resolveRun!: (r: RunResult) => void;
    const runCommandAndWait = vi.fn(
      () =>
        new Promise<RunResult>((r) => {
          resolveRun = r;
        }),
    );
    mocks.api.mockImplementation(async (path: string) => {
      if (String(path).includes("/terminal/ai")) {
        return { reply: "go", commands: ["sleep-long"] };
      }
      if (String(path).includes("/commands/record")) return {};
      return {};
    });

    renderChat({ runCommandAndWait });
    fireEvent.change(screen.getByPlaceholderText(/例如：查看 Docker/), {
      target: { value: "跑命令" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    await waitFor(() => {
      expect(
        screen.getByText((content) => /第\s*1\s*\/\s*3\s*轮/.test(content) && content.includes("sleep-long")),
      ).toBeTruthy();
    });

    await act(async () => {
      resolveRun({ ok: true, output: "done" });
    });
    await waitFor(() => expect(runCommandAndWait).toHaveBeenCalled());
  });

  it("first failed command stops batch and all later AI rounds", async () => {
    const runCommandAndWait = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, output: "fail" })
      .mockResolvedValue({ ok: true, output: "ok" });
    let aiCalls = 0;
    mocks.api.mockImplementation(async (path: string) => {
      if (String(path).includes("/terminal/ai")) {
        aiCalls += 1;
        if (aiCalls === 1) {
          return { reply: "r1", commands: ["bad", "never-run"] };
        }
        // Must not be called for analysis after failure
        return { reply: "should-not", commands: ["again"] };
      }
      if (String(path).includes("/commands/record")) return {};
      return {};
    });

    renderChat({ runCommandAndWait });
    fireEvent.change(screen.getByPlaceholderText(/例如：查看 Docker/), {
      target: { value: "失败场景" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    await waitFor(() => {
      expect(runCommandAndWait).toHaveBeenCalledWith("bad");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(runCommandAndWait).not.toHaveBeenCalledWith("never-run");
    // Only initial AI call — no follow-up analysis rounds
    expect(aiCalls).toBe(1);
  });

  it("ready becoming false mid-await stops later commands and AI rounds", async () => {
    let setReady!: (v: boolean) => void;
    let resolveFirst!: (r: RunResult) => void;
    const runCommandAndWait = vi.fn(
      (cmd: string) =>
        new Promise<RunResult>((r) => {
          if (cmd === "cmd-a") resolveFirst = r;
        }),
    );
    let aiCalls = 0;
    mocks.api.mockImplementation(async (path: string) => {
      if (String(path).includes("/terminal/ai")) {
        aiCalls += 1;
        return { reply: "r", commands: ["cmd-a", "cmd-b"] };
      }
      if (String(path).includes("/commands/record")) return {};
      return {};
    });

    renderChat({
      runCommandAndWait,
      onReadyChange: (sr) => {
        setReady = sr;
      },
    });

    fireEvent.change(screen.getByPlaceholderText(/例如：查看 Docker/), {
      target: { value: "断线" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    await waitFor(() => expect(runCommandAndWait).toHaveBeenCalledWith("cmd-a"));

    act(() => setReady(false));
    await act(async () => {
      resolveFirst({ ok: true, output: "a" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runCommandAndWait).not.toHaveBeenCalledWith("cmd-b");
    expect(aiCalls).toBe(1);
  });

  it("ready false then true again never resurrects the killed AI run", async () => {
    let setReady!: (v: boolean) => void;
    let resolveFirst!: (r: RunResult) => void;
    const runCommandAndWait = vi.fn(
      (cmd: string) =>
        new Promise<RunResult>((r) => {
          if (cmd === "cmd-a") resolveFirst = r;
        }),
    );
    let aiCalls = 0;
    mocks.api.mockImplementation(async (path: string) => {
      if (String(path).includes("/terminal/ai")) {
        aiCalls += 1;
        return { reply: "r", commands: ["cmd-a", "cmd-b"] };
      }
      if (String(path).includes("/commands/record")) return {};
      return {};
    });

    renderChat({
      runCommandAndWait,
      onReadyChange: (sr) => {
        setReady = sr;
      },
    });

    fireEvent.change(screen.getByPlaceholderText(/例如：查看 Docker/), {
      target: { value: "会话切换" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));
    await waitFor(() => expect(runCommandAndWait).toHaveBeenCalledWith("cmd-a"));

    // Session dies then a *new* SSH session becomes ready — old run must stay dead.
    act(() => setReady(false));
    act(() => setReady(true));
    await act(async () => {
      resolveFirst({ ok: true, output: "a" });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runCommandAndWait).not.toHaveBeenCalledWith("cmd-b");
    expect(aiCalls).toBe(1);
  });

  it("serverId change permanently kills the in-flight AI run", async () => {
    let setServerId!: (v: string) => void;
    let resolveFirst!: (r: RunResult) => void;
    const runCommandAndWait = vi.fn(
      (cmd: string) =>
        new Promise<RunResult>((r) => {
          if (cmd === "cmd-a") resolveFirst = r;
        }),
    );
    let aiCalls = 0;
    mocks.api.mockImplementation(async (path: string) => {
      if (String(path).includes("/terminal/ai")) {
        aiCalls += 1;
        return { reply: "r", commands: ["cmd-a", "cmd-b"] };
      }
      if (String(path).includes("/commands/record")) return {};
      return {};
    });

    renderChat({
      runCommandAndWait,
      onServerIdChange: (ss) => {
        setServerId = ss;
      },
    });

    fireEvent.change(screen.getByPlaceholderText(/例如：查看 Docker/), {
      target: { value: "换服务器" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));
    await waitFor(() => expect(runCommandAndWait).toHaveBeenCalledWith("cmd-a"));

    act(() => setServerId("server-b"));
    await act(async () => {
      resolveFirst({ ok: true, output: "a" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runCommandAndWait).not.toHaveBeenCalledWith("cmd-b");
    expect(aiCalls).toBe(1);
  });

  it("unmount during run does not throw or schedule stale command runs", async () => {
    let resolveRun!: (r: RunResult) => void;
    const runCommandAndWait = vi.fn(
      () =>
        new Promise<RunResult>((r) => {
          resolveRun = r;
        }),
    );
    mocks.api.mockImplementation(async (path: string) => {
      if (String(path).includes("/terminal/ai")) {
        return { reply: "r", commands: ["hold"] };
      }
      if (String(path).includes("/commands/record")) return {};
      return {};
    });

    const { unmount } = renderChat({ runCommandAndWait });
    fireEvent.change(screen.getByPlaceholderText(/例如：查看 Docker/), {
      target: { value: "卸载" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));
    await waitFor(() => expect(runCommandAndWait).toHaveBeenCalled());

    unmount();
    await act(async () => {
      resolveRun({ ok: true, output: "x" });
      await Promise.resolve();
    });
    // No second AI call after unmount
    const aiPosts = mocks.api.mock.calls.filter((c) =>
      String(c[0]).includes("/terminal/ai"),
    );
    expect(aiPosts.length).toBe(1);
  });

  it("quota error shows purchase action and leaves input usable when ready", async () => {
    mocks.api.mockRejectedValueOnce(
      new mocks.ApiError(403, "AI quota exceeded for this tenant.", {
        code: "AI_QUOTA_EXCEEDED",
        purchase_url: "https://app.itops.sh/account?tab=subscription",
      }),
    );

    renderChat({ ready: true });
    fireEvent.change(screen.getByPlaceholderText(/例如：查看 Docker/), {
      target: { value: "配额" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "查看我的订阅" })).toHaveAttribute(
        "href",
        "/account?tab=subscription",
      );
    });
    // Terminal remains usable: can type a new message (send stays disabled until non-empty).
    const input = screen.getByPlaceholderText(/例如：查看 Docker/);
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "再试一次" } });
    expect(screen.getByRole("button", { name: /发送/ })).not.toBeDisabled();
  });

  it("caps automatic analysis to MAX_COMMAND_ROUNDS command batches", async () => {
    const runCommandAndWait = vi.fn(async () => ({ ok: true, output: "ok" }));
    let aiCalls = 0;
    mocks.api.mockImplementation(async (path: string) => {
      if (String(path).includes("/terminal/ai")) {
        aiCalls += 1;
        // Always return more commands — loop must stop after 3 command rounds
        return { reply: `r${aiCalls}`, commands: [`c${aiCalls}`] };
      }
      if (String(path).includes("/commands/record")) return {};
      return {};
    });

    renderChat({ runCommandAndWait });
    fireEvent.change(screen.getByPlaceholderText(/例如：查看 Docker/), {
      target: { value: "多轮" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    await waitFor(() => {
      // Initial AI + up to MAX_COMMAND_ROUNDS analysis AI calls after each batch
      // Rounds: each round runs commands then may call AI again.
      // Max command rounds = 3 means at most 3 executeCommands batches.
      expect(runCommandAndWait.mock.calls.length).toBe(MAX_COMMAND_ROUNDS);
    });
    // 1 initial + 3 post-command analyses would be 4, but last analysis after round 3
    // may still run once to append final reply — plan says max 3 rounds of commands.
    expect(runCommandAndWait.mock.calls.length).toBeLessThanOrEqual(MAX_COMMAND_ROUNDS);
  });
});
