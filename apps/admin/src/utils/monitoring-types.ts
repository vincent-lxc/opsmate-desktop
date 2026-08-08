export const CHECK_TYPES = [
  "host_metrics",
  "ssh_command",
  "tcp_probe",
  "http_get",
  "redis_cli",
  "mysql_query",
  "docker_inspect",
  "log_tail",
  "pprof_fetch",
  "http_intel",
] as const;

export type CheckType = (typeof CHECK_TYPES)[number];

export type FoundationComponent = {
  id: string;
  product: string;
  version_range: string;
  display_name: string;
  category: string;
  source_kind: string;
  created_at: string;
  updated_at: string;
};

export type IntelSource = {
  id: string;
  foundation_component_id?: string | null;
  application_profile_id?: string | null;
  kind: string;
  label: string;
  url: string;
};

export type InternalStep = {
  id: string;
  foundation_component_id?: string;
  title: string;
  check_type: CheckType;
  config: Record<string, unknown>;
  sort_order: number;
  default_interval_sec: number;
  enabled: boolean;
};

export type ReferencedComponent = {
  name: string;
  version: string | null;
  address: string | null;
  latest_version: string | null;
  has_known_vulnerabilities: boolean;
  known_issues: string | null;
  update_recommendation: string | null;
};

export type UploadedManifest = {
  filename: string;
  content: string;
  uploaded_at: string;
};

export type DependencyManifestSet = {
  id: string;
  name: string;
  description: string | null;
  manifests: UploadedManifest[];
  language: string | null;
  language_version: string | null;
  referenced_components: ReferencedComponent[];
  profile_count: number;
  linked_service_names?: string[];
  created_at: string;
  updated_at: string;
};

export type ApplicationProfile = {
  id: string;
  service_name: string;
  docker_name: string | null;
  container_runtime_id: string | null;
  description: string | null;
  language: string | null;
  language_version: string | null;
  frameworks: string[];
  referenced_components: ReferencedComponent[];
  manifest_set_id: string | null;
  uploaded_manifests: UploadedManifest[];
  source_kind?: string;
  step_count?: number;
  instance_count?: number;
};

export type ApplicationStep = InternalStep & {
  profile_id: string;
};

// External Watch is a first-class domain. A top-level task targets a KIND of
// component (foundation | application) and fans out at run time to every
// in-scope component, fetching from each component's own configured external
// source. The source lives on the component, not the task.
export type ExternalWatchTargetKind = "foundation" | "application";

export type ExternalWatchTask = {
  id: string;
  title: string;
  description: string | null;
  target_kind: ExternalWatchTargetKind;
  schedule_interval_sec: number;
  ai_enabled: boolean;
  enabled: boolean;
  last_run_status?: string | null;
  last_run_at?: string | null;
  last_findings_count?: number | null;
};

export type UpgradeDraft = {
  target?: string;
  severity?: string;
  summary?: string;
  steps?: string[];
  auto_generated?: boolean;
};

export type ExternalWatchFinding = {
  component_id: string;
  component_kind: ExternalWatchTargetKind;
  component_name: string;
  identity: Record<string, string | string[]>;
  source_url: string;
  finding_type:
    | "cve"
    | "language_cve"
    | "framework_injection"
    | "version"
    | "ai_error"
    | "fetch_error"
    | "skipped"
    | "none";
  severity: "P1" | "P2" | "P3";
  ai_summary: string;
  recommended_action: string;
  raw_excerpt: string;
  source_kind?: string;
  disposition?: "external_only" | "server_required";
  cross_validated?: boolean;
  upgrade_draft?: UpgradeDraft | null;
  advisory_ids?: string[];
};

export type RecommendedTaskRow = {
  id: string;
  source_external_watch_run_id: string;
  finding_index: number;
  component_kind: ExternalWatchTargetKind;
  component_id: string;
  component_name: string;
  finding_type: string;
  severity: string;
  finding_summary: string;
  proposed_action: Record<string, unknown>;
  l_tier: "L1" | "L2" | "L3";
  status: "pending" | "claimed" | "completed" | "dismissed";
  created_at: string;
  updated_at: string;
  task_id?: string;
  run_finished_at?: string | null;
};

