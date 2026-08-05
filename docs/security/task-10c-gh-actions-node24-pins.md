# Task 10C/10D — GitHub Actions Node 24 / full-SHA supply-chain pins

**Dispatch 10C:** task_010f6ae55783 / ctx_0cae65b3c186  
**Dispatch 10D:** task_9f323517a253 / ctx_c10d2844d9a7  
**Date:** 2026-08-06  
**Edits:** apply_patch / structured Write only (no Python, no shell redirects)

## Prior annotation (evidence)

| Field | Value |
|-------|--------|
| CI run | **31024328981** (green so far) |
| Annotation | `actions/cache@v4`, `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4` target **deprecated Node 20** and are forced to Node 24 |
| Pre-fix CI | Floating `@v4` on `desktop-ci.yml`; older full SHAs on `desktop-release.yml` |
| 10C gap (review) | `actions/download-artifact@d3f86a…` left outside the gate though tag release **does** exercise it |

## Official download-artifact evidence (Task 10D)

| Field | Value |
|-------|--------|
| Latest release (coordinator check 2026-08-06 Asia/Shanghai) | **v8.0.1** |
| Exact tag commit | **`3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`** |
| `action.yml` | `using: node24` |

## RED → GREEN

### RED (10C)

Floating `@v4` / old SHAs failed the pin test.

### RED (10D)

With download-artifact in the pin map, `checkWorkflowGhActionPins` reported  
`must pin actions/download-artifact@3e5f45b2… (got d3f86a106a0bac45b974a628896c90dbdf5c8093)` ×3 on release.

### GREEN map

| Action | Major / tag | SHA | Presence |
|--------|-------------|-----|----------|
| `actions/checkout` | v7 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | CI + release |
| `actions/setup-node` | v7 | `820762786026740c76f36085b0efc47a31fe5020` | CI + release |
| `actions/cache` | v6 | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` | CI + release |
| `actions/upload-artifact` | v7 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | CI + release |
| `actions/download-artifact` | **v8.0.1** / node24 | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` | **release required**; any occurrence anywhere must match SHA |

Checker: `REQUIRED_GH_ACTION_SHA_PINS` + `REQUIRED_GH_ACTION_SET_CI` / `REQUIRED_GH_ACTION_SET_RELEASE` + simplified `checkWorkflowGhActionPins` (no duplicated special-case loops).

**Preserved:** `node-version: "22.22.0"` setup-node input (app engines / react-router 8.3).

## Commands / results (10D re-verify)

| Gate | Result |
|------|--------|
| Targeted security tests | see worker_done |
| Full `npm test` | see worker_done |
| `node scripts/check-release-config.mjs` | OK after pin |
| Docker `rhysd/actionlint:1.7.12` both workflows | exit 0 |
| `contracts:check` / `build:web` / `git diff --check` | clean |

## Non-claims

- Not a claim that **third-party** actions (SignPath, dtolnay/rust-toolchain, etc.) are fully re-audited for Node 24.
- Not a claim of zero Dependabot findings or merged Dependabot PRs.
- Not a production release / SignPath dry-run.
- Not an application runtime change (still Node **22.22.0** for npm).
