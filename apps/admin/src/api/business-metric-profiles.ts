import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { AnomalyRule } from "./anomaly-rules";

export interface BusinessMetricProfile {
  id: string;
  source_id: string;
  source_name: string | null;
  name: string;
  query_text: string;
  unit: string | null;
  enabled: boolean;
  risk_tier: "L1" | "L2" | "L3";
  panel_type: string | null;
  target_kind: string | null;
  metric_name: string | null;
  is_curated: boolean;
  last_synced_at: string | null;
  created_at: string;
}

export interface BusinessMetricProfileUpdate {
  risk_tier?: "L1" | "L2" | "L3";
  enabled?: boolean;
  name?: string;
  query_text?: string;
  unit?: string | null;
  target_kind?: string | null;
}

export interface DraftRulesResult {
  run_id: string | null;
  created: boolean;
  items: AnomalyRule[];
  total: number;
}

const BASE = "/api/monitoring/business-metrics/profiles";

/** PATCH /profiles/:id — update tier and other profile fields. */
export function useUpdateBusinessMetricProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: BusinessMetricProfileUpdate }) =>
      api<BusinessMetricProfile>(`${BASE}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard-layout"] });
    },
  });
}

/** POST /profiles/:id/draft-rules — persist recommender drafts (enabled=false). */
export function useDraftRulesForProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      target_kind,
    }: {
      id: string;
      target_kind?: string;
    }) =>
      api<DraftRulesResult>(`${BASE}/${id}/draft-rules`, {
        method: "POST",
        body: JSON.stringify(target_kind ? { target_kind } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["anomaly-rules"] });
    },
  });
}