import { api, proTableRequest, type ProTableRequestParams } from "./client";

const BASE = "/api/external-risk";

export type ExternalRiskSeverity = "P1" | "P2" | "P3";
export type ExternalRiskConfidence = "high" | "medium" | "low";
export type ExternalRiskTargetKind = "foundation" | "dependency" | "both";
export type ExternalRiskProviderKind =
  | "osv"
  | "github_advisory"
  | "github_repo"
  | "nvd"
  | "registry"
  | "custom_url"
  | "rss";
export type ExternalRiskProviderHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type ExternalRiskFindingStatus =
  | "new"
  | "acknowledged"
  | "in_progress"
  | "resolved"
  | "ignored"
  | "false_positive"
  | "superseded";
export type ExternalRiskRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type ExternalRiskSummary = {
  open_findings: number;
  open_critical: number;
  new_today: number;
  provider_failures: number;
  enabled_tasks: number;
};

export type ExternalRiskDistributions = {
  severity: { P1: number; P2: number; P3: number };
  finding_types: Array<{ finding_type: string; count: number }>;
};

export type ExternalRiskAssetSummary = {
  target_kind: string;
  target_id: string;
  open_p1: number;
  open_p2: number;
  open_p3: number;
  open_total: number;
  current_version: string | null;
  recommended_upgrade_version: string | null;
  cve_count: number;
  bug_count: number;
  eol_count: number;
};

export type ExternalRiskFindingEvent = {
  id: string;
  event_type: string;
  timestamp: string;
  human_involved: boolean;
  payload: Record<string, unknown>;
};

