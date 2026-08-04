/** Desktop navigation — four product surfaces only; admin surfaces excluded. */
export type DesktopNavItem = {
  path: string;
  label: string;
};

/**
 * Top-level nav (coordinator scope correction):
 * Terminal/AI is contextual under My Servers (`/servers/:serverId`), not a menu item.
 */
export const DESKTOP_NAV_ITEMS: readonly DesktopNavItem[] = [
  { path: "/monitoring", label: "监控中心" },
  { path: "/servers", label: "我的服务器" },
  { path: "/credentials", label: "凭证" },
  { path: "/account", label: "我的账户" },
] as const;

export function isDesktopNavPath(path: string): boolean {
  return DESKTOP_NAV_ITEMS.some((item) => item.path === path);
}
