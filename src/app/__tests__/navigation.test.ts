import { describe, expect, it } from "vitest";
import { DESKTOP_NAV_ITEMS, isDesktopNavPath } from "../navigation";

/**
 * Scope contract (user decision, Task 2B):
 * Top-level nav is exactly four items. Terminal/AI is NEVER top-level;
 * it is entered only from My Servers → /servers/:serverId.
 */
describe("desktop navigation scope", () => {
  it("exposes exactly four product nav items", () => {
    expect(DESKTOP_NAV_ITEMS).toHaveLength(4);

    const labels = DESKTOP_NAV_ITEMS.map((item) => item.label);
    expect(labels).toEqual([
      "监控中心",
      "我的服务器",
      "凭证",
      "我的账户",
    ]);

    const paths = DESKTOP_NAV_ITEMS.map((item) => item.path);
    expect(paths).toEqual([
      "/monitoring",
      "/servers",
      "/credentials",
      "/account",
    ]);
  });

  it("forbids standalone top-level /terminal path and Terminal/AI label", () => {
    expect(isDesktopNavPath("/terminal")).toBe(false);
    expect(DESKTOP_NAV_ITEMS.some((item) => item.path === "/terminal")).toBe(
      false,
    );
    expect(DESKTOP_NAV_ITEMS.some((item) => item.path.includes("terminal"))).toBe(
      false,
    );

    const labels = DESKTOP_NAV_ITEMS.map((item) => item.label);
    expect(labels).not.toContain("终端/AI");
    expect(labels).not.toContain("Terminal");
    expect(labels).not.toContain("Terminal/AI");
    expect(labels.some((l) => /终端|Terminal|AI\s*工作/.test(l))).toBe(false);
  });

  it("excludes admin surfaces from top-level nav", () => {
    const forbidden = [
      "/roles",
      "/menus",
      "/users",
      "/system",
      "/ai-providers",
      "/bot-config",
      "/providers",
    ];

    for (const path of forbidden) {
      expect(isDesktopNavPath(path)).toBe(false);
      expect(DESKTOP_NAV_ITEMS.some((item) => item.path === path)).toBe(false);
    }

    const forbiddenLabels = [
      "角色",
      "菜单",
      "用户管理",
      "系统管理",
      "AI Provider",
      "Bot 配置",
    ];
    const labels = DESKTOP_NAV_ITEMS.map((item) => item.label);
    for (const label of forbiddenLabels) {
      expect(labels).not.toContain(label);
    }
  });
});
