import { RobotOutlined, SendOutlined } from "@ant-design/icons";
import { Button, Input, Space, Spin, Typography, theme } from "antd";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api/client";

export type AiChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  commands?: string[];
  purchaseUrl?: string;
};

type TerminalAiChatProps = {
  serverId: string;
  ready: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  getRecentOutput: () => string;
  runCommandAndWait: (command: string) => Promise<{ ok: boolean; output: string }>;
  problemEventId?: string;
  interventionSeedMessage?: string;
  /** Shown above the chat thread when starting human intervention. */
  interventionRemediationPlan?: string | null;
  onInterventionComplete?: () => void;
};

type TerminalBlockedCommand = {
  command: string;
  tier: string;
  reason: string;
  status: string;
};

type TerminalAiApiResponse = {
  reply: string;
  commands: string[];
  blocked_commands?: TerminalBlockedCommand[];
  automation_paused?: boolean;
};

export const TERMINAL_AI_MAX_MESSAGES = 40;
export const TERMINAL_AI_MAX_CONTENT_CHARS = 8000;
/** Max automatic command→analyze rounds per user send (Task 8). */
export const MAX_COMMAND_ROUNDS = 3;

function nextId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function subscriptionPathFromUrl(value: string): string | undefined {
  try {
    const relative = value.startsWith("/");
    const url = new URL(value, "https://app.itops.sh");
    if ((!relative && url.protocol !== "https:") || url.pathname !== "/account") {
      return undefined;
    }
    if (url.searchParams.get("tab") !== "subscription") return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

function purchaseUrlFromError(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") {
    return undefined;
  }
  const body = error.body as { code?: unknown; purchase_url?: unknown };
  if (body.code !== "AI_QUOTA_EXCEEDED" || typeof body.purchase_url !== "string") {
    return undefined;
  }
  return subscriptionPathFromUrl(body.purchase_url);
}

function truncateTerminalAiContent(content: string): string {
  return content.trim().slice(-TERMINAL_AI_MAX_CONTENT_CHARS);
}

export function buildTerminalAiApiMessages(
  chatHistory: AiChatMessage[],
  options: {
    contextIntro?: string;
    remediationPlan?: string | null;
    contextInstruction?: string;
    contextAck?: string;
    extraUserContent?: string;
  } = {},
): { role: "user" | "assistant"; content: string }[] {
  const apiMessages: { role: "user" | "assistant"; content: string }[] = [];
  if (options.remediationPlan?.trim()) {
    apiMessages.push({
      role: "user",
      content: truncateTerminalAiContent(
        [
          options.contextIntro,
          options.remediationPlan.trim(),
          options.contextInstruction,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    });
    if (options.contextAck?.trim()) {
      apiMessages.push({
        role: "assistant",
        content: truncateTerminalAiContent(options.contextAck),
      });
    }
  }
  for (const msg of chatHistory) {
    const content = truncateTerminalAiContent(msg.content);
    if (content) apiMessages.push({ role: msg.role, content });
  }
  const extra = options.extraUserContent
    ? truncateTerminalAiContent(options.extraUserContent)
    : "";
  if (extra) apiMessages.push({ role: "user", content: extra });
  return apiMessages.slice(-TERMINAL_AI_MAX_MESSAGES);
}

export function TerminalAiChat({
  serverId,
  ready,
  collapsed,
  onToggleCollapsed,
  getRecentOutput,
  runCommandAndWait,
  problemEventId,
  interventionSeedMessage,
  interventionRemediationPlan,
  onInterventionComplete,
}: TerminalAiChatProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [runningCommand, setRunningCommand] = useState<string | null>(null);
  /** 1-based command batch round while auto-running (null when idle). */
  const [runningRound, setRunningRound] = useState<number | null>(null);
  const [completingIntervention, setCompletingIntervention] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const seededRef = useRef(false);
  const persistedCountRef = useRef(0);
  /** Live session liveness — avoids stale `ready` closure across awaits. */
  const readyRef = useRef(ready);
  const serverIdRef = useRef(serverId);
  const mountedRef = useRef(true);
  /** Bumped to permanently kill in-flight runs (ready drop, serverId change, unmount). */
  const runGenRef = useRef(0);

  useEffect(() => {
    readyRef.current = ready;
    // Permanent kill: once ready falls false, this run gen is dead even if ready returns true
    // on a new SSH session (false→true must not resurrect).
    if (!ready) {
      runGenRef.current += 1;
      setRunningCommand(null);
      setRunningRound(null);
    }
  }, [ready]);

  useEffect(() => {
    // New server = new session; kill any AI run bound to the previous serverId.
    if (serverIdRef.current !== serverId) {
      serverIdRef.current = serverId;
      runGenRef.current += 1;
      setRunningCommand(null);
      setRunningRound(null);
    }
  }, [serverId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!problemEventId) return;
    if (!seededRef.current) {
      seededRef.current = true;
      persistedCountRef.current = 0;
      void api(`/api/problems/${problemEventId}/intervention/start`, { method: "POST" });
      if (interventionSeedMessage) {
        setInput(interventionSeedMessage);
      }
    }
  }, [problemEventId, interventionSeedMessage]);

  const persistInterventionMessages = useCallback(
    async (newMessages: AiChatMessage[]) => {
      if (!problemEventId || newMessages.length === 0) return;
      await api(`/api/problems/${problemEventId}/intervention/messages`, {
        method: "POST",
        body: JSON.stringify({
          messages: newMessages.map((m) => ({
            role: m.role,
            content: m.content,
            commands: m.commands,
          })),
          terminal_transcript: getRecentOutput(),
        }),
      });
    },
    [getRecentOutput, problemEventId],
  );

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const chatMutation = useMutation({
    mutationFn: (body: {
      messages: { role: "user" | "assistant"; content: string }[];
      terminal_output?: string;
    }) => api<TerminalAiApiResponse>(`/api/servers/${serverId}/terminal/ai`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  });

  const recordCommandExecution = useCallback(
    async (command: string, result: { ok: boolean; output: string }) => {
      try {
        await api(`/api/servers/${serverId}/terminal/commands/record`, {
          method: "POST",
          body: JSON.stringify({
            command,
            ok: result.ok,
            output_summary: result.output.trim().slice(-500) || undefined,
            problem_event_id: problemEventId,
          }),
        });
      } catch {
        // Audit failure should not block terminal flow.
      }
    },
    [problemEventId, serverId],
  );

  /**
   * Run one command batch. Returns whether all commands succeeded and the run
   * is still live (session ready + mounted + same generation).
   */
  const executeCommands = useCallback(
    async (
      commands: string[],
      round: number,
      gen: number,
    ): Promise<{ allOk: boolean; live: boolean }> => {
      for (const command of commands) {
        if (!mountedRef.current || gen !== runGenRef.current || !readyRef.current) {
          return { allOk: false, live: false };
        }
        if (mountedRef.current && gen === runGenRef.current) {
          setRunningRound(round);
          setRunningCommand(command);
        }
        const result = await runCommandAndWait(command);
        if (!mountedRef.current || gen !== runGenRef.current) {
          return { allOk: false, live: false };
        }
        await recordCommandExecution(command, result);
        if (!result.ok) {
          if (mountedRef.current && gen === runGenRef.current) {
            setRunningCommand(null);
            setRunningRound(null);
          }
          return { allOk: false, live: readyRef.current && mountedRef.current };
        }
      }
      if (mountedRef.current && gen === runGenRef.current) {
        setRunningCommand(null);
        setRunningRound(null);
      }
      return {
        allOk: true,
        live: mountedRef.current && gen === runGenRef.current && readyRef.current,
      };
    },
    [recordCommandExecution, runCommandAndWait],
  );

  const buildApiMessages = useCallback(
    (chatHistory: AiChatMessage[], extraUserContent?: string) =>
      buildTerminalAiApiMessages(chatHistory, {
        contextIntro: problemEventId ? t("problems.intervention.contextIntro") : undefined,
        remediationPlan: problemEventId ? interventionRemediationPlan : undefined,
        contextInstruction: problemEventId
          ? t("problems.intervention.contextInstruction")
          : undefined,
        contextAck: problemEventId ? t("problems.intervention.contextAck") : undefined,
        extraUserContent,
      }),
    [interventionRemediationPlan, problemEventId, t],
  );

  const callAi = useCallback(
    async (chatHistory: AiChatMessage[], extraUserContent?: string) => {
      return chatMutation.mutateAsync({
        messages: buildApiMessages(chatHistory, extraUserContent),
        terminal_output: getRecentOutput(),
      });
    },
    [buildApiMessages, chatMutation, getRecentOutput],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || chatMutation.isPending || runningCommand) return;
    if (!readyRef.current) return;

    const gen = ++runGenRef.current;
    const priorCount = messages.length;
    const userMessage: AiChatMessage = { id: nextId(), role: "user", content: text };
    let chatHistory = [...messages, userMessage];
    if (mountedRef.current) {
      setMessages(chatHistory);
      setInput("");
    }

    const stillLive = () =>
      mountedRef.current && gen === runGenRef.current && readyRef.current;

    try {
      let response = await callAi(chatHistory);
      if (!stillLive()) return;

      const appendAssistant = (reply: string, commands: string[]) => {
        if (!stillLive()) return;
        const assistantMessage: AiChatMessage = {
          id: nextId(),
          role: "assistant",
          content: reply,
          commands: commands.length > 0 ? commands : undefined,
        };
        chatHistory = [...chatHistory, assistantMessage];
        setMessages(chatHistory);
        window.setTimeout(scrollToBottom, 0);
      };

      appendAssistant(response.reply, response.commands);

      // At most MAX_COMMAND_ROUNDS command batches; stop on first failure or session death.
      for (
        let round = 0;
        round < MAX_COMMAND_ROUNDS && response.commands.length > 0 && stillLive();
        round++
      ) {
        const { allOk, live } = await executeCommands(
          response.commands,
          round + 1,
          gen,
        );
        if (!allOk || !live || !stillLive()) {
          break;
        }
        response = await callAi(chatHistory, t("servers.terminal.ai.analyzePrompt"));
        if (!stillLive()) return;
        appendAssistant(response.reply, response.commands);
      }

      if (!stillLive()) return;
      const batch = chatHistory.slice(priorCount);
      await persistInterventionMessages(batch);
      if (stillLive()) {
        persistedCountRef.current = chatHistory.length;
      }
    } catch (error) {
      if (!stillLive()) return;
      const purchaseUrl = purchaseUrlFromError(error);
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : t("servers.terminal.ai.failed");
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "assistant", content: message, purchaseUrl },
      ]);
      window.setTimeout(scrollToBottom, 0);
    } finally {
      if (mountedRef.current && gen === runGenRef.current) {
        setRunningCommand(null);
        setRunningRound(null);
      }
    }
  }, [
    callAi,
    chatMutation.isPending,
    executeCommands,
    input,
    messages,
    persistInterventionMessages,
    runningCommand,
    scrollToBottom,
    t,
  ]);

  const handleCompleteIntervention = useCallback(async () => {
    if (!problemEventId || completingIntervention) return;
    setCompletingIntervention(true);
    try {
      const pending = messages.slice(persistedCountRef.current);
      await api(`/api/problems/${problemEventId}/intervention/complete`, {
        method: "POST",
        body: JSON.stringify({
          messages:
            pending.length > 0
              ? pending.map((m) => ({
                  role: m.role,
                  content: m.content,
                  commands: m.commands,
                }))
              : undefined,
          terminal_transcript: getRecentOutput(),
        }),
      });
      onInterventionComplete?.();
    } finally {
      setCompletingIntervention(false);
    }
  }, [
    completingIntervention,
    getRecentOutput,
    messages,
    onInterventionComplete,
    problemEventId,
  ]);

  const busy = chatMutation.isPending || Boolean(runningCommand) || completingIntervention;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: token.colorBgContainer,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "8px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorFillAlter,
          flexShrink: 0,
        }}
      >
        <Space size={6}>
          <RobotOutlined style={{ color: token.colorPrimary }} />
          <Typography.Text strong>
            {problemEventId
              ? t("problems.intervention.chatTitle")
              : t("servers.terminal.ai.title")}
          </Typography.Text>
        </Space>
        <Space size={4}>
          {problemEventId ? (
            <Button
              size="small"
              type="primary"
              loading={completingIntervention}
              disabled={busy}
              onClick={() => void handleCompleteIntervention()}
            >
              {t("problems.intervention.complete")}
            </Button>
          ) : null}
          <Button type="link" size="small" onClick={onToggleCollapsed}>
            {collapsed ? t("servers.terminal.ai.expand") : t("servers.terminal.ai.collapse")}
          </Button>
        </Space>
      </div>

      {!collapsed ? (
        <>
          <div
            ref={scrollRef}
            style={{
              flex: 1,
              overflow: "auto",
              padding: 12,
              minHeight: 0,
            }}
          >
            {messages.length === 0 && !interventionRemediationPlan?.trim() ? (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {t("servers.terminal.ai.placeholder")}
              </Typography.Text>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {problemEventId && interventionRemediationPlan?.trim() ? (
                  <div
                    style={{
                      alignSelf: "stretch",
                      padding: "10px 12px",
                      borderRadius: token.borderRadiusLG,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      background: token.colorPrimaryBg,
                    }}
                  >
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t("problems.intervention.remediationPlan")}
                    </Typography.Text>
                    <Typography.Paragraph
                      style={{
                        margin: "6px 0 0",
                        fontSize: 13,
                        lineHeight: 1.55,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {interventionRemediationPlan.trim()}
                    </Typography.Paragraph>
                  </div>
                ) : null}
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    style={{
                      alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                      maxWidth: "92%",
                      padding: "8px 10px",
                      borderRadius: token.borderRadiusLG,
                      background:
                        msg.role === "user" ? token.colorPrimaryBg : token.colorFillSecondary,
                      whiteSpace: "pre-wrap",
                      fontSize: 13,
                      lineHeight: 1.5,
                    }}
                  >
                    {msg.content}
                    {msg.purchaseUrl ? (
                      <div style={{ marginTop: 8 }}>
                        <Link to={msg.purchaseUrl}>
                          <Button type="primary" size="small">
                            {t("servers.terminal.ai.purchaseQuota")}
                          </Button>
                        </Link>
                      </div>
                    ) : null}
                    {msg.commands && msg.commands.length > 0 ? (
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 12,
                          color: token.colorTextSecondary,
                          fontFamily: "ui-monospace, monospace",
                        }}
                      >
                        {t("servers.terminal.ai.willRun")}: {msg.commands.join(" && ")}
                      </div>
                    ) : null}
                  </div>
                ))}
                {busy ? (
                  <div style={{ alignSelf: "flex-start" }}>
                    <Spin size="small" />
                    {runningCommand ? (
                      <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                        {runningRound != null
                          ? t("servers.terminal.ai.runningRound", {
                              round: runningRound,
                              max: MAX_COMMAND_ROUNDS,
                              command: runningCommand,
                            })
                          : t("servers.terminal.ai.running", { command: runningCommand })}
                      </Typography.Text>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
          <div
            style={{
              padding: 10,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <Input.TextArea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t("servers.terminal.ai.inputPlaceholder")}
                autoSize={{ minRows: 1, maxRows: 4 }}
                disabled={!ready || busy}
                style={{ flex: 1 }}
                onPressEnter={(e) => {
                  if (!e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <Button
                type="primary"
                icon={<SendOutlined />}
                disabled={!ready || busy || !input.trim()}
                onClick={() => void handleSend()}
              >
                {t("servers.terminal.ai.send")}
              </Button>
            </div>
            {!ready ? (
              <Typography.Text type="secondary" style={{ fontSize: 12, marginTop: 6, display: "block" }}>
                {t("servers.terminal.ai.waitReady")}
              </Typography.Text>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
