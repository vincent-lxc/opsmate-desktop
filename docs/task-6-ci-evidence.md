# Task 6 Evidence — Three-platform branch CI

**Date:** 2026-08-05  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Branch:** `feat/secure-desktop-foundation`  
**Dispatch (SHA pin):** `task_b6c1d52219e0` / `ctx_203d09743d63`  
**Prior reworks:** `task_a33a9daaa9b0`, `task_ff79bab5077a`  
**Worker:** no commit / no push  

## Final pin: rust-toolchain is a **commit SHA**, not a tag

Independent proof that `dtolnay/rust-toolchain@1.92.0` is a **branch tip**, not an immutable tag:

```text
$ git ls-remote https://github.com/dtolnay/rust-toolchain.git 1.92.0
87eb139fed4b08a67bd1fa429a21d1f5d523e03e        refs/heads/1.92.0
```

**Workflow uses line (final):**

```yaml
# Pinned full commit SHA for refs/heads/1.92.0 (not a tag; not @master).
# Proof: git ls-remote … → 87eb139fed4b08a67bd1fa429a21d1f5d523e03e  refs/heads/1.92.0
uses: dtolnay/rust-toolchain@87eb139fed4b08a67bd1fa429a21d1f5d523e03e
with:
  toolchain: "1.92.0"
```

Gate rejects:

- `dtolnay/rust-toolchain@master`
- floating `dtolnay/rust-toolchain@1.92.0` branch ref  
Requires exact full SHA string above. `with.toolchain` remains **exactly** `1.92.0`.

## Prior reliability fixes (still required)

| Item | Value |
|------|--------|
| macOS build | `npm run tauri -- build --target universal-apple-darwin --bundles dmg` |
| Windows | `npm run tauri -- build --bundles nsis` |
| Linux | `npm run tauri -- build --bundles appimage,deb` |
| Artifacts | `if-no-files-found: error` on all three uploads |
| npm cache | `setup-node` `cache: npm` |
| Permissions | `contents: read` only; no secrets/signing/Release |

## Commands

| Command | Result |
|---------|--------|
| `npm test -- tests/security/release-config.test.ts` | **4 passed** |
| `node scripts/check-release-config.mjs` | **OK** |
| `npm test` | **47 passed** |
| `npm run contracts:check` | **ok** |
| `npm run build:web` | **ok** |
| `git diff --check` | **clean** |

## Explicit non-claims

- No commit / push  
- No live GitHub Actions run  
- No signing / public Release  

## Files (this dispatch)

- `.github/workflows/desktop-ci.yml`  
- `scripts/check-release-config.mjs`  
- `tests/security/release-config.test.ts`  
- `docs/task-6-ci-evidence.md`  
