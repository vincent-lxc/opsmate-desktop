/**
 * Task 5 — three-platform release config security tests.
 * Bundle targets, identifier, deep-link scheme, required icon formats,
 * and rejection of single-color / placeholder PNGs.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  checkDesktopCiWorkflow,
  checkGitAttributesLfContent,
  checkReleaseConfig,
  checkRustToolchainActionWithBlock,
  decodePngRgba,
  isPlaceholderPng,
  requiredGitAttributesRules,
  REQUIRED_ARTIFACT_TOKEN,
  REQUIRED_CI_RUNNERS,
  REQUIRED_CSP,
  REQUIRED_ICON_PNG_DIMS,
  REQUIRED_ICON_REL,
  REQUIRED_IDENTIFIER,
  REQUIRED_LF_PATHS,
  REQUIRED_LINUX_TAURI_CMD,
  REQUIRED_MAC_TAURI_CMD,
  REQUIRED_RUST_TOOLCHAIN_ACTION,
  REQUIRED_RUST_VERSION,
  REQUIRED_SCHEMES,
  REQUIRED_TARGETS,
  REQUIRED_WIN_TAURI_CMD,
  checkGitAttributesLf,
} from "../../scripts/check-release-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const confPath = resolve(root, "src-tauri/tauri.conf.json");
const iconsDir = resolve(root, "src-tauri/icons");

/** Minimal solid red 2×2 RGBA PNG (filter 0) — classic placeholder failure mode. */
function solidRedPng2x2(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(2, 0);
  ihdrData.writeUInt32BE(2, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // RGBA
  const ihdr = chunk("IHDR", ihdrData);
  // two rows: filter 0 + R G B A × 2
  const raw = Buffer.from([
    0, 255, 0, 0, 255, 255, 0, 0, 255, // row0
    0, 255, 0, 0, 255, 255, 0, 0, 255, // row1
  ]);
  const idat = chunk("IDAT", deflateSync(raw));
  const iend = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crcBuf = Buffer.concat([t, data]);
  // CRC32
  let c = ~0;
  for (let i = 0; i < crcBuf.length; i++) {
    c ^= crcBuf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((~c) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

describe("Task 5 release config", () => {
  it("requires dmg/nsis/appimage/deb, identifier, deep-link opsmate, and icon formats", () => {
    const config = JSON.parse(readFileSync(confPath, "utf8"));

    expect(config.bundle.targets).toEqual(["dmg", "nsis", "appimage", "deb"]);
    expect(config.identifier).toBe("sh.itops.opsmate");
    expect(config.plugins["deep-link"].desktop.schemes).toEqual(["opsmate"]);

    // Shared constant list (must match script gate).
    expect(REQUIRED_TARGETS).toEqual(["dmg", "nsis", "appimage", "deb"]);
    expect(REQUIRED_IDENTIFIER).toBe("sh.itops.opsmate");
    expect(REQUIRED_SCHEMES).toEqual(["opsmate"]);
    expect(REQUIRED_ICON_REL).toEqual([
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.png",
      "icons/icon.icns",
      "icons/icon.ico",
    ]);

    // CSP must not be widened by Task 5.
    expect(config.app.security.csp).toBe(REQUIRED_CSP);

    // bundle.icon must reference every required format path.
    for (const rel of REQUIRED_ICON_REL) {
      expect(config.bundle.icon).toContain(rel);
    }
  });

  it("rejects single-color placeholder PNG and accepts branded icons", () => {
    const solid = solidRedPng2x2();
    expect(isPlaceholderPng(solid)).toBe(true);

    for (const [rel, dim] of Object.entries(REQUIRED_ICON_PNG_DIMS)) {
      const name = rel.replace("icons/", "");
      const buf = readFileSync(resolve(iconsDir, name));
      const decoded = decodePngRgba(buf);
      expect(decoded, name).not.toBeNull();
      expect(decoded!.width).toBe(dim);
      expect(decoded!.height).toBe(dim);
      expect(isPlaceholderPng(buf), `${name} must not be placeholder`).toBe(
        false,
      );
    }
  });

  it("check-release-config.mjs reports zero errors when GREEN", () => {
    const result = checkReleaseConfig();
    if (!result.ok) {
      // Surface list for RED diagnostics without hiding assertion.
      expect(result.errors, result.errors.join("\n")).toEqual([]);
    }
    expect(result.ok).toBe(true);
  });

  it("desktop-ci.yml exists with three runners, Rust 1.92.0, gates, and internal-unsigned artifacts", () => {
    expect(REQUIRED_CI_RUNNERS).toEqual([
      "macos-14",
      "windows-2025",
      "ubuntu-24.04",
    ]);
    expect(REQUIRED_RUST_VERSION).toBe("1.92.0");
    expect(REQUIRED_ARTIFACT_TOKEN).toBe("internal-unsigned");
    expect(REQUIRED_RUST_TOOLCHAIN_ACTION).toBe(
      "dtolnay/rust-toolchain@87eb139fed4b08a67bd1fa429a21d1f5d523e03e",
    );
    expect(REQUIRED_RUST_TOOLCHAIN_ACTION).not.toMatch(/@(master|1\.92\.0)$/);
    expect(REQUIRED_MAC_TAURI_CMD).toContain(
      "--target universal-apple-darwin --bundles dmg",
    );
    expect(REQUIRED_WIN_TAURI_CMD).toContain("--bundles nsis");
    expect(REQUIRED_LINUX_TAURI_CMD).toContain("--bundles appimage,deb");
    expect(REQUIRED_LF_PATHS).toEqual([
      "src-tauri/src/cloud_transport/operations.rs",
      "contracts/openapi-v1.yaml",
      "src/cloud/generated-operations.ts",
    ]);

    const ciErrors = checkDesktopCiWorkflow();
    expect(ciErrors, ciErrors.join("\n")).toEqual([]);

    const lfErrors = checkGitAttributesLf();
    expect(lfErrors, lfErrors.join("\n")).toEqual([]);
  });

  it("checkGitAttributesLfContent rejects extra/missing/changed rules (pure, no repo mutate)", () => {
    const exact = requiredGitAttributesRules().join("\n") + "\n";
    expect(checkGitAttributesLfContent(exact)).toEqual([]);

    const withComment =
      "# comment ok\n" + requiredGitAttributesRules().join("\n") + "\n";
    expect(checkGitAttributesLfContent(withComment)).toEqual([]);

    const extra =
      requiredGitAttributesRules().join("\n") + "\n* text=auto\n";
    const extraErr = checkGitAttributesLfContent(extra);
    expect(extraErr.some((e) => e.includes("extra") || e.includes("exactly"))).toBe(
      true,
    );

    const missing = REQUIRED_LF_PATHS.slice(0, 2)
      .map((p) => `${p} text eol=lf`)
      .join("\n");
    expect(checkGitAttributesLfContent(missing).length).toBeGreaterThan(0);

    const changed =
      "src-tauri/src/cloud_transport/operations.rs text eol=crlf\n" +
      "contracts/openapi-v1.yaml text eol=lf\n" +
      "src/cloud/generated-operations.ts text eol=lf\n";
    expect(checkGitAttributesLfContent(changed).length).toBeGreaterThan(0);

    const dup =
      requiredGitAttributesRules().join("\n") +
      "\n" +
      requiredGitAttributesRules()[0] +
      "\n";
    expect(
      checkGitAttributesLfContent(dup).some((e) => e.includes("duplicate")),
    ).toBe(true);
  });

  it("checkRustToolchainActionWithBlock rejects any with.toolchain key (pure)", () => {
    const good = `
      - uses: dtolnay/rust-toolchain@87eb139fed4b08a67bd1fa429a21d1f5d523e03e
        with:
          components: rustfmt, clippy
          targets: aarch64-apple-darwin
      env:
        RUST_VERSION: "1.92.0"
    `;
    expect(checkRustToolchainActionWithBlock(good)).toEqual([]);

    const bad192 = `
      - uses: dtolnay/rust-toolchain@87eb139fed4b08a67bd1fa429a21d1f5d523e03e
        with:
          toolchain: "1.92.0"
          components: rustfmt, clippy
    `;
    expect(checkRustToolchainActionWithBlock(bad192).length).toBeGreaterThan(0);

    const badStable = `
      - uses: dtolnay/rust-toolchain@87eb139fed4b08a67bd1fa429a21d1f5d523e03e
        with:
          toolchain: stable
          components: rustfmt
    `;
    expect(checkRustToolchainActionWithBlock(badStable).length).toBeGreaterThan(
      0,
    );
  });
});

// ─── Task 7A — MPL-2.0 public-source controls (RED until docs/metadata land) ─

const PKG_PATH = resolve(root, "package.json");
const CARGO_TOML_PATH = resolve(root, "src-tauri/Cargo.toml");
const LICENSE_PATH = resolve(root, "LICENSE");
const NOTICE_PATH = resolve(root, "NOTICE");
const README_PATH = resolve(root, "README.md");
const SECURITY_PATH = resolve(root, "SECURITY.md");
const THREAT_MODEL_PATH = resolve(root, "THREAT_MODEL.md");
const CODEOWNERS_PATH = resolve(root, ".github/CODEOWNERS");
const DEPENDABOT_PATH = resolve(root, ".github/dependabot.yml");

/** Distinctive structural markers of the canonical Mozilla Public License 2.0 text. */
const MPL_2_0_CANONICAL_MARKERS = [
  "Mozilla Public License Version 2.0",
  // Official Mozilla text may use http:// or https:// (do not fork the license body).
  "mozilla.org/MPL/2.0/",
  "1. Definitions",
  "2.1. Grants",
  "3.1. Distribution of Source Form",
  "Exhibit A - Source Code Form License Notice",
] as const;

/**
 * Parse Cargo.toml `package.license` without a full TOML dependency.
 * Reads only the first `[package]` table body (until the next `[section]`).
 */
function cargoPackageLicense(toml: string): string | null {
  const lines = toml.split(/\r?\n/);
  let inPackage = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[package\]\s*$/.test(trimmed)) {
      inPackage = true;
      continue;
    }
    if (inPackage && /^\[/.test(trimmed)) {
      break;
    }
    if (!inPackage) continue;
    const m = trimmed.match(/^license\s*=\s*"([^"]+)"\s*$/);
    if (m) return m[1];
  }
  return null;
}

/** Valid Dependabot schedule.interval values (GitHub docs). */
const DEPENDABOT_SCHEDULE_INTERVALS = new Set([
  "daily",
  "weekly",
  "monthly",
]);

type DependabotUpdateEntry = {
  ecosystem: string;
  directory: string | null;
  interval: string | null;
};

/** Leading whitespace width (tabs count as 2 spaces for structural compare). */
function yamlIndent(line: string): number {
  const m = line.match(/^[ \t]*/);
  if (!m) return 0;
  return m[0].replace(/\t/g, "  ").length;
}

/**
 * Minimal Dependabot updates extract (no full YAML parser).
 * Each `- package-ecosystem` list item collects sibling `directory` and
 * **only** `interval` nested under a `schedule:` mapping (indent > schedule).
 * A top-level/sibling `interval:` at the update entry level is ignored.
 */
function dependabotUpdateEntries(yml: string): DependabotUpdateEntry[] {
  const entries: DependabotUpdateEntry[] = [];
  let current: DependabotUpdateEntry | null = null;
  /** Indent of active `schedule:` key; null when not inside a schedule mapping. */
  let scheduleIndent: number | null = null;
  for (const raw of yml.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const indent = yamlIndent(raw);
    const eco = raw.match(
      /^\s*-\s*package-ecosystem:\s*["']?([A-Za-z0-9_-]+)["']?/,
    );
    if (eco) {
      if (current) entries.push(current);
      current = {
        ecosystem: eco[1].toLowerCase(),
        directory: null,
        interval: null,
      };
      scheduleIndent = null;
      continue;
    }
    if (!current) continue;

    // Leaving the schedule mapping: any key at indent <= schedule indent.
    if (scheduleIndent !== null && indent <= scheduleIndent) {
      scheduleIndent = null;
    }

    if (/^\s*schedule:\s*(?:#.*)?$/.test(raw)) {
      scheduleIndent = indent;
      continue;
    }

    const dir = raw.match(
      /^\s*directory:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/,
    );
    if (dir) {
      current.directory = dir[1].trim();
      continue;
    }

    const interval = raw.match(
      /^\s*interval:\s*["']?([A-Za-z0-9_-]+)["']?\s*(?:#.*)?$/,
    );
    if (interval) {
      // Require nesting under schedule: (strictly greater indent than schedule key).
      if (scheduleIndent !== null && indent > scheduleIndent) {
        current.interval = interval[1].toLowerCase();
      }
      // else: sibling/top-level interval — reject (leave interval null)
    }
  }
  if (current) entries.push(current);
  return entries;
}

// Surfaces that must own nested descendants (true recursive ownership).
// Valid: /.github/workflows/**  .github/workflows/**/*  .signpath/**
// Invalid: trailing-slash-only dirs, single-star /* (direct children only), prefix globs.
const REQUIRED_CODEOWNERS_RECURSIVE_SURFACES = [
  ".github/workflows",
  ".signpath",
] as const;

// Extract the path pattern token from a CODEOWNERS ownership line.
function codeownersPathPattern(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const token = trimmed.split(/\s+/)[0];
  return token ?? null;
}

// True only for recursive patterns rooted at surface (/** or /**/*).
// Single-star /* protects direct children only — not accepted.
function codeownersCoversDescendants(
  pattern: string,
  surface: string,
): boolean {
  const s = surface.replace(/\\/g, "/").replace(/^\/+/, "");
  const body = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!body.startsWith(`${s}/`)) return false;
  const rest = body.slice(s.length + 1);
  // Recursive: ** or **/* (and **/** variants). Not bare * or foo*.
  return rest === "**" || rest === "**/*" || rest === "**/**";
}

describe("Task 7A MPL-2.0 public-source controls", () => {
  it("requires package.json and Cargo.toml license metadata exactly MPL-2.0", () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
      license?: string;
      private?: boolean;
    };
    expect(pkg.license, "package.json license must be SPDX MPL-2.0").toBe(
      "MPL-2.0",
    );
    // Legal gate is the SPDX license field. private:true remains allowed for a
    // non-npm-published desktop app (blocks accidental npm publish); this test
    // does not require private:false.
    expect(pkg.license).not.toMatch(/proprietary|UNLICENSED|All Rights Reserved/i);

    const cargo = readFileSync(CARGO_TOML_PATH, "utf8");
    const cargoLic = cargoPackageLicense(cargo);
    expect(cargoLic, "Cargo.toml package.license must be MPL-2.0").toBe(
      "MPL-2.0",
    );
    expect(cargoLic).not.toMatch(/LicenseRef-Proprietary|proprietary/i);
  });

  it("requires canonical full Mozilla Public License 2.0 text in LICENSE (not a short placeholder)", () => {
    const license = readFileSync(LICENSE_PATH, "utf8");
    // Structural: full MPL-2.0 is multi-KB; proprietary placeholder is short.
    expect(
      license.length,
      "LICENSE must be the full MPL-2.0 text, not a short proprietary stub",
    ).toBeGreaterThan(8_000);
    for (const marker of MPL_2_0_CANONICAL_MARKERS) {
      expect(license, `LICENSE missing MPL-2.0 marker: ${marker}`).toContain(
        marker,
      );
    }
    // Must not remain proprietary all-rights-reserved private-stage text.
    expect(license).not.toMatch(/All rights reserved/i);
    expect(license).not.toMatch(/proprietary and confidential/i);
    expect(license).not.toMatch(
      /No permission is granted to use, copy, modify/i,
    );
  });

  it("requires private GitHub vulnerability reporting channel and supported pre-release policy", () => {
    const security = readFileSync(SECURITY_PATH, "utf8");
    // Positive: private advisory channel (Private Vulnerability Reporting and/or
    // private GitHub Security Advisory) — not public Issues as the disclosure path.
    const hasPrivateAdvisoryChannel =
      /Private\s+Vulnerability\s+Reporting/i.test(security) ||
      (/GitHub\s+Security\s+Advis(o|e)ry/i.test(security) &&
        /private/i.test(security)) ||
      /private\s+GitHub\s+Security\s+Advis/i.test(security) ||
      /security\s+advisories?\s+.*private|private\s+.*security\s+advisories?/i.test(
        security,
      );
    expect(
      hasPrivateAdvisoryChannel,
      "SECURITY.md must require GitHub Private Vulnerability Reporting or a private GitHub Security Advisory",
    ).toBe(true);
    // Public repos SHOULD steer reporters away from public Issues for vulns.
    // (Correct guidance — require it; do not forbid this wording.)
    expect(
      /public\s+GitHub\s+issues?/i.test(security) ||
        /public\s+issues?/i.test(security),
      "SECURITY.md should mention public Issues when steering reporters away from them",
    ).toBe(true);
    // Allow markdown emphasis around "not" (e.g. Do **not** open public…).
    expect(
      /do\s+(?:\*+)?not(?:\*+)?\s+open\s+public/i.test(security) ||
        /(?:\*+)?not(?:\*+)?\s+(?:open|file|use|post)\s+public\s+(?:GitHub\s+)?issues?/i.test(
          security,
        ) ||
        /avoid\s+public\s+(?:GitHub\s+)?issues?/i.test(security) ||
        /never\s+(?:open|file)\s+public\s+(?:GitHub\s+)?issues?/i.test(security),
      "SECURITY.md must tell reporters not to disclose vulns via public Issues",
    ).toBe(true);
    // Must not claim the repository is private-stage-only (public-source prep).
    // Allow markdown emphasis around "private".
    expect(security).not.toMatch(
      /(?:\*+)?private(?:\*+)?\s+repository\s+during\s+the\s+current\s+stage/i,
    );
    expect(security).not.toMatch(/^##\s+Private disclosure\s*$/im);
    // Supported versions / pre-release policy.
    expect(security).toMatch(/##\s+Supported versions/i);
    expect(
      /pre-?release/i.test(security),
      "SECURITY.md must document supported pre-release policy",
    ).toBe(true);
  });
  it("requires accurate local-vault vs cloud-credential and SaaS-boundary wording", () => {
    // Contract may live in README and/or THREAT_MODEL (security product docs).
    const readme = readFileSync(README_PATH, "utf8");
    const threat = readFileSync(THREAT_MODEL_PATH, "utf8");
    const security = readFileSync(SECURITY_PATH, "utf8");
    const corpus = `${readme}\n${threat}\n${security}`;

    // Local vault: SSH keys / passwords stay local by default.
    expect(
      /local\s+vault/i.test(corpus) ||
        /Stronghold/i.test(corpus) ||
        /keys?\s+and\s+passwords?\s+stay\s+local/i.test(corpus),
      "docs must describe local vault / local key storage",
    ).toBe(true);
    expect(
      /(stay|remain|stored)\s+local/i.test(corpus) ||
        /local\s+by\s+default/i.test(corpus) ||
        /never\s+leave\s+the\s+(device|machine|host)/i.test(corpus),
      "docs must state local credentials stay local by default",
    ).toBe(true);

    // Explicitly selected cloud-hosted credentials enable unattended patrol.
    expect(
      /cloud[- ]hosted\s+credentials?/i.test(corpus) ||
        /credentials?\s+.*cloud/i.test(corpus),
      "docs must mention cloud-hosted credentials as an explicit path",
    ).toBe(true);
    expect(
      /unattended\s+patrol/i.test(corpus) ||
        /patrol/i.test(corpus),
      "docs must describe unattended patrol enabled by selected cloud credentials",
    ).toBe(true);

    // Cloud login/account/subscription/monitoring/AI remain OpsMate SaaS services.
    expect(
      /SaaS/i.test(corpus) || /OpsMate\s+(cloud|service|backend)/i.test(corpus),
      "docs must identify OpsMate cloud services as SaaS/backend",
    ).toBe(true);
    for (const service of [
      /login|auth(entication)?|Logto/i,
      /account/i,
      /subscription/i,
      /monitor/i,
      /\bAI\b|assistant/i,
    ] as const) {
      expect(
        service.test(corpus),
        `docs must reference SaaS surface matching ${service}`,
      ).toBe(true);
    }

    // Publishing the desktop repository does not open-source the SaaS backend.
    expect(
      /does\s+not\s+open[- ]source/i.test(corpus) ||
        /not\s+open[- ]source\s+the\s+(SaaS|backend|cloud)/i.test(corpus) ||
        /SaaS\s+backend\s+remains?\s+(proprietary|closed|private)/i.test(
          corpus,
        ) ||
        /publishing\s+this\s+(desktop\s+)?repository\s+does\s+not/i.test(
          corpus,
        ),
      "docs must explicitly state desktop open-source does not open-source SaaS backend",
    ).toBe(true);
  });

  it("requires NOTICE third-party/brand wording compatible with MPL-2.0 (not private-proprietary stage)", () => {
    const notice = readFileSync(NOTICE_PATH, "utf8");
    // Third-party attribution structure remains required.
    expect(notice.length).toBeGreaterThan(200);
    expect(
      /third[- ]party/i.test(notice) || /dependencies/i.test(notice),
      "NOTICE must mention third-party / dependencies",
    ).toBe(true);
    // Must not claim the product remains proprietary under private-stage NOTICE.
    expect(notice).not.toMatch(/Private-stage\s+binaries\s+and\s+source\s+remain\s+proprietary/i);
    expect(notice).not.toMatch(/see LICENSE\).*proprietary/i);
    // Brand: OpsMate ownership of trademarks/brand assets is fine under MPL;
    // must not forbid redistribution of the MPL-covered source itself.
    expect(notice).not.toMatch(
      /not licensed\s+for\s+third-party\s+redistribution\s+under\s+this\s+private-stage/i,
    );
  });

  it("codeownersCoversDescendants accepts only true recursive globs under surface", () => {
    // Directory-only trailing slash — fail.
    expect(codeownersCoversDescendants(".github/workflows/", ".github/workflows")).toBe(
      false,
    );
    expect(codeownersCoversDescendants("/.github/workflows/", ".github/workflows")).toBe(
      false,
    );
    expect(codeownersCoversDescendants(".signpath/", ".signpath")).toBe(false);
    expect(codeownersCoversDescendants("/.signpath/", ".signpath")).toBe(false);
    // Direct-children-only / prefix globs — fail (not nested recursive).
    expect(codeownersCoversDescendants(".github/workflows/*", ".github/workflows")).toBe(
      false,
    );
    expect(codeownersCoversDescendants("/.github/workflows/*", ".github/workflows")).toBe(
      false,
    );
    expect(codeownersCoversDescendants(".github/workflows/foo*", ".github/workflows")).toBe(
      false,
    );
    expect(codeownersCoversDescendants("/.signpath/*", ".signpath")).toBe(false);
    expect(codeownersCoversDescendants(".signpath/foo*", ".signpath")).toBe(false);
    // True recursive variants — pass.
    expect(codeownersCoversDescendants("/.github/workflows/**", ".github/workflows")).toBe(
      true,
    );
    expect(codeownersCoversDescendants(".github/workflows/**", ".github/workflows")).toBe(
      true,
    );
    expect(codeownersCoversDescendants(".github/workflows/**/*", ".github/workflows")).toBe(
      true,
    );
    expect(codeownersCoversDescendants("/.signpath/**", ".signpath")).toBe(true);
    expect(codeownersCoversDescendants(".signpath/**/*", ".signpath")).toBe(true);
  });

  it("requires CODEOWNERS recursive ownership of release workflows and SignPath policies", () => {
    expect(existsSync(CODEOWNERS_PATH), ".github/CODEOWNERS must exist").toBe(
      true,
    );
    const codeowners = readFileSync(CODEOWNERS_PATH, "utf8");
    expect(codeowners.length).toBeGreaterThan(0);
    const lines = codeowners
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    expect(lines.length).toBeGreaterThan(0);
    const patterns = lines
      .map(codeownersPathPattern)
      .filter((p): p is string => p != null);
    for (const surface of REQUIRED_CODEOWNERS_RECURSIVE_SURFACES) {
      const hit = patterns.some((p) => codeownersCoversDescendants(p, surface));
      expect(
        hit,
        `CODEOWNERS must recursively protect ${surface} (e.g. /${surface}/**), not trailing-slash-only`,
      ).toBe(true);
    }
    // Each ownership line must name at least one @owner or @team.
    expect(
      lines.every((l) => /@[\w./-]+/.test(l)),
      "CODEOWNERS entries must assign an @owner",
    ).toBe(true);
  });

  it("dependabotUpdateEntries accepts schedule.interval and rejects sibling/top-level interval", () => {
    const good = `
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
`;
    const goodEntries = dependabotUpdateEntries(good);
    expect(goodEntries).toHaveLength(1);
    expect(goodEntries[0].ecosystem).toBe("npm");
    expect(goodEntries[0].directory).toBe("/");
    expect(goodEntries[0].interval).toBe("weekly");

    // interval sibling of schedule (same indent as directory/schedule) — not nested.
    const siblingInterval = `
version: 2
updates:
  - package-ecosystem: cargo
    directory: "/"
    interval: weekly
    schedule:
      day: monday
`;
    const sibling = dependabotUpdateEntries(siblingInterval);
    expect(sibling).toHaveLength(1);
    expect(sibling[0].ecosystem).toBe("cargo");
    expect(sibling[0].directory).toBe("/");
    expect(
      sibling[0].interval,
      "sibling interval must not count as schedule.interval",
    ).toBeNull();

    // Top-level interval outside updates entry.
    const topLevel = `
version: 2
interval: weekly
updates:
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: monthly
`;
    const top = dependabotUpdateEntries(topLevel);
    expect(top).toHaveLength(1);
    expect(top[0].interval).toBe("monthly");
  });

  it("requires Dependabot npm/cargo/github-actions each with directory / and schedule interval", () => {
    expect(
      existsSync(DEPENDABOT_PATH),
      ".github/dependabot.yml must exist",
    ).toBe(true);
    const yml = readFileSync(DEPENDABOT_PATH, "utf8");
    const entries = dependabotUpdateEntries(yml);
    expect(
      entries.length,
      "dependabot.yml must declare package-ecosystem update entries",
    ).toBeGreaterThan(0);
    for (const eco of ["npm", "cargo", "github-actions"] as const) {
      const entry = entries.find((e) => e.ecosystem === eco);
      expect(entry, `Dependabot must include package-ecosystem: ${eco}`).toBeTruthy();
      expect(
        entry!.directory,
        `Dependabot ${eco} must set directory: "/"`,
      ).toBe("/");
      expect(
        entry!.interval,
        `Dependabot ${eco} must set schedule.interval`,
      ).toBeTruthy();
      expect(
        DEPENDABOT_SCHEDULE_INTERVALS.has(entry!.interval!),
        `Dependabot ${eco} schedule.interval must be daily|weekly|monthly (got ${entry!.interval})`,
      ).toBe(true);
      // Preferred cadence for public-source hygiene.
      expect(
        entry!.interval,
        `Dependabot ${eco} preferred schedule.interval is weekly`,
      ).toBe("weekly");
    }
  });
});

