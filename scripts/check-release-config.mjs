/**
 * Task 5/6/8 — three-platform release config + branch CI + signed-release gates
 * (no extra deps). Validates tauri.conf.json, icons, desktop-ci.yml, and
 * (when present) desktop-release.yml + SignPath policy. Importable from vitest.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const CONF_PATH = resolve(ROOT, "src-tauri/tauri.conf.json");
export const ICONS_DIR = resolve(ROOT, "src-tauri/icons");
export const CAPABILITIES_PATH = resolve(
  ROOT,
  "src-tauri/capabilities/default.json",
);
/** Task 6 three-platform internal CI workflow. */
export const DESKTOP_CI_PATH = resolve(ROOT, ".github/workflows/desktop-ci.yml");
export const GITATTRIBUTES_PATH = resolve(ROOT, ".gitattributes");

/** Task 8 protected signed-release workflow + SignPath policy. */
export const DESKTOP_RELEASE_PATH = resolve(
  ROOT,
  ".github/workflows/desktop-release.yml",
);
export const SIGNPATH_POLICY_PATH = resolve(
  ROOT,
  ".signpath/policies/opsmate-desktop/release-signing.yml",
);
export const REQUIRED_RELEASE_ENVIRONMENT = "desktop-release";
export const REQUIRED_RELEASE_TAG_PATTERN = "desktop-v*";
export const REQUIRED_APPLE_SECRET_NAMES = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
];
/** Exact SignPath action pin (v2 line documented as commit SHA). */
export const REQUIRED_SIGNPATH_ACTION_SHA =
  "b9d91eadd323de506c0c81cf0c7fe7438f3360fd";
export const REQUIRED_SIGNPATH_ACTION = `signpath/github-action-submit-signing-request@${REQUIRED_SIGNPATH_ACTION_SHA}`;
/** Protected SignPath secret identifiers required in Windows job + policy. */
export const REQUIRED_SIGNPATH_SECRET_NAMES = [
  "SIGNPATH_API_TOKEN",
  "SIGNPATH_ORGANIZATION_ID",
  "SIGNPATH_PROJECT_SLUG",
  "SIGNPATH_SIGNING_POLICY_SLUG",
  "SIGNPATH_ARTIFACT_CONFIGURATION_SLUG",
];

/** Required GitHub-hosted runners (exact). */
export const REQUIRED_CI_RUNNERS = ["macos-14", "windows-2025", "ubuntu-24.04"];
export const REQUIRED_RUST_VERSION = "1.92.0";
/** react-router 8.3 engines.node; pin exact line in CI/release workflows. */
export const REQUIRED_NODE_VERSION = "22.22.0";
export const REQUIRED_ARTIFACT_TOKEN = "internal-unsigned";

/**
 * Task 10C/10D — approved full commit SHAs for official actions/* (Node 24 runtimes).
 * Floating tags / old SHAs are Node-20 deprecation surface. download-artifact is
 * required on the tag release aggregator (Task 10D; official v8.0.1 uses node24).
 */
export const REQUIRED_ACTIONS_CHECKOUT_SHA =
  "3d3c42e5aac5ba805825da76410c181273ba90b1";
export const REQUIRED_ACTIONS_SETUP_NODE_SHA =
  "820762786026740c76f36085b0efc47a31fe5020";
export const REQUIRED_ACTIONS_CACHE_SHA =
  "55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
export const REQUIRED_ACTIONS_UPLOAD_ARTIFACT_SHA =
  "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
/** actions/download-artifact@v8.0.1 tag commit (using: node24). */
export const REQUIRED_ACTIONS_DOWNLOAD_ARTIFACT_SHA =
  "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";

/** action name → required 40-hex SHA (no floating tags). */
export const REQUIRED_GH_ACTION_SHA_PINS = Object.freeze({
  "actions/checkout": REQUIRED_ACTIONS_CHECKOUT_SHA,
  "actions/setup-node": REQUIRED_ACTIONS_SETUP_NODE_SHA,
  "actions/cache": REQUIRED_ACTIONS_CACHE_SHA,
  "actions/upload-artifact": REQUIRED_ACTIONS_UPLOAD_ARTIFACT_SHA,
  "actions/download-artifact": REQUIRED_ACTIONS_DOWNLOAD_ARTIFACT_SHA,
});

/** Branch CI must present these four (no download steps). */
export const REQUIRED_GH_ACTION_SET_CI = Object.freeze([
  "actions/checkout",
  "actions/setup-node",
  "actions/cache",
  "actions/upload-artifact",
]);

/** Tag release must present CI set + download-artifact (aggregator). */
export const REQUIRED_GH_ACTION_SET_RELEASE = Object.freeze([
  ...REQUIRED_GH_ACTION_SET_CI,
  "actions/download-artifact",
]);

export const REQUIRED_ACTIONS_CHECKOUT = `actions/checkout@${REQUIRED_ACTIONS_CHECKOUT_SHA}`;
export const REQUIRED_ACTIONS_SETUP_NODE = `actions/setup-node@${REQUIRED_ACTIONS_SETUP_NODE_SHA}`;
export const REQUIRED_ACTIONS_CACHE = `actions/cache@${REQUIRED_ACTIONS_CACHE_SHA}`;
export const REQUIRED_ACTIONS_UPLOAD_ARTIFACT = `actions/upload-artifact@${REQUIRED_ACTIONS_UPLOAD_ARTIFACT_SHA}`;
export const REQUIRED_ACTIONS_DOWNLOAD_ARTIFACT = `actions/download-artifact@${REQUIRED_ACTIONS_DOWNLOAD_ARTIFACT_SHA}`;

/** Generated contract outputs that must stay LF on Windows checkout. */
export const REQUIRED_LF_PATHS = [
  "src-tauri/src/cloud_transport/operations.rs",
  "contracts/openapi-v1.yaml",
  "src/cloud/generated-operations.ts",
];

/** Required bundle targets for macOS / Windows / Linux installers. */
export const REQUIRED_TARGETS = ["dmg", "nsis", "appimage", "deb"];
export const REQUIRED_IDENTIFIER = "sh.itops.opsmate";
export const REQUIRED_SCHEMES = ["opsmate"];

/**
 * Required icon paths relative to src-tauri/ (Tauri 2 desktop set).
 * .icns = macOS, .ico = Windows, PNGs = Linux / shared.
 */
export const REQUIRED_ICON_REL = [
  "icons/32x32.png",
  "icons/128x128.png",
  "icons/128x128@2x.png",
  "icons/icon.png",
  "icons/icon.icns",
  "icons/icon.ico",
];

/** Frozen security surface — Task 5 must not alter CSP or capabilities. */
export const REQUIRED_CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'";

/** PNG primary (icon.png) must meet these dimensions. */
export const REQUIRED_ICON_PNG_DIMS = {
  "icons/32x32.png": 32,
  "icons/128x128.png": 128,
  "icons/128x128@2x.png": 256,
  "icons/icon.png": 512,
};

/**
 * Minimum distinct non-transparent colors for a branded icon (rejects solid placeholders).
 * Official OpsMate logo has blue field + white "M" (+ antialias) → many colors.
 */
export const MIN_DISTINCT_OPAQUE_COLORS = 8;

/**
 * Decode 8-bit RGBA/RGB PNG to raw pixels (no deps). Returns null if unsupported.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, rgba: Buffer } | null}
 */
