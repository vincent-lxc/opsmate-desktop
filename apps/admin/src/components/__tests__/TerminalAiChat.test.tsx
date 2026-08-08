import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { TerminalAiChat } from "../TerminalAiChat";

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

function renderChat() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <AntApp>
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <TerminalAiChat
            serverId="server-a"
            ready
            collapsed={false}
            onToggleCollapsed={vi.fn()}
            getRecentOutput={() => ""}
            runCommandAndWait={vi.fn()}
          />
        </QueryClientProvider>
      </MemoryRouter>
    </AntApp>,
  );
}

describe("TerminalAiChat quota action", () => {
  beforeEach(async () => {
    mocks.api.mockReset();
    await i18n.changeLanguage("zh-CN");
  });

  it("shows a paid AI quota link when the API reports exhausted quota", async () => {
    mocks.api.mockRejectedValueOnce(new mocks.ApiError(
      403,
      "AI quota exceeded for this tenant.",
      {
        code: "AI_QUOTA_EXCEEDED",
        purchase_url: "https://app.itops.sh/account?tab=subscription",
      },
    ));
    renderChat();

    fireEvent.change(screen.getByPlaceholderText("例如：查看 Docker 容器状态和磁盘占用"), {
      target: { value: "检查异常" },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "查看我的订阅" })).toHaveAttribute(
        "href",
        "/account?tab=subscription",
      );
    });
  });
});
