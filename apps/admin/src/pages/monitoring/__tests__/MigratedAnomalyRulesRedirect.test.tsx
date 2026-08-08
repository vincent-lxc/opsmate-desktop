import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MigratedAnomalyRulesRedirect } from "../MigratedAnomalyRulesRedirect";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("MigratedAnomalyRulesRedirect (U15)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/config/route-sunset")) {
          return jsonResponse({
            deadlines: { anomaly_rule_drafts: "2026-10-06" },
            warning_days: 14,
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

  it("Navigate replace redirects to merged anomaly rules tab", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/monitoring/anomaly-rule-drafts"]}>
          <Routes>
          <Route
            path="/monitoring/anomaly-rule-drafts"
            element={
              <MigratedAnomalyRulesRedirect
                routeKey="anomaly_rule_drafts"
                target="/monitoring/anomaly-rules?tab=draft"
              />
            }
          />
          <Route path="/monitoring/anomaly-rules" element={<div>merged-page</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("merged-page")).toBeInTheDocument();
  });
});
