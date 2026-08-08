import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Spin } from "antd";
import { AdminShell } from "./components/AdminShell";
import { AuthGate } from "./components/AuthGate";
import { RequireFeature } from "./components/RequireFeature";
import { RequirePlatformAdmin } from "./components/RequirePlatformAdmin";

const LoginPage = lazy(() => import("./pages/Login"));
const LogtoCallbackPage = lazy(() => import("./pages/LogtoCallbackPage"));
const DesktopLogtoBridgePage = lazy(
  () => import("./pages/login/DesktopLogtoBridgePage"),
);
const InternalLoginPage = lazy(() => import("./pages/InternalLoginPage"));
const InviteRedeemPage = lazy(() => import("./pages/InviteRedeem"));
const AccountPage = lazy(() => import("./pages/Account"));
const UsersPage = lazy(() => import("./pages/Users"));

const TimelineBrowser = lazy(() => import("./pages/TimelineBrowser"));

const AIProviderConfig = lazy(() => import("./pages/AIProviderConfig"));
const PlatformAiProvidersPage = lazy(
  () => import("./pages/settings/ai/ProvidersPage"),
);
const PlatformAiSkillsPage = lazy(
  () => import("./pages/settings/ai/SkillsListPage"),
);
const PlatformAiSkillEditPage = lazy(
  () => import("./pages/settings/ai/SkillEditPage"),
);
const PlatformAiAgentsPage = lazy(
  () => import("./pages/settings/ai/AgentsPage"),
);
const FreeAccessProfilePage = lazy(
  () => import("./pages/settings/FreeAccessProfilePage"),
);
const WorkflowsPage = lazy(() =>
  import("./pages/settings/WorkflowsPage").then((m) => ({ default: m.WorkflowsPage })),
);
const ServerManagement = lazy(() =>
  import("./pages/ServerManagement").then((m) => ({ default: m.ServerManagement })),
);
const ServerDetail = lazy(() =>
  import("./pages/ServerDetail").then((m) => ({ default: m.ServerDetail })),
);
const ProblemList = lazy(() =>
  import("./pages/ProblemList").then((m) => ({ default: m.ProblemList })),
);

