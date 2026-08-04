import { describe, expect, it } from "vitest";
import {
  SERVER_DETAIL_CONTEXTUAL_FEATURES,
  SERVER_DETAIL_ROUTE,
} from "../server-detail-contract";

describe("server detail navigation contract", () => {
  it("reserves /servers/:serverId as the contextual entry route", () => {
    expect(SERVER_DETAIL_ROUTE).toBe("/servers/:serverId");
    // Must never collide with a top-level /terminal product path.
    expect(SERVER_DETAIL_ROUTE.startsWith("/servers/")).toBe(true);
    expect(SERVER_DETAIL_ROUTE).not.toBe("/terminal");
    expect(SERVER_DETAIL_ROUTE.includes("terminal")).toBe(false);
  });

  it("lists terminal and AI workspace as contextual features only", () => {
    expect([...SERVER_DETAIL_CONTEXTUAL_FEATURES]).toEqual([
      "terminal",
      "ai-workspace",
    ]);
  });
});
