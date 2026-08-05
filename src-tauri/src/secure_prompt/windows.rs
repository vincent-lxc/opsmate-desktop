//! Windows native secure prompts: Win32 modal EDIT (ES_PASSWORD / multiline) + rfd.
//! Secrets are read via GetWindowTextW into Zeroizing; UTF-16 buffers are zeroized.
//! Edit HWND is resolved per-dialog via GetDlgItem (no process-global Atomic state).
//!
//! Typed against `windows` 0.62.2 Option/Result HWND APIs.

use super::{NativeSecurePrompt, PromptError, SecurePrompt};
use std::cell::RefCell;
use zeroize::{Zeroize, Zeroizing};

const IDC_EDIT: i32 = 1001;
const IDC_OK: i32 = 1002;
const IDC_CANCEL: i32 = 1003;
const IDC_FILE: i32 = 1004;
const IDC_PASTE: i32 = 1005;

thread_local! {
    /// Per-thread dialog result only (never process-global secret/HWND state).
    static DIALOG_RESULT: RefCell<Option<DialogOutcome>> = const { RefCell::new(None) };
}

enum DialogOutcome {
    Ok(Zeroizing<String>),
    Cancel,
    ChooseFile,
    ChoosePaste,
}

impl SecurePrompt for NativeSecurePrompt {
    fn prompt_password(
        &self,
        title: &str,
        message: &str,
    ) -> Result<Zeroizing<String>, PromptError> {
        let s = run_edit_dialog(title, message, EditMode::Password)?;
        if s.is_empty() {
            return Err(PromptError::Cancelled);
        }
        Ok(s)
    }

    fn prompt_passphrase(
        &self,
        title: &str,
        message: &str,
    ) -> Result<Option<Zeroizing<String>>, PromptError> {
        let s = run_edit_dialog(title, message, EditMode::Password)?;
        if s.is_empty() {
            Ok(None)
        } else {
            Ok(Some(s))
        }
    }

    fn pick_pem_file(&self) -> Result<Option<std::path::PathBuf>, PromptError> {
        Ok(rfd::FileDialog::new()
            .add_filter("PEM / key", &["pem", "key", "txt"])
            .set_title("Import SSH private key")
            .pick_file())
    }

    fn prompt_pem_paste(&self, title: &str) -> Result<Zeroizing<String>, PromptError> {
        let s = run_edit_dialog(
            title,
            "Paste PEM private key (never entered in WebView)",
            EditMode::Multiline,
        )?;
        if s.trim().is_empty() {
            return Err(PromptError::Cancelled);
        }
        Ok(s)
    }

    fn choose_pem_import(&self) -> Result<Zeroizing<String>, PromptError> {
        match run_choice_dialog(
            "Import SSH private key",
            "Choose a key file or paste PEM. Selection stays native (never WebView).",
        )? {
            DialogOutcome::ChooseFile => {
                let path = self.pick_pem_file()?.ok_or(PromptError::Cancelled)?;
                let secret = Zeroizing::new(
                    std::fs::read_to_string(&path)
                        .map_err(|e| PromptError::Native(e.to_string()))?,
                );
                if secret.trim().is_empty() {
                    return Err(PromptError::Cancelled);
                }
                Ok(secret)
            }
            DialogOutcome::ChoosePaste => self.prompt_pem_paste("Paste SSH private key"),
            DialogOutcome::Cancel => Err(PromptError::Cancelled),
            DialogOutcome::Ok(_) => Err(PromptError::Cancelled),
        }
    }
}

#[derive(Clone, Copy)]
enum EditMode {
    Password,
    Multiline,
}

fn run_edit_dialog(
    title: &str,
    message: &str,
    mode: EditMode,
) -> Result<Zeroizing<String>, PromptError> {
    DIALOG_RESULT.with(|c| *c.borrow_mut() = None);
    unsafe { create_and_run_edit_dialog(title, message, mode) }?;
    DIALOG_RESULT.with(|c| match c.borrow_mut().take() {
        Some(DialogOutcome::Ok(s)) => Ok(s),
        Some(DialogOutcome::Cancel) | None => Err(PromptError::Cancelled),
        _ => Err(PromptError::Cancelled),
    })
}