export function decodePngRgba(buf) {
  if (
    buf.length < 8 ||
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47
  ) {
    return null;
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  /** @type {Buffer[]} */
  const idat = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len; // len + type + data + crc
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    return null;
  }
  const bpp = colorType === 6 ? 4 : 3;
  let inflated;
  try {
    inflated = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * bpp;
  const expected = (stride + 1) * height;
  if (inflated.length < expected) return null;

  const rgba = Buffer.alloc(width * height * 4);
  /** @type {Buffer | null} */
  let prev = null;
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = inflated[rowStart];
    const row = inflated.subarray(rowStart + 1, rowStart + 1 + stride);
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const x = row[i];
      const a = i >= bpp ? recon[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let val;
      switch (filter) {
        case 0:
          val = x;
          break;
        case 1:
          val = (x + a) & 0xff;
          break;
        case 2:
          val = (x + b) & 0xff;
          break;
        case 3:
          val = (x + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4: {
          // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          val = (x + pr) & 0xff;
          break;
        }
        default:
          return null;
      }
      recon[i] = val;
    }
    for (let x = 0; x < width; x++) {
      const si = x * bpp;
      const di = (y * width + x) * 4;
      rgba[di] = recon[si];
      rgba[di + 1] = recon[si + 1];
      rgba[di + 2] = recon[si + 2];
      rgba[di + 3] = bpp === 4 ? recon[si + 3] : 255;
    }
    prev = recon;
  }
  return { width, height, rgba };
}

/**
 * True when the PNG is a single-color / near-solid placeholder (not brand artwork).
 * Samples opaque pixels (alpha >= 16); rejects if distinct colors < MIN_DISTINCT_OPAQUE_COLORS.
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function isPlaceholderPng(buf) {
  const decoded = decodePngRgba(buf);
  if (!decoded) {
    // Unreadable/unsupported → treat as bad asset (not a pass for placeholder gate).
    return true;
  }
  const { width, height, rgba } = decoded;
  if (width < 1 || height < 1) return true;
  const colors = new Set();
  const total = width * height;
  // Stride sampling for large images (still dense enough for solid vs brand).
  const step = total > 20000 ? Math.floor(total / 10000) : 1;
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    const a = rgba[o + 3];
    if (a < 16) continue;
    // Quantize lightly to absorb antialias noise when counting diversity floor
    const r = rgba[o] >> 3;
    const g = rgba[o + 1] >> 3;
    const b = rgba[o + 2] >> 3;
    colors.add((r << 10) | (g << 5) | b);
    if (colors.size >= MIN_DISTINCT_OPAQUE_COLORS) return false;
  }
  return colors.size < MIN_DISTINCT_OPAQUE_COLORS;
}

/**
 * @returns {{ ok: boolean, errors: string[], config: object | null }}
 */
export function checkReleaseConfig() {
  const errors = [];
  if (!existsSync(CONF_PATH)) {
    return { ok: false, errors: [`missing ${CONF_PATH}`], config: null };
  }
  /** @type {any} */
  let config;
  try {
    config = JSON.parse(readFileSync(CONF_PATH, "utf8"));
  } catch (e) {
    return {
      ok: false,
      errors: [`invalid JSON: ${e instanceof Error ? e.message : String(e)}`],
      config: null,
    };
  }

  if (config.identifier !== REQUIRED_IDENTIFIER) {
    errors.push(
      `identifier: expected ${REQUIRED_IDENTIFIER}, got ${JSON.stringify(config.identifier)}`,
    );
  }

  const targets = config.bundle?.targets;
  if (!Array.isArray(targets) || targets.length !== REQUIRED_TARGETS.length) {
    errors.push(
      `bundle.targets: expected ${JSON.stringify(REQUIRED_TARGETS)}, got ${JSON.stringify(targets)}`,
    );
  } else {
    for (let i = 0; i < REQUIRED_TARGETS.length; i++) {
      if (targets[i] !== REQUIRED_TARGETS[i]) {
        errors.push(
          `bundle.targets: expected ${JSON.stringify(REQUIRED_TARGETS)}, got ${JSON.stringify(targets)}`,
        );
        break;
      }
    }
  }

  const schemes = config.plugins?.["deep-link"]?.desktop?.schemes;
  if (
    !Array.isArray(schemes) ||
    schemes.length !== REQUIRED_SCHEMES.length ||
    schemes[0] !== REQUIRED_SCHEMES[0]
  ) {
    errors.push(
      `deep-link desktop schemes: expected ${JSON.stringify(REQUIRED_SCHEMES)}, got ${JSON.stringify(schemes)}`,
    );
  }

  const csp = config.app?.security?.csp;
  if (csp !== REQUIRED_CSP) {
    errors.push("app.security.csp must remain unchanged from Task 5 baseline");
  }

  if (!existsSync(CAPABILITIES_PATH)) {
    errors.push("capabilities/default.json missing");
  } else {
    const cap = JSON.parse(readFileSync(CAPABILITIES_PATH, "utf8"));
    if (!Array.isArray(cap.permissions) || cap.permissions.length !== 1 || cap.permissions[0] !== "core:default") {
      errors.push(
        "capabilities/default.json must stay core:default only (no opener/deep-link/shell/stronghold WebView grants)",
      );
    }
  }

  const confIcons = config.bundle?.icon;
  if (!Array.isArray(confIcons)) {
    errors.push("bundle.icon must be an array of icon paths");
  } else {
    for (const rel of REQUIRED_ICON_REL) {
      if (!confIcons.includes(rel)) {
        errors.push(`bundle.icon must list ${rel}`);
      }
    }
  }

  for (const rel of REQUIRED_ICON_REL) {
    const abs = resolve(ROOT, "src-tauri", rel);
    if (!existsSync(abs)) {
      errors.push(`missing icon file: src-tauri/${rel}`);
      continue;
    }
    const st = statSync(abs);
    if (st.size < 16) {
      errors.push(`icon too small / empty: src-tauri/${rel}`);
    }
    // Format sniff: PNG / ICO / ICNS magic
    const buf = readFileSync(abs);
    if (rel.endsWith(".png")) {
      if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
        errors.push(`${rel} is not a PNG`);
        continue;
      }
      const want = REQUIRED_ICON_PNG_DIMS[rel];
      const decoded = decodePngRgba(buf);
      if (!decoded) {
        errors.push(`${rel}: failed to decode PNG RGBA`);
        continue;
      }
      if (want && (decoded.width !== want || decoded.height !== want)) {
        errors.push(
          `${rel}: expected ${want}x${want}, got ${decoded.width}x${decoded.height}`,
        );
      }
      // Reject solid/placeholder art (previous Task 5 solid-red failure mode).
      if (isPlaceholderPng(buf)) {
        errors.push(
          `${rel}: placeholder/single-color PNG rejected (use official OpsMate brand mark)`,
        );
      }
    } else if (rel.endsWith(".ico")) {
      // ICO: 00 00 01 00
      if (buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1 || buf[3] !== 0) {
        errors.push(`${rel} is not an ICO`);
      }
    } else if (rel.endsWith(".icns")) {
      if (buf.toString("ascii", 0, 4) !== "icns") {
        errors.push(`${rel} is not an ICNS`);
      }
    }
  }

  // ── Task 6: desktop-ci.yml ─────────────────────────────────────────────
  errors.push(...checkDesktopCiWorkflow());

  return { ok: errors.length === 0, errors, config };
}

/** Exact platform Tauri CLI invocations required by Task 6 rework. */
export const REQUIRED_MAC_TAURI_CMD =
  "npm run tauri -- build --target universal-apple-darwin --bundles dmg";
export const REQUIRED_WIN_TAURI_CMD = "npm run tauri -- build --bundles nsis";
export const REQUIRED_LINUX_TAURI_CMD =
  "npm run tauri -- build --bundles appimage,deb";

