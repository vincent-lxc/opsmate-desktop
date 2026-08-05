# Task 10A — Windows CI vault idle Instant overflow

**Dispatch:** task_0ee21212f8c1 / ctx_2839c7ac24cf  
**Date:** 2026-08-06  
**Edits:** apply_patch / structured Write only (no Python, no shell redirects)

## Prior CI failure (exact)

| Field | Value |
|-------|--------|
| GitHub Actions run | **31017613079** |
| Job | **92345694969** |
| Symptom | Eight `vault_lifecycle_coordinator` tests panic in `std` `time.rs` |
| Root cause | `Instant::now() - VAULT_IDLE_TIMEOUT` (15 minutes) on a **fresh Windows runner** whose monotonic clock uptime is shorter than the subtracted duration → overflow panic |
| Not acceptable “fixes” | saturating sub that makes due tests not due; sleeps; `cfg(windows)` skips; `#[ignore]`; lowered timeout; platform exclusions |

## RED → GREEN (TDD)

### RED intent

Regression `idle_due_evaluation_does_not_subtract_timeout_from_instant_now` requires:

1. `last_activity = Instant::now()` (no past Instant construction via timeout subtraction)  
2. `now = last_activity + VAULT_IDLE_TIMEOUT + 2s` (**addition** only)  
3. Pure `activity_is_idle_due(last, now)` and coordinator `on_idle_tick_at(now)` seal as idle_timeout  

Source ban: no non-comment line may contain the contiguous subtraction pattern.

### GREEN implementation (smallest seam)

| Piece | Visibility | Role |
|-------|------------|------|
| `vault::activity_is_idle_due(last, now)` | **`pub(crate)`** (not public API) | Pure `checked_duration_since` compare to `VAULT_IDLE_TIMEOUT` |
| `VaultService::idle_timeout_due_at` | **private** | Explicit-time idle probe used by public `idle_timeout_due` |
| `VaultService::seal_if_still_idle_with_pre_seal_at` | **`pub(crate)`** (not public API) | Explicit-time seal used by public production wrapper + tests |
| Production wrappers (`idle_timeout_due`, `seal_if_still_idle_with_pre_seal`) | **`pub`** unchanged | Call `*_at(self.idle_now())`; production `idle_now()` is real `Instant::now()` |
| `VaultLifecycleCoordinator::on_idle_tick` | **`pub`** unchanged | Production path → real now via vault |
| `on_idle_tick_at(now)` | **`#[cfg(test)] pub(crate)`** only | Deterministic coordinator **test** seam (not in release builds) |
| `#[cfg(test)] idle_now_override` + `test_set_idle_now` | test-only | Lets `enter_op` / `idle_timeout_due` / watchdog see due state without Instant subtraction |
| `test_touch_activity` | test-only | Sets `last_activity = idle_now()` so refresh clears due under override |
| Lifecycle tests | — | All former `Instant::now() - VAULT_IDLE_TIMEOUT` replaced with `last + timeout + slack` |

### Task 10B visibility close-out

Review rejected exporting arbitrary-Instant seams as **public** crate API (`pub mod vault` re-exports). Source regression `explicit_time_idle_seams_are_not_public_api` forbids `pub fn` on those helpers and requires `on_idle_tick_at` to be `#[cfg(test)]`.

**Preserved production semantics:** 15-minute timeout, fail-closed SSH cutoff order, no weakening of seal paths.

## Verification

| Gate | Result |
|------|--------|
| `cargo test --lib vault_lifecycle_coordinator` | **17 passed** |
| `cargo test --all-targets` | **324 passed**, 0 failed, 1 ignored |
| `cargo fmt --check` | clean |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `npm test` | **80/80** |
| `npm run contracts:check` | ok |
| `npm run build:web` | ok |
| `git diff --check` | clean |

## Files touched

- `src-tauri/src/vault/mod.rs`
- `src-tauri/src/vault_lifecycle_coordinator.rs`
- `docs/security/task-10a-windows-idle-instant-overflow.md` (this doc)
