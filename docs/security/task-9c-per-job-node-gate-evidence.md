# Task 9C — per-job Node pin gate (false-negative fix)

**Dispatch:** task_a4b9b0575f2c / ctx_235bf843130e  
**Date:** 2026-08-05

## Process disclosure

| Item | Detail |
|------|--------|
| Prior dispatch violation | Python wrote `docs/security/public-release-dependency-audit.md` contrary to apply_patch-only instruction |
| This dispatch | **apply_patch / Write tool only** — no Python, no shell redirects for file content |

## Bug

`checkDesktopReleaseWorkflowContent` previously validated a **global** `nodePins.length >= 1` scan. A workflow missing `setup-node` / `node-version` on **macos** (or any single build job) could still pass when windows/linux retained exact `22.22.0`.

Smoke proof after fix (strip only first pin from real `desktop-release.yml`):

- pins remaining: 2  
- `would_pass_old_global`: **true**  
- new error: `job 'macos' must set setup-node node-version to exact 22.22.0`

## Fix

- Added exported `checkBuildJobNodeVersion(jobBody, jobName)`  
- After `extractWorkflowJobs`, require **each** of `macos` / `windows` / `linux` to have `actions/setup-node` with exact `REQUIRED_NODE_VERSION` (`22.22.0`)  
- Rejects: missing pin, Node 20, wrong pin, **conflicting duplicate** pins in one job  
- `release` job is not required to use Node  

## Tests added

- Delete only macos pin (windows/linux correct) → fails macos  
- Delete only windows pin (macos/linux correct) → fails windows  
- Insert wrong duplicate pin on macos while others correct → conflicting / Node 20  
- Real workflow still expects **exactly three** `node-version: "22.22.0"` pins  

## Verification

| Gate | Result |
|------|--------|
| Targeted release + dependency tests | 37 pass |
| Full `npm test` | **80/80** |
| `node scripts/check-release-config.mjs` | OK |
| `contracts:check` | ok |
| `build:web` | ok |
| Docker actionlint 1.7.12 both workflows | exit 0 |
| `git diff --check` | clean |
| Cargo | **not rerun** (no Cargo edits) |
