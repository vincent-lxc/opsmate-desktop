# Task 3 Evidence — native secure prompts (runtime safety rework)

**Date:** 2026-08-05  
**Repo:** `/Users/vincent/Documents/ClaudeCode/opsmate-desktop`  
**Branch:** `feat/secure-desktop-foundation`  
**Base:** dirty Task 3 tree (Windows 0.62.2 compile fixes accepted)  
**Dispatch:** `task_36e1881c774b` / `ctx_3951772290f3`  
**Worker:** no commit / no push

## Context

Prior Windows GNU Docker compile is green. Coordinator review found **runtime safety** issues in the modal pump / secret capture. This dispatch fixes those only; 0.62.2 API fixes and layout/security boundaries stay.

## Runtime safety repair

| # | Blocker | Fix |
|---|---------|-----|
| 1 | `PostQuitMessage` in `WM_DESTROY` (edit + choice procs) | **Removed.** Private pump already exits when `IsWindow` is false after `DestroyWindow`. Posting `WM_QUIT` left a stale quit that could abort later prompts or poison the host thread queue. `WM_DESTROY` returns `LRESULT(0)` only. |
| 2 | Raw `String` from `from_utf16_lossy` before wrap | Wrap-first into `Zeroizing`, then `buf.zeroize()` — no raw secret `String` local. |

### Final consistency repair (`task_ff7424d13200` / `ctx_27cd15613fe7`)

| Gap | Fix |
|-----|-----|
| macOS `prompt_pem_paste` raw `String` from `stringValue` | `let secret = Zeroizing::new(field.stringValue().to_string())` then trim on `secret` |
| Linux `run_textview_dialog` `buffer().expect(...)` | Missing buffer → `PromptError::Native("text buffer unavailable")` (no panic, no secret in error); text still wrapped in `Zeroizing` immediately |

Source contracts: macOS forbids `let s = field.stringValue().to_string()`; Linux forbids `.buffer().expect(`.

### Independent Windows GNU compile repair (`task_e383f9cb4428` / `ctx_6aa0869e8b7b`)

Independent Docker `x86_64-pc-windows-gnu` check failed **E0599** at `windows.rs` capture:

```text
String::from_utf16_lossy(...).into_owned()
// error: method `into_owned` not found (returns String, not Cow)
```

**Fix:** direct wrap only:

```rust
let secret = Zeroizing::new(String::from_utf16_lossy(&buf[..n as usize]));
buf.zeroize();
```

Source contract still requires exact `Zeroizing::new(String::from_utf16_lossy` (no broad OR).

**Recheck (this dispatch):** Docker `x86_64-pc-windows-gnu cargo check --lib` → **exit 0** (~19s with warm cache; temp ICO only, removed after).

Source contract (`vault::tests::secure_prompt_windows_source_uses_password_edit_and_zeroizing`): no `PostQuitMessage`; explicit `GetMessageW` `-1` / `0` / `>0`; no `let s = String::from_utf16_lossy`.

## Security properties preserved

- No process-global shared edit HWND (`GetDlgItem(Some(hwnd), IDC_EDIT)` only)
- `DIALOG_RESULT` remains **thread_local**
- Secrets stay **`Zeroizing`** across helper boundaries (`DialogOutcome::Ok(Zeroizing<String>)`)
- UTF-16 buffers **zeroized** after capture (wrap-first, then wipe vec)
- **`GetMessageW`**: `-1` → `PromptError::Native`, `0` quit, `>0` dispatch (pump still exits on destroyed window without thread quit)
- Plan layout unchanged: `secure_prompt.rs` + `secure_prompt/{macos,windows,linux}.rs`
- **`UnsupportedPlatform`** retained for non-target OS
- Password empty → Cancelled; passphrase empty → `Ok(None)`; no WebView/IPC

## Windows 0.62.2 API fixes (both credential + import dialogs)

