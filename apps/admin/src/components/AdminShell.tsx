import { type ReactNode, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ProLayout } from "@ant-design/pro-components";
import type { MenuDataItem } from "@ant-design/pro-components";
import { Dropdown, Result } from "antd";
import { OpsMateLogo } from "./OpsMateLogo";
import { HeaderActions } from "./HeaderActions";
import { useAppSettings } from "../providers/AppProvider";
import { useEntitlements } from "../providers/EntitlementsProvider";
import type { FeatureKey } from "../services/entitlements";
import { getUsername, isAdmin, isPlatformAdmin, logout } from "../services/auth/roles";
import {
  ClockCircleOutlined,
  SettingOutlined,
  UserOutlined,
  LogoutOutlined,
  CloudServerOutlined,
  AlertOutlined,
  ApartmentOutlined,
  ApiOutlined,
  FundOutlined,
  FileSearchOutlined,
  AuditOutlined,
  AppstoreOutlined,
  DashboardOutlined,
  SafetyOutlined,
  SafetyCertificateOutlined,
  CalendarOutlined,
  LineChartOutlined,
  FundProjectionScreenOutlined,
  MonitorOutlined,
  KeyOutlined,
  NotificationOutlined,
  PauseCircleOutlined,
  DatabaseOutlined,
  UnorderedListOutlined,
  ExperimentOutlined,
  SwapOutlined,
  FileTextOutlined,
  PartitionOutlined,
  RadarChartOutlined,
  GlobalOutlined,
  FilterOutlined,
} from "@ant-design/icons";

// ---------------------------------------------------------------------------
// Single-source menu + route definition
// ---------------------------------------------------------------------------

type AppRoute = {
  key?: string;
  path?: string;
  localeKey: string;
  icon?: ReactNode;
  children?: AppRoute[];
  /**
   * Edition feature required to see this entry (U2). When set, the route is
   * hidden unless the current tenant's entitlements enable the feature. When
   * unset, the entry is always visible. Backend gates remain the source of
   * truth; this only controls menu visibility.
   */
  feature?: FeatureKey;
  /** Only default-tenant admin (platform AI config). */
  platformAdminOnly?: boolean;
};

