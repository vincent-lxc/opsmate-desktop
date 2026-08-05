import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "../App";

describe("App primary navigation", () => {
  it("renders exactly four top-level Chinese labels and paths", () => {
    render(
      <MemoryRouter initialEntries={["/monitoring"]}>
        <App />
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(4);

    const labels = links.map((a) => a.textContent);
    expect(labels).toEqual([
      "监控中心",
      "我的服务器",
      "凭证",
      "我的账户",
    ]);

    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "/monitoring",
      "/servers",
      "/credentials",
      "/account",
    ]);

    expect(within(nav).queryByRole("link", { name: /终端|Terminal/i })).toBeNull();
    expect(document.querySelector('nav a[href="/terminal"]')).toBeNull();
  });
});
