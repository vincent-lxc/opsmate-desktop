import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const adminRoot = join(root, "apps/admin");
const desktopRoot = join(root, "apps/desktop");

function sourceText(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? [sourceText(path)] : [readFileSync(path, "utf8")];
  }).join("\n");
}

describe("reviewed Web Admin Desktop release lineage", () => {
  it("owns the reviewed Admin and Tauri sources in this repository", () => {
    expect(existsSync(join(adminRoot, "src/App.tsx"))).toBe(true);
    expect(existsSync(join(desktopRoot, "src-tauri/Cargo.toml"))).toBe(true);
    expect(existsSync(join(root, "scripts/desktop-build-admin-dist.sh"))).toBe(true);
  });

  it("does not ship placeholder pages from the reviewed Admin source", () => {
    const text = sourceText(join(adminRoot, "src"));
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("cloud adapters land in later tasks");
    expect(text).toContain("/monitoring/");
  });

  it("binds Tauri to the repository-owned Admin dist", () => {
    const path = join(desktopRoot, "src-tauri/tauri.conf.json");
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.build.frontendDist).toBe("../../admin/dist");
  });

  it.each(["desktop-ci.yml", "desktop-release.yml"])(
    "%s builds the repository-owned Desktop runtime",
    (name) => {
      const text = readFileSync(join(root, ".github/workflows", name), "utf8");
      expect(text).toContain("apps/desktop/src-tauri/Cargo.toml");
      expect(text).toContain("npm --prefix apps/desktop run tauri --");
      expect(text).not.toMatch(/manifest-path\s+src-tauri\//);
    },
  );

  it("routes root developer commands to the reviewed sources", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["build:web"]).toContain("apps/admin");
    expect(pkg.scripts.tauri).toContain("apps/desktop");
    expect(pkg.scripts.build).toContain("build:web");
  });
});
