import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../i18n";
import { AlertTuningPage } from "../AlertTuningPage";

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
          <AlertTuningPage />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe("AlertTuningPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/monitoring/alert-tuning")) {
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

  it("renders tabs and switches between rule types", async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(i18n.t("monitoring.alertTuning.title"))).toBeInTheDocument();
    });

    expect(screen.getByText(i18n.t("monitoring.alertTuning.tabs.logMatch"))).toBeInTheDocument();
    await user.click(screen.getByText(i18n.t("monitoring.alertTuning.tabs.signatureSuppress")));
    expect(
      screen.getByText(i18n.t("monitoring.alertTuning.tabs.signatureSuppress")),
    ).toBeInTheDocument();
    expect(screen.getAllByText(i18n.t("monitoring.alertTuning.empty")).length).toBeGreaterThan(0);
  });
});