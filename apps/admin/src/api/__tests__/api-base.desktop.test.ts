import { describe, expect, it } from "vitest";
import {
  DESKTOP_API_BASE_URL,
  resolveApiBaseUrl,
  resolveApiUrl,
} from "../api-base";

/**
 * Task D1 — desktop Admin dist fixture contract.
 * Browser same-origin (empty base) is preserved; desktop builds inject absolute API origin.
 */
describe("API base URL (desktop fixture contract)", () => {
  it("documents desktop build injects exact https://app.itops.sh", () => {
    expect(DESKTOP_API_BASE_URL).toBe("https://app.itops.sh");
  });

  it("browser same-origin: empty/missing env keeps relative API base", () => {
    expect(resolveApiBaseUrl(undefined)).toBe("");
    expect(resolveApiBaseUrl(null)).toBe("");
    expect(resolveApiBaseUrl("")).toBe("");
    expect(resolveApiBaseUrl("   ")).toBe("");
    expect(resolveApiUrl("/api/security/credentials", "")).toBe(
      "/api/security/credentials",
    );
  });

  it("desktop fixture: absolute base resolves API paths against app.itops.sh", () => {
    const base = resolveApiBaseUrl(DESKTOP_API_BASE_URL);
    expect(base).toBe("https://app.itops.sh");
    expect(resolveApiUrl("/api/auth/logto/config", base)).toBe(
      "https://app.itops.sh/api/auth/logto/config",
    );
    expect(resolveApiUrl("/api/security/credentials", base)).toBe(
      "https://app.itops.sh/api/security/credentials",
    );
    // trailing slash on env is normalized
    expect(resolveApiBaseUrl("https://app.itops.sh/")).toBe("https://app.itops.sh");
  });
});
