# Task 9B — Node runtime alignment evidence

**Dispatch:** task_39bdad64accc / ctx_5064e5a0215b  
**Date:** 2026-08-05  
**Blocker fixed:** `react-router@8.3.0` requires `engines.node >=22.22.0`; CI/release had been on Node 20.

## Process disclosure (coordinator status)

| Item | Detail |
|------|--------|
| Exact file altered by **Python** | `docs/security/public-release-dependency-audit.md` (runtime section + pin-table Node row) |
| Exact file altered by **shell redirect** (`cat >`) | `docs/security/task-9b-node-runtime-evidence.md` (this evidence artifact) |
| Subsequent correction | Both files re-materialized via apply_patch/Write tool only; content verified read-only first (UTF-8 LF, no corruption) |
| Other edits this task | `tests/security/*.ts` used StrReplace (apply_patch path); workflows/package engines already present |

## Changes

| Surface | Value |
|---------|--------|
| `package.json` engines.node | `>=22.22.0` |
| `package-lock.json` root engines | `>=22.22.0` (regenerated `--registry https://registry.npmjs.org/`) |
| `desktop-ci.yml` setup-node | exact `node-version: "22.22.0"` (1 job matrix) |
| `desktop-release.yml` setup-node | exact `node-version: "22.22.0"` ×3 (macos/windows/linux) |
| setup-node action pins | **kept** (CI `@v4`; release SHA `49933ea…`) |
| `REQUIRED_NODE_VERSION` | `22.22.0` in `scripts/check-release-config.mjs` |
| Checker | rejects Node 20 and non-exact pins on both workflows |
| Tests | dependency-audit + release-config reject Node 20 / missing engines / wrong pin |
| Audit doc | `## Runtime alignment (Node / CI)` + pin table row |

## rg proof (no node-version 20 in workflows)

```text
.github/workflows/desktop-ci.yml:45:          node-version: "22.22.0"
.github/workflows/desktop-release.yml:44:          node-version: "22.22.0"
.github/workflows/desktop-release.yml:146:          node-version: "22.22.0"
.github/workflows/desktop-release.yml:264:          node-version: "22.22.0"
```

`rg` for `node-version` 20 under `.github/workflows/desktop-ci.yml` and `desktop-release.yml` → no matches.

## Verification (this dispatch)

| Gate | Result |
|------|--------|
| Targeted security tests | 35/35 pass |
| Full `npm test` | **78/78** pass |
| `npm audit --omit=dev --audit-level=high --registry https://registry.npmjs.org/` | 0 vulnerabilities |
| `npm run contracts:check` | ok |
| `npm run build:web` | ok |
| `node scripts/check-release-config.mjs` | OK |
| Docker `rhysd/actionlint:1.7.12` both workflows | exit 0 |
| `cargo fmt --check` / `clippy -D warnings` / `test` (Cargo.toml+lock dirty) | **322 passed, 0 failed, 1 ignored** |
| `git diff --check` | clean |

## Residual honesty (unchanged from Task 9A)

- OSV Cargo residuals remain (quick-xml 0.38.4 via plist, GTK, etc.) — not claimed clean.
- Gitleaks fixture private keys classified as test-only.
- No commit/push performed.
