# Task 6 Evidence — Three-platform branch CI

**Date:** 2026-08-05
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`
**Branch:** `feat/secure-desktop-foundation`
**Dispatch (clippy collapsible_if):** `task_7cd57de04a43` / `ctx_62dc20d3fcf0`
**Worker:** no commit / no push

## Live run — clippy collapsible_if (this dispatch)

**Actions run:** https://github.com/vincent-lxc/opsmate-desktop/actions/runs/31003338908

| Job | Failure | Fix |
|-----|---------|-----|
| Windows `92297227766` | rustc/clippy **1.92.0** `-D warnings`: `clippy::collapsible_if` at `src-tauri/src/vault_os_sleep/windows.rs` ~242 (`unexpected_exit && !stop` nested with `IsWindow`) | Semantics-preserving collapse into one `if unexpected_exit && !stop && IsWindow(...)`; then `if let Some(st)` seal. **No** `#[allow]`; clippy not weakened |

## Prior live run (still applied)

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

## Rust action

```yaml
uses: dtolnay/rust-toolchain@87eb139fed4b08a67bd1fa429a21d1f5d523e03e
with:
  components: rustfmt, clippy
  targets: … # macOS only
# forbids ANY with.toolchain key
```

## Commands (this dispatch)

| Command | Result |
|---------|--------|
| `cargo fmt` | ok |
| `cargo clippy --all-targets --all-features -- -D warnings` | **exit 0** |
| `cargo test --all-targets` | **318 passed**, 1 ignored |
| `npm test` | **49 passed** (8 files) |
| `node scripts/check-release-config.mjs` | **OK** |
| `npm run contracts:check` | **ok** |
| `npm run build:web` | **ok** |
| `git diff --check` | **clean** |

## Explicit non-claims

- No commit / push
- No MSVC local validation claim
- No claim that Actions run 31003338908 is green after this patch (re-run needed)

## Files (this dispatch)

- `src-tauri/src/vault_os_sleep/windows.rs`
- `docs/task-6-ci-evidence.md`
