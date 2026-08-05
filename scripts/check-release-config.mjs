/**
 * Task 5/6 — three-platform release config + branch CI gate (no extra deps).
 * Validates tauri.conf.json, icons, and .github/workflows/desktop-ci.yml.
 * Exit 0 only when all checks pass. Importable from vitest.
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

/** Required GitHub-hosted runners (exact). */
export const REQUIRED_CI_RUNNERS = ["macos-14", "windows-2025", "ubuntu-24.04"];
export const REQUIRED_RUST_VERSION = "1.92.0";
export const REQUIRED_ARTIFACT_TOKEN = "internal-unsigned";

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
  // Core npm/cargo gates
  for (const needle of [
    "npm ci",
    "npm test",
    "contracts:check",
    "cargo fmt",
    "clippy",
    "cargo test",
  ]) {
    if (!yml.includes(needle)) {
      errors.push(`desktop-ci.yml must run ${needle}`);
    }
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
  // Pinned major actions
  for (const action of [
    "actions/checkout@v4",
    "actions/setup-node@v4",
    "actions/cache@v4",
    "actions/upload-artifact@v4",
  ]) {
    if (!yml.includes(action)) {
      errors.push(`desktop-ci.yml must pin action ${action}`);
    }
  }
  // Real npm cache via setup-node (not a no-op)
  if (!/cache:\s*npm/.test(yml)) {
    errors.push(
      "desktop-ci.yml setup-node must enable cache: npm (real dependency cache)",
    );
  }
  // Cargo cache
  if (!yml.includes("actions/cache@v4") || !yml.toLowerCase().includes("cargo")) {
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
  return errors;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const result = checkReleaseConfig();
  if (!result.ok) {
    console.error("check-release-config FAILED:");
    for (const e of result.errors) console.error(" -", e);
    process.exit(1);
  }
  console.log("check-release-config OK");
  process.exit(0);
}
