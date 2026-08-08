import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

/**
 * Admin react-query hooks for anomaly rules (U8 rule-draft review surface).
 *
 * The drafts page lists recommender-generated rules (created_by set, enabled
 * false), edits PromQL/threshold/severity via PATCH, runs a trial via
 * POST /:id/test, and enables a draft with an explicit action (no auto-enable).
 *
 * The backend `AnomalyRule` shape carries the U7 target layering + provenance
 * columns (target_kind, target_ref, evidence_plan, created_by). The update
 * schema (anomalyRuleUpdateSchema) governs which fields PATCH may change:
 * name, rule_type, source_id, query_text, threshold_json, risk_tier, enabled.
 * target_kind/target_ref/evidence_plan are recommender-set and not editable from
 * the admin surface; evaluation_interval_sec (duration) is not in the update
 * schema, so duration editing is deferred to a later unit.
 */

export type AnomalyRuleType =
  | "threshold"
  | "baseline"
  | "ratio"
  | "absence"
  | "log_pattern"
  | "composite";

/** Provenance tag set by the U7 recommender path (never by a direct API caller). */
export type RuleCreatedBy = "ai_recommendation" | "rule_recommendation";

export interface AnomalyRule {
  id: string;
  name: string;
  rule_type: AnomalyRuleType;
  source_id: string | null;
  source_name: string | null;
  query_text: string;
  threshold_json: Record<string, unknown>;
  risk_tier: "L1" | "L2" | "L3";
  enabled: boolean;
  last_evaluated_at: string | null;
  evaluation_interval_sec: number;
  target_kind: string | null;
  target_ref: string | null;
  evidence_plan: Record<string, unknown> | null;
  created_by: RuleCreatedBy | null;
  created_at: string;
  updated_at: string;
}

/** POST /:id/test result — `result_json` carries the trial verdict + sample. */
export interface AnomalyRuleTestRun {
  id: string;
  rule_id: string;
  status: string;
  result_json: {
    matched: boolean;
    sample_value: number | null;
    threshold: Record<string, unknown>;
    message: string;
    evaluation: string;
  };
  created_at: string;
}

/** Fields the backend PATCH accepts (anomalyRuleUpdateSchema). */
export interface AnomalyRuleUpdate {
  name?: string;
  rule_type?: AnomalyRuleType;
  source_id?: string | null;
  query_text?: string;
  threshold_json?: Record<string, unknown>;
  risk_tier?: "L1" | "L2" | "L3";
  enabled?: boolean;
}

const BASE = "/api/monitoring/anomaly-rules";
const RULES_KEY = ["anomaly-rules"] as const;

export type AnomalyRuleListStatus = "draft" | "enabled" | "all";

function rulesListUrl(status: AnomalyRuleListStatus = "all"): string {
  const query = new URLSearchParams({ status });
  return `${BASE}?${query.toString()}`;
}

/** List anomaly rules; U8 tabs pass `draft` | `enabled` | `all`. */
export function useAnomalyRules(status: AnomalyRuleListStatus = "all") {
  return useQuery({
    queryKey: [...RULES_KEY, status],
    queryFn: () => api<{ items: AnomalyRule[]; total: number }>(rulesListUrl(status)),
  });
}

/** PATCH /:id — edit PromQL/threshold/severity or toggle enabled. */
export function useUpdateAnomalyRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AnomalyRuleUpdate }) =>
      api<AnomalyRule>(`${BASE}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (data) => {
      // Apply the PATCH response to the cache immediately so the enabled flag
      // (and edited fields) reflect the backend state without waiting on a
      // refetch — a failed refetch would otherwise leave the UI showing the
      // pre-toggle state (review ADV-03). source_name is not in the PATCH
      // RETURNING, so preserve it from the cached row.
      queryClient.setQueryData<{ items: AnomalyRule[]; total: number }>(RULES_KEY, (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((r) =>
            r.id === data.id ? { ...r, ...data, source_name: r.source_name } : r,
          ),
        };
      });
      void queryClient.invalidateQueries({ queryKey: RULES_KEY, exact: false }).catch(() => {});
    },
  });
}

/**
 * POST /:id/test — trial-run a rule. Returns current value (sample_value) +
 * verdict (matched: breach vs pass). The backend testRun is fail-soft: a
 * downed Prometheus resolves to a run with a `message` reason, not a 5xx.
 *
 * A 30s client-side AbortController guards against a hung network/Prometheus
 * path that would otherwise spin the Test button forever (review R-1) — the
 * abort surfaces as an ApiError caught by the page's handleTest catch.
 */
const TEST_RUN_TIMEOUT_MS = 30_000;
export function useTestAnomalyRule() {
  return useMutation({
    mutationFn: (id: string) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TEST_RUN_TIMEOUT_MS);
      return api<AnomalyRuleTestRun>(`${BASE}/${id}/test`, {
        method: "POST",
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    },
  });
}