import { api } from "../api/client";

/**
 * SaaS edition entitlements mirror of the backend
 * `apps/backend/src/services/entitlements.ts` (U1/U2). The admin frontend uses
 * this only to drive menu visibility and upgrade prompts — the backend feature
 * gates remain the source of truth and re-check on every request.
 */
export type EditionPlan = "free" | "enterprise";

export type FeatureKey =
  | "monitoring_projects"
  | "monitoring_center"
  | "foundation"
  | "applications"
  | "dependency_manifests"
  | "patrol"
  | "basic_problem"
  | "event_center"
  | "basic_ai_diagnosis"
  | "oncall_closure"
  | "telegram"
  | "external_risk"
  | "business_observability"
  | "team_governance"
  | "encrypted_credentials"
  | "pdf_postmortem"
  | "long_audit_retention"
  | "emergency_stoploss"
  | "sso"
  | "ha"
  | "private_ai"
  | "dedicated_bot";

export type FeatureMatrix = Record<FeatureKey, boolean>;

export type Entitlements = {
  plan: EditionPlan;
  status: string;
  host_quota: number | null;
  ai_quota: number | null;
  trial_ends_at: string | null;
  features: FeatureMatrix;
  access_profile_key?: string | null;
  menu_paths?: string[] | null;
};

/**
 * Full enterprise feature matrix. Used as the fail-open fallback so:
 *   - dev/test installs with auth disabled keep the full menu;
 *   - the internal/legacy `default` tenant (R17) keeps full capabilities;
 *   - a transient `/api/entitlements/current` fetch error never locks a user
 *     out of the UI — the backend gates still enforce per-request.
 */
export const FULL_FEATURES: FeatureMatrix = {
  monitoring_projects: true,
  monitoring_center: true,
  foundation: true,
  applications: true,
  dependency_manifests: true,
  patrol: true,
  basic_problem: true,
  event_center: true,
  basic_ai_diagnosis: true,
  oncall_closure: true,
  telegram: true,
  external_risk: true,
  business_observability: true,
  team_governance: true,
  encrypted_credentials: true,
  pdf_postmortem: true,
  long_audit_retention: true,
  emergency_stoploss: true,
  sso: true,
  ha: true,
  private_ai: true,
  dedicated_bot: true,
};

/** Permanent Free surface. Keep aligned with the backend plan upper bound. */
export const FREE_FEATURES: FeatureMatrix = {
  monitoring_projects: true,
  monitoring_center: true,
  foundation: true,
  applications: true,
  dependency_manifests: true,
  patrol: true,
  basic_problem: true,
  event_center: true,
  basic_ai_diagnosis: true,
  oncall_closure: false,
  telegram: true,
  external_risk: false,
  business_observability: false,
  team_governance: false,
  encrypted_credentials: true,
  pdf_postmortem: false,
  long_audit_retention: false,
  emergency_stoploss: false,
  sso: false,
  ha: false,
  private_ai: false,
  dedicated_bot: false,
};

export const FREE_ENTITLEMENTS: Entitlements = {
  plan: "free",
  status: "active",
  host_quota: null,
  ai_quota: 500,
  trial_ends_at: null,
  features: FREE_FEATURES,
  access_profile_key: "free",
  menu_paths: null,
};

export const FULL_ENTITLEMENTS: Entitlements = {
  plan: "enterprise",
  status: "active",
  host_quota: null,
  ai_quota: null,
  trial_ends_at: null,
  features: FULL_FEATURES,
  access_profile_key: null,
  menu_paths: null,
};

export type EntitlementsResponse = Entitlements & { tenant_id?: string };

/** Fetch the current tenant's entitlements from GET /api/entitlements/current. */
export async function fetchEntitlements(): Promise<EntitlementsResponse> {
  return api<EntitlementsResponse>("/api/entitlements/current");
}

/** Coerce an arbitrary parsed value into a FeatureMatrix, filling gaps from `base`. */
export function coerceFeatures(
  raw: unknown,
  base: FeatureMatrix = FULL_FEATURES,
): FeatureMatrix {
  const merged: FeatureMatrix = { ...base };
  if (!raw || typeof raw !== "object") return merged;
  const stored = raw as Record<string, unknown>;
  for (const key of Object.keys(merged) as FeatureKey[]) {
    const value = stored[key];
    if (typeof value === "boolean") merged[key] = value;
  }
  return merged;
}

/** Normalize a backend entitlements payload into a local Entitlements object. */
export function normalizeEntitlements(payload: EntitlementsResponse): Entitlements {
  const plan: EditionPlan =
    payload.plan === "free" || payload.plan === "enterprise"
      ? payload.plan
      : "free";
  return {
    plan,
    status: payload.status ?? "active",
    host_quota: payload.host_quota ?? null,
    ai_quota: payload.ai_quota ?? null,
    trial_ends_at: payload.trial_ends_at ?? null,
    features: coerceFeatures(
      payload.features,
      plan === "enterprise" ? FULL_FEATURES : FREE_FEATURES,
    ),
    access_profile_key:
      typeof payload.access_profile_key === "string" ? payload.access_profile_key : null,
    menu_paths: Array.isArray(payload.menu_paths)
      ? payload.menu_paths.filter((path): path is string => typeof path === "string")
      : null,
  };
}