const MonitorFoundationPage = lazy(() =>
  import("./pages/MonitorFoundationPage").then((m) => ({ default: m.MonitorFoundationPage })),
);
const ClassificationRulesPage = lazy(() =>
  import("./pages/ClassificationRulesPage").then((m) => ({ default: m.ClassificationRulesPage })),
);
const MonitorApplicationsPage = lazy(() =>
  import("./pages/MonitorApplicationsPage").then((m) => ({ default: m.MonitorApplicationsPage })),
);
const MonitorDependencyManifestsPage = lazy(() =>
  import("./pages/MonitorDependencyManifestsPage").then((m) => ({
    default: m.MonitorDependencyManifestsPage,
  })),
);
const MonitorPatrolTasksPage = lazy(() =>
  import("./pages/MonitorPatrolTasksPage").then((m) => ({ default: m.MonitorPatrolTasksPage })),
);
const MonitorPatrolRecordsPage = lazy(() =>
  import("./pages/MonitorPatrolRecordsPage").then((m) => ({ default: m.MonitorPatrolRecordsPage })),
);
const OperationsOverviewPage = lazy(() => import("./pages/OperationsOverviewPage"));
const RiskPoliciesPage = lazy(() =>
  import("./pages/security/RiskPoliciesPage").then((m) => ({ default: m.RiskPoliciesPage })),
);
const L2ApprovalsPage = lazy(() =>
  import("./pages/security/L2ApprovalsPage").then((m) => ({ default: m.L2ApprovalsPage })),
);
const ApprovalChannelsPage = lazy(() =>
  import("./pages/security/ApprovalChannelsPage").then((m) => ({ default: m.ApprovalChannelsPage })),
);
const CredentialsPage = lazy(() =>
  import("./pages/security/CredentialsPage").then((m) => ({ default: m.CredentialsPage })),
);
const AuditLogPage = lazy(() =>
  import("./pages/security/AuditLogPage").then((m) => ({ default: m.AuditLogPage })),
);
const KillSwitchPage = lazy(() =>
  import("./pages/security/KillSwitchPage").then((m) => ({ default: m.KillSwitchPage })),
);
const ConfigHealthPage = lazy(() =>
  import("./pages/security/ConfigHealth").then((m) => ({ default: m.ConfigHealthPage })),
);
const DeploymentConsistencyPage = lazy(() =>
  import("./pages/security/DeploymentConsistency").then((m) => ({ default: m.DeploymentConsistencyPage })),
);
const RetentionPoliciesPage = lazy(() =>
  import("./pages/security/RetentionPoliciesPage").then((m) => ({
    default: m.RetentionPoliciesPage,
  })),
);
const OpsDutyCalendarPage = lazy(() =>
  import("./pages/ops-duty/OpsDutyCalendarPage").then((m) => ({ default: m.OpsDutyCalendarPage })),
);
const WorkbenchPage = lazy(() =>
  import("./pages/ops-duty/WorkbenchPage").then((m) => ({ default: m.WorkbenchPage })),
);
const OpsDutyChecklistsPage = lazy(() =>
  import("./pages/ops-duty/OpsDutyChecklistsPage").then((m) => ({ default: m.OpsDutyChecklistsPage })),
);
const OpsDrillsPage = lazy(() =>
  import("./pages/ops-duty/OpsDrillsPage").then((m) => ({ default: m.OpsDrillsPage })),
);
const ChangeTasksPage = lazy(() =>
  import("./pages/ops-duty/ChangeTasksPage").then((m) => ({ default: m.ChangeTasksPage })),
);
const MonthlyReviewsPage = lazy(() =>
  import("./pages/ops-duty/MonthlyReviewsPage").then((m) => ({ default: m.MonthlyReviewsPage })),
);
const IncidentReportPage = lazy(() =>
  import("./pages/IncidentReportPage").then((m) => ({ default: m.IncidentReportPage })),
);
const IncidentReportsPage = lazy(() =>
  import("./pages/ops-duty/IncidentReportsPage").then((m) => ({
    default: m.IncidentReportsPage,
  })),
);
const AnomalyRulesPage = lazy(() =>
  import("./pages/monitoring/AnomalyRulesPage").then((m) => ({ default: m.AnomalyRulesPage })),
);
const MigratedAnomalyRulesRedirect = lazy(() =>
  import("./pages/monitoring/MigratedAnomalyRulesRedirect").then((m) => ({
    default: m.MigratedAnomalyRulesRedirect,
  })),
);

const RemediationQueuePage = lazy(() =>
  import("./pages/oncall/RemediationQueuePage").then((m) => ({ default: m.RemediationQueuePage })),
);
const AlertTuningPage = lazy(() =>
  import("./pages/monitoring/AlertTuningPage").then((m) => ({ default: m.AlertTuningPage })),
);
const BusinessMetricsDashboardPage = lazy(() =>
  import("./pages/monitoring/BusinessMetricsDashboard").then((m) => ({
    default: m.BusinessMetricsDashboardPage,
  })),
);
const BusinessDataSourcesPage = lazy(() =>
  import("./pages/monitoring/BusinessDataSourcesPage").then((m) => ({
    default: m.BusinessDataSourcesPage,
  })),
);
const ExternalRiskOverviewPage = lazy(() =>
  import("./pages/external-risk/ExternalRiskOverviewPage").then((m) => ({
    default: m.ExternalRiskOverviewPage,
  })),
);
const ExternalRiskTasksPage = lazy(() =>
  import("./pages/external-risk/ExternalRiskTasksPage").then((m) => ({
    default: m.ExternalRiskTasksPage,
  })),
);
const ExternalRiskFindingsPage = lazy(() =>
  import("./pages/external-risk/ExternalRiskFindingsPage").then((m) => ({
    default: m.ExternalRiskFindingsPage,
  })),
);
const ExternalRiskCriticalPage = lazy(() =>
  import("./pages/external-risk/ExternalRiskCriticalPage").then((m) => ({
    default: m.ExternalRiskCriticalPage,
  })),
);
const ExternalRiskProvidersPage = lazy(() =>
  import("./pages/external-risk/ExternalRiskProvidersPage").then((m) => ({
    default: m.ExternalRiskProvidersPage,
  })),
);
function PageFallback() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
      <Spin size="large" />
    </div>
  );
}