const GH_ACTION_SHA_HEX = /^[0-9a-f]{40}$/i;
const GH_ACTION_USES_RE =
  /uses:\s*(actions\/(?:checkout|setup-node|cache|upload-artifact|download-artifact))@([^\s#'"]+)/g;

/**
 * Pin gate for official actions/* used in desktop CI/release.
 *
 * - Every matched known action must equal the approved full 40-hex SHA.
 * - Presence set: desktop-ci → REQUIRED_GH_ACTION_SET_CI;
 *   desktop-release → REQUIRED_GH_ACTION_SET_RELEASE (includes download-artifact).
 * - download-artifact is not required on CI (no download steps); if present
 *   anywhere it must still be the approved SHA.
 *
 * @param {string} yml workflow YAML
 * @param {string} label e.g. desktop-ci.yml / desktop-release.yml
 * @returns {string[]}
 */
export function checkWorkflowGhActionPins(yml, label) {
  const errors = [];
  const text = String(yml ?? "");
  const isRelease = /desktop-release/.test(label);
  const requiredNames = isRelease
    ? REQUIRED_GH_ACTION_SET_RELEASE
    : REQUIRED_GH_ACTION_SET_CI;

  const uses = [...text.matchAll(GH_ACTION_USES_RE)];
  /** @type {Record<string, number>} */
  const seen = {};

  for (const m of uses) {
    const name = m[1];
    const ref = m[2].replace(/['"]/g, "");
    const required = REQUIRED_GH_ACTION_SHA_PINS[name];
    seen[name] = (seen[name] ?? 0) + 1;
    if (!required) continue;
    if (!GH_ACTION_SHA_HEX.test(ref)) {
      errors.push(
        `${label} must pin ${name} to full 40-hex SHA ${required} (got ${ref}; floating tags like @v4 are Node-20 deprecation surface)`,
      );
      continue;
    }
    if (ref.toLowerCase() !== required.toLowerCase()) {
      errors.push(`${label} must pin ${name}@${required} (got ${ref})`);
    }
  }

  for (const name of requiredNames) {
    if (!seen[name]) {
      errors.push(
        `${label} must include ${name}@${REQUIRED_GH_ACTION_SHA_PINS[name]}`,
      );
    }
  }
  return errors;
}
/**
 * Pinned full commit SHA for dtolnay/rust-toolchain refs/heads/1.92.0
 * (ls-remote proves 1.92.0 is a branch tip, not an immutable tag).
 * Rejects @master and floating @1.92.0 branch refs.
 */
export const REQUIRED_RUST_TOOLCHAIN_ACTION =
  "dtolnay/rust-toolchain@87eb139fed4b08a67bd1fa429a21d1f5d523e03e";

/**
 * Static requirements for three-platform branch CI (no YAML parser dep).
 * @returns {string[]}
 */
export function checkDesktopCiWorkflow() {
  const errors = [];
  if (!existsSync(DESKTOP_CI_PATH)) {
    errors.push("missing .github/workflows/desktop-ci.yml");
    return errors;
  }
  const yml = readFileSync(DESKTOP_CI_PATH, "utf8");

  for (const runner of REQUIRED_CI_RUNNERS) {
    if (!yml.includes(runner)) {
      errors.push(`desktop-ci.yml must use runner ${runner}`);
    }
  }
  if (!yml.includes(REQUIRED_RUST_VERSION)) {
    errors.push(`desktop-ci.yml must pin Rust ${REQUIRED_RUST_VERSION}`);
  }
  // Node line must satisfy react-router 8.3 engines (reject Node 20).
  if (
    !new RegExp(
      `node-version:\\s*["']${REQUIRED_NODE_VERSION.replace(/\./g, "\\.")}["']`,
    ).test(yml)
  ) {
    errors.push(
      `desktop-ci.yml must set setup-node node-version to exact ${REQUIRED_NODE_VERSION}`,
    );
  }
  if (/node-version:\s*["']20(\.|\s|["']|$)/.test(yml)) {
    errors.push(
      "desktop-ci.yml must not use Node 20 (react-router 8.3 requires >=22.22.0)",
    );
  }
  // Core npm/cargo gates
  for (const needle of [
    "npm ci",
    "npm test",
    "contracts:check",
    "npm run build:web",
    "cargo fmt",
    "clippy",
    "cargo test",
  ]) {
    if (!yml.includes(needle)) {
      errors.push(`desktop-ci.yml must run ${needle}`);
    }
  }
  // build:web step must run before cargo fmt step (dist for generate_context).
  // Match the step run line, not comments that mention "cargo fmt".
  const buildWebIdx = yml.indexOf("run: npm run build:web");
  const cargoFmtIdx = yml.indexOf("cargo fmt --manifest-path");
  if (buildWebIdx < 0 || cargoFmtIdx < 0 || buildWebIdx > cargoFmtIdx) {
    errors.push(
      "desktop-ci.yml must run npm run build:web before cargo fmt/clippy/test",
    );
  }

  // Exact platform build commands (prevent global four-target bleed on macOS).
  if (!yml.includes(REQUIRED_MAC_TAURI_CMD)) {
    errors.push(
      `desktop-ci.yml must contain exact macOS command: ${REQUIRED_MAC_TAURI_CMD}`,
    );
  }
  if (!yml.includes(REQUIRED_WIN_TAURI_CMD)) {
    errors.push(
      `desktop-ci.yml must contain exact Windows command: ${REQUIRED_WIN_TAURI_CMD}`,
    );
  }
  if (!yml.includes(REQUIRED_LINUX_TAURI_CMD)) {
    errors.push(
      `desktop-ci.yml must contain exact Linux command: ${REQUIRED_LINUX_TAURI_CMD}`,
    );
  }

  if (!yml.includes(REQUIRED_ARTIFACT_TOKEN)) {
    errors.push(
      `desktop-ci.yml artifact names must contain ${REQUIRED_ARTIFACT_TOKEN}`,
    );
  }

  // All upload-artifact steps must fail the job if bundles are missing.
  const uploadBlocks = yml.split("actions/upload-artifact@");
  if (uploadBlocks.length < 4) {
    // header + 3 uses
    errors.push(
      "desktop-ci.yml must use actions/upload-artifact three times (mac/win/linux)",
    );
  }
  const ifNoFiles = [...yml.matchAll(/if-no-files-found:\s*(\w+)/g)].map(
    (m) => m[1],
  );
  if (ifNoFiles.length < 3) {
    errors.push(
      "desktop-ci.yml must set if-no-files-found on all three artifact uploads",
    );
  }
  for (const v of ifNoFiles) {
    if (v !== "error") {
      errors.push(
        `desktop-ci.yml if-no-files-found must be error (got ${v})`,
      );
    }
  }
  if (yml.includes("if-no-files-found: warn")) {
    errors.push("desktop-ci.yml must not use if-no-files-found: warn");
  }

  // Security / non-goals
  if (!yml.includes("contents: read")) {
    errors.push("desktop-ci.yml must set permissions contents: read");
  }
  const forbidden = [
    /softprops\/action-gh-release/i,
    /actions\/create-release/i,
    /gh release create/i,
    /notariz/i,
    /codesign/i,
    /signpath/i,
    /apple-actions\/import-codesign/i,
    /\$\{\{\s*secrets\./i,
  ];
  for (const re of forbidden) {
    if (re.test(yml)) {
      errors.push(
        `desktop-ci.yml must not invoke release/signing/secrets (${re})`,
      );
    }
  }
  // Reject mutable / floating toolchain action refs (branch tips, not commit SHAs).
  if (/dtolnay\/rust-toolchain@master\b/.test(yml)) {
    errors.push(
      "desktop-ci.yml must not use mutable dtolnay/rust-toolchain@master",
    );
  }
  if (/dtolnay\/rust-toolchain@1\.92\.0\b/.test(yml)) {
    errors.push(
      "desktop-ci.yml must not use floating dtolnay/rust-toolchain@1.92.0 branch ref; pin full commit SHA",
    );
  }
  if (!yml.includes(REQUIRED_RUST_TOOLCHAIN_ACTION)) {
    errors.push(
      `desktop-ci.yml must pin full commit SHA ${REQUIRED_RUST_TOOLCHAIN_ACTION}`,
    );
  }
  errors.push(...checkRustToolchainActionWithBlock(yml));
  // Task 10C: full commit SHAs (not floating @v4 Node-20 action runtimes)
  errors.push(...checkWorkflowGhActionPins(yml, "desktop-ci.yml"));
  for (const pin of [
    REQUIRED_ACTIONS_CHECKOUT,
    REQUIRED_ACTIONS_SETUP_NODE,
    REQUIRED_ACTIONS_CACHE,
    REQUIRED_ACTIONS_UPLOAD_ARTIFACT,
  ]) {
    if (!yml.includes(pin)) {
      errors.push(`desktop-ci.yml must pin action ${pin}`);
    }
  }
  // Real npm cache via setup-node (not a no-op)
  if (!/cache:\s*npm/.test(yml)) {
    errors.push(
      "desktop-ci.yml setup-node must enable cache: npm (real dependency cache)",
    );
  }
  // Cargo cache
  if (
    !yml.includes(REQUIRED_ACTIONS_CACHE) ||
    !yml.toLowerCase().includes("cargo")
  ) {
    errors.push("desktop-ci.yml must cache Cargo artifacts");
  }
  // Ubuntu system packages for Tauri
  for (const pkg of [
    "libwebkit2gtk",
    "libgtk-3-dev",
    "librsvg2-dev",
    "patchelf",
  ]) {
    if (!yml.includes(pkg)) {
      errors.push(`desktop-ci.yml Ubuntu job must install ${pkg}*`);
    }
  }
  // Short retention for internal artifacts
  if (!yml.includes("retention-days")) {
    errors.push("desktop-ci.yml must set short artifact retention-days");
  }

  // .gitattributes LF for contract generator outputs (Windows CRLF drift fix)
  if (!existsSync(GITATTRIBUTES_PATH)) {
    errors.push("missing .gitattributes (required for LF contract outputs)");
  } else {
    errors.push(
      ...checkGitAttributesLfContent(readFileSync(GITATTRIBUTES_PATH, "utf8")),
    );
  }

  return errors;
}

/**
 * Expected exact non-comment .gitattributes rules (order-fixed as REQUIRED_LF_PATHS).
 * @returns {string[]}
 */
export function requiredGitAttributesRules() {
  return REQUIRED_LF_PATHS.map((p) => `${p} text eol=lf`);
}

/**
 * Pure validator: exact normalized non-comment rule set for contract LF paths.
 * Rejects missing, changed, duplicated, or extra non-comment rules.
 * @param {string} body
 * @returns {string[]}
 */
export function checkGitAttributesLfContent(body) {
  const errors = [];
  const expected = requiredGitAttributesRules();
  const lines = body.split(/\r?\n/);
  /** @type {string[]} */
  const rules = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    rules.push(line);
  }
  if (rules.length !== expected.length) {
    errors.push(
      `.gitattributes must contain exactly ${expected.length} non-comment rules (got ${rules.length})`,
    );
  }
  // Exact multiset equality in fixed order
  for (let i = 0; i < expected.length; i++) {
    if (rules[i] !== expected[i]) {
      errors.push(
        `.gitattributes rule ${i + 1} must be exactly ${JSON.stringify(expected[i])} (got ${JSON.stringify(rules[i] ?? null)})`,
      );
    }
  }
  // Duplicates
  const seen = new Set();
  for (const r of rules) {
    if (seen.has(r)) {
      errors.push(`.gitattributes has duplicate rule: ${r}`);
    }
    seen.add(r);
  }
  // Extra rules not in expected set
  for (const r of rules) {
    if (!expected.includes(r)) {
      errors.push(`.gitattributes has extra/forbidden rule: ${r}`);
    }
  }
  return errors;
}

/**
 * File-backed wrapper for .gitattributes gate.
 * @returns {string[]}
 */
export function checkGitAttributesLf() {
  if (!existsSync(GITATTRIBUTES_PATH)) {
    return ["missing .gitattributes (required for LF contract outputs)"];
  }
  return checkGitAttributesLfContent(readFileSync(GITATTRIBUTES_PATH, "utf8"));
}

/**
 * Pure validator: forbid ANY `toolchain:` key under a dtolnay/rust-toolchain `with:` block.
 * Allows env RUST_VERSION and rustc version greps outside that action with-block.
 * @param {string} yml
 * @returns {string[]}
 */
export function checkRustToolchainActionWithBlock(yml) {
  const errors = [];
  // Split on uses: dtolnay/rust-toolchain@...
  const re =
    /uses:\s*dtolnay\/rust-toolchain@[^\s\n]+[^\n]*\n((?:[ \t]+[^\n]*\n)*)/g;
  let m;
  let found = 0;
  while ((m = re.exec(yml)) !== null) {
    found += 1;
    const following = m[1] || "";
    // Only inspect the immediate with: block under this uses line
    const withMatch = following.match(/^[ \t]+with:\s*\n((?:[ \t]+[^\n]*\n)*)/m);
    if (!withMatch) continue;
    const withBody = withMatch[1] || "";
    if (/^[ \t]+toolchain\s*:/m.test(withBody)) {
      errors.push(
        "desktop-ci.yml must not pass any with.toolchain key under dtolnay/rust-toolchain action",
      );
    }
  }
  if (found === 0 && yml.includes("dtolnay/rust-toolchain")) {
    // Still scan generically if indentation differs
    if (
      /uses:\s*dtolnay\/rust-toolchain@[\s\S]{0,400}?with:[\s\S]{0,200}?^\s+toolchain\s*:/m.test(
        yml,
      )
    ) {
      errors.push(
        "desktop-ci.yml must not pass any with.toolchain key under dtolnay/rust-toolchain action",
      );
    }
  }
  return errors;
}

/** Leading whitespace width (tabs → 2 spaces). */
export function yamlLineIndent(line) {
  const m = line.match(/^[ \t]*/);
  if (!m) return 0;
  return m[0].replace(/\t/g, "  ").length;
}

/**
 * Extract mapping block for a top-level key (`on:`, `permissions:`, `jobs:`).
 * Supports both nested blocks and single-line forms (`permissions: write-all`).
 * @param {string} text
 * @param {string} key
 * @returns {string|null}
 */
export function extractTopLevelYamlBlock(text, key) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const keyOnly = new RegExp(`^([ \\t]*)${key}:\\s*(?:#.*)?$`);
  const keyInline = new RegExp(`^([ \\t]*)${key}:\\s+(.+)$`);
  let start = -1;
  let baseIndent = 0;
  let inlineValue = null;
  for (let i = 0; i < lines.length; i++) {
    const only = lines[i].match(keyOnly);
    if (only && yamlLineIndent(lines[i]) === 0) {
      start = i;
      baseIndent = 0;
      break;
    }
    const inl = lines[i].match(keyInline);
    if (inl && yamlLineIndent(lines[i]) === 0) {
      return String(inl[2]).trim();
    }
  }
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      out.push(line);
      continue;
    }
    const ind = yamlLineIndent(line);
    if (ind <= baseIndent) break;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Extract job name → full job body (including nested steps) under `jobs:`.
 * Always returns Record<string, string> (job body text).
 * @param {string} yml
 * @returns {Record<string, string>}
 */
export function extractWorkflowJobs(yml) {
  const text = yml.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  let jobsLine = -1;
  let jobsIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^([ \t]*)jobs:\s*(?:#.*)?$/.test(lines[i])) {
      jobsLine = i;
      jobsIndent = yamlLineIndent(lines[i]);
      break;
    }
  }
  /** @type {Record<string, string>} */
  const result = {};
  if (jobsLine < 0) return result;

  let jobName = /** @type {string|null} */ (null);
  let jobKeyIndent = /** @type {number|null} */ (null);
  /** @type {string[]} */
  let buf = [];

  const flush = () => {
    if (jobName != null) {
      result[jobName] = buf.join("\n");
    }
    buf = [];
  };

  for (let i = jobsLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      if (jobName != null) buf.push(line);
      continue;
    }
    const ind = yamlLineIndent(line);
    if (ind <= jobsIndent) break;

    const keyMatch = line.match(/^([ \t]+)([A-Za-z_][\w-]*)\s*:\s*(?:#.*)?$/);
    if (keyMatch) {
      const kid = yamlLineIndent(line);
      if (jobKeyIndent === null) jobKeyIndent = kid;
      if (kid === jobKeyIndent) {
        flush();
        jobName = keyMatch[2];
        buf = [];
        continue;
      }
    }
    if (jobName != null) buf.push(line);
  }
  flush();
  return result;
}

/**
 * Ordered step blobs inside a job body (each `- ` list item under `steps:`).
 * @param {string} jobBody
 * @returns {string[]}
 */
export function extractJobSteps(jobBody) {
  const lines = String(jobBody).replace(/\r\n/g, "\n").split("\n");
  let stepsIndent = null;
  let itemIndent = null;
  /** @type {string[]} */
  const steps = [];
  /** @type {string[]} */
  let cur = [];

  const flush = () => {
    if (cur.length) steps.push(cur.join("\n"));
    cur = [];
  };

  let inSteps = false;
  for (const line of lines) {
    if (!inSteps) {
      if (/^([ \t]*)steps:\s*(?:#.*)?$/.test(line)) {
        inSteps = true;
        stepsIndent = yamlLineIndent(line);
      }
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) {
      if (cur.length) cur.push(line);
      continue;
    }
    const ind = yamlLineIndent(line);
    if (ind <= /** @type {number} */ (stepsIndent)) break;
    if (/^[ \t]+-\s+/.test(line)) {
      if (itemIndent === null) itemIndent = ind;
      if (ind === itemIndent) {
        flush();
        cur.push(line);
        continue;
      }
    }
    if (cur.length) cur.push(line);
  }
  flush();
  return steps;
}

/**
 * @param {string} body
 * @param {string} name
 * @returns {boolean}
 */
function jobHasEnvironment(body, name) {
  return new RegExp(
    `^\\s*environment:\\s*['"]?${name}['"]?\\s*(?:#.*)?$`,
    "m",
  ).test(body);
}

/**
 * Secret reference: secrets.NAME or secrets['NAME'].
 * @param {string} body
 * @param {string} name
 */
function bodyRefsSecret(body, name) {
  return new RegExp(
    `secrets\\.${name}\\b|secrets\\[['\\"]${name}['\\"]\\]`,
  ).test(body);
}

/**
 * Dot or bracket secret expressions (both quote styles), with or without ${{ }}.
 * @param {string} line
 * @returns {boolean}
 */
export function lineHasSecretExpression(line) {
  const s = String(line);
  return (
    /\$\{\{\s*secrets\s*\.\s*[A-Za-z_][\w]*\s*\}\}/.test(s) ||
    /\$\{\{\s*secrets\s*\[\s*['"][^'"]+['"]\s*\]\s*\}\}/.test(s) ||
    /(?:^|[^.\w])secrets\s*\.\s*[A-Za-z_][\w]*/.test(s) ||
    /secrets\s*\[\s*['"][^'"]+['"]\s*\]/.test(s)
  );
}

/**
 * True if any `run:` / shell multiline script contains secrets expressions.
 * Detects secrets.NAME and secrets['NAME'] / secrets["NAME"] in inline and block runs.
 * @param {string} body
 */
export function runScriptsContainSecrets(body) {
  const lines = String(body).replace(/\r\n/g, "\n").split("\n");
  let inRun = false;
  let runIndent = 0;
  for (const line of lines) {
    // Match `run:` or list item `- run:`
    const runMatch = line.match(/^([ \t]*)(?:-\s+)?run:\s*(.*)$/);
    if (runMatch && /(^|\s)run:/.test(line)) {
      const ind = yamlLineIndent(line);
      const rest = runMatch[2].trim();
      if (rest === "|" || rest === ">") {
        inRun = true;
        runIndent = ind;
        continue;
      }
      // single-line run:
      if (lineHasSecretExpression(rest)) return true;
      inRun = false;
      continue;
    }
    if (inRun) {
      const ind = yamlLineIndent(line);
      if (line.trim() && ind <= runIndent) {
        inRun = false;
      } else if (lineHasSecretExpression(line)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Parse job-level `permissions:` mapping only (not script text).
 * @param {string} jobBody
 * @returns {Record<string, string>|null} null if no permissions key
 */
export function extractJobPermissionsMap(jobBody) {
  const lines = String(jobBody).replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(
      /^([ \t]+)permissions:\s+(\S+)\s*(?:#.*)?$/,
    );
    if (inline) {
      return { _inline: inline[2] };
    }
    const block = lines[i].match(/^([ \t]+)permissions:\s*(?:#.*)?$/);
    if (!block) continue;
    const base = yamlLineIndent(lines[i]);
    /** @type {Record<string, string>} */
    const map = {};
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      const ind = yamlLineIndent(line);
      if (ind <= base) break;
      const kv = line.match(/^[ \t]+([A-Za-z_]+):\s*(\S+)\s*(?:#.*)?$/);
      if (kv && ind > base && ind <= base + 4) {
        map[kv[1]] = kv[2].replace(/['"]/g, "");
      }
    }
    return map;
  }
  return null;
}

/**
 * Parse `output-artifact-directory` from a SignPath step blob.
 * @param {string} step
 * @returns {string|null}
 */
export function parseSignPathOutputArtifactDirectory(step) {
  const m = String(step).match(
    /^\s*output-artifact-directory:\s*['"]?([^\s'"#]+)/m,
  );
  return m ? m[1].replace(/\/+$/, "") : null;
}

/**
 * Real SHA-256 command (not mere echo of the word SHA256SUMS).
 * @param {string} step
 * @returns {boolean}
 */
export function isRealSha256Command(step) {
  const s = String(step);
  return (
    /\bsha256sum\b/.test(s) ||
    /\bshasum\s+-a\s+256\b/.test(s) ||
    /\bGet-FileHash\b[\s\S]*\bSHA256\b/i.test(s) ||
    /\bGet-FileHash\b[\s\S]*-Algorithm\s+SHA256\b/i.test(s)
  );
}

/**
 * @param {string} jobBody
 * @returns {boolean}
 */
function jobPermissionsContentsWrite(jobBody) {
  const map = extractJobPermissionsMap(jobBody);
  if (!map) return false;
  if (map._inline === "write-all") return true;
  return map.contents === "write";
}

/**
 * Job-level env mapping of NAME: ${{ secrets.NAME }} for Apple secrets.
 * @param {string} jobBody
 * @param {string} secretName
 */
function jobEnvMapsSecret(jobBody, secretName) {
  // env: block then KEY: ${{ secrets.SECRET }}
  // Accept either env key matching secret name or any mapping to secrets.SECRET
  const re = new RegExp(
    `^\\s*(?:${secretName}|[A-Z0-9_]+):\\s*\\$\\{\\{\\s*secrets\\.${secretName}\\s*\\}\\}`,
    "m",
  );
  // Only count under env: or step env: — reject run: lines already via runScriptsContainSecrets
  // Structural: line with secrets.X that is not under a run block
  if (!bodyRefsSecret(jobBody, secretName)) return false;
  if (runScriptsContainSecrets(jobBody) && /run:[\s\S]*secrets\./.test(jobBody)) {
    // still allow if also mapped in env — require env mapping specifically
  }
  // Require a non-run mapping line
  const lines = jobBody.replace(/\r\n/g, "\n").split("\n");
  let inRun = false;
  let runIndent = 0;
  for (const line of lines) {
    const runMatch = line.match(/^([ \t]+)run:\s*(.*)$/);
    if (runMatch) {
      const rest = runMatch[2].trim();
      if (rest === "|" || rest === ">") {
        inRun = true;
        runIndent = yamlLineIndent(line);
        continue;
      }
      inRun = false;
      continue;
    }
    if (inRun) {
      if (line.trim() && yamlLineIndent(line) <= runIndent) inRun = false;
      else continue;
    }
    if (
      new RegExp(
        `^\\s*\\w+:\\s*\\$\\{\\{\\s*secrets\\.${secretName}\\s*\\}\\}`,
      ).test(line)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Final artifact names (exact lineage).
 */
export const ARTIFACT_MACOS = "opsmate-macos-signed-notarized";
export const ARTIFACT_WINDOWS = "opsmate-windows-signed";
export const ARTIFACT_LINUX = "opsmate-linux-release";

/**
 * Per-build-job Node pin gate for desktop-release (react-router 8.3 engines).
 * Requires actions/setup-node with exact REQUIRED_NODE_VERSION; rejects missing,
 * Node 20, wrong pins, and duplicate conflicting node-version values in the job.
 * Prefer setup-node step bodies when steps parse; fall back to whole job text.
 *
 * @param {string} jobBody
 * @param {string} jobName macos|windows|linux
 * @returns {string[]}
 */
export function checkBuildJobNodeVersion(jobBody, jobName) {
  const errors = [];
  const body = String(jobBody ?? "");
  const steps = extractJobSteps(body);
  const setupNodeSteps = steps.filter((s) =>
    /uses:\s*actions\/setup-node@/i.test(s),
  );

  /** @type {string[]} */
  let pins = [];
  if (setupNodeSteps.length > 0) {
    for (const step of setupNodeSteps) {
      pins.push(
        ...[...step.matchAll(/node-version:\s*["']([^"']+)["']/g)].map(
          (m) => m[1],
        ),
      );
    }
  } else {
    // No setup-node step found via steps parse — still scan job body.
    if (!/actions\/setup-node@/i.test(body)) {
      errors.push(
        `desktop-release.yml job '${jobName}' must use actions/setup-node with node-version ${REQUIRED_NODE_VERSION}`,
      );
      return errors;
    }
    pins = [
      ...body.matchAll(/node-version:\s*["']([^"']+)["']/g),
    ].map((m) => m[1]);
  }

  if (pins.length === 0) {
    errors.push(
      `desktop-release.yml job '${jobName}' must set setup-node node-version to exact ${REQUIRED_NODE_VERSION}`,
    );
    return errors;
  }

  const unique = [...new Set(pins)];
  if (unique.length > 1) {
    errors.push(
      `desktop-release.yml job '${jobName}' has conflicting node-version pins (${unique.join(", ")}); require single exact ${REQUIRED_NODE_VERSION}`,
    );
  }

  for (const v of unique) {
    if (v === "20" || v.startsWith("20.")) {
      errors.push(
        `desktop-release.yml job '${jobName}' must not use Node 20 (react-router 8.3 requires >=22.22.0)`,
      );
    } else if (v !== REQUIRED_NODE_VERSION) {
      errors.push(
        `desktop-release.yml job '${jobName}' node-version must be exact ${REQUIRED_NODE_VERSION} (got ${v})`,
      );
    }
  }

  return errors;
}

/** @param {string} body */
function jobHasExplicitFalseCondition(body) {
  const header = body.split(/^\s*steps\s*:/m)[0];
  return /^\s*if:\s*\$\{\{\s*false\s*\}\}\s*(?:#.*)?$/m.test(header);
}

/**
 * Pure content validator for desktop-release.yml (Task 8 signed release).
 * @param {string} yml
 * @returns {string[]}
 */
export function checkDesktopReleaseWorkflowContent(yml) {
  const errors = [];
  const text = yml.replace(/\r\n/g, "\n");

  // --- on: push + desktop-v* only; reject other event keys ---
  const onBlock = extractTopLevelYamlBlock(text, "on");
  if (!onBlock) {
    errors.push("desktop-release.yml must declare on: trigger block");
  } else {
    const hasPush = /^\s*push\s*:/m.test(onBlock);
    const hasTag =
      /tags:\s*\n(?:[ \t]+-[ \t]*['"]?)desktop-v\*/.test(onBlock) ||
      /['"]desktop-v\*['"]/.test(onBlock);
    if (!hasPush || !hasTag) {
      errors.push(
        `desktop-release.yml on: must include push with tags ${REQUIRED_RELEASE_TAG_PATTERN}`,
      );
    }
    // First-level event keys under on:
    const eventKeys = [];
    const onLines = onBlock.split("\n");
    let base = null;
    for (const line of onLines) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const ind = yamlLineIndent(line);
      if (base === null) base = ind;
      const m = line.match(/^([ \t]+)([A-Za-z_]+)\s*:/);
      if (m && yamlLineIndent(line) === base) {
        eventKeys.push(m[2]);
      }
    }
    const allowed = new Set(["push"]);
    for (const k of eventKeys) {
      if (!allowed.has(k)) {
        errors.push(
          `desktop-release.yml on: must not include event '${k}' (tag push only)`,
        );
      }
    }
    if (/^\s*branches\s*:/m.test(onBlock)) {
      errors.push(
        "desktop-release.yml must not trigger on branches (tag desktop-v* only)",
      );
    }
  }

  // Top-level permissions read-only
  const topPerms = extractTopLevelYamlBlock(text, "permissions");
  if (!topPerms) {
    errors.push(
      "desktop-release.yml must declare top-level permissions (contents/actions read)",
    );
  } else {
    if (/write-all/.test(topPerms)) {
      errors.push("desktop-release.yml must not use permissions: write-all");
    }
    if (!/contents:\s*read/.test(topPerms)) {
      errors.push(
        "desktop-release.yml top-level permissions must set contents: read",
      );
    }
    if (!/actions:\s*read/.test(topPerms)) {
      errors.push(
        "desktop-release.yml top-level permissions must set actions: read",
      );
    }
    if (/contents:\s*write/.test(topPerms)) {
      errors.push(
        "desktop-release.yml top-level permissions must not set contents: write (release job only)",
      );
    }
  }

  if (/continue-on-error\s*:\s*true/i.test(text)) {
    errors.push(
      "desktop-release.yml must not set continue-on-error: true anywhere",
    );
  }

  // Task 10C: checkout / setup-node / cache / upload-artifact full SHA pins
  errors.push(...checkWorkflowGhActionPins(text, "desktop-release.yml"));

  // Per-job Node pins (macos/windows/linux) are validated after extractWorkflowJobs.
  // Global whole-file node-version counts are intentionally NOT sufficient: a missing
  // pin on one build job must fail even when other jobs retain exact 22.22.0.

  const jobs = extractWorkflowJobs(text);
  for (const name of ["macos", "windows", "linux", "release"]) {
    if (typeof jobs[name] !== "string") {
      errors.push(`desktop-release.yml must define job '${name}'`);
    }
  }
  if (
    typeof jobs.macos !== "string" ||
    typeof jobs.windows !== "string" ||
    typeof jobs.linux !== "string" ||
    typeof jobs.release !== "string"
  ) {
    return errors;
  }

  if (!jobHasExplicitFalseCondition(jobs.windows)) {
    errors.push(
      "desktop-release.yml job 'windows' must be explicitly disabled with job-level if: ${{ false }}",
    );
  }

  // react-router 8.3 engines: each build job must use setup-node with exact Node pin.
  // release job need not install Node (artifact staging / gh only).
  for (const name of ["macos", "windows", "linux"]) {
    const jobErrors = checkBuildJobNodeVersion(jobs[name], name);
    for (const e of jobErrors) errors.push(e);
  }

  for (const name of ["macos", "windows", "release"]) {
    if (!jobHasEnvironment(jobs[name], REQUIRED_RELEASE_ENVIRONMENT)) {
      errors.push(
        `desktop-release.yml job '${name}' must set environment: ${REQUIRED_RELEASE_ENVIRONMENT}`,
      );
    }
  }

  // Permissions: only release job mapping may have contents: write
  if (!jobPermissionsContentsWrite(jobs.release)) {
    errors.push(
      "desktop-release.yml job 'release' must set permissions mapping contents: write",
    );
  }
  for (const name of ["macos", "windows", "linux"]) {
    if (jobPermissionsContentsWrite(jobs[name])) {
      errors.push(
        `desktop-release.yml job '${name}' must not set permissions contents: write`,
      );
    }
  }

  // No secrets in any run: scripts
  for (const [name, body] of Object.entries(jobs)) {
    if (runScriptsContainSecrets(body)) {
      errors.push(
        `desktop-release.yml job '${name}' must not use secrets expressions inside run: scripts (use env mappings)`,
      );
    }
  }

  // macOS: Apple secrets via env mappings; universal; codesign; spctl; stapler validate; optional APPLE_ID on build
  for (const sec of REQUIRED_APPLE_SECRET_NAMES) {
    if (!jobEnvMapsSecret(jobs.macos, sec)) {
      errors.push(
        `desktop-release.yml job 'macos' must map secrets.${sec} through job/step env (not run scripts)`,
      );
    }
    for (const other of ["windows", "linux", "release"]) {
      if (bodyRefsSecret(jobs[other], sec)) {
        errors.push(
          `desktop-release.yml job '${other}' must not reference Apple secret ${sec}`,
        );
      }
    }
  }
  if (
    !/universal-apple-darwin/.test(jobs.macos) &&
    !/--target\s+universal-apple-darwin/.test(jobs.macos)
  ) {
    errors.push(
      "desktop-release.yml job 'macos' must build universal-apple-darwin",
    );
  }
  if (!/\bcodesign\b/.test(jobs.macos)) {
    errors.push(
      "desktop-release.yml job 'macos' must run codesign verification",
    );
  }
  if (!/\bspctl\b/.test(jobs.macos)) {
    errors.push(
      "desktop-release.yml job 'macos' must run spctl Gatekeeper assessment",
    );
  }
  // Notarization evidence: APPLE_ID/PASSWORD/TEAM_ID on build and/or stapler validate
  const hasAppleIdEnv =
    jobEnvMapsSecret(jobs.macos, "APPLE_ID") &&
    jobEnvMapsSecret(jobs.macos, "APPLE_PASSWORD") &&
    jobEnvMapsSecret(jobs.macos, "APPLE_TEAM_ID");
  if (!hasAppleIdEnv) {
    errors.push(
      "desktop-release.yml job 'macos' must map APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID for notarization evidence",
    );
  }
  if (!/stapler\s+validate|\bstapler\b.*validate|xcrun\s+stapler\s+validate/i.test(
    jobs.macos,
  )) {
    errors.push(
      "desktop-release.yml job 'macos' must run xcrun stapler validate",
    );
  }

  // macOS: ordered codesign → spctl → stapler validate → final upload
  const macSteps = extractJobSteps(jobs.macos);
  let codesignIdx = -1;
  let spctlIdx = -1;
  let staplerIdx = -1;
  let macUploadIdx = -1;
  for (let i = 0; i < macSteps.length; i++) {
    if (/\bcodesign\b/.test(macSteps[i])) codesignIdx = i;
    if (/\bspctl\b/.test(macSteps[i])) spctlIdx = i;
    if (/stapler\s+validate/i.test(macSteps[i])) staplerIdx = i;
    if (
      /actions\/upload-artifact@/.test(macSteps[i]) &&
      macSteps[i].includes(ARTIFACT_MACOS)
    ) {
      macUploadIdx = i;
    }
  }
  if (codesignIdx < 0 || spctlIdx < 0 || staplerIdx < 0) {
    errors.push(
      "desktop-release.yml job 'macos' must run codesign, spctl, and stapler validate as steps (not comments)",
    );
  } else if (
    !(codesignIdx < spctlIdx && spctlIdx < staplerIdx)
  ) {
    errors.push(
      "desktop-release.yml job 'macos' must order codesign then spctl then stapler validate",
    );
  }
  if (codesignIdx >= 0) {
    const codesignStep = macSteps[codesignIdx];
    if (
      !/hdiutil\s+attach/i.test(codesignStep) ||
      !/hdiutil\s+detach/i.test(codesignStep) ||
      !/(?:\.dmg\b|\$(?:\{DMG\}|DMG\b))/i.test(codesignStep)
    ) {
      errors.push(
        "desktop-release.yml job 'macos' codesign verification must mount the stapled DMG and verify the app from that mounted volume",
      );
    }
  }
  if (spctlIdx >= 0) {
    const spctlStep = macSteps[spctlIdx];
    if (
      !/--type\s+install\b/i.test(spctlStep) ||
      !/(?:\.dmg\b|\$(?:\{DMG\}|DMG\b))/i.test(spctlStep)
    ) {
      errors.push(
        "desktop-release.yml job 'macos' Gatekeeper verification must assess the DMG with --type install",
      );
    }
  }
  if (macUploadIdx < 0) {
    errors.push(
      `desktop-release.yml job 'macos' must upload-artifact name ${ARTIFACT_MACOS}`,
    );
  } else if (staplerIdx < 0 || macUploadIdx <= staplerIdx) {
    errors.push(
      `desktop-release.yml job 'macos' must upload ${ARTIFACT_MACOS} only after codesign/spctl/stapler validate`,
    );
  }

  // Windows pipeline
  const win = jobs.windows;
  const winSteps = extractJobSteps(win);
  if (!/nsis/i.test(win)) {
    errors.push("desktop-release.yml job 'windows' must build NSIS bundle");
  }

  let unsignedIdx = -1;
  let unsignedId = null;
  let signpathIdx = -1;
  let authIdx = -1;
  let winFinalUpload = -1;
  /** @type {string|null} */
  let signpathOutDir = null;

  for (let i = 0; i < winSteps.length; i++) {
    const s = winSteps[i];
    if (
      /actions\/upload-artifact@/.test(s) &&
      /unsigned/i.test(s) &&
      /nsis/i.test(s)
    ) {
      unsignedIdx = i;
      const idm = s.match(/^\s*id:\s*([A-Za-z_][\w-]*)/m);
      if (idm) unsignedId = idm[1];
    }
    if (s.includes(REQUIRED_SIGNPATH_ACTION)) {
      signpathIdx = i;
      signpathOutDir = parseSignPathOutputArtifactDirectory(s);
    }
    if (/Get-AuthenticodeSignature/i.test(s)) {
      authIdx = i;
    }
    if (
      /actions\/upload-artifact@/.test(s) &&
      s.includes(ARTIFACT_WINDOWS)
    ) {
      winFinalUpload = i;
    }
  }

  if (unsignedIdx < 0) {
    errors.push(
      "desktop-release.yml job 'windows' must upload-artifact unsigned NSIS before SignPath",
    );
  } else if (!unsignedId) {
    errors.push(
      "desktop-release.yml unsigned NSIS upload step must set id: for artifact-id output",
    );
  }

  if (signpathIdx < 0) {
    errors.push(
      `desktop-release.yml job 'windows' must use exact pinned ${REQUIRED_SIGNPATH_ACTION}`,
    );
  } else {
    const around = winSteps
      .slice(Math.max(0, signpathIdx - 1), signpathIdx + 2)
      .join("\n");
    if (!/\bv2\b/.test(around)) {
      errors.push(
        "desktop-release.yml SignPath step must have a nearby v2 documentation comment",
      );
    }
    if (unsignedIdx < 0 || unsignedIdx >= signpathIdx) {
      errors.push(
        "desktop-release.yml job 'windows' must upload unsigned NSIS before SignPath action",
      );
    }
    const sp = winSteps[signpathIdx];
    for (const sec of REQUIRED_SIGNPATH_SECRET_NAMES) {
      if (!bodyRefsSecret(sp, sec)) {
        errors.push(
          `desktop-release.yml SignPath step must map secrets.${sec} on the action step itself`,
        );
      }
    }
    if (!/wait-for-completion:\s*true/i.test(sp)) {
      errors.push(
        "desktop-release.yml SignPath step must set wait-for-completion: true",
      );
    }
    if (!signpathOutDir) {
      errors.push(
        "desktop-release.yml SignPath step must set output-artifact-directory",
      );
    }
    if (unsignedId) {
      const expectRef = new RegExp(
        `github-artifact-id:\\s*\\$\\{\\{\\s*steps\\.${unsignedId}\\.outputs\\.artifact-id\\s*\\}\\}`,
      );
      if (!expectRef.test(sp)) {
        errors.push(
          `desktop-release.yml SignPath github-artifact-id must be steps.${unsignedId}.outputs.artifact-id`,
        );
      }
    } else if (!/github-artifact-id:/i.test(sp)) {
      errors.push(
        "desktop-release.yml SignPath step must set github-artifact-id",
      );
    }
  }

  // Authenticode after SignPath: inspect exe under SignPath output dir; fail-closed Status -ne Valid
  if (authIdx < 0) {
    errors.push(
      "desktop-release.yml job 'windows' must run Get-AuthenticodeSignature after SignPath",
    );
  } else {
    if (signpathIdx >= 0 && authIdx <= signpathIdx) {
      errors.push(
        "desktop-release.yml Get-AuthenticodeSignature step must run after SignPath",
      );
    }
    const a = winSteps[authIdx];
    if (!/Get-AuthenticodeSignature/i.test(a)) {
      errors.push(
        "desktop-release.yml Authenticode step must call Get-AuthenticodeSignature",
      );
    }
    if (signpathOutDir && !a.includes(signpathOutDir)) {
      errors.push(
        `desktop-release.yml Authenticode step must inspect files under SignPath output-artifact-directory '${signpathOutDir}'`,
      );
    }
    const failClosed =
      (/Status\s*-ne\s*['"]Valid['"]/i.test(a) ||
        /\.Status\s*-ne\s*['"]Valid['"]/i.test(a)) &&
      (/throw\b|exit\s+1|Environment\.Exit|Write-Error/i.test(a));
    if (!failClosed) {
      errors.push(
        "desktop-release.yml Authenticode step must fail-closed with Status -ne 'Valid' (throw/exit)",
      );
    }
  }

  if (winFinalUpload < 0) {
    errors.push(
      `desktop-release.yml job 'windows' must upload-artifact name ${ARTIFACT_WINDOWS} after Authenticode`,
    );
  } else if (authIdx >= 0 && winFinalUpload <= authIdx) {
    errors.push(
      `desktop-release.yml job 'windows' must upload ${ARTIFACT_WINDOWS} only after Authenticode verification`,
    );
  } else if (signpathOutDir) {
    const up = winSteps[winFinalUpload];
    const pathM = up.match(/^\s*path:\s*['"]?([^\s'"#]+)/m);
    const upPath = pathM ? pathM[1].replace(/\/+$/, "") : "";
    if (upPath !== signpathOutDir && upPath !== `${signpathOutDir}/`) {
      // allow path: signed-out or signed-out/
      if (
        !upPath.startsWith(`${signpathOutDir}/`) &&
        upPath !== signpathOutDir
      ) {
        errors.push(
          `desktop-release.yml ${ARTIFACT_WINDOWS} upload path must be SignPath output-artifact-directory '${signpathOutDir}'`,
        );
      }
    }
  }

  // Linux
  if (!/appimage/i.test(jobs.linux)) {
    errors.push("desktop-release.yml job 'linux' must build AppImage");
  }
  if (!/\bdeb\b/i.test(jobs.linux)) {
    errors.push("desktop-release.yml job 'linux' must build deb");
  }
  const linSteps = extractJobSteps(jobs.linux);
  let linBuild = -1;
  let linUpload = -1;
  for (let i = 0; i < linSteps.length; i++) {
    if (/appimage|\bdeb\b|tauri.*build/i.test(linSteps[i])) linBuild = i;
    if (
      /actions\/upload-artifact@/.test(linSteps[i]) &&
      linSteps[i].includes(ARTIFACT_LINUX)
    ) {
      linUpload = i;
    }
  }
  if (linUpload < 0) {
    errors.push(
      `desktop-release.yml job 'linux' must upload-artifact name ${ARTIFACT_LINUX}`,
    );
  } else if (linBuild >= 0 && linUpload < linBuild) {
    errors.push(
      `desktop-release.yml job 'linux' must upload ${ARTIFACT_LINUX} after build`,
    );
  } else {
    const up = linSteps[linUpload];
    if (
      !/\.AppImage\b/.test(up) ||
      !/\.deb\b/.test(up) ||
      /^\s*path:\s*[^|\n]*\/$/m.test(up) ||
      /appimage\/\*(?!\.AppImage)/i.test(up) ||
      /deb\/\*(?!\.deb)/i.test(up)
    ) {
      errors.push(
        "desktop-release.yml Linux artifact upload must include only final installers (*.AppImage and *.deb), not AppDir/build-tree contents",
      );
    }
  }

  // Release job lineage
  const rel = jobs.release;
  const needsLine = rel.match(/^\s*needs:\s*\[([^\]]+)\]/m);
  const needsBlock = rel.match(/^\s*needs:\s*\n((?:[ \t]+-[ \t]*.+\n?)+)/m);
  /** @type {Set<string>} */
  const needNames = new Set();
  if (needsLine) {
    for (const p of needsLine[1].split(",")) {
      needNames.add(p.trim().replace(/['"]/g, ""));
    }
  } else if (needsBlock) {
    for (const line of needsBlock[1].split("\n")) {
      const m = line.match(/^\s*-\s*([A-Za-z_][\w-]*)/);
      if (m) needNames.add(m[1]);
    }
  } else {
    errors.push(
      "desktop-release.yml job 'release' must declare needs exactly [macos, linux] while Windows is disabled",
    );
  }
  const expectedNeeds = new Set(["macos", "linux"]);
  if (
    needNames.size !== expectedNeeds.size ||
    [...expectedNeeds].some((name) => !needNames.has(name))
  ) {
    errors.push(
      "desktop-release.yml job 'release' must declare needs exactly [macos, linux] while Windows is disabled",
    );
  }

  const relSteps = extractJobSteps(rel);
  const activeReleaseArtifacts = [ARTIFACT_MACOS, ARTIFACT_LINUX];
  const downloads = new Set();
  let stageIdx = -1;
  let shaIdx = -1;
  let pubIdx = -1;
  const oneLevelGlobRe = new RegExp(
    `(${ARTIFACT_MACOS}|${ARTIFACT_WINDOWS}|${ARTIFACT_LINUX})/\\*`,
  );

  for (let i = 0; i < relSteps.length; i++) {
    const s = relSteps[i];
    if (/actions\/download-artifact@/.test(s)) {
      for (const name of activeReleaseArtifacts) {
        if (s.includes(name)) downloads.add(name);
      }
    }
    // Recursive flatten staging: installer whitelist + release-assets + both roots + collision.
    if (
      /\bfind\b/.test(s) &&
      /-type\s+f/.test(s) &&
      /release-assets/.test(s) &&
      activeReleaseArtifacts.every((name) => s.includes(name)) &&
      /\.dmg\b/.test(s) &&
      /\.AppImage\b/.test(s) &&
      /\.deb\b/.test(s) &&
      /\bcase\b/.test(s) &&
      /\bcontinue\b/.test(s) &&
      (/collision/i.test(s) ||
        /already staged/i.test(s) ||
        /\[\[\s*-e\s+/.test(s) ||
        /\[\s+-e\s+/.test(s) ||
        /test\s+!-e|test\s+! -e|\[\[ ! -e/.test(s) ||
        /-e\s+"\$\{?dest/.test(s))
    ) {
      stageIdx = i;
    }
    if (isRealSha256Command(s) && /SHA256SUMS/.test(s)) {
      shaIdx = i;
    }
    if (/gh\s+release\s+create/i.test(s)) pubIdx = i;
  }
  for (const name of activeReleaseArtifacts) {
    if (!downloads.has(name)) {
      errors.push(
        `desktop-release.yml job 'release' must download-artifact ${name} before checksum`,
      );
    }
  }
  if (rel.includes(ARTIFACT_WINDOWS)) {
    errors.push(
      `desktop-release.yml job 'release' must not download, stage, checksum, or publish disabled Windows artifact ${ARTIFACT_WINDOWS}`,
    );
  }
  const lastDl = Math.max(
    -1,
    ...relSteps.map((s, i) =>
      /actions\/download-artifact@/.test(s) ? i : -1,
    ),
  );

  // Reject unsafe one-level platform globs on checksum/publish (dirs break Linux nested trees).
  for (let i = 0; i < relSteps.length; i++) {
    const s = relSteps[i];
    if (
      (isRealSha256Command(s) || /gh\s+release\s+create/i.test(s)) &&
      oneLevelGlobRe.test(s)
    ) {
      errors.push(
        "desktop-release.yml must not use one-level artifact globs (e.g. opsmate-linux-release/*) for checksum/publish; stage recursive regular files first",
      );
    }
  }

  if (stageIdx < 0) {
    errors.push(
      "desktop-release.yml release staging must whitelist final installer extensions (.dmg, .AppImage, .deb) while staging recursive regular files from both active artifact roots with collision detection",
    );
  } else if (lastDl >= 0 && stageIdx < lastDl) {
    errors.push(
      "desktop-release.yml job 'release' must download all artifacts before recursive staging",
    );
  }

  if (shaIdx < 0) {
    errors.push(
      "desktop-release.yml job 'release' must run a real SHA-256 command (sha256sum|shasum -a 256|Get-FileHash SHA256) writing SHA256SUMS over staged release-assets files",
    );
  } else {
    const shaStep = relSteps[shaIdx];
    if (stageIdx >= 0 && shaIdx < stageIdx) {
      errors.push(
        "desktop-release.yml job 'release' must stage release-assets before SHA256SUMS",
      );
    }
    if (!/release-assets/.test(shaStep)) {
      errors.push(
        "desktop-release.yml SHA256SUMS step must hash files under release-assets (not one-level platform globs)",
      );
    }
    if (!/>\s*SHA256SUMS|Out-File\s+.*SHA256SUMS|Set-Content\s+.*SHA256SUMS|Tee-Object\s+.*SHA256SUMS/i.test(
      shaStep,
    )) {
      errors.push(
        "desktop-release.yml SHA step must write output to SHA256SUMS",
      );
    }
  }
  if (pubIdx < 0) {
    errors.push(
      "desktop-release.yml job 'release' must publish with gh release create after checksum",
    );
  } else if (shaIdx >= 0 && pubIdx < shaIdx) {
    errors.push(
      "desktop-release.yml job 'release' must compute SHA256SUMS before gh release create",
    );
  } else if (pubIdx >= 0) {
    const pub = relSteps[pubIdx];
    const afterCreate = pub.slice(pub.search(/gh\s+release\s+create/i));
    // Must publish staged files: release-assets path on create cmdline and/or ${files[@]} fed by find release-assets.
    const publishesStaged =
      (/files\[@\]/.test(afterCreate) && /find\s+release-assets/.test(pub)) ||
      /release-assets\//.test(afterCreate) ||
      /release-assets\/\*/.test(afterCreate);
    if (!publishesStaged) {
      errors.push(
        "desktop-release.yml gh release create must publish staged release-assets regular files (not platform directory globs)",
      );
    }
    if (!/\bSHA256SUMS\b/.test(afterCreate)) {
      errors.push(
        "desktop-release.yml gh release create must include SHA256SUMS",
      );
    }
    // Checksum-only release (SHA256SUMS without staged assets) is forbidden.
    if (
      /\bSHA256SUMS\b/.test(afterCreate) &&
      !publishesStaged
    ) {
      errors.push(
        "desktop-release.yml gh release create must not be checksum-only; include staged release assets",
      );
    }
    if (oneLevelGlobRe.test(afterCreate)) {
      errors.push(
        "desktop-release.yml gh release create must not use one-level platform artifact globs",
      );
    }
    if (!/Windows is not included/i.test(pub)) {
      errors.push(
        "desktop-release.yml gh release create notes must state that Windows is not included",
      );
    }
  }
  if (/unsigned/i.test(rel)) {
    errors.push(
      "desktop-release.yml job 'release' must not reference unsigned artifacts",
    );
  }

  if (/REPLACE_ME|YOUR_SECRET|changeme/i.test(text)) {
    errors.push(
      "desktop-release.yml must not embed placeholder secret literals",
    );
  }

  return errors;
}

/**
 * File-backed desktop-release.yml gate.
 * @returns {string[]}
 */
export function checkDesktopReleaseWorkflow() {
  if (!existsSync(DESKTOP_RELEASE_PATH)) {
    return [
      "missing .github/workflows/desktop-release.yml (Task 8 signed release workflow)",
    ];
  }
  return checkDesktopReleaseWorkflowContent(
    readFileSync(DESKTOP_RELEASE_PATH, "utf8"),
  );
}

/**
 * Pure content validator for SignPath release-signing policy YAML.
 * @param {string} yml
 * @returns {string[]}
 */
export function checkSignPathReleasePolicyContent(yml) {
  const errors = [];
  const text = yml.replace(/\r\n/g, "\n");

  if (!/desktop-v\*/.test(text)) {
    errors.push(
      "SignPath policy must record allowed trigger tag pattern desktop-v*",
    );
  }
  if (
    !new RegExp(
      `(^|[\\s:'"])${REQUIRED_RELEASE_ENVIRONMENT}([\\s:'"]|$)`,
    ).test(text)
  ) {
    errors.push(
      `SignPath policy must reference protected environment ${REQUIRED_RELEASE_ENVIRONMENT}`,
    );
  }
  if (!/\bNSIS\b|\bnsis\b/.test(text)) {
    errors.push("SignPath policy must scope Windows NSIS artifacts");
  }
  for (const sec of REQUIRED_SIGNPATH_SECRET_NAMES) {
    if (!bodyRefsSecret(text, sec)) {
      errors.push(
        `SignPath policy must reference secrets.${sec}`,
      );
    }
  }
  if (!/Authenticode/i.test(text) || !/\bValid\b/.test(text)) {
    errors.push(
      "SignPath policy must require Authenticode Valid verification",
    );
  }
  if (!/fail_closed\s*:\s*true/i.test(text)) {
    errors.push("SignPath policy must set fail_closed: true");
  }
  if (/continue-on-error\s*:\s*true/i.test(text)) {
    errors.push("SignPath policy must not allow continue-on-error: true");
  }
  return errors;
}

/**
 * File-backed SignPath policy gate.
 * @returns {string[]}
 */
export function checkSignPathReleasePolicy() {
  if (!existsSync(SIGNPATH_POLICY_PATH)) {
    return [
      "missing .signpath/policies/opsmate-desktop/release-signing.yml (Task 8 SignPath policy)",
    ];
  }
  return checkSignPathReleasePolicyContent(
    readFileSync(SIGNPATH_POLICY_PATH, "utf8"),
  );
}

/**
 * Combined Task 8 release gates (workflow + policy).
 * Not folded into checkReleaseConfig() so Task 5/6 GREEN stays independent.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkDesktopSignedReleaseConfig() {
  const errors = [
    ...checkDesktopReleaseWorkflow(),
    ...checkSignPathReleasePolicy(),
  ];
  return { ok: errors.length === 0, errors };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const result = checkReleaseConfig();
  const release = checkDesktopSignedReleaseConfig();
  const allErrors = [...result.errors, ...release.errors];
  if (allErrors.length > 0) {
    console.error("check-release-config FAILED:");
    for (const e of allErrors) console.error(" -", e);
    process.exit(1);
  }
  console.log("check-release-config OK");
  process.exit(0);
}