export type ExternalRiskProvider = {
  id: string;
  name: string;
  kind: string;
  config_json: Record<string, unknown>;
  enabled: boolean;
  rate_limit_per_min: number | null;
  last_health_status: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ExternalRiskTask = {
  id: string;
  title: string;
  description: string | null;
  target_kind: string;
  target_scope_json: Record<string, unknown>;
  schedule_interval_sec: number;
  provider_ids: string[];
  ai_enabled: boolean;
  confidence_threshold: string;
  force_notify_policy_json: Record<string, unknown>;
  enabled: boolean;
  paused_until: string | null;
  last_run_status: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ExternalRiskRun = {
  id: string;
  task_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  target_count: number;
  source_count: number;
  raw_signal_count: number;
  finding_count: number;
  ai_analyzed_count: number;
  error_message: string | null;
  summary: string | null;
};

export type ExternalRiskFinding = {
  id: string;
  run_id: string | null;
  task_id: string | null;
  target_kind: string;
  target_id: string;
  component_name: string;
  ecosystem: string | null;
  current_version: string | null;
  source_kind: string;
  source_url: string;
  finding_type: string;
  advisory_id: string | null;
  cve_id: string | null;
  title: string;
  severity: string;
  confidence: string;
  affected: boolean;
  exploit_available: boolean;
  internet_exposed: boolean;
  ai_summary: string | null;
  ai_evidence_json: Record<string, unknown> | null;
  recommended_action: string | null;
  upgrade_target_version: string | null;
  verification_steps_json: unknown[] | null;
  rollback_plan: string | null;
  risk_tier: string | null;
  status: string;
  problem_id: string | null;
  recommended_task_id: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  ignored_reason: string | null;
  ignore_until: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

export type ExternalRiskProviderTestResult = {
  ok: boolean;
  status: string;
  message: string;
};

export type ExternalRiskTaskRunResult = {
  run: ExternalRiskRun;
  errors: string[];
  enabled: boolean;
};

export type ExternalRiskCreateProblemResult = {
  problem_id: string;
  finding: ExternalRiskFinding;
};

export type ExternalRiskCreateRecommendedTaskResult = {
  recommended_task_id: string;
  finding: ExternalRiskFinding;
};

export type WorkflowTicketProvider = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
};

export type ExternalRiskCreateTicketResult = {
  ticket: {
    ok: boolean;
    provider: string;
    ticket_id?: string;
    ticket_url?: string;
    message: string;
  };
  finding: ExternalRiskFinding;
};

export function formatScopeSummary(scope: Record<string, unknown>): string {
  const keys = Object.keys(scope);
  if (keys.length === 0) return "—";
  try {
    const text = JSON.stringify(scope);
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  } catch {
    return "—";
  }
}

export function isToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** P1: 24h, P2: 72h; exploit_available tightens P2 to 24h. */
export function isSlaBreached(
  finding: Pick<ExternalRiskFinding, "severity" | "first_seen_at" | "created_at" | "exploit_available">,
): boolean {
  const anchor = finding.first_seen_at || finding.created_at;
  const ageMs = Date.now() - new Date(anchor).getTime();
  const hours = ageMs / (1000 * 60 * 60);
  if (finding.severity === "P1") return hours > 24;
  if (finding.severity === "P2" && finding.exploit_available) return hours > 24;
  if (finding.severity === "P2") return hours > 72;
  return false;
}

export const externalRiskApi = {
  getSummary: () => api<ExternalRiskSummary>(`${BASE}/summary`),

  getDistributions: () => api<ExternalRiskDistributions>(`${BASE}/distributions`),

  getAssetSummary: (targetKind: string, targetId: string) =>
    api<ExternalRiskAssetSummary>(
      `${BASE}/asset-summary?target_kind=${encodeURIComponent(targetKind)}&target_id=${encodeURIComponent(targetId)}`,
    ),

  getAssetSummaries: (items: Array<{ target_kind: string; target_id: string }>) =>
    api<{ items: ExternalRiskAssetSummary[] }>(`${BASE}/asset-summaries`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),

  listFindingEvents: (findingId: string) =>
    api<{ items: ExternalRiskFindingEvent[]; total: number }>(`${BASE}/findings/${findingId}/events`),

  listProviders: () => api<{ items: ExternalRiskProvider[]; total: number }>(`${BASE}/providers`),
  createProvider: (body: Record<string, unknown>) =>
    api<ExternalRiskProvider>(`${BASE}/providers`, { method: "POST", body: JSON.stringify(body) }),
  updateProvider: (id: string, body: Record<string, unknown>) =>
    api<ExternalRiskProvider>(`${BASE}/providers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProvider: (id: string) => api<void>(`${BASE}/providers/${id}`, { method: "DELETE" }),
  testProvider: (id: string) =>
    api<ExternalRiskProviderTestResult>(`${BASE}/providers/${id}/test`, { method: "POST" }),

  listTasks: (enabled?: boolean) => {
    const q = enabled === undefined ? "" : `?enabled=${enabled}`;
    return api<{ items: ExternalRiskTask[]; total: number }>(`${BASE}/tasks${q}`);
  },
  getTask: (id: string) => api<ExternalRiskTask>(`${BASE}/tasks/${id}`),
  createTask: (body: Record<string, unknown>) =>
    api<ExternalRiskTask>(`${BASE}/tasks`, { method: "POST", body: JSON.stringify(body) }),
  updateTask: (id: string, body: Record<string, unknown>) =>
    api<ExternalRiskTask>(`${BASE}/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTask: (id: string) => api<void>(`${BASE}/tasks/${id}`, { method: "DELETE" }),
  runTask: (id: string) =>
    api<ExternalRiskTaskRunResult>(`${BASE}/tasks/${id}/run`, { method: "POST" }),
  stopTask: (id: string) => api<ExternalRiskTask>(`${BASE}/tasks/${id}/stop`, { method: "POST" }),
  enableTask: (id: string) => api<ExternalRiskTask>(`${BASE}/tasks/${id}/enable`, { method: "POST" }),
  pauseTask: (id: string, pausedUntil: string) =>
    api<ExternalRiskTask>(`${BASE}/tasks/${id}/pause`, {
      method: "POST",
      body: JSON.stringify({ paused_until: pausedUntil }),
    }),
  skipNextRun: (id: string) =>
    api<ExternalRiskTask>(`${BASE}/tasks/${id}/skip-next-run`, { method: "POST" }),

  listRuns: (taskId: string, page = 1, pageSize = 8) =>
    api<{ items: ExternalRiskRun[]; total: number }>(
      `${BASE}/runs?task_id=${taskId}&page=${page}&page_size=${pageSize}`,
    ),

  listFindings: (params: ProTableRequestParams, sort?: Record<string, string | null>, filter?: Record<string, (string | number)[] | null>) =>
    proTableRequest<ExternalRiskFinding>(`${BASE}/findings`, params, sort, filter),

  listCritical: (params: ProTableRequestParams, sort?: Record<string, string | null>, filter?: Record<string, (string | number)[] | null>) =>
    proTableRequest<ExternalRiskFinding>(`${BASE}/critical`, params, sort, filter),

  getFinding: (id: string) => api<ExternalRiskFinding>(`${BASE}/findings/${id}`),

  acknowledgeFinding: (id: string, acknowledgedBy: string) =>
    api<ExternalRiskFinding>(`${BASE}/findings/${id}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({ acknowledged_by: acknowledgedBy }),
    }),

  ignoreFinding: (id: string, ignoredReason: string, ignoreUntil: string) =>
    api<ExternalRiskFinding>(`${BASE}/findings/${id}/ignore`, {
      method: "POST",
      body: JSON.stringify({ ignored_reason: ignoredReason, ignore_until: ignoreUntil }),
    }),

  falsePositiveFinding: (id: string, note?: string) =>
    api<ExternalRiskFinding>(`${BASE}/findings/${id}/false-positive`, {
      method: "POST",
      body: JSON.stringify({ note: note ?? null }),
    }),

  resolveFinding: (id: string, resolutionNote?: string) =>
    api<ExternalRiskFinding>(`${BASE}/findings/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution_note: resolutionNote ?? null }),
    }),

  inProgressFinding: (id: string) =>
    api<ExternalRiskFinding>(`${BASE}/findings/${id}/in-progress`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  createProblem: (id: string) =>
    api<ExternalRiskCreateProblemResult>(`${BASE}/findings/${id}/create-problem`, { method: "POST" }),

  createRecommendedTask: (id: string) =>
    api<ExternalRiskCreateRecommendedTaskResult>(`${BASE}/findings/${id}/create-recommended-task`, {
      method: "POST",
    }),

  listTicketProviders: () =>
    api<{ items: WorkflowTicketProvider[]; total: number }>("/api/workflows/providers"),

  createTicket: (id: string, providerId: string) =>
    api<ExternalRiskCreateTicketResult>(`${BASE}/findings/${id}/create-ticket`, {
      method: "POST",
      body: JSON.stringify({ provider_id: providerId }),
    }),
};