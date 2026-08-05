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

---

## Live run — SSH actor fairness (dispatch `task_ac9e6200ff3c` / `ctx_6891bb80e295`)

**Actions run:** https://github.com/vincent-lxc/opsmate-desktop/actions/runs/31005287693
**Linux job:** `92303595760`
**Exact failure:** `local_ssh::transport::tests::actor_fairness_cmd_not_starved_by_continuous_peer` at `transport.rs:1805` — `peers_before=64` with branch log 64×`peer` then `cmd`. Suite result on that job: **317 pass / 1 fail / 1 ignored**.

### Root cause (one hypothesis + evidence)

**Hypothesis:** The live failure is a **non-deterministic test setup race**, not a production `FairIoScheduler` contract break. Fairness only reorders when **both** select arms are ready. The old test flooded 64 peer events, then spawned `write` on another thread with no barrier. On a fast Linux runner the actor can drain all queued peers before `try_send` enqueues the cmd; `prefer_cmd_first` then never sees a ready cmd during the flood, so the log is 64×peer then cmd (`peers_before=64`) — matching CI exactly.

**Evidence:**

| Item | Detail |
|------|--------|
| Production scheduler | `FAIR_IO_MAX_BURST=8`; after ≥8 consecutive peers, biased select prefers `cmd` when ready |
| Live CI | `peers_before=64` = entire flood before first cmd (cmd not ready during drain) |
| Deterministic document test | `actor_fairness_peers_before_is_64_if_cmd_arrives_after_peer_drain` holds actor, drains 64 peers first, then writes → asserts `peers_before == 64` (CI failure mode, fixed) |
| RED probe (temp) | Forced `prefer_cmd_first() -> false` under **held** concurrent setup → same panic: `peers_before=64` + 64 peer then cmd |
| GREEN | Restored real `prefer_cmd_first`; held harness enqueues peers **and** write (`cmds_submitted` spin, no sleep) before `start_gate.notify_one()` → `peers_before ≤ FAIR_IO_MAX_BURST+2` |

**Not done:** no raise of `FAIR_IO_MAX_BURST`, no ignore, no sleep/retry flake band-aids, fairness/security not weakened.

### Fix (minimal, semantics-preserving)

- `open_fake_transport_held` + `FakePeerHandle.start_gate` — actor waits before first select
- `ActorSshTransport.cmds_submitted` — **`#[cfg(test)]` only** (import, field, `fetch_add`, initializers); not in production layout/hot path; observes successful `try_send` so the held harness can wait for cmd enqueue without timed sleeps
- Rewrite `actor_fairness_cmd_not_starved_by_continuous_peer` to use the held concurrent harness
- `actor_fairness_cmd_not_starved_stress_repeat` — 64× harness
- Document-mode test for late cmd after full peer drain (CI shape)

### Review rework — `cmds_submitted` cfg(test) (`task_05d81f6aecf4`)

Production `ActorSshTransport` must not carry test observability. All of: `AtomicUsize` import for this counter, struct field, `send_cmd` increment, and both initializers (`open_session_transport`, fake open) are gated `#[cfg(test)]`. Non-test builds compile without the field (`cargo check --lib` exit 0); held-start fairness harness unchanged.

| Gate (rework) | Result |
|---------------|--------|
| Fairness filter | **4 passed** |
| `cargo clippy --all-targets --all-features -- -D warnings` | **exit 0** |
| `cargo test --all-targets` | **320 passed**, 1 ignored |
| `npm test` | **49 passed** |
| release-config / contracts:check / build:web / `git diff --check` | **ok** |

### RED / GREEN capture

**RED** (prefer_cmd forced false under held concurrent setup):

```text
cmd must win after peer burst, peers_before=64 log=["peer", …×64…, "cmd"]
test …actor_fairness_cmd_not_starved_by_continuous_peer ... FAILED
```

**GREEN** (real scheduler + held harness):

```text
running 4 tests
actor_fairness_peers_before_is_64_if_cmd_arrives_after_peer_drain ... ok
actor_fairness_cmd_not_starved_by_continuous_peer ... ok
actor_fairness_peer_eof_not_starved_by_continuous_cmds ... ok
actor_fairness_cmd_not_starved_stress_repeat ... ok
test result: ok. 4 passed
```

### Native verification (this dispatch)

| Command | Result |
|---------|--------|
| Fairness filter (`actor_fairness*`) | **4 passed** |
| `cargo +1.92.0 clippy --all-targets --all-features -- -D warnings` | **exit 0** |
| `cargo +1.92.0 test --all-targets` | **320 passed**, 1 ignored |
| `npm test` | **49 passed** (8 files) |
| `node scripts/check-release-config.mjs` | **OK** |
| `npm run contracts:check` | **ok** |
| `npm run build:web` | **ok** |
| `git diff --check` | **clean** |