export const appRoutes: AppRoute[] = [
  {
    key: "group-dashboard",
    localeKey: "menu.group.dashboard",
    icon: <DashboardOutlined />,
    children: [
      {
        path: "/dashboard/overview",
        localeKey: "menu.operationsOverview",
        icon: <DashboardOutlined />,
      },
    ],
  },
  { path: "/servers", localeKey: "menu.servers", icon: <CloudServerOutlined />, feature: "monitoring_projects" },
  {
    key: "group-monitor-items",
    localeKey: "menu.group.monitorItems",
    icon: <AppstoreOutlined />,
    feature: "monitoring_projects",
    children: [
      { path: "/monitoring/foundation", localeKey: "menu.foundationComponentMgmt", icon: <FundOutlined /> },
      {
        path: "/monitoring/classification-rules",
        localeKey: "menu.classificationRules",
        icon: <FundOutlined />,
      },
      { path: "/monitoring/applications", localeKey: "menu.monitorApplications", icon: <FundOutlined /> },
      {
        path: "/monitoring/dependency-manifests",
        localeKey: "menu.dependencyManifests",
        icon: <FundOutlined />,
      },
    ],
  },
  {
    key: "group-monitoring-center",
    localeKey: "menu.group.monitoringCenter",
    icon: <MonitorOutlined />,
    feature: "monitoring_center",
    children: [
      { path: "/monitoring/tasks", localeKey: "menu.monitoringTasks", icon: <FundOutlined /> },
      { path: "/monitoring/patrol-records", localeKey: "menu.patrolRecords", icon: <FileSearchOutlined /> },
      { path: "/problems", localeKey: "menu.problems", icon: <AlertOutlined /> },
      { path: "/timeline", localeKey: "menu.eventCenter", icon: <ClockCircleOutlined /> },
    ],
  },
  {
    key: "group-oncall-closure",
    localeKey: "menu.group.oncallClosure",
    icon: <AuditOutlined />,
    feature: "oncall_closure",
    children: [
      {
        path: "/oncall/remediation-queue",
        localeKey: "menu.remediationQueue",
        icon: <UnorderedListOutlined />,
      },
      {
        path: "/monitoring/alert-tuning",
        localeKey: "menu.alertTuning",
        icon: <FilterOutlined />,
      },
      {
        path: "/ops-duty/workbench",
        localeKey: "menu.opsDutyWorkbench",
        icon: <FundOutlined />,
      },
      {
        path: "/ops-duty/incident-reports",
        localeKey: "menu.incidentReports",
        icon: <FileTextOutlined />,
      },
    ],
  },
  {
    key: "group-external-risk",
    localeKey: "menu.group.externalRisk",
    icon: <RadarChartOutlined />,
    feature: "external_risk",
    children: [
      {
        path: "/external-risk/overview",
        localeKey: "menu.externalRiskOverview",
        icon: <RadarChartOutlined />,
      },
      {
        path: "/external-risk/tasks",
        localeKey: "menu.externalRiskTasks",
        icon: <UnorderedListOutlined />,
      },
      {
        path: "/external-risk/findings",
        localeKey: "menu.externalRiskFindings",
        icon: <AlertOutlined />,
      },
      {
        path: "/external-risk/critical",
        localeKey: "menu.externalRiskCritical",
        icon: <SafetyOutlined />,
      },
      {
        path: "/external-risk/providers",
        localeKey: "menu.externalRiskProviders",
        icon: <GlobalOutlined />,
      },
    ],
  },
  {
    key: "group-business-monitoring",
    localeKey: "menu.group.businessMonitoring",
    icon: <LineChartOutlined />,
    feature: "business_observability",
    children: [
      {
        path: "/monitoring/business-data-sources",
        localeKey: "menu.businessDataSources",
        icon: <DatabaseOutlined />,
      },
      {
        path: "/monitoring/business-metrics-dashboard",
        localeKey: "menu.businessMetricsDashboard",
        icon: <DashboardOutlined />,
      },
      {
        path: "/monitoring/anomaly-rules",
        localeKey: "menu.anomalyRules",
        icon: <AlertOutlined />,
      },
    ],
  },
  {
    key: "group-security",
    localeKey: "menu.group.security",
    icon: <SafetyOutlined />,
    children: [
      { path: "/security/risk-policies", localeKey: "menu.riskPolicies", icon: <SafetyOutlined /> },
      { path: "/security/l2-approvals", localeKey: "menu.l2Approvals", icon: <AuditOutlined />, feature: "oncall_closure" },
      { path: "/security/credentials", localeKey: "menu.credentialsVault", icon: <KeyOutlined />, feature: "encrypted_credentials" },
      { path: "/security/audit-log", localeKey: "menu.auditLog", icon: <FileSearchOutlined />, feature: "team_governance" },
      { path: "/security/retention", localeKey: "menu.retentionPolicies", icon: <DatabaseOutlined />, feature: "long_audit_retention" },
      { path: "/security/kill-switch", localeKey: "menu.killSwitch", icon: <PauseCircleOutlined />, feature: "team_governance" },
      { path: "/security/config-health", localeKey: "menu.configHealth", icon: <SafetyOutlined /> },
      { path: "/security/deployment-consistency", localeKey: "menu.deploymentConsistency", icon: <SafetyCertificateOutlined />, feature: "team_governance" },
    ],
  },
  {
    key: "group-ops-duty",
    localeKey: "menu.group.opsDuty",
    icon: <CalendarOutlined />,
    feature: "oncall_closure",
    children: [
      { path: "/ops-duty/calendar", localeKey: "menu.opsDutyCalendar", icon: <CalendarOutlined /> },
      { path: "/ops-duty/checklists", localeKey: "menu.opsDutyChecklists", icon: <UnorderedListOutlined /> },
      { path: "/ops-duty/drills", localeKey: "menu.opsDrills", icon: <ExperimentOutlined /> },
      { path: "/ops-duty/changes", localeKey: "menu.changeTasks", icon: <SwapOutlined /> },
      { path: "/ops-duty/reviews", localeKey: "menu.monthlyReviews", icon: <FileTextOutlined /> },
    ],
  },
  {
    key: "group-settings",
    localeKey: "menu.group.settings",
    icon: <SettingOutlined />,
    children: [
      { path: "/settings/workflows", localeKey: "menu.workflows", icon: <PartitionOutlined />, feature: "oncall_closure" },
      {
        path: "/settings/access-profile",
        localeKey: "menu.freeAccessProfile",
        icon: <SafetyCertificateOutlined />,
        platformAdminOnly: true,
      },
      {
        path: "/settings/ai/providers",
        localeKey: "menu.aiProviders",
        icon: <ApiOutlined />,
        platformAdminOnly: true,
      },
      {
        path: "/settings/ai/skills",
        localeKey: "menu.aiSkills",
        icon: <ApiOutlined />,
        platformAdminOnly: true,
      },
      {
        path: "/settings/ai/agents",
        localeKey: "menu.aiAgents",
        icon: <ApiOutlined />,
        platformAdminOnly: true,
      },
      { path: "/settings/im", localeKey: "menu.imConfig", icon: <NotificationOutlined />, feature: "team_governance" },
      { path: "/settings/users", localeKey: "menu.users", icon: <UserOutlined />, feature: "team_governance" },
      { path: "/account", localeKey: "menu.account", icon: <UserOutlined /> },
    ],
  },
];

function toMenuRoutes(
  routes: AppRoute[],
  t: (key: string) => string,
): MenuDataItem[] {
  return routes.map((route) => {
    const item: MenuDataItem = {
      key: route.key ?? route.path,
      // Pre-translate via i18next; disable ProLayout re-i18n on menu.${name}
      name: t(route.localeKey),
      locale: false,
      icon: route.icon,
    };
    if (route.children?.length) {
      item.children = toMenuRoutes(route.children, t);
      return item;
    }
    item.path = route.path;
    return item;
  });
}