fn run_choice_dialog(title: &str, message: &str) -> Result<DialogOutcome, PromptError> {
    DIALOG_RESULT.with(|c| *c.borrow_mut() = None);
    unsafe { create_and_run_choice_dialog(title, message) }?;
    DIALOG_RESULT.with(|c| c.borrow_mut().take().ok_or(PromptError::Cancelled))
}

/// `GetMessageW`: -1 = error, 0 = WM_QUIT, >0 = dispatch message.
unsafe fn pump_until_destroyed(hwnd: windows::Win32::Foundation::HWND) -> Result<(), PromptError> {
    use windows::Win32::UI::WindowsAndMessaging::*;
    let mut msg = MSG::default();
    loop {
        let gm = GetMessageW(&mut msg, None, 0, 0);
        // BOOL is i32-backed; do not treat -1 as success via bool conversion.
        match gm.0 {
            -1 => return Err(PromptError::Native("GetMessageW failed".into())),
            0 => break,
            _ => {
                if !IsDialogMessageW(hwnd, &msg).as_bool() {
                    let _ = TranslateMessage(&msg);
                    let _ = DispatchMessageW(&msg);
                }
            }
        }
        if !IsWindow(Some(hwnd)).as_bool() {
            break;
        }
    }
    Ok(())
}

fn hinstance_from_module(
    module: windows::Win32::Foundation::HMODULE,
) -> windows::Win32::Foundation::HINSTANCE {
    windows::Win32::Foundation::HINSTANCE::from(module)
}

fn menu_id(id: i32) -> windows::Win32::UI::WindowsAndMessaging::HMENU {
    windows::Win32::UI::WindowsAndMessaging::HMENU(id as usize as *mut _)
}

fn style_bits(bits: i32) -> windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE {
    windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE(bits as u32)
}

unsafe fn create_and_run_edit_dialog(
    title: &str,
    message: &str,
    mode: EditMode,
) -> Result<(), PromptError> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        GetStockObject, GetSysColorBrush, COLOR_WINDOW, DEFAULT_GUI_FONT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows::Win32::UI::WindowsAndMessaging::*;

    let module = GetModuleHandleW(None).map_err(|e| PromptError::Native(e.to_string()))?;
    let hinstance: HINSTANCE = hinstance_from_module(module);
    let class_name = w!("OpsMateSecureEditDialog");

    let wc = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(edit_dialog_proc),
        hInstance: hinstance,
        lpszClassName: class_name,
        hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
        hbrBackground: GetSysColorBrush(COLOR_WINDOW),
        ..Default::default()
    };
    let _ = RegisterClassW(&wc);

    let title_w = to_wide(title);
    let hwnd = CreateWindowExW(
        WS_EX_DLGMODALFRAME | WS_EX_TOPMOST,
        class_name,
        PCWSTR(title_w.as_ptr()),
        WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
        200,
        200,
        420,
        if matches!(mode, EditMode::Multiline) {
            280
        } else {
            180
        },
        None,
        None,
        Some(hinstance),
        None,
    )
    .map_err(|e| PromptError::Native(e.to_string()))?;

    let msg_w = to_wide(message);
    let _label = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        w!("STATIC"),
        PCWSTR(msg_w.as_ptr()),
        WS_CHILD | WS_VISIBLE,
        16,
        16,
        370,
        36,
        Some(hwnd),
        None,
        Some(hinstance),
        None,
    )
    .map_err(|e| PromptError::Native(e.to_string()))?;

    // ES_* / BS_* are i32 in windows 0.62; cast to WINDOW_STYLE(u32) without `.0`.
    let edit_style = match mode {
        EditMode::Password => {
            WS_CHILD | WS_VISIBLE | WS_BORDER | style_bits(ES_PASSWORD | ES_AUTOHSCROLL | ES_LEFT)
        }
        EditMode::Multiline => {
            WS_CHILD
                | WS_VISIBLE
                | WS_BORDER
                | WS_VSCROLL
                | style_bits(ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN | ES_LEFT)
        }
    };
    let edit_h = if matches!(mode, EditMode::Multiline) {
        120
    } else {
        28
    };
    let hedit = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        w!("EDIT"),
        w!(""),
        edit_style,
        16,
        56,
        370,
        edit_h,
        Some(hwnd),
        Some(menu_id(IDC_EDIT)),
        Some(hinstance),
        None,
    )
    .map_err(|e| PromptError::Native(e.to_string()))?;

    let btn_y = if matches!(mode, EditMode::Multiline) {
        190
    } else {
        100
    };
    let _ok = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        w!("BUTTON"),
        w!("OK"),
        WS_CHILD | WS_VISIBLE | style_bits(BS_DEFPUSHBUTTON),
        200,
        btn_y,
        80,
        28,
        Some(hwnd),
        Some(menu_id(IDC_OK)),
        Some(hinstance),
        None,
    )
    .map_err(|e| PromptError::Native(e.to_string()))?;
    let _cancel = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        w!("BUTTON"),
        w!("Cancel"),
        WS_CHILD | WS_VISIBLE | style_bits(BS_PUSHBUTTON),
        300,
        btn_y,
        80,
        28,
        Some(hwnd),
        Some(menu_id(IDC_CANCEL)),
        Some(hinstance),
        None,
    )
    .map_err(|e| PromptError::Native(e.to_string()))?;

    let font = GetStockObject(DEFAULT_GUI_FONT);
    let _ = SendMessageW(
        hedit,
        WM_SETFONT,
        Some(WPARAM(font.0 as usize)),
        Some(LPARAM(1)),
    );
    let _ = SetFocus(Some(hedit));

    pump_until_destroyed(hwnd)
}