export function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/login/internal" element={<InternalLoginPage />} />
        <Route path="/login/logto/callback" element={<LogtoCallbackPage />} />
        <Route
          path="/login/desktop/callback"
          element={<DesktopLogtoBridgePage />}
        />
        <Route path="/invite/:token" element={<InviteRedeemPage />} />
        <Route
          path="/*"
          element={
            <AuthGate>
              <AdminShell>
                <Routes>
                  <Route path="/" element={<Navigate to="/dashboard/overview" replace />} />
          <Route path="/dashboard/overview" element={<OperationsOverviewPage />} />
          <Route path="/timeline" element={<TimelineBrowser />} />
          <Route
            path="/knowledge-base"
            element={<Navigate to="/timeline?preset=human" replace />}
          />
          <Route path="/problems" element={<ProblemList />} />
          <Route
            path="/oncall/remediation-queue"
            element={
              <RequireFeature feature="oncall_closure">
                <RemediationQueuePage />
              </RequireFeature>
            }
          />
          <Route
            path="/monitoring/alert-tuning"
            element={
              <RequireFeature feature="oncall_closure">
                <AlertTuningPage />
              </RequireFeature>
            }
          />
          <Route path="/servers" element={<ServerManagement />} />
          <Route path="/servers/:id" element={<ServerDetail />} />
          <Route path="/monitoring/foundation" element={<MonitorFoundationPage />} />
          <Route path="/monitoring/classification-rules" element={<ClassificationRulesPage />} />
          <Route path="/monitoring/applications" element={<MonitorApplicationsPage />} />
          <Route
            path="/monitoring/dependency-manifests"
            element={<MonitorDependencyManifestsPage />}
          />
          <Route path="/monitoring/tasks" element={<MonitorPatrolTasksPage />} />
          <Route path="/monitoring/patrol-records" element={<MonitorPatrolRecordsPage />} />
          <Route
            path="/monitoring/business-data-sources"
            element={
              <RequireFeature feature="business_observability">
                <BusinessDataSourcesPage />
              </RequireFeature>
            }
          />
          <Route
            path="/monitoring/business-metrics-dashboard"
            element={
              <RequireFeature feature="business_observability">
                <BusinessMetricsDashboardPage />
              </RequireFeature>
            }
          />
          <Route
            path="/monitoring/business-metrics"
            element={<Navigate to="/monitoring/business-data-sources" replace />}
          />
          <Route
            path="/monitoring/risk-metrics"
            element={
              <MigratedAnomalyRulesRedirect
                routeKey="risk_metrics"
                target="/monitoring/anomaly-rules"
              />
            }
          />
          <Route
            path="/monitoring/anomaly-rules"
            element={
              <RequireFeature feature="business_observability">
                <AnomalyRulesPage />
              </RequireFeature>
            }
          />
          <Route
            path="/monitoring/anomaly-rule-drafts"
            element={
              <MigratedAnomalyRulesRedirect
                routeKey="anomaly_rule_drafts"
                target="/monitoring/anomaly-rules?tab=draft"
              />
            }
          />
          <Route
            path="/external-risk/overview"
            element={
              <RequireFeature feature="external_risk">
                <ExternalRiskOverviewPage />
              </RequireFeature>
            }
          />
          <Route
            path="/external-risk/tasks"
            element={
              <RequireFeature feature="external_risk">
                <ExternalRiskTasksPage />
              </RequireFeature>
            }
          />
          <Route
            path="/external-risk/findings"
            element={
              <RequireFeature feature="external_risk">
                <ExternalRiskFindingsPage />
              </RequireFeature>
            }
          />
          <Route
            path="/external-risk/critical"
            element={
              <RequireFeature feature="external_risk">
                <ExternalRiskCriticalPage />
              </RequireFeature>
            }
          />
          <Route
            path="/external-risk/providers"
            element={
              <RequireFeature feature="external_risk">
                <ExternalRiskProvidersPage />
              </RequireFeature>
            }
          />
          <Route path="/security/risk-policies" element={<RiskPoliciesPage />} />
          <Route
            path="/security/l2-approvals"
            element={
              <RequireFeature feature="oncall_closure">
                <L2ApprovalsPage />
              </RequireFeature>
            }
          />
          <Route
            path="/settings/im"
            element={
              <RequireFeature feature="telegram" title="IM 通知">
                <ApprovalChannelsPage />
              </RequireFeature>
            }
          />
          <Route
            path="/security/notification-channels"
            element={<Navigate to="/settings/im" replace />}
          />
          <Route
            path="/security/approval-channels"
            element={<Navigate to="/settings/im" replace />}
          />
          <Route
            path="/security/credentials"
            element={
              <RequireFeature feature="encrypted_credentials">
                <CredentialsPage />
              </RequireFeature>
            }
          />
          <Route
            path="/security/audit-log"
            element={
              <RequireFeature feature="team_governance">
                <AuditLogPage />
              </RequireFeature>
            }
          />
          <Route
            path="/security/retention"
            element={
              <RequireFeature feature="long_audit_retention">
                <RetentionPoliciesPage />
              </RequireFeature>
            }
          />
          <Route
            path="/security/kill-switch"
            element={
              <RequireFeature feature="team_governance">
                <KillSwitchPage />
              </RequireFeature>
            }
          />
          <Route path="/security/config-health" element={<ConfigHealthPage />} />
          <Route
            path="/security/deployment-consistency"
            element={
              <RequireFeature feature="team_governance">
                <DeploymentConsistencyPage />
              </RequireFeature>
            }
          />
          <Route
            path="/ops-duty/workbench"
            element={
              <RequireFeature feature="oncall_closure">
                <WorkbenchPage />
              </RequireFeature>
            }
          />
          <Route
            path="/ops-duty/calendar"
            element={
              <RequireFeature feature="oncall_closure">
                <OpsDutyCalendarPage />
              </RequireFeature>
            }
          />
          <Route
            path="/ops-duty/checklists"
            element={
              <RequireFeature feature="oncall_closure">
                <OpsDutyChecklistsPage />
              </RequireFeature>
            }
          />
          <Route
            path="/ops-duty/drills"
            element={
              <RequireFeature feature="oncall_closure">
                <OpsDrillsPage />
              </RequireFeature>
            }
          />
          <Route
            path="/ops-duty/changes"
            element={
              <RequireFeature feature="oncall_closure">
                <ChangeTasksPage />
              </RequireFeature>
            }
          />
          <Route
            path="/ops-duty/reviews"
            element={
              <RequireFeature feature="oncall_closure">
                <MonthlyReviewsPage />
              </RequireFeature>
            }
          />
          <Route
            path="/ops-duty/incident-reports"
            element={
              <RequireFeature feature="oncall_closure">
                <IncidentReportsPage />
              </RequireFeature>
            }
          />
          <Route
            path="/incident-reports/:id"
            element={
              <RequireFeature feature="oncall_closure">
                <IncidentReportPage />
              </RequireFeature>
            }
          />
          <Route path="/monitoring/internal-robot" element={<Navigate to="/monitoring/tasks" replace />} />
          <Route
            path="/monitoring/external-watch"
            element={<Navigate to="/external-risk/overview" replace />}
          />
          <Route
            path="/monitoring/troubleshooting"
            element={<Navigate to="/monitoring/foundation" replace />}
          />
          <Route
            path="/settings/workflows"
            element={
              <RequireFeature feature="oncall_closure">
                <WorkflowsPage />
              </RequireFeature>
            }
          />
          <Route path="/settings/ai" element={<Navigate to="/settings/ai/providers" replace />} />
          <Route path="/settings/access-profile" element={<RequirePlatformAdmin><FreeAccessProfilePage /></RequirePlatformAdmin>} />
          <Route path="/settings/ai/providers" element={<RequirePlatformAdmin><PlatformAiProvidersPage /></RequirePlatformAdmin>} />
          <Route path="/settings/ai/skills" element={<RequirePlatformAdmin><PlatformAiSkillsPage /></RequirePlatformAdmin>} />
          <Route path="/settings/ai/skills/:id" element={<RequirePlatformAdmin><PlatformAiSkillEditPage /></RequirePlatformAdmin>} />
          <Route path="/settings/ai/agents" element={<RequirePlatformAdmin><PlatformAiAgentsPage /></RequirePlatformAdmin>} />
          <Route path="/settings/ai/legacy" element={<RequirePlatformAdmin><AIProviderConfig /></RequirePlatformAdmin>} />
          <Route path="/settings/users" element={<UsersPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/settings/middleware" element={<Navigate to="/settings/ai/providers" replace />} />
          <Route path="*" element={<Navigate to="/dashboard/overview" replace />} />
                </Routes>
              </AdminShell>
            </AuthGate>
          }
        />
      </Routes>
    </Suspense>
  );
}