/**
 * Hide menu entries the current edition cannot use (U2). A route with no
 * `feature` is always visible. A group is visible when its own feature (if any)
 * is enabled AND at least one child survives filtering — empty groups are
 * dropped so free tenants don't see collapsed headers with no children.
 */
export function filterRoutesByFeatures(
  routes: AppRoute[],
  hasFeature: (feature: FeatureKey) => boolean,
): AppRoute[] {
  const visible: AppRoute[] = [];
  for (const route of routes) {
    if (route.feature && !hasFeature(route.feature)) continue;
    if (route.children?.length) {
      const children = filterRoutesByFeatures(route.children, hasFeature);
      if (!children.length) continue;
      visible.push({ ...route, children });
    } else {
      visible.push(route);
    }
  }
  return visible;
}

/** Apply the platform-managed menu allow-list. Null keeps Enterprise/dev menus unchanged. */
export function filterRoutesByMenuPaths(
  routes: AppRoute[],
  menuPaths: string[] | null,
): AppRoute[] {
  if (menuPaths === null) return routes;
  const allowed = new Set(menuPaths);
  const visible: AppRoute[] = [];
  for (const route of routes) {
    if (route.children?.length) {
      const children = filterRoutesByMenuPaths(route.children, menuPaths);
      if (children.length) visible.push({ ...route, children });
      continue;
    }
    if (route.path && allowed.has(route.path)) visible.push(route);
  }
  return visible;
}

export function isPathAllowedByMenu(pathname: string, menuPaths: string[] | null): boolean {
  if (menuPaths === null) return true;
  return menuPaths.some(
    (allowedPath) => pathname === allowedPath || pathname.startsWith(`${allowedPath}/`),
  );
}

// ---------------------------------------------------------------------------
// AdminShell
// ---------------------------------------------------------------------------

type AdminShellProps = {
  children: ReactNode;
};

export function AdminShell({ children }: AdminShellProps) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const { isDark } = useAppSettings();
  const { entitlements, hasFeature } = useEntitlements();
  const username = getUsername() ?? t("header.admin");
  const platform = isPlatformAdmin();
  const pathAllowed = platform || isPathAllowedByMenu(
    location.pathname,
    entitlements.menu_paths ?? null,
  );

  const menuRoutes = useMemo(() => {
    const editionFiltered = filterRoutesByFeatures(appRoutes, hasFeature);
    const accessFiltered = filterRoutesByMenuPaths(
      editionFiltered,
      entitlements.menu_paths ?? null,
    );
    const routes = accessFiltered.map((route) => {
      if (route.key !== "group-settings" || !route.children) return route;
      return {
        ...route,
        children: route.children.filter((child) => {
          if (child.platformAdminOnly) return platform;
          if (child.path === "/settings/users") return isAdmin();
          return true;
        }),
      };
    });
    return toMenuRoutes(routes, t);
    // t is referentially stable; recompute when language changes
  }, [t, i18n.language, hasFeature, entitlements.menu_paths, platform]);

  return (
    <ProLayout
      title={t("app.title")}
      logo={<OpsMateLogo size={28} />}
      layout="mix"
      splitMenus={false}
      fixedHeader
      fixSiderbar
      navTheme={isDark ? "realDark" : "light"}
      siderWidth={216}
      location={{ pathname: location.pathname }}
      route={{ path: "/", routes: menuRoutes }}
      // Pre-translated names — turn off ProLayout/umi locale pass
      menu={{ locale: false }}
      formatMessage={({ id, defaultMessage }) =>
        id ? t(id, { defaultValue: defaultMessage ?? id }) : (defaultMessage ?? "")
      }
      actionsRender={() => <HeaderActions />}
      token={{
        header: { heightLayoutHeader: 56 },
        pageContainer: {
          paddingBlockPageContainerContent: 24,
          paddingInlinePageContainerContent: 24,
        },
      }}
      contentStyle={{ minHeight: "calc(100vh - 56px)" }}
      avatarProps={{
        title: username,
        size: "small",
        icon: <UserOutlined />,
        render: (_, dom) => (
          <Dropdown
            menu={{
              items: [
                {
                  key: "account",
                  icon: <UserOutlined />,
                  label: t("menu.account"),
                  onClick: () => {
                    window.location.href = "/account";
                  },
                },
                {
                  key: "logout",
                  icon: <LogoutOutlined />,
                  label: t("header.logout"),
                  onClick: () => void logout(),
                },
              ],
            }}
          >
            {dom}
          </Dropdown>
        ),
      }}
      menuItemRender={(item, dom) => {
        if (!item.path || item.children?.length) return dom;
        return <Link to={item.path}>{dom}</Link>;
      }}
      breadcrumbRender={(routers = []) => [
        { path: "/", title: t("header.home") },
        ...routers.map((r) => ({ path: r.path, title: r.title })),
      ]}
    >
      {pathAllowed ? (
        children
      ) : (
        <Result
          status="403"
          title="403"
          subTitle={t("accessProfile.denied")}
        />
      )}
    </ProLayout>
  );
}
