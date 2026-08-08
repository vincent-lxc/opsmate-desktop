# Self-Contained Desktop Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore `opsmate-desktop` as an independently versioned, built, signed, and released product with no runtime or CI dependency on `vincent-lxc/opsmate`.

**Architecture:** Keep the existing root React and Tauri sources as the only release inputs. Remove the later canonical-source lock, private cross-repository checkout, and token contract while preserving the existing macOS signing/notarization gates, Linux artifacts, Windows disablement, security validators, and artifact whitelist.

**Tech Stack:** React, TypeScript, Vitest, Tauri, Rust, GitHub Actions.

---

### Task 1: Lock the repository boundary

- [x] Add a regression test rejecting `OPSMATE_SOURCE_TOKEN`, `release/source-lock.json`, `source/apps/`, and `vincent-lxc/opsmate` checkout references.
- [x] Verify the test fails against the cross-repository workflows.

### Task 2: Restore self-contained build and release

- [x] Reverse only commits `d8179d8`, `fba2368`, `2c79973`, `d1dfd72`, and `862bf5d`.
- [x] Preserve all product commits through `27b0186` and all local untracked audit artifacts.
- [x] Verify the new boundary test, full npm suite, and contracts check.

### Task 3: Release safely

- [ ] Push the repair commit.
- [ ] Create a new immutable tag `desktop-v0.1.5`; never move failed tag `desktop-v0.1.4`.
- [ ] Approve macOS and final release gates only after preceding jobs pass.
