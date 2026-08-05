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
  checkBuildJobNodeVersion,
  checkDesktopCiWorkflow,
  checkDesktopReleaseWorkflow,
  checkDesktopReleaseWorkflowContent,
  checkDesktopSignedReleaseConfig,
  checkGitAttributesLfContent,
  checkReleaseConfig,
  checkRustToolchainActionWithBlock,
  checkSignPathReleasePolicy,
  checkSignPathReleasePolicyContent,
  decodePngRgba,
  isPlaceholderPng,
  requiredGitAttributesRules,
  ARTIFACT_LINUX,
  ARTIFACT_MACOS,
  ARTIFACT_WINDOWS,
  DESKTOP_RELEASE_PATH,
  REQUIRED_APPLE_SECRET_NAMES,
  REQUIRED_ARTIFACT_TOKEN,
  REQUIRED_CI_RUNNERS,
  REQUIRED_CSP,
  REQUIRED_ICON_PNG_DIMS,
  REQUIRED_ICON_REL,
  REQUIRED_IDENTIFIER,
  REQUIRED_LF_PATHS,
  REQUIRED_LINUX_TAURI_CMD,
  REQUIRED_MAC_TAURI_CMD,
  REQUIRED_RELEASE_ENVIRONMENT,
  REQUIRED_RELEASE_TAG_PATTERN,
  REQUIRED_NODE_VERSION,
  REQUIRED_RUST_TOOLCHAIN_ACTION,
  REQUIRED_RUST_VERSION,
  REQUIRED_SCHEMES,
  REQUIRED_SIGNPATH_ACTION,
  REQUIRED_SIGNPATH_ACTION_SHA,
  REQUIRED_SIGNPATH_SECRET_NAMES,
  REQUIRED_TARGETS,
  REQUIRED_WIN_TAURI_CMD,
  SIGNPATH_POLICY_PATH,
  checkGitAttributesLf,
  extractWorkflowJobs,
  isRealSha256Command,
  lineHasSecretExpression,
  parseSignPathOutputArtifactDirectory,
  runScriptsContainSecrets,
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

  it("desktop-ci.yml exists with three runners, Rust 1.92.0, Node 22.22.0, gates, and internal-unsigned artifacts", () => {
    expect(REQUIRED_CI_RUNNERS).toEqual([
      "macos-14",
      "windows-2025",
      "ubuntu-24.04",
    ]);
    expect(REQUIRED_RUST_VERSION).toBe("1.92.0");
    expect(REQUIRED_NODE_VERSION).toBe("22.22.0");
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

    const ciYml = readFileSync(
      resolve(root, ".github/workflows/desktop-ci.yml"),
      "utf8",
    );
    expect(ciYml).toMatch(/node-version:\s*"22\.22\.0"/);
    expect(ciYml).not.toMatch(/node-version:\s*"20"/);

    const lfErrors = checkGitAttributesLf();
    expect(lfErrors, lfErrors.join("\n")).toEqual([]);
  });

  it("rejects Node 20 in desktop-ci and desktop-release checker content", () => {
    // Use full CI checker on real file is green; pure content via release path for node:
    const badRelease = `
on:
  push:
    tags:
      - 'desktop-v*'
permissions:
  contents: read
  actions: read
jobs:
  macos:
    runs-on: macos-14
    environment: desktop-release
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
  windows:
    runs-on: windows-2025
    environment: desktop-release
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
  linux:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
  release:
    needs: [macos, windows, linux]
    runs-on: ubuntu-24.04
    environment: desktop-release
    permissions:
      contents: write
    steps:
      - run: echo hi
`;
    const errs = checkDesktopReleaseWorkflowContent(badRelease);
    expect(errs.some((e) => /must not use Node 20/i.test(e))).toBe(true);
    expect(
      errs.some((e) => e.includes(REQUIRED_NODE_VERSION)),
    ).toBe(true);
  });

  it("rejects wrong or missing Node pin on desktop-release (requires exact 22.22.0)", () => {
    const missingNode = `
on:
  push:
    tags:
      - 'desktop-v*'
permissions:
  contents: read
  actions: read
jobs:
  macos:
    runs-on: macos-14
    environment: desktop-release
    steps:
      - uses: actions/setup-node@v4
        with:
          cache: npm
  windows:
    runs-on: windows-2025
    environment: desktop-release
    steps:
      - run: echo win
  linux:
    runs-on: ubuntu-24.04
    environment: desktop-release
    steps:
      - run: echo linux
  release:
    needs: [macos, windows, linux]
    runs-on: ubuntu-24.04
    environment: desktop-release
    permissions:
      contents: write
    steps:
      - run: echo hi
`;
    const missingErrs = checkDesktopReleaseWorkflowContent(missingNode);
    expect(
      missingErrs.some((e) =>
        /must set setup-node node-version|node-version must be exact/i.test(e),
      ),
      missingErrs.join("\n"),
    ).toBe(true);

    const wrongPin = `
on:
  push:
    tags:
      - 'desktop-v*'
permissions:
  contents: read
  actions: read
jobs:
  macos:
    runs-on: macos-14
    environment: desktop-release
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
  windows:
    runs-on: windows-2025
    environment: desktop-release
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "22.22.0"
  linux:
    runs-on: ubuntu-24.04
    environment: desktop-release
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "22.22.0"
  release:
    needs: [macos, windows, linux]
    runs-on: ubuntu-24.04
    environment: desktop-release
    permissions:
      contents: write
    steps:
      - run: echo hi
`;
    const wrongErrs = checkDesktopReleaseWorkflowContent(wrongPin);
    expect(
      wrongErrs.some((e) => /node-version must be exact 22\.22\.0/i.test(e)),
      wrongErrs.join("\n"),
    ).toBe(true);
  });

  it("desktop-release.yml pins exact Node 22.22.0 on all three build jobs", () => {
    const yml = readFileSync(
      resolve(root, ".github/workflows/desktop-release.yml"),
      "utf8",
    );
    const pins = [...yml.matchAll(/node-version:\s*["']([^"']+)["']/g)].map(
      (m) => m[1],
    );
    // Exactly three supported pins (macos/windows/linux); release job has none.
    expect(pins.length).toBe(3);
    expect(pins.every((v) => v === REQUIRED_NODE_VERSION)).toBe(true);
    expect(yml).not.toMatch(/node-version:\s*["']20(\.|["']|$)/);
    const releaseErrs = checkDesktopReleaseWorkflow();
    expect(
      releaseErrs.filter((e) => /node-version|Node 20/i.test(e)),
      releaseErrs.join("\n"),
    ).toEqual([]);
  });

  it("rejects missing Node pin on only one build job (per-job gate false-negative fix)", () => {
    const base = signedReleaseHappyPathYaml();
    // Delete only macos node-version; windows/linux remain exact 22.22.0.
    const noMacosPin = base.replace(
      /(jobs:\n  macos:[\s\S]*?steps:\n      - uses: actions\/setup-node@v4\n        with:\n)          node-version: "22\.22\.0"\n/,
      "$1",
    );
    expect(noMacosPin).toMatch(/windows:[\s\S]*node-version:\s*"22\.22\.0"/);
    expect(noMacosPin).toMatch(/linux:[\s\S]*node-version:\s*"22\.22\.0"/);
    expect(
      (noMacosPin.match(/node-version:\s*"22\.22\.0"/g) ?? []).length,
    ).toBe(2);

    const macErrs = checkDesktopReleaseWorkflowContent(noMacosPin);
    expect(
      macErrs.some((e) => /job 'macos'.*node-version|job 'macos'.*setup-node/i.test(e)),
      macErrs.join("\n"),
    ).toBe(true);
    // Other jobs must not be the only remaining green path — macos specifically fails.
    expect(macErrs.some((e) => e.includes("job 'macos'"))).toBe(true);

    // Delete only windows node-version; macos/linux remain correct.
    const noWindowsPin = base.replace(
      /(jobs:[\s\S]*?windows:[\s\S]*?steps:\n      - uses: actions\/setup-node@v4\n        with:\n)          node-version: "22\.22\.0"\n/,
      "$1",
    );
    expect(
      (noWindowsPin.match(/node-version:\s*"22\.22\.0"/g) ?? []).length,
    ).toBe(2);
    const winErrs = checkDesktopReleaseWorkflowContent(noWindowsPin);
    expect(
      winErrs.some((e) => /job 'windows'.*node-version|job 'windows'.*setup-node/i.test(e)),
      winErrs.join("\n"),
    ).toBe(true);
  });

  it("rejects conflicting duplicate Node pins inside a single build job", () => {
    const base = signedReleaseHappyPathYaml();
    // Insert a second wrong pin on macos while windows/linux stay exact 22.22.0.
    const dupWrong = base.replace(
      /(macos:[\s\S]*?node-version: "22\.22\.0"\n)/,
      '$1          node-version: "20"\n',
    );
    expect(dupWrong).toMatch(/macos:[\s\S]*node-version:\s*"22\.22\.0"[\s\S]*node-version:\s*"20"/);
    expect(dupWrong).toMatch(/windows:[\s\S]*node-version:\s*"22\.22\.0"/);
    expect(dupWrong).toMatch(/linux:[\s\S]*node-version:\s*"22\.22\.0"/);

    const errs = checkDesktopReleaseWorkflowContent(dupWrong);
    expect(
      errs.some(
        (e) =>
          /job 'macos'.*conflicting node-version/i.test(e) ||
          (/job 'macos'/i.test(e) && /Node 20|got 20/i.test(e)),
      ),
      errs.join("\n"),
    ).toBe(true);

    // Unit helper: two conflicting pins in one job body.
    const unit = checkBuildJobNodeVersion(
      `
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "22.22.0"
          node-version: "18"
`,
      "macos",
    );
    expect(unit.some((e) => /conflicting node-version/i.test(e))).toBe(true);
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

// ─── Task 8A — protected signed-release workflow + SignPath (RED until files land) ─

/** Minimal GREEN skeleton for indentation-aware job checks. */
function signedReleaseHappyPathYaml(): string {
  const sha = REQUIRED_SIGNPATH_ACTION_SHA;
  return `
on:
  push:
    tags:
      - 'desktop-v*'
permissions:
  contents: read
  actions: read
jobs:
  macos:
    runs-on: macos-14
    environment: desktop-release
    env:
      APPLE_CERTIFICATE: \${{ secrets.APPLE_CERTIFICATE }}
      APPLE_CERTIFICATE_PASSWORD: \${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
      APPLE_SIGNING_IDENTITY: \${{ secrets.APPLE_SIGNING_IDENTITY }}
      APPLE_ID: \${{ secrets.APPLE_ID }}
      APPLE_PASSWORD: \${{ secrets.APPLE_PASSWORD }}
      APPLE_TEAM_ID: \${{ secrets.APPLE_TEAM_ID }}
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "22.22.0"
          cache: npm
      - run: npm run tauri -- build --target universal-apple-darwin --bundles dmg
      - run: codesign --verify --deep --strict out.app
      - run: spctl --assess --type execute out.app
      - run: xcrun stapler validate out.dmg
      - uses: actions/upload-artifact@v4
        with:
          name: ${ARTIFACT_MACOS}
          path: out.dmg
  windows:
    runs-on: windows-2025
    environment: desktop-release
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "22.22.0"
          cache: npm
      - run: npm run tauri -- build --bundles nsis
      - name: upload unsigned nsis
        id: unsigned_nsis
        uses: actions/upload-artifact@v4
        with:
          name: windows-unsigned-nsis
          path: bundle/nsis/*.exe
      - name: SignPath request
        # documented pin v2
        uses: signpath/github-action-submit-signing-request@${sha}
        with:
          api-token: \${{ secrets.SIGNPATH_API_TOKEN }}
          organization-id: \${{ secrets.SIGNPATH_ORGANIZATION_ID }}
          project-slug: \${{ secrets.SIGNPATH_PROJECT_SLUG }}
          signing-policy-slug: \${{ secrets.SIGNPATH_SIGNING_POLICY_SLUG }}
          artifact-configuration-slug: \${{ secrets.SIGNPATH_ARTIFACT_CONFIGURATION_SLUG }}
          github-artifact-id: \${{ steps.unsigned_nsis.outputs.artifact-id }}
          wait-for-completion: true
          output-artifact-directory: signed-out
      - run: |
          $s = Get-AuthenticodeSignature .\\signed-out\\app.exe
          if ($s.Status -ne 'Valid') { throw 'Authenticode not Valid' }
      - uses: actions/upload-artifact@v4
        with:
          name: ${ARTIFACT_WINDOWS}
          path: signed-out/
  linux:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "22.22.0"
          cache: npm
      - run: npm run tauri -- build --bundles appimage,deb
      - uses: actions/upload-artifact@v4
        with:
          name: ${ARTIFACT_LINUX}
          path: bundle/
  release:
    needs: [macos, windows, linux]
    runs-on: ubuntu-24.04
    environment: desktop-release
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: ${ARTIFACT_MACOS}
          path: ${ARTIFACT_MACOS}
      - uses: actions/download-artifact@v4
        with:
          name: ${ARTIFACT_WINDOWS}
          path: ${ARTIFACT_WINDOWS}
      - uses: actions/download-artifact@v4
        with:
          name: ${ARTIFACT_LINUX}
          path: ${ARTIFACT_LINUX}
      - run: |
          set -euo pipefail
          STAGE_DIR="release-assets"
          rm -rf "\${STAGE_DIR}"
          mkdir -p "\${STAGE_DIR}"
          stage_platform() {
            local root="\$1"
            local count=0
            while IFS= read -r -d '' f; do
              local base dest
              base="\$(basename -- "\${f}")"
              dest="\${STAGE_DIR}/\${base}"
              if [[ -e "\${dest}" ]]; then
                echo "collision: \${base} already staged" >&2
                exit 1
              fi
              cp -p -- "\${f}" "\${dest}"
              count=\$((count + 1))
            done < <(find "\${root}" -type f -print0 | sort -z)
            if [[ "\${count}" -lt 1 ]]; then
              echo "no regular files under \${root}" >&2
              exit 1
            fi
          }
          stage_platform "${ARTIFACT_MACOS}"
          stage_platform "${ARTIFACT_WINDOWS}"
          stage_platform "${ARTIFACT_LINUX}"
      - run: |
          set -euo pipefail
          mapfile -d '' -t files < <(find release-assets -type f -print0 | sort -z)
          sha256sum -- "\${files[@]}" > SHA256SUMS
      - run: |
          set -euo pipefail
          mapfile -d '' -t files < <(find release-assets -type f -print0 | sort -z)
          gh release create "\$GITHUB_REF_NAME" --prerelease -- "\${files[@]}" SHA256SUMS
`;
}

function signPathHappyPolicy(): string {
  return `
allowed_triggers:
  - tag: desktop-v*
required_environment: desktop-release
artifact_scope:
  - windows-nsis
protected_secrets:
  api_token: \${{ secrets.SIGNPATH_API_TOKEN }}
  organization_id: \${{ secrets.SIGNPATH_ORGANIZATION_ID }}
  project_slug: \${{ secrets.SIGNPATH_PROJECT_SLUG }}
  signing_policy_slug: \${{ secrets.SIGNPATH_SIGNING_POLICY_SLUG }}
  artifact_configuration_slug: \${{ secrets.SIGNPATH_ARTIFACT_CONFIGURATION_SLUG }}
verification:
  authenticode: Valid
  fail_closed: true
`;
}

describe("Task 8A desktop signed-release controls", () => {
  it("exports required release paths, environment, tag pattern, Apple and SignPath secrets", () => {
    expect(DESKTOP_RELEASE_PATH.replace(/\\/g, "/")).toMatch(
      /\.github\/workflows\/desktop-release\.yml$/,
    );
    expect(SIGNPATH_POLICY_PATH.replace(/\\/g, "/")).toMatch(
      /\.signpath\/policies\/opsmate-desktop\/release-signing\.yml$/,
    );
    expect(REQUIRED_RELEASE_ENVIRONMENT).toBe("desktop-release");
    expect(REQUIRED_RELEASE_TAG_PATTERN).toBe("desktop-v*");
    expect(REQUIRED_APPLE_SECRET_NAMES).toHaveLength(6);
    expect(REQUIRED_SIGNPATH_SECRET_NAMES).toHaveLength(5);
    expect(REQUIRED_SIGNPATH_ACTION).toContain(REQUIRED_SIGNPATH_ACTION_SHA);
    expect(ARTIFACT_MACOS).toBe("opsmate-macos-signed-notarized");
    expect(ARTIFACT_WINDOWS).toBe("opsmate-windows-signed");
    expect(ARTIFACT_LINUX).toBe("opsmate-linux-release");
  });

  it("requires desktop-release.yml and SignPath policy present and structurally valid", () => {
    expect(
      existsSync(DESKTOP_RELEASE_PATH),
      "missing .github/workflows/desktop-release.yml",
    ).toBe(true);
    expect(
      existsSync(SIGNPATH_POLICY_PATH),
      "missing .signpath/policies/opsmate-desktop/release-signing.yml",
    ).toBe(true);
    const combined = checkDesktopSignedReleaseConfig();
    expect(combined.ok, combined.errors.join("\n")).toBe(true);
  });

  it("extractWorkflowJobs returns Record of string job bodies", () => {
    const jobs = extractWorkflowJobs(signedReleaseHappyPathYaml());
    expect(Object.keys(jobs).sort()).toEqual([
      "linux",
      "macos",
      "release",
      "windows",
    ]);
    for (const v of Object.values(jobs)) {
      expect(typeof v).toBe("string");
    }
    expect(jobs.macos).toMatch(/codesign/);
    expect(jobs.linux).not.toMatch(/codesign/);
  });

  it("checkDesktopReleaseWorkflowContent accepts structural happy-path skeleton", () => {
    const errs = checkDesktopReleaseWorkflowContent(signedReleaseHappyPathYaml());
    expect(errs, errs.join("\n")).toEqual([]);
  });

  it("rejects secrets inside run scripts (env mapping required)", () => {
    // Dot and bracket forms, both quote styles, inline + multiline.
    expect(lineHasSecretExpression("echo ${{ secrets.APPLE_ID }}")).toBe(true);
    expect(
      lineHasSecretExpression(`echo \${{ secrets['APPLE_PASSWORD'] }}`),
    ).toBe(true);
    expect(
      lineHasSecretExpression(`echo \${{ secrets["APPLE_TEAM_ID"] }}`),
    ).toBe(true);
    expect(lineHasSecretExpression("print(secrets.FOO)")).toBe(true);
    expect(lineHasSecretExpression(`print(secrets['BAR'])`)).toBe(true);
    expect(lineHasSecretExpression("echo no secrets here")).toBe(false);

    expect(
      runScriptsContainSecrets(`
    steps:
      - run: echo \${{ secrets.APPLE_CERTIFICATE }}
`),
    ).toBe(true);
    expect(
      runScriptsContainSecrets(`
    steps:
      - run: |
          echo \${{ secrets['APPLE_CERTIFICATE'] }}
`),
    ).toBe(true);
    expect(
      runScriptsContainSecrets(`
    steps:
      - run: |
          echo \${{ secrets["APPLE_ID"] }}
`),
    ).toBe(true);
    expect(
      runScriptsContainSecrets(`
    env:
      APPLE_CERTIFICATE: \${{ secrets.APPLE_CERTIFICATE }}
    steps:
      - run: codesign --verify out.app
`),
    ).toBe(false);

    let yml = signedReleaseHappyPathYaml();
    yml = yml.replace(
      "APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}",
      "APPLE_CERTIFICATE: unused",
    );
    yml = yml.replace(
      "- run: codesign --verify --deep --strict out.app",
      "- run: echo ${{ secrets.APPLE_CERTIFICATE }} && codesign --verify --deep --strict out.app",
    );
    const errs = checkDesktopReleaseWorkflowContent(yml);
    expect(
      errs.some((e) => /must not use secrets expressions inside run/i.test(e)),
    ).toBe(true);
  });

  it("ties Authenticode and windows signed upload to SignPath output-artifact-directory", () => {
    expect(
      parseSignPathOutputArtifactDirectory(
        "          output-artifact-directory: signed-out\n",
      ),
    ).toBe("signed-out");

    // Authenticode inspects wrong path (unsigned rename after fake Valid).
    let yml = signedReleaseHappyPathYaml();
    expect(yml).toContain("signed-out");
    yml = yml.replace(
      /Get-AuthenticodeSignature[^\n]+/,
      "Get-AuthenticodeSignature .\\bundle\\nsis\\unsigned.exe",
    );
    let errs = checkDesktopReleaseWorkflowContent(yml);
    expect(
      errs.some((e) =>
        /Authenticode step must inspect files under SignPath output-artifact-directory/i.test(
          e,
        ),
      ),
    ).toBe(true);

    // Final upload path not the SignPath output dir.
    yml = signedReleaseHappyPathYaml().replace(
      /name: opsmate-windows-signed\n\s*path:\s*signed-out\/?/,
      "name: opsmate-windows-signed\n          path: bundle/nsis/",
    );
    errs = checkDesktopReleaseWorkflowContent(yml);
    expect(
      errs.some((e) =>
        /upload path must be SignPath output-artifact-directory/i.test(e),
      ),
    ).toBe(true);
  });

  it("requires real SHA-256 over staged release-assets and rejects one-level platform globs", () => {
    expect(isRealSha256Command("sha256sum a b > SHA256SUMS")).toBe(true);
    expect(isRealSha256Command("shasum -a 256 a > SHA256SUMS")).toBe(true);
    expect(
      isRealSha256Command("Get-FileHash -Algorithm SHA256 a | Out-File SHA256SUMS"),
    ).toBe(true);
    expect(isRealSha256Command("echo SHA256SUMS")).toBe(false);

    // Old one-level globs (Linux nested appimage/deb dirs break this).
    let yml = signedReleaseHappyPathYaml().replace(
      /sha256sum -- "\$\{files\[@\]\}" > SHA256SUMS/,
      `sha256sum ${ARTIFACT_MACOS}/* ${ARTIFACT_WINDOWS}/* ${ARTIFACT_LINUX}/* > SHA256SUMS`,
    );
    let errs = checkDesktopReleaseWorkflowContent(yml);
    expect(
      errs.some((e) => /one-level artifact globs/i.test(e)),
    ).toBe(true);

    yml = signedReleaseHappyPathYaml().replace(
      /gh release create "\$GITHUB_REF_NAME" --prerelease -- "\$\{files\[@\]\}" SHA256SUMS/,
      `gh release create "$GITHUB_REF_NAME" ${ARTIFACT_MACOS}/* ${ARTIFACT_WINDOWS}/* ${ARTIFACT_LINUX}/* SHA256SUMS`,
    );
    errs = checkDesktopReleaseWorkflowContent(yml);
    expect(
      errs.some(
        (e) =>
          /one-level/i.test(e) ||
          /staged release-assets regular files/i.test(e),
      ),
    ).toBe(true);

    yml = signedReleaseHappyPathYaml().replace(
      /sha256sum -- "\$\{files\[@\]\}" > SHA256SUMS/,
      "echo 'checksums' > SHA256SUMS",
    );
    errs = checkDesktopReleaseWorkflowContent(yml);
    expect(errs.some((e) => /real SHA-256 command/i.test(e))).toBe(true);

    yml = signedReleaseHappyPathYaml().replace(
      /gh release create "\$GITHUB_REF_NAME" --prerelease -- "\$\{files\[@\]\}" SHA256SUMS/,
      'gh release create "$GITHUB_REF_NAME" SHA256SUMS',
    );
    errs = checkDesktopReleaseWorkflowContent(yml);
    expect(
      errs.some((e) => /publish staged release-assets/i.test(e)),
    ).toBe(true);
  });
  it("rejects cross-job Apple secrets and environment only on one job", () => {
    let yml = signedReleaseHappyPathYaml().replace(
      /environment: desktop-release\n/g,
      "",
    );
    yml = yml.replace(
      /linux:\n    runs-on: ubuntu-24.04\n/m,
      "linux:\n    runs-on: ubuntu-24.04\n    environment: desktop-release\n",
    );
    const errs = checkDesktopReleaseWorkflowContent(yml);
    expect(errs.some((e) => /job 'macos' must set environment/i.test(e))).toBe(
      true,
    );
    expect(errs.some((e) => /job 'windows' must set environment/i.test(e))).toBe(
      true,
    );
  });

  it("rejects wrong SignPath SHA, missing step id artifact-id, and pre-sign Authenticode", () => {
    let yml = signedReleaseHappyPathYaml().replace(
      REQUIRED_SIGNPATH_ACTION_SHA,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    let errs = checkDesktopReleaseWorkflowContent(yml);
    expect(errs.some((e) => /exact pinned/i.test(e))).toBe(true);

    yml = signedReleaseHappyPathYaml().replace(
      "id: unsigned_nsis",
      "name: no-id-upload",
    );
    errs = checkDesktopReleaseWorkflowContent(yml);
    expect(errs.some((e) => /must set id:/i.test(e))).toBe(true);

    yml = signedReleaseHappyPathYaml();
    // Move Authenticode before SignPath by swapping step order roughly:
    yml = yml.replace(
      /      - name: SignPath request[\s\S]*?output-artifact-directory: signed-out\n      - run: \|\n          \$s = Get-AuthenticodeSignature[\s\S]*?throw 'Authenticode not Valid' \}\n/,
      `      - run: |
          $s = Get-AuthenticodeSignature .\\\\early.exe
          if ($s.Status -ne 'Valid') { throw 'Authenticode not Valid' }
      - name: SignPath request
        # documented pin v2
        uses: signpath/github-action-submit-signing-request@${REQUIRED_SIGNPATH_ACTION_SHA}
        with:
          api-token: \${{ secrets.SIGNPATH_API_TOKEN }}
          organization-id: \${{ secrets.SIGNPATH_ORGANIZATION_ID }}
          project-slug: \${{ secrets.SIGNPATH_PROJECT_SLUG }}
          signing-policy-slug: \${{ secrets.SIGNPATH_SIGNING_POLICY_SLUG }}
          artifact-configuration-slug: \${{ secrets.SIGNPATH_ARTIFACT_CONFIGURATION_SLUG }}
          github-artifact-id: \${{ steps.unsigned_nsis.outputs.artifact-id }}
          wait-for-completion: true
          output-artifact-directory: signed-out
`,
    );
    errs = checkDesktopReleaseWorkflowContent(yml);
    expect(
      errs.some((e) => /AuthenticodeSignature step must run after SignPath/i.test(e)),
    ).toBe(true);
  });

  it("rejects release missing download, wrong order, and unsigned reference", () => {
    let yml = signedReleaseHappyPathYaml().replace(
      new RegExp(
        String.raw`      - uses: actions/download-artifact@v4\n        with:\n          name: ${ARTIFACT_LINUX}\n          path: ${ARTIFACT_LINUX}\n`,
      ),
      "",
    );
    let errs = checkDesktopReleaseWorkflowContent(yml);
    expect(
      errs.some((e) => e.includes(`download-artifact ${ARTIFACT_LINUX}`)),
    ).toBe(true);

    yml = signedReleaseHappyPathYaml().replace(
      "needs: [macos, windows, linux]",
      "needs: [macos, windows]",
    );
    errs = checkDesktopReleaseWorkflowContent(yml);
    expect(errs.some((e) => /needs: must include 'linux'/i.test(e))).toBe(true);

    yml = signedReleaseHappyPathYaml().replace(
      "gh release create",
      "gh release create windows-unsigned-nsis && gh release create",
    );
    errs = checkDesktopReleaseWorkflowContent(yml);
    expect(errs.some((e) => /must not reference unsigned/i.test(e))).toBe(true);
  });

  it("rejects upload before macos verification order and forbidden on: events", () => {
    let yml = signedReleaseHappyPathYaml();
    // put upload before ordered verify steps (after setup-node + build)
    yml = yml.replace(
      /- run: npm run tauri -- build --target universal-apple-darwin --bundles dmg\n      - run: codesign --verify --deep --strict out.app\n      - run: spctl --assess --type execute out.app\n      - run: xcrun stapler validate out.dmg\n      - uses: actions\/upload-artifact@v4\n        with:\n          name: opsmate-macos-signed-notarized\n          path: out.dmg\n/,
      `- run: npm run tauri -- build --target universal-apple-darwin --bundles dmg
      - uses: actions/upload-artifact@v4
        with:
          name: ${ARTIFACT_MACOS}
          path: out.dmg
      - run: codesign --verify --deep --strict out.app
      - run: spctl --assess --type execute out.app
      - run: xcrun stapler validate out.dmg
`,
    );
    let errs = checkDesktopReleaseWorkflowContent(yml);
    expect(
      errs.some((e) => /only after codesign\/spctl\/stapler validate/i.test(e)),
    ).toBe(true);

    // Reorder: spctl before codesign must fail order check
    yml = signedReleaseHappyPathYaml().replace(
      "- run: codesign --verify --deep --strict out.app\n      - run: spctl --assess --type execute out.app\n",
      "- run: spctl --assess --type execute out.app\n      - run: codesign --verify --deep --strict out.app\n",
    );
    errs = checkDesktopReleaseWorkflowContent(yml);
    expect(
      errs.some((e) => /order codesign then spctl then stapler validate/i.test(e)),
    ).toBe(true);

    yml = signedReleaseHappyPathYaml().replace(
      "on:\n  push:\n    tags:\n      - 'desktop-v*'\n",
      "on:\n  workflow_dispatch:\n  pull_request:\n  schedule:\n    - cron: '0 0 * * *'\n  push:\n    tags:\n      - 'desktop-v*'\n",
    );
    errs = checkDesktopReleaseWorkflowContent(yml);
    expect(errs.some((e) => /event 'workflow_dispatch'/i.test(e))).toBe(true);
    expect(errs.some((e) => /event 'pull_request'/i.test(e))).toBe(true);
    expect(errs.some((e) => /event 'schedule'/i.test(e))).toBe(true);
  });

  it("checkSignPathReleasePolicyContent requires five secrets, tag, env, NSIS, Valid, fail_closed", () => {
    const bad = checkSignPathReleasePolicyContent("artifact: foo\n");
    expect(bad.some((e) => /desktop-v\*/.test(e))).toBe(true);
    for (const sec of REQUIRED_SIGNPATH_SECRET_NAMES) {
      expect(bad.some((e) => e.includes(sec))).toBe(true);
    }
    const good = checkSignPathReleasePolicyContent(signPathHappyPolicy());
    expect(good, good.join("\n")).toEqual([]);
  });
});
