import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../i18n";
import { WorkbenchPage } from "../WorkbenchPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const emptyWorkbench = {
  shift: null,
  problems: {
    patrol: { count: 0, items: [] },
    business: { count: 0, items: [] },
  },
  patrol_summary: {
    total: 0,
    normal_count: 0,
    watch_count: 0,
    anomaly_count: 0,
    latest_at: null,
  },
  remediation_queue: { count: 0, items: [] },
  l2_in_progress: { count: 0, items: [] },
  today_tasks: {
    total: 0,
    completed: 0,
    completion_rate: 0,
    from: "2026-07-06T00:00:00.000Z",
    to: "2026-07-06T23:59:59.999Z",
    items: [],
  },
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter>
          <WorkbenchPage />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("WorkbenchPage (U9)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/ops-duty/workbench")) {
          return jsonResponse(emptyWorkbench);
        }
        return jsonResponse({});
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders workbench title and patrol tab by default", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(i18n.t("opsDuty.workbench.title"))).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(i18n.t("opsDuty.workbench.tabs.patrol"))).toBeInTheDocument();
    });
    expect(screen.getByText(i18n.t("opsDuty.workbench.noActiveProblems"))).toBeInTheDocument();
  });

  it("links view-all patrol problems to source=patrol", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(i18n.t("opsDuty.workbench.title"))).toBeInTheDocument();
    });
    const viewAllLinks = screen.getAllByText(i18n.t("opsDuty.workbench.viewAll"));
    const patrolViewAll = viewAllLinks.find(
      (node) => node.closest("a")?.getAttribute("href") === "/problems?source=patrol&sort=severity",
    );
    expect(patrolViewAll).toBeTruthy();
  });
});