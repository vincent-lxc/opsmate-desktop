# Desktop Web UI secure runtime — local macOS UAT (unsigned candidate)

**Date:** 2026-08-08  
**Status:** Local candidate only — **not** signed, notarized, or release-ready.

## Commits

| Tree | SHA | Notes |
|---|---|---|
| Product (`ops-ai` / `cloud/develop`) | `378c1b0f92ae567fc1b341d9fc737f96682621d4` | Candidate after clippy gate fix (`9cc4612` was pre-clippy-fix) |
| Release (`opsmate-desktop` / `ci/release-explicit-repo`) | `d1dfd72` | `chore(release): lock desktop candidate source` → product SHA above |
| `release/source-lock.json` | `repository=vincent-lxc/opsmate` `commit=378c1b0f92ae567fc1b341d9fc737f96682621d4` | Exact 40-char lock |

Product tree still preserves unstaged user `README.md`. Release tree leaves untracked `.superpowers/` and `docs/superpowers/audits/` unstaged.

## Product gates (Rust **1.92.0**)

Commands (cwd product worktree):

```bash
rustup run 1.92.0 rustc --version   # rustc 1.92.0 (ded5c06cf 2025-12-08)
npm --prefix apps/admin test
npm --prefix apps/admin run build
rustup run 1.92.0 cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
rustup run 1.92.0 cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
rustup run 1.92.0 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets
```

| Gate | Result | Evidence |
|---|---|---|
| Admin tests | **PASS(local)** | 44 files, **262** tests passed |
| Admin build | **PASS(local)** | `tsc && vite build` OK; dist under `apps/admin/dist` |
| cargo fmt --check | **PASS(local)** | exit 0 after fmt of clippy-fix commit |
| cargo clippy -D warnings | **PASS(local)** | exit 0 after `fix(desktop): satisfy clippy -D warnings for candidate gates` |
| cargo test --all-targets | **PASS(local)** | lib **265** passed / 1 ignored; capabilities **4**; conf_paths **7** |

### Clippy gate failure (real) and fix

Initial clippy with `-D warnings` failed on inherited dead_code / style lints. Separate product commit `378c1b0` fixed:

- removed unnecessary `unsafe` (upload)
- type alias for IPC `on_ended` callback
- intentional `#[allow]` for too-many-arguments / large_enum_variant
- `#![allow(dead_code)]` for retained IPC/test hooks
- `OpGuard` visibility + Argon2 test config field init
- conf_paths `map_identity` cleanup

Release source-lock was re-pointed to `378c1b0…` after that fix.

## Release repo gates

```bash
npm test
npm run contracts:check
```

| Gate | Result | Evidence |
|---|---|---|
| npm test | **PASS(local)** | 9 files, **93** tests |
| contracts:check | **PASS(local)** | operations / openapi / generated-operations match |

## Local macOS build (unsigned)

```bash
cd apps/desktop
rustup run 1.92.0 rustc --version
rustup run 1.92.0 npm run tauri -- build --target aarch64-apple-darwin --bundles app,dmg
```

`tauri.conf.json`: `frontendDist: ../../admin/dist`, `withGlobalTauri: false`, `connect-src 'self'`.  
`beforeBuildCommand` rebuilds production Admin dist. Identity is **adhoc / linker-signed** (not Developer ID).

| Artifact | Path |
|---|---|
| App | `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/OpsMate.app` |
| DMG | `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/OpsMate_0.1.0_aarch64.dmg` (~8.7 MB) |

### Bundle / Web UI verification (executed)

| Check | Result | Observation |
|---|---|---|
| App + DMG exist | **PASS(local)** | Paths above |
| Identity not release-signed | **PASS(local)** | `Signature=adhoc`, `TeamIdentifier=not set`, flags `adhoc,linker-signed` |
| frontendDist config | **PASS(local)** | `../../admin/dist` |
| Embedded Admin assets | **PASS(local)** | Binary strings include `/assets/ServerManagement-…js`, `ServerDetail-…js`, `Account-…js` |
| Four shell placeholders absent | **PASS(local)** | strings scan: none of the four placeholder phrases |
| Interactive GUI launch | **NOT RUN** | Headless agent environment; no interactive launch |

## Ten-gate interactive production UAT (design)

All rows remain **NOT RUN** until signed-DMG interactive UAT (Task 14):

| # | Gate | Status |
|---|---|---|
| 1 | Fresh install | NOT RUN |
| 2 | Logto login | NOT RUN |
| 3 | Tenant-isolated servers | NOT RUN |
| 4 | Web UI pages (servers/monitoring/credentials/account) | NOT RUN (assets present only) |
| 5 | Stronghold import | NOT RUN |
| 6 | Real SSH I/O / resize / close | NOT RUN |
| 7 | AI automatic command loop | NOT RUN |
| 8 | Sleep/lock cutoff | NOT RUN |
| 9 | Subscription / Telegram state | NOT RUN |
| 10 | No JWT in WebView storage | NOT RUN |

## Signing / notarization / Gatekeeper

| Check | Status |
|---|---|
| Developer ID import | NOT RUN |
| notarytool submit / wait | NOT RUN |
| staple | NOT RUN |
| codesign (release identity) | NOT RUN |
| spctl Gatekeeper assess | NOT RUN |
| stapler validate | NOT RUN |
| Public tag / website promotion | NOT RUN |

## Go / No-Go

**No-Go for public release.** Local unsigned candidate + automated gates only. Task 14 required for signed UAT and website promotion.
