import type { CheckType } from "./monitoring-types";

/** Config JSON keys documented per check type (order preserved for UI). */
export const CHECK_TYPE_CONFIG_FIELDS: Record<CheckType, string[]> = {
  host_metrics: [],
  ssh_command: [
    "scope",
    "command",
    "metric_kind",
    "container",
    "timeout_ms",
    "cpu_threshold_pct",
    "host_cpu_threshold_pct",
    "memory_threshold_pct",
  ],
  tcp_probe: ["scope", "host", "port", "timeout_ms"],
  http_get: ["scope", "url", "host", "port", "path", "expect_status", "timeout_ms"],
  redis_cli: ["scope", "host", "port", "password", "command", "sections", "timeout_ms"],
  mysql_query: ["scope", "host", "port", "username", "password", "query", "queries", "timeout_ms"],
  docker_inspect: ["scope", "container", "expected_status"],
  log_tail: ["scope", "source", "container", "lines", "pattern", "alert_on_match"],
  pprof_fetch: ["scope", "url", "timeout_ms"],
  http_intel: ["scope", "url", "timeout_ms"],
};