export type ExternalWatchRun = {
  id: string;
  task_id: string;
  task_title?: string;
  task_target_kind?: ExternalWatchTargetKind;
  status: string;
  started_at: string;
  finished_at: string | null;
  findings: ExternalWatchFinding[];
  component_count: number;
  findings_count: number;
  raw_excerpt: string | null;
};

export type ServerBinding = {
  id: string;
  server_id: string;
  title: string;
  check_type: string;
  interval_sec: number;
  enabled: boolean;
  pinned: boolean;
  last_status: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
};

export type RunnerState = {
  server_id: string;
  runner_status: string;
  paused: boolean;
  last_tick_at: string | null;
} | null;

export type MonitorRun = {
  id: string;
  binding_id: string;
  binding_title?: string;
  server_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
};

export type InternalTaskRow = {
  server_id: string;
  server_name: string;
  server_group: string;
  runner_status: string | null;
  paused: boolean | null;
  last_tick_at: string | null;
  enabled_steps: number;
  total_steps: number;
  last_failure_status: string | null;
  last_failure_step_id: string | null;
  next_run_at: string | null;
};

export type L2PendingItem = {
  id: string;
  foundation_component_id: string;
  status: string;
  proposed_action: Record<string, unknown>;
  created_at: string;
};

export type TroubleshootingStep = {
  id: string;
  title: string;
  monitor_step_id: string | null;
  foundation_internal_step_id: string | null;
  application_step_id: string | null;
  problem_type_pattern: string | null;
  steps: Record<string, unknown>[];
  source: string;
  auto_executable: boolean;
  updated_at: string;
};

export type InternalPatrolTask = {
  id: string;
  title: string;
  description: string | null;
  server_group_name: string;
  schedule_interval_sec: number;
  retention_days: number;
  status: "stopped" | "running";
  mandatory_hardware: boolean;
  ai_enabled: boolean;
  response_locale?: "zh-CN" | "en-US";
  next_run_at: string | null;
  last_round_at: string | null;
  server_count?: number;
  recent_anomaly_count?: number;
  last_round_status?: string | null;
  created_at: string;
  updated_at: string;
};

export type PatrolRecord = {
  id: string;
  round_id: string;
  task_id: string;
  server_id: string;
  server_name: string;
  verdict: "normal" | "watch" | "anomaly";
  severity: string | null;
  summary: string | null;
  hardware_gate_status: string | null;
  problem_event_id: string | null;
  promoted_at: string | null;
  verdict_source?: "ai" | "rules" | "rules_fallback" | null;
  self_resolvable?: boolean | null;
  recommended_action?: string | null;
  problem_location?: string | null;
  problem_statement?: string | null;
  follow_up_recommendations?: string[];
  response_locale?: "zh-CN" | "en-US";
  suggested_troubleshooting_step_ids?: string[];
  created_at: string;
  task_title?: string;
  server_group_name?: string;
  round_status?: string;
  round_started_at?: string;
  round_finished_at?: string | null;
  round_trigger_kind?: string;
  step_total?: number;
  step_anomaly_count?: number;
};

export type PatrolStepOwnerKind = "foundation" | "application";

export type PatrolStepRun = {
  id: string;
  binding_id: string;
  binding_title?: string;
  monitor_owner_name?: string | null;
  monitor_owner_kind?: PatrolStepOwnerKind | null;
  server_id: string;
  status: string;
  metrics?: Record<string, unknown>;
  skip_reason?: string | null;
  raw_excerpt?: string | null;
  error?: string | null;
  started_at?: string;
  finished_at?: string | null;
};

export type PatrolRoundRecordGroup = {
  round_id: string;
  task_id: string;
  task_title: string;
  server_group_name: string;
  round_started_at: string;
  round_status?: string;
  round_trigger_kind?: string;
  records: PatrolRecord[];
};

export type PatrolRound = {
  id: string;
  task_id: string;
  status: string;
  trigger_kind: string;
  started_at: string;
  finished_at: string | null;
  server_count: number;
  completed_count: number;
  anomaly_count: number;
  step_completed_count?: number;
  step_total_count?: number;
  task_title?: string;
  server_group_name?: string;
  task_status?: string;
};
