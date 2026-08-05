# Task 2 Evidence — cross-platform SystemRandomSource

**Date:** 2026-08-05  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Branch:** `feat/secure-desktop-foundation`  
**Base:** `1f9818a` (clean) + uncommitted Task 2  
**Dispatch:** `task_1b0b7b59c58e` / `ctx_b754a5fb412d`  
**Worker:** no commit / no push

## Goal

Replace macOS-only `SecRandomSource` / non-macOS zero-fill failure with one Rust-owned cross-platform `SystemRandomSource` backed by exact direct dependency:

```toml
getrandom = "=0.4.3"
```

Implementation:

```rust
getrandom::fill(dest).map_err(|_| AuthError::Random)
```

## RED

1. Added contract tests that require:
   - no `SecRandomCopyBytes` / `dest.fill(0)` / `SecRandomSource` in `auth/pkce.rs`
   - production `SystemRandomSource` succeeds with non-all-zero independent fills
   - `generate_state` / `generate_code_verifier` nonzero length and nonrepeating under production source
2. **Before implementation:** compile failed (`crate::platform_random` missing) and/or source contract would fail on legacy zero-fill/FFI design.

## GREEN implementation

| Path | Change |
|------|--------|
| `src-tauri/Cargo.toml` | direct `getrandom = "=0.4.3"` |
| `src-tauri/Cargo.lock` | lock records direct dep on `getrandom 0.4.3` |
| `src-tauri/src/platform_random.rs` | **new** `SystemRandomSource` |
| `src-tauri/src/lib.rs` | `pub mod platform_random`; `auth_begin_logto` uses `SystemRandomSource` |
| `src-tauri/src/auth/pkce.rs` | removed all `SecRandomSource` / FFI / zero-fill; kept injectable `RandomSource` + zeroize of raw buffers after encode |
| `src-tauri/src/auth/mod.rs` | export `SystemRandomSource`; drop `SecRandomSource` |
| `src-tauri/src/auth/tests.rs` | Task 2 contract + entropy/nonrepeat tests |
| `src-tauri/src/vault/mod.rs` | call-site rename → `SystemRandomSource` (required to remove every `SecRandomSource` use) |
| `src-tauri/src/local_ssh/session.rs` | production manager constructor → `SystemRandomSource` |

### Design invariants preserved

- `RandomSource` remains injectable for deterministic tests (`DetRng`, etc.)
- Production Logto begin constructs `SystemRandomSource` in `auth_begin_logto`
- Verifier/state raw buffers still `zeroize()` after base64url encode
- No WebView randomness, JS crypto, fallback zeros, unsafe FFI, or new IPC
- No other new dependencies beyond the approved `getrandom = "=0.4.3"`

## Verification (fresh this dispatch)

| Command | Result |
|---------|--------|
| `cargo +1.92.0 test --manifest-path src-tauri/Cargo.toml --lib auth::` | **41** passed (includes 3 Task 2 tests) |
| `cargo +1.92.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` | **exit 0**, zero warnings |
| `cargo +1.92.0 fmt --manifest-path src-tauri/Cargo.toml -- --check` | **ok** |
| `cargo +1.92.0 test --manifest-path src-tauri/Cargo.toml --all-targets` | **300** passed, **1** ignored, **143.99s** |
| `npm test` | **43** passed |
| `npm run contracts:check` | **ok** |
| `npm run build:web` | **ok** |
| `cargo +1.92.0 build --manifest-path src-tauri/Cargo.toml --release` | **ok** (~21s) |
| `git diff --check` | **clean** |

### Dependency / secret scan

- Direct pin: `getrandom = "=0.4.3"` only new dependency.
- No secrets, PEMs, tokens, or host material in random path.
- Diff free of `SecRandomCopyBytes` / production zero-fill fallback.

## Explicit non-claims

- No commit / push  
- No WebView `crypto.getRandomValues` / JS entropy  
- No “full entropy audit” or NIST CSPRNG certification — only nonzero/nonrepeating smoke under production source  
- No new IPC surface  
- No dependency upgrades beyond adding the approved exact pin  

## Files modified

- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/src/platform_random.rs` (new)
- `src-tauri/src/lib.rs`
- `src-tauri/src/auth/pkce.rs`
- `src-tauri/src/auth/mod.rs`
- `src-tauri/src/auth/tests.rs`
- `src-tauri/src/vault/mod.rs` (rename only)
- `src-tauri/src/local_ssh/session.rs` (rename only)
- `docs/task-2-system-random-evidence.md`
