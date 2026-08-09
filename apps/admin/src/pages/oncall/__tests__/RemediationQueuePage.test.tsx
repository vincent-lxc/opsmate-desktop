import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../i18n";
import { RemediationQueuePage } from "../RemediationQueuePage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter>
          <RemediationQueuePage />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("RemediationQueuePage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/oncall/remediation-queue")) {
          return jsonResponse({ items: [], total: 0 });
        }
        return jsonResponse({});
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders page title and empty state", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(i18n.t("oncall.remediationQueue.title"))).toBeInTheDocument();
    });
    expect(screen.getByText(i18n.t("oncall.remediationQueue.empty"))).toBeInTheDocument();
  });

  it("renders status action buttons for open queue items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/oncall/remediation-queue")) {
          return jsonResponse({
            items: [
              {
                id: "q1",
                problem_event_id: "evt-12345678",
                server_id: "srv-1",
                failure_reason: "SSH failed",
                suggested_next_step: "Review logs",
                exit_status: "new",
                source: "execution_failed",
                l2_approval_id: null,
                created_at: "2026-07-06T10:00:00Z",
                updated_at: "2026-07-06T10:00:00Z",
              },
            ],
            total: 1,
          });
        }
        return jsonResponse({});
      }),
    );

    renderPage();
    await waitFor(() => {
      expect(
        screen.getByText(i18n.t("oncall.remediationQueue.actions.startIntervention")),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(i18n.t("oncall.remediationQueue.actions.acceptRisk")),
    ).toBeInTheDocument();
  });
});