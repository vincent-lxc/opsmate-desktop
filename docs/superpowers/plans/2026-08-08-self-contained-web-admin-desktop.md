# Self-Contained Web Admin Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish the reviewed OpsMate Web Admin Desktop from source owned by `opsmate-desktop`, without runtime CI checkout of another repository and without the legacy placeholder UI entering artifacts.

**Architecture:** Vendor the reviewed `apps/admin` and `apps/desktop` trees from product commit `378c1b0f92ae567fc1b341d9fc737f96682621d4` into this repository. Root commands and GitHub workflows build only those vendored paths; the old root `src` and `src-tauri` remain historical and are never release inputs.

**Tech Stack:** React 19, TypeScript, Ant Design, Tauri 2.11, Rust 1.92, Vitest, GitHub Actions.

---

### Task 1: Lock release lineage

- [x] Add a failing regression test requiring repository-owned `apps/admin` and `apps/desktop` sources.
- [x] Reject placeholder text and root Tauri build paths.

### Task 2: Migrate reviewed sources

- [x] Copy tracked Admin and Desktop source from verified product commit `378c1b0f92ae567fc1b341d9fc737f96682621d4`.
- [x] Copy `scripts/desktop-build-admin-dist.sh` so Tauri builds the local Admin dist.
- [x] Point root commands, CI, Cargo gates, Tauri builds, and artifact paths at local `apps/*`.

### Task 3: Verify and release

- [x] Run root security tests and contracts check.
- [x] Run Admin tests and production build.
- [x] Run Rust fmt, strict clippy, and all tests.
- [ ] Publish a new immutable `desktop-v0.1.6` tag only after all gates pass.
- [ ] Install the signed DMG and prove the placeholder UI is absent.
