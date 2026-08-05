# Task 5 Evidence — Cross-platform bundle configuration

**Date:** 2026-08-05  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Branch:** `feat/secure-desktop-foundation`  
**Dispatch (icon rework):** `task_5d106c05bdc5` / `ctx_2e48c7dbc5a7`  
**Prior Task 5:** `task_518f13f636c3` / `ctx_3c949320dbd0`  
**Worker:** no commit / no push  

## Review repair — official brand icons

**Rejected:** First Task 5 GREEN used a **solid red** `icon.png` placeholder (and derivatives).  
**Repair:** Regenerated all required icons from the official OpsMate brand mark:

```text
Source (one-time generation only; not a build-time path):
  /Users/vincent/Documents/ClaudeCode/ops-ai/apps/www/assets/opsmate-logo.png
  (blue rounded square + white "M", 512×512 RGBA)

Desktop repo is self-contained after generation:
  src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png
  src-tauri/icons/icon.icns
  src-tauri/icons/icon.ico
```

No runtime or CI dependency on the ops-ai tree.

### Placeholder gate (no new deps)

`scripts/check-release-config.mjs` now:

- Decodes PNG RGBA (stdlib `zlib` + filter reconstruction)
- Enforces exact dimensions: 32 / 128 / 256 / 512
- Rejects PNGs with fewer than **8** distinct quantized opaque colors (`isPlaceholderPng`)
- Accepts branded multi-color icons

Tests cover solid-red synthetic PNG → reject; on-disk brand icons → accept.

## Config (unchanged this rework)

| Field | Value |
|-------|--------|
| `bundle.targets` | `["dmg", "nsis", "appimage", "deb"]` |
| `identifier` | `sh.itops.opsmate` |
| deep-link schemes | `["opsmate"]` |
| CSP | unchanged |
| capabilities | `core:default` only |

## Commands

| Command | Result |
|---------|--------|
| `npm test -- tests/security/release-config.test.ts` | **3 passed** (after brand regen + gate) |
| `node scripts/check-release-config.mjs` | **OK** |
| `npm run build:web` | **ok** |
| `git diff --check` | **clean** |

## Explicit non-claims

- No commit / push  
- No new dependencies  
- No schema / Compose / deploy/gcp changes  
- No full `tauri build` / signing  
- Brand source used only offline to regenerate assets  

## Files (this rework)

- Regenerated: `src-tauri/icons/*`  
- Modified: `scripts/check-release-config.mjs`, `tests/security/release-config.test.ts`, `docs/task-5-bundle-evidence.md`  