| Error family | Fix |
|--------------|-----|
| `COLOR_WINDOW` not available as brush | `GetSysColorBrush(COLOR_WINDOW)` from `Win32::Graphics::Gdi` |
| `IsWindow` expects `Option<HWND>` | `IsWindow(Some(hwnd))` |
| `CreateWindowExW` parent/menu/instance | `Some(hwnd)` / `Some(menu_id(id))` / `Some(hinstance)` / top-level `None` parents |
| `GetModuleHandleW` → `HMODULE` | `HINSTANCE::from(module)` for class + create |
| `ES_*` / `BS_*` are `i32` | `WINDOW_STYLE(bits as u32)` via `style_bits` (no `.0` on i32) |
| `SendMessageW` wparam/lparam | `Some(WPARAM(...))` / `Some(LPARAM(...))` |
| `SetFocus` missing | Feature `Win32_UI_Input_KeyboardAndMouse`; `SetFocus(Some(hedit))` |
| `GetDlgItem` API | `GetDlgItem(Some(hwnd), id) -> Result<HWND>`; `Err` → cancel fail-closed (no unwrap on secret path) |

Also: child creates map `Result` errors with `map_err` → `PromptError::Native` (no `unwrap`/`expect` on secret paths).

## Cross-target recheck (this dispatch)

### Windows GNU (Docker, temporary ICO only)

```text
docker run --platform linux/amd64 rust:1.92-bookworm
  + gcc-mingw-w64-x86-64, nasm
  + rustup target add x86_64-pc-windows-gnu
  + temp src-tauri/icons/icon.ico (removed after check; not committed)
  cargo check --target x86_64-pc-windows-gnu --lib
→ Finished `dev` profile … exit 0  (~35s after deps warm)
```

**Honest notes**

- Repo still **lacks** packaging `icons/icon.ico`; tauri-build requires it for Windows resource generation. Only a **temporary** file inside the check was used; **not** added as product packaging in this task.
- Prior Docker attempt without ICO failed at build-script (`icon.ico` not found) before product typecheck.
- Prior attempt without nasm failed in `aws-lc-sys` before product code.

### Linux x64 (final independent coordinator verification)

```text
docker run --platform linux/amd64
  + read-only source mount
  + CARGO_TARGET_DIR=/target on dedicated opsmate-linux-target volume
  cargo check --all-features --lib
→ Finished `dev` profile ... in 6m 01s; exit 0
```

The dedicated target volume keeps Linux artifacts out of the macOS
`src-tauri/target` directory and is reusable by the next lifecycle task.

## Host macOS verification (runtime safety rework)

| Command | Result |
|---------|--------|
| `cargo +1.92.0 fmt -- --check` | **ok** |
| `cargo +1.92.0 test --lib secure_prompt_` | **5** passed |
| `cargo +1.92.0 clippy --all-targets --all-features -- -D warnings` | **exit 0** |
| `cargo +1.92.0 test --all-targets --all-features -- --test-threads=1` | **304** passed, **1** ignored (**237.13s**) |
| `npm test -- --run` | **43** passed |
| `npm run contracts:check` | **ok** |
| `npm run build:web` | **ok** |
| `cargo +1.92.0 build --release` | **exit 0** |
| `git diff --check` | **clean** |

Windows GNU compile: still valid from prior rework; this dispatch is a small source-only safety fix (no API signature change). Docker GNU recheck optional / not required for PostQuitMessage removal.

## Explicit non-claims

- No permanent packaging icon added  
- No GUI E2E of dialogs  
- No commit / push  
- No new dependencies beyond already-approved `windows` / `gtk` (only added `Win32_UI_Input_KeyboardAndMouse` feature on windows)  

## Files changed (this rework)

- `src-tauri/src/secure_prompt/windows.rs` — 0.62.2-correct Win32 calls  
- `src-tauri/Cargo.toml` — `Win32_UI_Input_KeyboardAndMouse` feature  
- `src-tauri/Cargo.lock` — lock metadata as needed  
- `docs/task-3-native-secure-prompt-evidence.md` — this update  
- Prior Task 3 files remain: `secure_prompt.rs`, `secure_prompt/{macos,linux}.rs`, `vault/tests.rs`
