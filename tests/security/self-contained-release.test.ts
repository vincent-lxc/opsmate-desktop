import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const workflows = ["desktop-ci.yml", "desktop-release.yml"];

describe("self-contained desktop release boundary", () => {
  it.each(workflows)("%s builds only repository-owned source", (workflow) => {
    const text = readFileSync(join(root, ".github/workflows", workflow), "utf8");

    expect(text).not.toContain("OPSMATE_SOURCE_TOKEN");
    expect(text).not.toContain("release/source-lock.json");
    expect(text).not.toContain("source/apps/");
    expect(text).not.toMatch(/repository:\s*vincent-lxc\/opsmate/);
    expect(text).not.toMatch(/path:\s*source(?:\s|$)/m);
  });

  it("does not retain a cross-repository source lock", () => {
    expect(existsSync(join(root, "release/source-lock.json"))).toBe(false);
  });
});
