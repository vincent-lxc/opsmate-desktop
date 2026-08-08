import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntitlementsProvider, useEntitlements } from "../EntitlementsProvider";
import {
  FREE_ENTITLEMENTS,
  fetchEntitlements,
} from "../../services/entitlements";
import { hasActiveSession } from "../../services/auth/roles";

vi.mock("../../services/auth/roles", () => ({
  hasActiveSession: vi.fn(),
}));

vi.mock("../../services/entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/entitlements")>();
  return { ...actual, fetchEntitlements: vi.fn() };
});

function PlanProbe() {
  const { entitlements } = useEntitlements();
  return <span data-testid="plan">{entitlements.plan}</span>;
}

beforeEach(() => {
  vi.mocked(hasActiveSession).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EntitlementsProvider authenticated fallback", () => {
  it("loads the real Free plan for a secret-free Desktop session", async () => {
    vi.mocked(fetchEntitlements).mockResolvedValue({
      ...FREE_ENTITLEMENTS,
      tenant_id: "tnt_free",
    });

    render(
      <EntitlementsProvider>
        <PlanProbe />
      </EntitlementsProvider>,
    );

    await waitFor(() => expect(fetchEntitlements).toHaveBeenCalledOnce());
    expect(screen.getByTestId("plan")).toHaveTextContent("free");
  });

  it("fails closed to Free when the entitlement request fails", async () => {
    vi.mocked(fetchEntitlements).mockRejectedValue(new Error("proxy unavailable"));

    render(
      <EntitlementsProvider>
        <PlanProbe />
      </EntitlementsProvider>,
    );

    await waitFor(() => expect(fetchEntitlements).toHaveBeenCalledOnce());
    expect(screen.getByTestId("plan")).toHaveTextContent("free");
  });
});
