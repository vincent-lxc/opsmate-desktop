import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { ProblemList } from "../ProblemList";
import "../../i18n";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

let queryClient: QueryClient;
let lastProblemsUrl = "";

beforeEach(() => {
  localStorage.clear();
  lastProblemsUrl = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/problems")) {
        lastProblemsUrl = url;
        return jsonResponse({ items: [], total: 0 });
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  if (queryClient) queryClient.clear();
  vi.unstubAllGlobals();
});

describe("ProblemList — U8 R22 default filter", () => {
  it("requests open preset by default and shows open-filter subtitle", async () => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AntApp>
            <ProblemList />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      screen.getByText(
        "Defaults to open problems with pending verification pinned first; switch filters for the full list.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("problem-list-table")).toBeInTheDocument();

    await waitFor(() => expect(lastProblemsUrl).toContain("filter_preset=open"), {
      timeout: 5000,
    });
  });
});