unsafe extern "system" fn edit_dialog_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::WindowsAndMessaging::*;

    match msg {
        WM_COMMAND => {
            let id = (wparam.0 & 0xFFFF) as i32;
            if id == IDC_OK {
                // Resolve EDIT for *this* dialog only — no process-global HWND.
                match GetDlgItem(Some(hwnd), IDC_EDIT) {
                    Ok(hedit) => {
                        let text = read_window_text_zeroizing(hedit);
                        DIALOG_RESULT.with(|c| *c.borrow_mut() = Some(DialogOutcome::Ok(text)));
                    }
                    Err(_) => {
                        // Fail closed without panicking on secret path.
                        DIALOG_RESULT.with(|c| *c.borrow_mut() = Some(DialogOutcome::Cancel));
                    }
                }
                let _ = DestroyWindow(hwnd);
                return LRESULT(0);
            }
            if id == IDC_CANCEL {
                DIALOG_RESULT.with(|c| *c.borrow_mut() = Some(DialogOutcome::Cancel));
                let _ = DestroyWindow(hwnd);
                return LRESULT(0);
            }
        }
        WM_CLOSE => {
            DIALOG_RESULT.with(|c| *c.borrow_mut() = Some(DialogOutcome::Cancel));
            let _ = DestroyWindow(hwnd);
            return LRESULT(0);
        }
        WM_DESTROY => {
            // Do not PostQuitMessage: the private pump exits via IsWindow(false)
            // after DestroyWindow. A thread-wide WM_QUIT would stale-quit later prompts.
            return LRESULT(0);
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

unsafe fn create_and_run_choice_dialog(title: &str, message: &str) -> Result<(), PromptError> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::HINSTANCE;
    use windows::Win32::Graphics::Gdi::{GetSysColorBrush, COLOR_WINDOW};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;

    let module = GetModuleHandleW(None).map_err(|e| PromptError::Native(e.to_string()))?;
    let hinstance: HINSTANCE = hinstance_from_module(module);
    let class_name = w!("OpsMateSecureChoiceDialog");
    let wc = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(choice_dialog_proc),
        hInstance: hinstance,
        lpszClassName: class_name,
        hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
        hbrBackground: GetSysColorBrush(COLOR_WINDOW),
        ..Default::default()
    };
    let _ = RegisterClassW(&wc);

    let title_w = to_wide(title);
    let hwnd = CreateWindowExW(
        WS_EX_DLGMODALFRAME | WS_EX_TOPMOST,
        class_name,
        PCWSTR(title_w.as_ptr()),
        WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
        220,
        220,
        420,
        180,
        None,
        None,
        Some(hinstance),
        None,
    )
    .map_err(|e| PromptError::Native(e.to_string()))?;

    let msg_w = to_wide(message);
    let _ = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        w!("STATIC"),
        PCWSTR(msg_w.as_ptr()),
        WS_CHILD | WS_VISIBLE,
        16,
        16,
        370,
        48,
        Some(hwnd),
        None,
        Some(hinstance),
        None,
    )
    .map_err(|e| PromptError::Native(e.to_string()))?;
    let _ = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        w!("BUTTON"),
        w!("Choose File"),
        WS_CHILD | WS_VISIBLE | style_bits(BS_PUSHBUTTON),
        20,
        90,
        110,
        28,
        Some(hwnd),
        Some(menu_id(IDC_FILE)),
        Some(hinstance),
        None,
    )
    .map_err(|e| PromptError::Native(e.to_string()))?;
    let _ = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        w!("BUTTON"),
        w!("Paste Key"),
        WS_CHILD | WS_VISIBLE | style_bits(BS_PUSHBUTTON),
        150,
        90,
        110,
        28,
        Some(hwnd),
        Some(menu_id(IDC_PASTE)),
        Some(hinstance),
        None,
    )
    .map_err(|e| PromptError::Native(e.to_string()))?;
    let _ = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        w!("BUTTON"),
        w!("Cancel"),
        WS_CHILD | WS_VISIBLE | style_bits(BS_PUSHBUTTON),
        290,
        90,
        90,
        28,
        Some(hwnd),
        Some(menu_id(IDC_CANCEL)),
        Some(hinstance),
        None,
    )
    .map_err(|e| PromptError::Native(e.to_string()))?;

    pump_until_destroyed(hwnd)
}

