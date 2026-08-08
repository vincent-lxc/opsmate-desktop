/**
 * Task 10 — Web UI parity + placeholder rejection.
 * Built Admin route table must still include the real product pages (not the
 * independent shell placeholders).
 *
 * Uses Vite `?raw` imports so tsc does not need node:fs types.
 */
import { describe, expect, it } from "vitest";

// Vite/Vitest raw source import (resolved at test runtime).
import appSource from "../../App.tsx?raw";

/** Four forbidden independent-shell placeholders (plan Task 10). */
const FORBIDDEN_A = "Monitoring overview" + " placeholder";
const FORBIDDEN_B = "My Servers" + " placeholder";
const FORBIDDEN_C = "Credentials vault" + " placeholder";
const FORBIDDEN_D = "My Account" + " placeholder";
const FORBIDDEN_PLACEHOLDERS = [FORBIDDEN_A, FORBIDDEN_B, FORBIDDEN_C, FORBIDDEN_D] as const;

// Eager raw glob of Admin source (excludes this test file by pattern of content checks).
const adminSources = import.meta.glob(
  ["../**/*.{ts,tsx}", "../../**/*.{ts,tsx}"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

describe("web-ui parity (Task 10)", () => {
  it("Admin App route table includes servers, monitoring, credentials, and account", () => {
    const src = String(appSource);
    // Server management + detail
    expect(src).toMatch(/path=["']\/servers["']/);
    expect(src).toMatch(/path=["']\/servers\/:id["']/);
    // Monitoring (foundation is the primary monitoring entry)
    expect(src).toMatch(/path=["']\/monitoring\//);
    // Credentials
    expect(src).toMatch(/path=["']\/security\/credentials["']/);
    // Account
    expect(src).toMatch(/path=["']\/account["']/);

    // Real page components — not placeholder shells
    expect(src).toMatch(/ServerManagement/);
    expect(src).toMatch(/ServerDetail/);
    expect(src).toMatch(/AccountPage|Account/);
    expect(src).toMatch(/CredentialsPage|security\/credentials/);
  });

  it("repository Admin sources contain none of the four shell placeholders", () => {
    const hits: string[] = [];
    for (const [path, text] of Object.entries(adminSources)) {
      if (path.includes("web-ui-parity.test")) continue;
      const body = String(text);
      for (const ph of FORBIDDEN_PLACEHOLDERS) {
        if (body.includes(ph)) {
          hits.push(`${path}: ${ph}`);
        }
      }
    }
    // Also scan App.tsx raw (may not be in glob depending on relative path).
    for (const ph of FORBIDDEN_PLACEHOLDERS) {
      if (String(appSource).includes(ph)) {
        hits.push(`App.tsx: ${ph}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("only apps/admin/src/desktop/* may import @tauri-apps/api", () => {
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(adminSources)) {
      // Glob paths are relative to this file (desktop/__tests__/):
      //   ../foo.ts → desktop/* (allowed)
      //   ../../App.tsx / ../../pages/* → outside desktop (must not import)
      const underDesktopTree =
        (path.startsWith("../") && !path.startsWith("../../"))
        || path.includes("/desktop/")
        || path.includes("\\desktop\\");
      if (underDesktopTree) continue;
      const body = String(text);
      if (/from\s+["']@tauri-apps\//.test(body) || /require\(["']@tauri-apps\//.test(body)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
