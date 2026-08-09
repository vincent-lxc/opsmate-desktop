import { describe, expect, it } from "vitest";
import {
  buildTerminalAiApiMessages,
  TERMINAL_AI_MAX_CONTENT_CHARS,
  TERMINAL_AI_MAX_MESSAGES,
  type AiChatMessage,
} from "../TerminalAiChat";

function message(index: number): AiChatMessage {
  return {
    id: String(index),
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index}`,
  };
}

describe("buildTerminalAiApiMessages", () => {
  it("keeps the payload within the terminal AI route message limit", () => {
    const history = Array.from({ length: TERMINAL_AI_MAX_MESSAGES + 8 }, (_, index) =>
      message(index),
    );

    const result = buildTerminalAiApiMessages(history);

    expect(result).toHaveLength(TERMINAL_AI_MAX_MESSAGES);
    expect(result[0].content).toBe("message-8");
    expect(result.at(-1)?.content).toBe(`message-${TERMINAL_AI_MAX_MESSAGES + 7}`);
  });

  it("trims and truncates long content to the backend schema limit", () => {
    const longContent = `  ${"a".repeat(TERMINAL_AI_MAX_CONTENT_CHARS + 25)}  `;

    const result = buildTerminalAiApiMessages([
      {
        id: "long",
        role: "user",
        content: longContent,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(TERMINAL_AI_MAX_CONTENT_CHARS);
    expect(result[0].content).toBe("a".repeat(TERMINAL_AI_MAX_CONTENT_CHARS));
  });

  it("truncates remediation context before adding it to the payload", () => {
    const result = buildTerminalAiApiMessages([], {
      contextIntro: "intro",
      remediationPlan: "p".repeat(TERMINAL_AI_MAX_CONTENT_CHARS + 100),
      contextInstruction: "instruction",
      contextAck: "ack",
    });

    expect(result[0].role).toBe("user");
    expect(result[0].content).toHaveLength(TERMINAL_AI_MAX_CONTENT_CHARS);
    expect(result[1]).toEqual({ role: "assistant", content: "ack" });
  });
});
