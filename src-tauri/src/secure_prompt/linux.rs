//! Linux native secure prompts: GTK3 Dialog + hidden Entry / TextView + rfd.
//! Secrets convert into Zeroizing at capture (no raw String across boundaries).

use super::{NativeSecurePrompt, PromptError, SecurePrompt};
use zeroize::Zeroizing;

impl SecurePrompt for NativeSecurePrompt {
    fn prompt_password(
        &self,
        title: &str,
        message: &str,
    ) -> Result<Zeroizing<String>, PromptError> {
        let s = run_entry_dialog(title, message, true)?;
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
        let s = run_entry_dialog(title, message, true)?;
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
        let s = run_textview_dialog(title, "Paste PEM private key (never entered in WebView)")?;
        if s.trim().is_empty() {
            return Err(PromptError::Cancelled);
        }
        Ok(s)
    }

    fn choose_pem_import(&self) -> Result<Zeroizing<String>, PromptError> {
        ensure_gtk()?;
        use gtk::prelude::*;
        use gtk::{Dialog, DialogFlags, Label, ResponseType};

        let dialog = Dialog::with_buttons(
            Some("Import SSH private key"),
            None::<&gtk::Window>,
            DialogFlags::MODAL,
            &[
                ("Choose File", ResponseType::Accept),
                ("Paste Key", ResponseType::Apply),
                ("Cancel", ResponseType::Cancel),
            ],
        );
        let area = dialog.content_area();
        let label = Label::new(Some(
            "Choose a key file or paste PEM. Selection stays native (never WebView).",
        ));
        label.set_line_wrap(true);
        area.add(&label);
        dialog.set_default_size(420, 140);
        dialog.show_all();
        let response = dialog.run();
        dialog.hide();
        dialog.close();

        match response {
            ResponseType::Accept => {
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
            ResponseType::Apply => self.prompt_pem_paste("Paste SSH private key"),
            _ => Err(PromptError::Cancelled),
        }
    }
}

fn ensure_gtk() -> Result<(), PromptError> {
    if gtk::is_initialized() || gtk::init().is_ok() {
        Ok(())
    } else {
        Err(PromptError::Native("gtk init failed".into()))
    }
}

fn run_entry_dialog(
    title: &str,
    message: &str,
    hide: bool,
) -> Result<Zeroizing<String>, PromptError> {
    ensure_gtk()?;
    use gtk::prelude::*;
    use gtk::{Dialog, DialogFlags, Entry, Label, Orientation, ResponseType};

    let dialog = Dialog::with_buttons(
        Some(title),
        None::<&gtk::Window>,
        DialogFlags::MODAL,
        &[("OK", ResponseType::Ok), ("Cancel", ResponseType::Cancel)],
    );
    let area = dialog.content_area();
    area.set_spacing(8);
    let vbox = gtk::Box::new(Orientation::Vertical, 6);
    let label = Label::new(Some(message));
    label.set_line_wrap(true);
    let entry = Entry::new();
    // Hidden Entry for password/passphrase (GTK3).
    if hide {
        entry.set_visibility(false);
        entry.set_input_purpose(gtk::InputPurpose::Password);
    }
    vbox.add(&label);
    vbox.add(&entry);
    area.add(&vbox);
    dialog.set_default_size(400, 140);
    dialog.show_all();
    let response = dialog.run();
    // Capture into Zeroizing at the GTK boundary (no raw String return).
    let secret = if response == ResponseType::Ok {
        Zeroizing::new(entry.text().to_string())
    } else {
        Zeroizing::new(String::new())
    };
    dialog.hide();
    dialog.close();
    if response != ResponseType::Ok {
        return Err(PromptError::Cancelled);
    }
    Ok(secret)
}

fn run_textview_dialog(title: &str, message: &str) -> Result<Zeroizing<String>, PromptError> {
    ensure_gtk()?;
    use gtk::prelude::*;
    use gtk::{Dialog, DialogFlags, Label, Orientation, ResponseType, ScrolledWindow, TextView};

    let dialog = Dialog::with_buttons(
        Some(title),
        None::<&gtk::Window>,
        DialogFlags::MODAL,
        &[("OK", ResponseType::Ok), ("Cancel", ResponseType::Cancel)],
    );
    let area = dialog.content_area();
    let vbox = gtk::Box::new(Orientation::Vertical, 6);
    let label = Label::new(Some(message));
    label.set_line_wrap(true);
    let scrolled = ScrolledWindow::default();
    scrolled.set_min_content_height(140);
    let text_view = TextView::new();
    text_view.set_wrap_mode(gtk::WrapMode::WordChar);
    scrolled.add(&text_view);
    vbox.add(&label);
    vbox.add(&scrolled);
    area.add(&vbox);
    dialog.set_default_size(480, 280);
    dialog.show_all();
    let response = dialog.run();
    let secret = if response == ResponseType::Ok {
        // No panic on secret path: missing buffer → fixed Native error (no secret content).
        let Some(buffer) = text_view.buffer() else {
            dialog.hide();
            dialog.close();
            return Err(PromptError::Native("text buffer unavailable".into()));
        };
        let (start, end) = buffer.bounds();
        // Capture into Zeroizing immediately (empty text is fine; caller trims).
        Zeroizing::new(
            buffer
                .text(&start, &end, false)
                .map(|g| g.to_string())
                .unwrap_or_default(),
        )
    } else {
        Zeroizing::new(String::new())
    };
    dialog.hide();
    dialog.close();
    if response != ResponseType::Ok {
        return Err(PromptError::Cancelled);
    }
    Ok(secret)
}
