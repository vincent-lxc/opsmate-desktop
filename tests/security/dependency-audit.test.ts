/**
 * Public-release dependency security gates (pre-publication remediation).
 * Asserts router pin, no vulnerable react-router-dom, toolchain pin, audit doc.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("public-release dependency security gates", () => {
  it("pins react-router 8.3.0 and does not depend on react-router-dom", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      engines?: { node?: string };
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps["react-router"], "must pin react-router 8.3.0").toBe("8.3.0");
    expect(
      deps["react-router-dom"],
      "must not depend on react-router-dom (RSC advisory surface)",
    ).toBeUndefined();
    // react-router 8.3 engines.node — missing engines or Node 20 floor must fail
    expect(pkg.engines, "package.json engines object required").toBeDefined();
    expect(pkg.engines?.node, "package.json engines.node required").toBe(
      ">=22.22.0",
    );
    expect(pkg.engines?.node).not.toMatch(/^20|>=?\s*20(\.|$)/);

    const lockRaw = readFileSync(resolve(root, "package-lock.json"), "utf8");
    const lock = JSON.parse(lockRaw) as {
      packages?: Record<string, { engines?: { node?: string }; version?: string }>;
    };
    // Lock root metadata must carry the same engines floor (official registry regen).
    expect(
      lock.packages?.[""]?.engines?.node,
      "package-lock root engines.node required",
    ).toBe(">=22.22.0");
    // Lock must install react-router@8.3.0 and not nest react-router-dom.
    expect(lockRaw).toMatch(
      /"node_modules\/react-router":\s*\{[^}]*"version": "8\.3\.0"/s,
    );
    expect(lockRaw).not.toMatch(/"node_modules\/react-router-dom"/);
    expect(lock.packages?.["node_modules/react-router"]?.engines?.node).toMatch(
      />=\s*22\.22\.0/,
    );
  });

  it("requires Node 22.22.0 exact pins in both desktop workflows (no Node 20)", () => {
    const ci = readFileSync(
      resolve(root, ".github/workflows/desktop-ci.yml"),
      "utf8",
    );
    const release = readFileSync(
      resolve(root, ".github/workflows/desktop-release.yml"),
      "utf8",
    );
    const pin = /node-version:\s*"22\.22\.0"/g;
    expect((ci.match(pin) ?? []).length, "desktop-ci exact Node pin count").toBe(
      1,
    );
    expect(
      (release.match(pin) ?? []).length,
      "desktop-release exact Node pin count (macos/windows/linux)",
    ).toBe(3);
    expect(ci).not.toMatch(/node-version:\s*["']20(\.|["']|$)/);
    expect(release).not.toMatch(/node-version:\s*["']20(\.|["']|$)/);
  });

  it("pins root rust-toolchain.toml to 1.92.0 with rustfmt and clippy", () => {
    const path = resolve(root, "rust-toolchain.toml");
    expect(existsSync(path), "rust-toolchain.toml must exist at repo root").toBe(
      true,
    );
    const body = readFileSync(path, "utf8");
    expect(body).toMatch(/channel\s*=\s*"1\.92\.0"/);
    expect(body).toMatch(/rustfmt/);
    expect(body).toMatch(/clippy/);
    // Prefer components-only pin; CI installs platform targets explicitly.
    expect(body).not.toMatch(/targets\s*=/);
  });

  it("records public-release dependency audit with reachability decisions", () => {
    const path = resolve(root, "docs/security/public-release-dependency-audit.md");
    expect(
      existsSync(path),
      "docs/security/public-release-dependency-audit.md must exist",
    ).toBe(true);
    const body = readFileSync(path, "utf8");
    expect(body).toMatch(/quick-xml/i);
    expect(body).toMatch(/react-router/i);
    expect(body).toMatch(/reachability|reachable/i);
    expect(body).toMatch(/GTK|gtk/i);
    // Must document residuals / deferred items (not a false all-clear).
    expect(body).toMatch(/Residual|residual|deferred/i);
    expect(body).toMatch(/Non-claims|not a claim/i);
    // Runtime alignment: Node floor + exact CI pins for react-router 8.3 engines.
    expect(body).toMatch(/22\.22\.0/);
    expect(body).toMatch(/Runtime alignment|engines\.node|Node 20/i);
  });

  it("pins Cargo anyhow to a fixed advisory version (>= 1.0.103 exact)", () => {
    const cargo = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
    const m = cargo.match(/^\s*anyhow\s*=\s*"=?([^"]+)"/m);
    expect(m, "anyhow must be declared in Cargo.toml").toBeTruthy();
    const ver = m![1];
    // Exact-pin policy: =1.0.103 or higher patch that is fixed.
    expect(ver.startsWith("1.0.")).toBe(true);
    const patch = Number(ver.split(".")[2]);
    expect(patch).toBeGreaterThanOrEqual(103);
  });
});
