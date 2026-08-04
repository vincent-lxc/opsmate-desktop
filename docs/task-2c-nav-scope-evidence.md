# Task 2C Navigation Scope Correction — Evidence

**Date:** 2026-08-04  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Dispatch:** `task_669ccee70096` / `ctx_3dcf3e3c0b9b`  
**Branch worktree ops-ai:** `feat/desktop-local-credentials` (design/plan docs only)

## Decision (user-approved)

Top-level navigation is **exactly four** items:

| Label | Path |
|-------|------|
| 监控中心 | `/monitoring` |
| 我的服务器 | `/servers` |
| 凭证 | `/credentials` |
| 我的账户 | `/account` |

Terminal/AI is **contextual only** under `/servers/:serverId` and is **not implemented** in this foundation (placeholder route + contract only).

**Forbidden:** standalone top-level `终端/AI`, `/terminal`, `TerminalPage`, top-level `src/terminal/`.

## Code audit result

| Check | Result |
|-------|--------|
| `src/app/navigation.ts` | Four items only; no terminal |
| `src/app/routes.tsx` | No `/terminal` Route; has `/servers/:serverId` placeholder |
| `src/terminal/` | **Absent** |
| `TerminalPage` | **Absent** |
| `ServerDetailPlaceholder` | Present; documents later terminal/AI context |
| `server-detail-contract.ts` | Reserves contextual features; route not `/terminal` |

## Docs sync

| Doc | Status |
|-----|--------|
| `opsmate-desktop/README.md` | Four top-level; contextual terminal under servers |
| `opsmate-desktop/THREAT_MODEL.md` | Four top-level; contextual under server detail |
| `opsmate-desktop/docs/task-2a-foundation-evidence.md` | Product routes list corrected (removed stale `/terminal`) |
| `ops-ai/.../2026-08-04-001-...-design.md` | Already four-item nav + forbid `/terminal` |
| `ops-ai/.../2026-08-04-002-...-implementation-plan.md` | Already four-item RED/GREEN contract |

## Commands (this dispatch)

```bash
cd /Users/vincent/Documents/ClaudeCode/opsmate-desktop
npm test
npm run build:web
rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml
```

Forbidden greps (expect no product hits under `src/`):

```bash
# no standalone TerminalPage
rg -n 'TerminalPage' src || true
# no top-level product path registration
rg -n 'path=["'\'']\/terminal["'\'']' src || true
# no monorepo coupling
rg -n 'admin/dist|ops-ai/apps/admin' . --glob '!node_modules/**' --glob '!dist/**' || true
```

## Result block (this dispatch)

| Command | Result |
|---------|--------|
| `npm test` | **12/12 passed** (4 files): navigation, App.nav, routes, server-detail-contract |
| `npm run build:web` | **exit 0** — `tsc --noEmit` + vite build; `dist/` emitted |
| `rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml` | **4/4 lib tests passed** |
| `TerminalPage` under `src/` | **none** |
| `path="/terminal"` under `src/` | **none** |
| `src/terminal/` | **absent** |
| `终端/AI` in `navigation.ts` | **none** |
| `admin/dist` / `ops-ai/apps/admin` in product code | **none** (only docs + cargo assert that forbid coupling) |

## Coordinator security review note

`react-router-dom` was raised from `6.30.4` to `7.18.2` because `7.18.0` is the first patched version for the general navigation open-redirect advisory. npm audit still flags `GHSA-qwww-vcr4-c8h2`; the reviewed GitHub advisory limits that issue to unstable RSC APIs. This desktop Vite SPA does not enable or call RSC APIs, so the finding is recorded as non-applicable to the current runtime rather than hidden. It must be rechecked on dependency updates.

**No commit / no push** (per task).
