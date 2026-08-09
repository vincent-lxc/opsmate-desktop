import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenExternalRouteArgs,
  EXTERNAL_ROUTE_IDS,
  isExternalRouteId,
  openExternalRoute,
  type ExternalRouteId,
} from "../external-navigation";
import { desktopInvoke, isDesktopRuntime } from "../tauri-bridge";

vi.mock("../tauri-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri-bridge")>();
  return {
    ...actual,
    isDesktopRuntime: vi.fn(() => false),
    desktopInvoke: vi.fn(),
  };
});

/**
 * Canonical wire shape shared with Rust `open_external_route` IPC.
 * Tauri binds command param `req: OpenExternalRouteRequest` from the top-level
 * `req` key — NOT a bare `{ routeId }` object.
 */
const CANONICAL_WIRE = {
  checkout: { req: { routeId: "checkout" as const } },
  account_subscription: { req: { routeId: "account_subscription" as const } },
  terms: { req: { routeId: "terms" as const } },
  privacy: { req: { routeId: "privacy" as const } },
} as const;

describe("external-navigation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exposes only the four fixed ExternalRouteId values", () => {
    const expected: ExternalRouteId[] = [
      "account_subscription",
      "checkout",
      "terms",
      "privacy",
    ];
    expect([...EXTERNAL_ROUTE_IDS].sort()).toEqual([...expected].sort());
    for (const id of expected) {
      expect(isExternalRouteId(id)).toBe(true);
    }
    expect(isExternalRouteId("https://checkout.stripe.com/c/pay/cs_test")).toBe(false);
    expect(isExternalRouteId("https://evil.example/path")).toBe(false);
    expect(isExternalRouteId("opener")).toBe(false);
    expect(isExternalRouteId("account")).toBe(false);
    expect(isExternalRouteId("tg://resolve?domain=x")).toBe(false);
  });

  it("buildOpenExternalRouteArgs matches exact Tauri { req: { routeId } } envelope", () => {
    for (const routeId of EXTERNAL_ROUTE_IDS) {
      const args = buildOpenExternalRouteArgs(routeId);
      expect(args).toEqual(CANONICAL_WIRE[routeId]);
      expect(Object.keys(args)).toEqual(["req"]);
      expect(Object.keys(args.req)).toEqual(["routeId"]);
      // Fail closed: no caller URL/scheme/host/path fields on the wire.
      expect(JSON.stringify(args)).not.toMatch(
        /https?:|stripe\.com|itops\.sh|\/account|qr_url|"url"|"scheme"|"host"|"path"/i,
      );
    }
    // Bare { routeId } is NOT the IPC contract (would not bind Rust `req`).
    expect(buildOpenExternalRouteArgs("checkout")).not.toEqual({ routeId: "checkout" });
  });

  it("browser runtime must not open external routes via IPC", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(false);
    await expect(openExternalRoute("checkout")).rejects.toThrow(/desktop/i);
    expect(desktopInvoke).not.toHaveBeenCalled();
  });

  it("desktop invokes open_external_route with exact { req: { routeId } } wire shape", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    vi.mocked(desktopInvoke).mockResolvedValue(undefined);

    for (const routeId of EXTERNAL_ROUTE_IDS) {
      await openExternalRoute(routeId);
      expect(desktopInvoke).toHaveBeenLastCalledWith(
        "open_external_route",
        CANONICAL_WIRE[routeId],
      );
      const args = vi.mocked(desktopInvoke).mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(Object.keys(args)).toEqual(["req"]);
      expect(args).toEqual({ req: { routeId } });
      expect(JSON.stringify(args)).not.toMatch(/https?:|stripe\.com|qr_url|"url"/i);
    }
  });

  it("rejects non-allowlisted route ids before IPC", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    await expect(
      openExternalRoute("https://checkout.stripe.com/c/pay/cs_test" as ExternalRouteId),
    ).rejects.toThrow("invalid_external_route");
    expect(desktopInvoke).not.toHaveBeenCalled();
  });

  it("invalid route rejection never echoes sentinel URL/secret into public error or IPC", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(true);
    // Attacker-controlled input: URL + secret must not leak via throw message or invoke args.
    const SENTINEL =
      "https://evil.example/open?token=SENTINEL_SECRET_route_9a1b2c&scheme=https";

    let thrown: unknown;
    try {
      await openExternalRoute(SENTINEL as ExternalRouteId);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    expect(err.message).toBe("invalid_external_route");
    expect(err.message).not.toContain(SENTINEL);
    expect(err.message).not.toContain("SENTINEL_SECRET");
    expect(err.message).not.toContain("evil.example");
    expect(err.message).not.toMatch(/https?:\/\//i);
    // No secret material on Error stack either when message was the leak vector.
    expect(String(err)).not.toContain("SENTINEL_SECRET");
    expect(String(err)).not.toContain(SENTINEL);

    expect(desktopInvoke).not.toHaveBeenCalled();
    const ipcDump = JSON.stringify(vi.mocked(desktopInvoke).mock.calls);
    expect(ipcDump).not.toContain(SENTINEL);
    expect(ipcDump).not.toContain("SENTINEL_SECRET");
    expect(ipcDump).not.toContain("evil.example");
  });
});
