# Task 6 Evidence — Three-platform branch CI

**Date:** 2026-08-05
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`
**Branch:** `feat/secure-desktop-foundation`
**Dispatch (gate strictness):** `task_3efe60e444a3` / `ctx_7098af1f298a`
**Worker:** no commit / no push

## Live run reference

**Actions run:** https://github.com/vincent-lxc/opsmate-desktop/actions/runs/31002584367

| Job | Failure | Fix |
|-----|---------|-----|
| Windows `92294761004` | contracts CRLF drift | minimal `.gitattributes` LF rules |
| macOS `92294760960` | missing `../dist` for clippy | `npm run build:web` before cargo |
| All | unexpected `with.toolchain` | no toolchain key under pinned SHA action |

## Minimal `.gitattributes` (exact — no comments, no extra rules)

```
src-tauri/src/cloud_transport/operations.rs text eol=lf
contracts/openapi-v1.yaml text eol=lf
src/cloud/generated-operations.ts text eol=lf
```

`checkGitAttributesLfContent` requires this exact non-comment rule set (order fixed); rejects missing, changed, duplicated, or extra rules. Pure-string negative tests cover drift without mutating the repo.

## Rust action

```yaml
uses: dtolnay/rust-toolchain@87eb139fed4b08a67bd1fa429a21d1f5d523e03e
with:
  components: rustfmt, clippy
  targets: … # macOS only
# forbids ANY with.toolchain key (stable / 1.92.0 / anything)
```

`checkRustToolchainActionWithBlock` pure validator + negative tests.

## Commands

| Command | Result |
|---------|--------|
| `npm test -- tests/security/release-config.test.ts` | **6 passed** |
| `node scripts/check-release-config.mjs` | **OK** |
| `npm test` | **49 passed** |
| `npm run contracts:check` | **ok** |
| `npm run build:web` | **ok** |
| `git diff --check` | **clean** |

## Explicit non-claims

- No commit / push
- No claim that Actions run 31002584367 is green after this patch

## Files

- `.gitattributes`
- `.github/workflows/desktop-ci.yml`
- `scripts/check-release-config.mjs`
- `tests/security/release-config.test.ts`
- `docs/task-6-ci-evidence.md`
