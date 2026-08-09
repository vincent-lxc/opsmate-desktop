import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import { IncidentReportsPage } from "../IncidentReportsPage";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter>
          <IncidentReportsPage />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("IncidentReportsPage (U11)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/incident-reports")) {
          return jsonResponse({
            items: [
              {
                id: "rep-1",
                title: "Alpha manual report",
                status: "draft",
                source: "auto",
                problem_group_id: "srv-a:sig",
                problem_event_id: "evt-1",
                has_export: false,
                created_at: "2026-07-06T10:00:00.000Z",
                updated_at: "2026-07-06T10:00:00.000Z",
              },
            ],
            total: 1,
          });
        }
        return jsonResponse({});
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders list with AI auto badge column", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(i18n.t("incidentReports.list.title"))).toBeInTheDocument();
    });
    expect(await screen.findByText("Alpha manual report")).toBeInTheDocument();
    expect(await screen.findByText(i18n.t("incidentReports.list.autoBadge"))).toBeInTheDocument();
  });
});
