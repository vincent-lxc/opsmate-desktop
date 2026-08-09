import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { MetricChartStatus, MetricPoint, MetricSeries } from "../components/charts/types";

/**
 * Admin react-query hooks for the U6 data-source candidates page.
 *
 * The list query uses `?status=all` so confirmed candidates stay visible in the
 * same table the user just confirmed — the inline 1h-trend sparkline renders on
 * the confirmed row (the Phase-1 "confirmed metric must be visible" unit). The
 * sparkline fetches a representative 1h `up` series via
 * `POST /data-sources/:id/query`, which wraps the backend connector so the
 * admin never calls Prometheus directly.
 */

export type DataSourceCandidateStatus = "pending" | "confirmed" | "ignored";

export interface DataSourceCandidate {
  id: string;
  server_id: string;
  name: string;
  type: string;
  endpoint: string;
  status: DataSourceCandidateStatus;
  discovery_source: string | null;
  config_json: Record<string, unknown>;
  confirmed_source_id: string | null;
  last_probe_at: string | null;
  created_at: string;
  updated_at: string;
}

// The query endpoint returns Prometheus-agnostic series mapped at the backend
// (epoch-sec -> epoch-ms, NaN -> null). Reuse the canonical chart domain types
// (components/charts/types.ts) instead of redeclaring them so the sparkline path
// cannot drift from MetricChart when those types evolve.
export type DataSourceQueryPoint = MetricPoint;
export type DataSourceQuerySeries = MetricSeries;

export interface DataSourceQueryResult {
  ok: boolean;
  status: MetricChartStatus;
  reason: string | null;
  series: DataSourceQuerySeries[];
}

const BASE = "/api/monitoring/business-metrics";
const CANDIDATES_KEY = ["business-data-source-candidates"] as const;

/** All candidates across every status (pending/confirmed/ignored). */
export function useDataSourceCandidates() {
  return useQuery({
    queryKey: CANDIDATES_KEY,
    queryFn: () =>
      api<{ items: DataSourceCandidate[]; total: number }>(
        `${BASE}/data-source-candidates?status=all`,
      ),
  });
}

/**
 * Fetch a 1h representative-metric series for a confirmed candidate's promoted
 * data source, for the inline sparkline. Only enabled when `sourceId` is
 * present (i.e. the candidate was confirmed into a real business_data_sources
 * row). The trend loads once on confirm and is refreshed by the table reload
 * after the next confirm/ignore (no refetchInterval).
 */
export function useDataSourceSparkline(sourceId: string | null | undefined) {
  return useQuery({
    queryKey: ["business-data-source-query", sourceId] as const,
    enabled: Boolean(sourceId),
    queryFn: () =>
      api<DataSourceQueryResult>(`${BASE}/data-sources/${sourceId}/query`, {
        method: "POST",
        body: JSON.stringify({ query: "up", window_seconds: 3600, step_seconds: 60 }),
      }),
    // Fail-soft: the backend degrades to { ok:false, status:'unavailable', reason }
    // rather than throwing, so a network/5xx still resolves and the sparkline
    // renders an UnavailableCard. Keep retry conservative to avoid hammering a
    // downed Prometheus. No refetchInterval — the trend loads once on confirm
    // and is refreshed by the table reload after the next confirm/ignore.
    retry: 1,
  });
}

export function useConfirmCandidate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<unknown>(`${BASE}/data-source-candidates/${id}/confirm`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CANDIDATES_KEY });
    },
  });
}

export function useIgnoreCandidate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<unknown>(`${BASE}/data-source-candidates/${id}/ignore`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CANDIDATES_KEY });
    },
  });
}