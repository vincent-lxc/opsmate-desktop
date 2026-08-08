import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App as AntApp } from "antd";
import {
  AdminShell,
  appRoutes,
  filterRoutesByFeatures,
  filterRoutesByMenuPaths,
  isPathAllowedByMenu,
} from "../AdminShell";
import { AppProvider } from "../../providers/AppProvider";
import { EntitlementsProvider } from "../../providers/EntitlementsProvider";
import {
  FULL_FEATURES,
  type Entitlements,
  type FeatureMatrix,
  type FeatureKey,
} from "../../services/entitlements";
import "../../i18n";

/**
 * U2 — edition-aware menu visibility.
 *
 * Product rule (2026-08-01): public SaaS is permanently Free with a mature,
 * reduced feature set. There is no trial or Pro menu surface. Enterprise keeps
 * the full navigation. Backend gates remain the source of truth.
 *
 * ProLayout's `mix` layout collapses submenus under jsdom, so anchor-based
 * DOM assertions are brittle. We assert on the filtered route structure
 * (`filterRoutesByFeatures` + `appRoutes`), which is the single source of
 * menu visibility, plus a render smoke test confirming AdminShell mounts
 * under an injected entitlements value without throwing.
 */

/** Permanent Free public feature matrix. */
const FREE_FEATURES: FeatureMatrix = {
  monitoring_projects: true,
  monitoring_center: true,
  foundation: true,
  applications: true,
  dependency_manifests: true,
  patrol: true,
  basic_problem: true,
  event_center: true,
  basic_ai_diagnosis: true,
  long_audit_retention: false,
  oncall_closure: false,
  telegram: true,
  external_risk: false,
  business_observability: false,
  team_governance: false,
  encrypted_credentials: true,
  pdf_postmortem: false,
  emergency_stoploss: false,
  sso: false,
  ha: false,
  private_ai: false,
  dedicated_bot: false,
};

function freeEntitlements(): Entitlements {
  return {
    plan: "free",
    status: "active",
    host_quota: 3,
    ai_quota: 100,
    trial_ends_at: null,
    features: FREE_FEATURES,
    access_profile_key: "free",
    menu_paths: [
      "/dashboard/overview",
      "/servers",
      "/monitoring/foundation",
      "/monitoring/tasks",
      "/problems",
      "/timeline",
      "/security/credentials",
      "/account",
    ],
  };
}

function enterpriseEntitlements(): Entitlements {
  return {
    plan: "enterprise",
    status: "active",
    host_quota: null,
    ai_quota: null,
    trial_ends_at: null,
    features: FULL_FEATURES,
    access_profile_key: null,
    menu_paths: null,
  };
}

/** Recursively collect leaf paths from a filtered route tree. */
function leafPaths(routes: typeof appRoutes): string[] {
  const out: string[] = [];
  for (const route of routes) {
    if (route.children?.length) {
      out.push(...leafPaths(route.children));
    } else if (route.path) {
      out.push(route.path);
    }
  }
  return out;
}

function has(features: FeatureMatrix): (f: FeatureKey) => boolean {
  return (f) => features[f] === true;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("opsmate_role", "admin");
  localStorage.setItem("opsmate_username", "owner-free");
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
});

describe("AdminShell — edition-aware menu filtering (U2)", () => {
  it("permanent Free menu includes only the mature public feature set", () => {
    const filtered = filterRoutesByFeatures(appRoutes, has(FREE_FEATURES));
    const paths = leafPaths(filtered);

    const expectedPresent = [
      "/dashboard/overview",
      "/servers",
      "/monitoring/foundation",
      "/monitoring/tasks",
      "/problems",
      "/timeline",
      "/security/credentials",
      "/account",
    ];
    for (const path of expectedPresent) {
      expect(paths, `Free menu should include ${path}`).toContain(path);
    }

    for (const path of [
      "/oncall/remediation-queue",
      "/ops-duty/workbench",
      "/external-risk/overview",
      "/monitoring/business-metrics-dashboard",
      "/security/l2-approvals",
      "/settings/im",
      "/settings/users",
    ]) {
      expect(paths, `Free menu should exclude ${path}`).not.toContain(path);
    }
  });

  it("enterprise menu shows the full navigation", () => {
    const filtered = filterRoutesByFeatures(appRoutes, has(FULL_FEATURES));
    const paths = leafPaths(filtered);
    for (const path of [
      "/oncall/remediation-queue",
      "/external-risk/overview",
      "/monitoring/business-data-sources",
      "/ops-duty/calendar",
      "/security/audit-log",
      "/security/retention",
      "/settings/workflows",
      "/settings/im",
    ]) {
      expect(paths, `enterprise menu should include ${path}`).toContain(path);
    }
  });

  it("platform Free menu configuration can remove a mature feature entry", () => {
    const featureFiltered = filterRoutesByFeatures(appRoutes, has(FREE_FEATURES));
    const menuFiltered = filterRoutesByMenuPaths(featureFiltered, [
      "/dashboard/overview",
      "/account",
    ]);
    expect(leafPaths(menuFiltered)).toEqual(["/dashboard/overview", "/account"]);
  });

  it("blocks direct deep links that the Free menu profile does not allow", () => {
    expect(isPathAllowedByMenu("/servers/server-a", ["/servers"])).toBe(true);
    expect(isPathAllowedByMenu("/monitoring/tasks", ["/servers"])).toBe(false);
  });

  it("AdminShell mounts under an injected free entitlements value", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/servers"]}>
        <AppProvider>
          <AntApp>
            <EntitlementsProvider value={freeEntitlements()}>
              <AdminShell>
                <div data-testid="page" />
              </AdminShell>
            </EntitlementsProvider>
          </AntApp>
        </AppProvider>
      </MemoryRouter>,
    );
    // AdminShell renders without throwing and the page child mounts.
    expect(container.querySelector('[data-testid="page"]')).not.toBeNull();
    // The /servers leaf (a top-level leaf, no children) renders a link.
    expect(container.querySelector('a[href="/servers"]')).not.toBeNull();
  });

  it("AdminShell mounts under an injected enterprise entitlements value", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/servers"]}>
        <AppProvider>
          <AntApp>
            <EntitlementsProvider value={enterpriseEntitlements()}>
              <AdminShell>
                <div data-testid="page" />
              </AdminShell>
            </EntitlementsProvider>
          </AntApp>
        </AppProvider>
      </MemoryRouter>,
    );
    expect(container.querySelector('a[href="/servers"]')).not.toBeNull();
  });
});