unsafe extern "system" fn choice_dialog_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::WindowsAndMessaging::*;

    match msg {
        WM_COMMAND => {
            let id = (wparam.0 & 0xFFFF) as i32;
            let outcome = match id {
                IDC_FILE => Some(DialogOutcome::ChooseFile),
                IDC_PASTE => Some(DialogOutcome::ChoosePaste),
                IDC_CANCEL => Some(DialogOutcome::Cancel),
                _ => None,
            };
            if let Some(o) = outcome {
                DIALOG_RESULT.with(|c| *c.borrow_mut() = Some(o));
                let _ = DestroyWindow(hwnd);
                return LRESULT(0);
            }
        }
        WM_CLOSE => {
            DIALOG_RESULT.with(|c| *c.borrow_mut() = Some(DialogOutcome::Cancel));
            let _ = DestroyWindow(hwnd);
            return LRESULT(0);
        }
        WM_DESTROY => {
            // Do not PostQuitMessage: the private pump exits via IsWindow(false)
            // after DestroyWindow. A thread-wide WM_QUIT would stale-quit later prompts.
            return LRESULT(0);
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// Capture EDIT text into Zeroizing; zeroize UTF-16 scratch on every path.
unsafe fn read_window_text_zeroizing(hwnd: windows::Win32::Foundation::HWND) -> Zeroizing<String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return Zeroizing::new(String::new());
    }
    let mut buf = vec![0u16; (len + 1) as usize];
    let n = GetWindowTextW(hwnd, &mut buf);
    if n <= 0 {
        buf.zeroize();
        return Zeroizing::new(String::new());
    }
    // Wrap into Zeroizing immediately — no raw secret String local.
    // from_utf16_lossy returns String (not Cow); wrap directly before buf.zeroize().
    let secret = Zeroizing::new(String::from_utf16_lossy(&buf[..n as usize]));
    buf.zeroize();
    secret
}

fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
