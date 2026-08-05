/**
 * Task 5 — three-platform release config security tests.
 * Bundle targets, identifier, deep-link scheme, required icon formats,
 * and rejection of single-color / placeholder PNGs.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  checkReleaseConfig,
  decodePngRgba,
  isPlaceholderPng,
  REQUIRED_CSP,
  REQUIRED_ICON_PNG_DIMS,
  REQUIRED_ICON_REL,
  REQUIRED_IDENTIFIER,
  REQUIRED_SCHEMES,
  REQUIRED_TARGETS,
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
});

