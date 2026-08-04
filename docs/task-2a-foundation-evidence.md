# Task 2A Foundation Evidence

**Date:** 2026-08-04  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Remote:** `https://github.com/vincent-lxc/opsmate-desktop` — **PRIVATE**  
**Branch:** `feat/secure-desktop-foundation` (no commits, nothing pushed)

## Scope correction (coordinator msg_7fe22f7ac455)

User clarified Terminal/AI is **contextual under My Servers**, not top-level.

**Top-level nav (exactly four):**

| Label | Path |
|-------|------|
| 监控中心 | `/monitoring` |
| 我的服务器 | `/servers` |
| 凭证 | `/credentials` |
| 我的账户 | `/account` |

**Removed from top-level:** `/terminal`, label `终端/AI`, `src/terminal/TerminalPage.tsx`

**Reserved contract:** `/servers/:serverId` via `ServerDetailPlaceholder` + `server-detail-contract.ts` (placeholder only; full terminal/AI later).

**Post-correction GREEN:** `npm test` 12/12, `npm run build:web` exit 0, cargo 4/4.

## Preconditions

| Check | Result |
|-------|--------|
| Local `/Users/vincent/Documents/ClaudeCode/opsmate-desktop` | Did not exist → created via `gh repo create --clone` |
| Remote `vincent-lxc/opsmate-desktop` | Did not exist → created PRIVATE |
| `ops-ai` and other repos | Not modified by this task |

## RED (TDD)

**Setup:** stubs with empty `DESKTOP_NAV_ITEMS` and non-rendering `AppRoutes`.

```bash
cd /Users/vincent/Documents/ClaudeCode/opsmate-desktop
npm install --legacy-peer-deps --registry https://registry.npmjs.org/
npm test
```

**Observed RED:**

1. `navigation.test.ts` — `expected [] to deeply equal [监控中心, 我的服务器, 凭证, 终端/AI, 我的账户]`
2. `routes.test.tsx` suite initially failed resolving `@testing-library/dom` peer until pinned at `10.4.1` (then would fail heading assertions against stub)

## GREEN

```bash
npm test
# After Task 2C: Test Files 4 passed (4); Tests 12 passed (12)
# (navigation, App.nav, routes, server-detail-contract)

npm run build:web
# tsc --noEmit + vite build → exit 0; dist/ emitted

rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml
# 4 lib tests passed (foundation_crate_builds, frontend_dist_is_independent_dist,
# foundation_csp_is_self_only_connect, default_capability_has_no_shell_or_opener)
```

## Independence greps

```bash
git grep '../../admin/dist'   # no matches
git grep 'ops-ai/apps/admin'  # no matches
```

`src-tauri/tauri.conf.json`: `frontendDist: ../dist`, CSP `connect-src 'self'` only.

## Dependency pins (exact)

### npm (aligned with ops-ai admin/desktop installed versions)

| Package | Version |
|---------|---------|
| react / react-dom | 19.2.7 |
| react-router-dom | 7.18.2 |
| vite | 6.4.3 |
| vitest | 4.1.9 |
| typescript | 5.9.3 |
| @vitejs/plugin-react | 4.7.0 |
| @testing-library/react | 16.3.2 |
| @testing-library/jest-dom | 6.9.1 |
| @testing-library/dom | 10.4.1 |
| jsdom | 29.1.1 |
| @tauri-apps/api | 2.11.1 |
| @tauri-apps/cli | 2.11.4 |

### Rust (aligned with ops-ai apps/desktop Cargo.toml)

| Crate | Version |
|-------|---------|
| rust-version (MSRV) | 1.92 |
| tauri | =2.11.5 |
| tauri-build | =2.6.3 |
| serde | =1.0.219 |
| serde_json | =1.0.140 |

Foundation intentionally omits stronghold/opener/deep-link/russh (later tasks).  
WebView capability: `core:default` only — no shell/opener.

## Product routes implemented (after Task 2C nav scope correction)

**Top-level (exactly four):**

- `/monitoring` 监控中心
- `/servers` 我的服务器
- `/credentials` 凭证
- `/account` 我的账户

**Contextual (not top-level; placeholder only in foundation):**

- `/servers/:serverId` — reserved server detail; Terminal/AI entry later
- **No** top-level `/terminal`, **no** `src/terminal/TerminalPage.tsx`

Excluded: roles, users, system, AI Provider, Bot 配置.

## Files created (working tree, uncommitted)

```
.gitignore, LICENSE, NOTICE, README.md, SECURITY.md, THREAT_MODEL.md
index.html, package.json, package-lock.json, tsconfig.json, vite.config.ts
src/main.tsx, src/styles.css, src/test-setup.ts, src/vite-env.d.ts
src/app/{App.tsx,routes.tsx,navigation.ts}
src/app/__tests__/{routes.test.tsx,navigation.test.ts}
src/{monitoring,servers,credentials,account}/*Page.tsx
src/servers/{ServerDetailPlaceholder.tsx,server-detail-contract.ts}
(no top-level src/terminal — removed per scope correction)
src-tauri/{Cargo.toml,Cargo.lock,build.rs,tauri.conf.json}
src-tauri/src/{main.rs,lib.rs}
src-tauri/capabilities/default.json
src-tauri/icons/icon.png
docs/task-2a-foundation-evidence.md
```

## Remaining warnings / notes

1. **Install verification:** coordinator verified a clean `npm ci`; use `registry.npmjs.org` for `npm audit` because the configured npmmirror endpoint does not implement npm's audit API.
2. **Host default rustc is 1.84.1**; use `rustup run 1.92.0` for cargo (1.92.0 toolchain is installed).
3. **Worker made no commit / push** per task instruction; coordinator owns review and the first commit.
4. **No Admin source copied**; no cloud/auth/vault business logic yet.
5. Cargo resolved transitive crates within exact direct pins; newer transitive versions exist but were not forced via `latest` ranges.
6. **npm audit residual:** `react-router-dom` is pinned to `7.18.2`, the first version patched for the general `<Link>` / `useNavigate` open-redirect advisory. npm still reports `GHSA-qwww-vcr4-c8h2`; GitHub's reviewed advisory states it only affects unstable RSC APIs, which this Vite SPA/Tauri shell does not use. Re-evaluate when a non-RSC patched stable DOM release is available.

## Out of scope (later plan tasks)

Contracts, backend principal, Rust auth, cloud transport, vault/SSH, full monitoring pages, account/Telegram/subscription, CI security scanners, signing/UAT.
