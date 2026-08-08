import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import { OpsDutyCalendarPage } from "../OpsDutyCalendarPage";

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
          <OpsDutyCalendarPage />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("OpsDutyCalendarPage (U10)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/ops-duty/shifts/resolve")) {
          return jsonResponse({ shift: null });
        }
        if (url.includes("/api/ops-duty/shifts")) {
          return jsonResponse({ items: [] });
        }
        return jsonResponse({});
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders workbench link (R24)", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(i18n.t("opsDuty.calendar.openWorkbench"))).toBeInTheDocument();
    });
    const link = screen.getByRole("link", { name: i18n.t("opsDuty.calendar.openWorkbench") });
    expect(link).toHaveAttribute("href", "/ops-duty/workbench");
  });
});