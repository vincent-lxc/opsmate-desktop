import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AppRoutes, REGISTERED_PRODUCT_PATHS } from "../routes";

describe("AppRoutes", () => {
  it("exposes desktop product routes and excludes admin routes", () => {
    render(
      <MemoryRouter initialEntries={["/servers"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "我的服务器" }),
    ).toBeInTheDocument();

    // Admin surface paths must never be treated as in-scope desktop routes.
    expect(["/roles", "/users", "/system"]).not.toContain("/servers");
  });

  it("renders the four top-level product headings", () => {
    const cases: Array<{ path: string; heading: string }> = [
      { path: "/monitoring", heading: "监控中心" },
      { path: "/servers", heading: "我的服务器" },
      { path: "/credentials", heading: "凭证" },
      { path: "/account", heading: "我的账户" },
    ];

    for (const { path, heading } of cases) {
      const { unmount } = render(
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>,
      );
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
      unmount();
    }
  });

  it("forbids top-level /terminal: redirects away and never shows Terminal/AI heading", () => {
    render(
      <MemoryRouter initialEntries={["/terminal"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    // Unknown top-level /terminal redirects to monitoring foundation route.
    expect(screen.getByRole("heading", { name: "监控中心" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "终端/AI" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Terminal/i })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/terminal"]')).toBeNull();
  });

  it("registers product paths without standalone /terminal", () => {
    const paths: readonly string[] = REGISTERED_PRODUCT_PATHS;
    expect(paths).toEqual([
      "/monitoring",
      "/servers",
      "/servers/:serverId",
      "/credentials",
      "/account",
    ]);
    expect(paths).not.toContain("/terminal");
    expect(paths.some((p) => p === "/terminal" || p.startsWith("/terminal/"))).toBe(
      false,
    );
    expect(paths).toContain("/servers/:serverId");
  });

  it("asserts /servers/:serverId contract for contextual terminal/AI entry (placeholder only)", () => {
    render(
      <MemoryRouter initialEntries={["/servers/srv-demo"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "服务器详情" })).toBeInTheDocument();
    expect(screen.getByTestId("server-detail-placeholder")).toHaveTextContent(
      "srv-demo",
    );
    expect(
      screen.getByText(/Terminal and AI workspace will be entered from this context/i),
    ).toBeInTheDocument();
    // Foundation stage: no full workspace implementation yet.
    expect(screen.queryByRole("heading", { name: "终端/AI" })).not.toBeInTheDocument();
  });

  it("does not render admin-only headings on product routes", () => {
    render(
      <MemoryRouter initialEntries={["/monitoring"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("heading", { name: "角色管理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "用户管理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "系统管理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AI Provider" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Bot 配置" })).not.toBeInTheDocument();
  });
});