### Linux Docker / local emulation limitation (exact)

Attempted local Linux reproduce via:

```text
docker run --rm --platform linux/amd64 rust:1.92-bookworm
  + volumes opsmate-linux-target, opsmate-linux-cargo-cache
  + apt GTK/WebKit build deps
  + cargo test --lib local_ssh::transport::tests::actor_fairness
```

**Container `0e227077b003`:** observed **0.00% CPU**, `cargo` blocked in `rt_mutex_schedule` **>4 minutes**, with **3 defunct `rustc` children** under **amd64 Rosetta** on Apple host. Classified as **local emulation/tooling hang**, not product failure. **Terminated only this ephemeral container** (`docker kill 0e227077b003`, exit 137). **No claim of Linux-in-Docker green** for this dispatch; native macOS gates + deterministic harness + live CI signature are the evidence. Live CI Linux remains the authoritative Linux signal after re-run.

### Explicit non-claims

- No commit / push
- No Linux Docker GREEN claim (Rosetta hang; container killed)
- No claim that Actions run 31005287693 is green after this uncommitted patch (re-run needed)
- Prior Windows clippy / gitattributes / build:web CI fixes remain as previously recorded

### Files (this fairness dispatch)

- `src-tauri/src/local_ssh/transport.rs`
- `docs/task-6-ci-evidence.md`

---

## Live run — Windows source-contract CRLF (`task_39fdb18d1d00` / `ctx_b2ae79cc9750`)

**Actions run:** https://github.com/vincent-lxc/opsmate-desktop/actions/runs/31005287693
**Windows job:** `92303595964`

### Exact failures (3)

| Test | Failure mode |
|------|----------------|
| `local_ssh::session::tests::production_attach_helper_calls_shared_inner` | `.split("pub fn attach_session_manager_to_vault(\n")` found no match |
| `vault_os_sleep::tests::no_non_macos_stub_platform_modules_exist` | falsely found `Stub` / related markers |
| `vault_os_sleep::tests::register_returns_result_and_propagates_try_new` | falsely found `.ok().map` |

### Root cause

Windows CI presents **CRLF** (`\r\n`) for source read via `include_str!` / `fs::read_to_string`. Source-contract helpers used **LF-only** markers:

- `vault_os_sleep::prod_src()` split on `"#[cfg(test)]\nmod tests"` — no match on CRLF → entire file treated as production → test assertion strings (`Stub(`, `.ok().map`) counted as production.
- session attach split on `"pub fn attach_session_manager_to_vault(\n"` — signature line is `(\r\n` on Windows → `.nth(1)` missing.

Not a production behavior bug. **Not** fixed by broadening `.gitattributes` (existing contract LF rules unchanged).

### Fix (test-only)

- `crate::normalize_source_newlines` (`#[cfg(test)]`, **after** all production items in `lib.rs` so `split("#[cfg(test)]")` contracts still see full prod body)
- `vault_os_sleep::dispatch_src` normalizes after read
- `production_attach_helper_calls_shared_inner` normalizes `include_str!("session.rs")`

### RED / GREEN

**RED** (deterministic helpers with equivalent CRLF text):

- `source_contract_crlf_requires_newline_normalization` — without normalize, LF module marker does not split; `Stub(` / `.ok().map` visible
- `production_attach_signature_marker_requires_crlf_normalization` — LF signature marker misses CRLF text until normalize

**GREEN:** both CRLF regressions + original three tests pass; production code/layout untouched.

### Verification (this dispatch)

| Gate | Result |
|------|--------|
| Focused 3 + 2 CRLF regressions | **5 passed** |
| `cargo clippy --all-targets --all-features -- -D warnings` | **exit 0** |
| `cargo test --all-targets` | **322 passed**, 1 ignored |
| `npm test` | **49 passed** |
| release-config / contracts:check / build:web | **ok** |
| `git diff --check` | **clean** |

### Explicit non-claims

- No commit / push
- No broad `.gitattributes` expansion for all `*.rs`
- No assertion weakening / removal
- No production attach / os-sleep behavior change
- Preserves `972b3e6` fairness work and prior CI fixes
- No claim that Actions run 31005287693 is green until re-run

### Files (this Windows CRLF dispatch)

- `src-tauri/src/lib.rs` (`normalize_source_newlines`, test-only, post-production)
- `src-tauri/src/vault_os_sleep.rs` (`dispatch_src` normalize + CRLF RED/GREEN test)
- `src-tauri/src/local_ssh/session.rs` (attach normalize + CRLF signature test)
- `docs/task-6-ci-evidence.md`
