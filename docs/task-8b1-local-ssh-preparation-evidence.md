# Task 8B1 Evidence — Local SSH preparation boundary

**Date:** 2026-08-04  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Branch:** `feat/secure-desktop-foundation`  
**Start HEAD:** `f81a034`  
**Task / dispatch (initial):** `task_8478fd3d2253` / `ctx_69eb9f51082a`  
**Review rework 1:** `task_699e027c6606` / `ctx_12413883ebf9`  
**Review rework 2:** `task_f39f93b19285` / `ctx_d5f04bb8f314`  
**Worker:** no commit / no push

## Scope (honest)

| Path | Role |
|------|------|
| `src-tauri/src/local_ssh/mod.rs` | `pub(crate)` module; crate-only re-exports |
| `src-tauri/src/local_ssh/prepare.rs` | DTO, errors, prepare, russh Fingerprint validation |
| `src-tauri/src/local_ssh/tests.rs` | Behavioral + isolation + race + alias tests |
| `src-tauri/src/cloud_transport/sanitize.rs` | Duplicate-key + trailing-token rejection + secret strip |
| `src-tauri/src/cloud_transport/tests.rs` | Transport InvalidResponse on duplicates/trailing |
| `src-tauri/src/lib.rs` | `pub(crate) mod local_ssh` |
| `docs/task-8b1-local-ssh-preparation-evidence.md` | This document |

## What this ships

1. **WebView DTO** `LocalSshOpenRequest` — `serverId` + `credentialId` only, `deny_unknown_fields`.
2. **`prepare_local_ssh_open`** — AuthBinding + ssh_generation; vault/cutoff unlocked; `servers.get` with only id; strict metadata; revalidate before/after `lease_for_ssh`.
3. **`PreparedLocalSshOpen`** — not Serialize/Clone; redacted Debug; crate-internal.
4. **Fixed `LocalSshError` public codes**.
5. **Duplicate JSON keys** rejected recursively; **trailing tokens** rejected via `Deserializer::end()`.
6. **Host-key fingerprint** — `russh::keys::ssh_key::Fingerprint::from_str`, require `is_sha256()`, 32 digest bytes, and `to_string() == input` (canonical **unpadded** only).

## Review rework 2 (this dispatch)

| Finding | Fix |
|---------|-----|
| Handwritten base64 | Removed; use russh `Fingerprint` + exact Display match |
| Padded fingerprints accepted | Rejected (unpadded OpenSSH only) |
| No `de.end()` after parse | Call `de.end()`; reject trailing object/scalar/garbage |
| Incomplete alias rejection | Normalize trusted keys; reject ID/tenantId/ssh-port/SSH_USER/HostKeyFingerprint etc. |
| Broad `#![allow(dead_code)]` | Module-scoped `cfg_attr(not(test), allow(dead_code))` on prepare only |

## Explicit non-claims

- No SSH socket / russh **connection** / host-key UI / session registry
- No Tauri `local_ssh_open` IPC / capability / frontend / schema / new deps
- Does **not** claim “SSH connected”
- Types not exported outside the crate

## Host-key fingerprint semantics (canonical)

- Input must parse as OpenSSH fingerprint string
- Algorithm must be SHA-256 (SHA-512 rejected)
- Digest length exactly 32 bytes
- String must equal `Fingerprint` Display form (unpadded standard base64 after `SHA256:`)
- Padded (`=`), URL-safe (`-`/`_`), short/long, misplaced padding, noncanonical → invalid

## Fixed public error codes

| Code | When |
|------|------|
| `local_ssh_invalid_input` | DTO / id validation |
| `local_ssh_unauthenticated` | No auth binding |
| `local_ssh_binding_mismatch` | Epoch/principal change mid-prepare |
| `local_ssh_vault_locked` | Vault or cutoff vault gate locked |
| `local_ssh_ssh_cutoff` | SSH generation advanced |
| `local_ssh_online_metadata_required` | Cloud transport/HTTP/invalid JSON/duplicates/trailing |
| `local_ssh_metadata_mismatch` | Server/tenant/credential identity mismatch |
| `local_ssh_invalid_metadata` | Bad host/port/user/host-key / aliases / key collisions |
| `local_ssh_credential_not_found` | Local vault missing credential |
| `local_ssh_internal` | Unexpected internal |

## Tests

### local_ssh focused: **24** passed

DTO, happy path + unpadded host-key, A/B isolation, invalid host/port/user/host-key (short/URL-safe/padded/SHA512), array/aliases, **normalized colliding keys** (ID, tenantId, ssh-port, …), cloud errors, unauthenticated, epoch mid-cloud, cutoff/stronghold locked, GenBumpBackend generation race, missing credential, Debug redaction, duplicate JSON keys → online_metadata_required without lease.

### sanitizer / transport

- Duplicate keys top-level / nested / array objects
- Unique keys still strip secrets
- Trailing object / scalar / garbage unit tests
- Transport: duplicate keys → InvalidResponse; trailing JSON → InvalidResponse

## Verification (post rework 2)

| Command | Result |
|---------|--------|
| `rustup run 1.92.0 cargo fmt -- --check` | ok |
| `rustup run 1.92.0 cargo check` | Finished (no warnings) |
| `rustup run 1.92.0 cargo test --lib local_ssh` | **24** passed |
| `rustup run 1.92.0 cargo test` | **213** passed, **1** ignored |
| `npm test` | **43** passed |
| `npm run contracts:check` | ok |
| `npm run build:web` | ok |
| `git diff --check` | clean |
| `RUSTUP_TOOLCHAIN=1.92.0 npm run tauri build` | ok — `OpsMate.app` bundled |
