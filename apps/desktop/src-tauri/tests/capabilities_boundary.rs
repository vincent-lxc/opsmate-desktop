//! WebView capability boundary (D0 security):
//! `capabilities/default.json` must not grant plugin command surfaces to the SPA.

use std::fs;
use std::path::PathBuf;

fn default_capability_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json")
}

fn permission_strings(json: &serde_json::Value) -> Vec<String> {
    json.get("permissions")
        .and_then(|p| p.as_array())
        .expect("capabilities/default.json must have a permissions array")
        .iter()
        .map(|v| {
            // Tauri allows either "core:default" strings or objects with an identifier.
            if let Some(s) = v.as_str() {
                return s.to_string();
            }
            if let Some(obj) = v.as_object() {
                if let Some(id) = obj.get("identifier").and_then(|x| x.as_str()) {
                    return id.to_string();
                }
            }
            v.to_string()
        })
        .collect()
}

#[test]
fn default_capability_has_no_opener_deep_link_or_stronghold_permissions() {
    let path = default_capability_path();
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let json: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

    let perms = permission_strings(&json);
    assert!(
        !perms.is_empty(),
        "expected at least core UI permission(s) in default capability"
    );

    for p in &perms {
        let lower = p.to_ascii_lowercase();
        assert!(
            !lower.starts_with("opener:") && !lower.contains("opener:"),
            "WebView must not get opener plugin permissions; found {p:?}"
        );
        assert!(
            !lower.starts_with("deep-link:") && !lower.contains("deep-link:"),
            "WebView must not get deep-link plugin permissions; found {p:?}"
        );
        assert!(
            !lower.starts_with("stronghold:") && !lower.contains("stronghold:"),
            "WebView must not get stronghold plugin permissions; found {p:?}"
        );
    }

    // Also scan the raw file so object-shaped grants cannot hide prefixes.
    let raw_lower = raw.to_ascii_lowercase();
    for forbidden in ["opener:", "deep-link:", "stronghold:"] {
        assert!(
            !raw_lower.contains(forbidden),
            "capabilities/default.json must not contain permission string {forbidden:?}"
        );
    }
}

#[test]
fn default_capability_keeps_minimal_core_permission() {
    let path = default_capability_path();
    let raw = fs::read_to_string(&path).expect("read default.json");
    let json: serde_json::Value = serde_json::from_str(&raw).expect("parse default.json");
    let perms = permission_strings(&json);
    assert!(
        perms
            .iter()
            .any(|p| p == "core:default" || p.starts_with("core:")),
        "expected a minimal Tauri core permission; got {perms:?}"
    );
}

#[test]
fn default_capability_is_main_window_with_named_app_commands_only() {
    let path = default_capability_path();
    let raw = fs::read_to_string(&path).expect("read default.json");
    let json: serde_json::Value = serde_json::from_str(&raw).expect("parse default.json");

    let windows = json
        .get("windows")
        .and_then(|w| w.as_array())
        .expect("capabilities/default.json must declare windows");
    let labels: Vec<&str> = windows.iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(
        labels,
        vec!["main"],
        "WebView capability must apply only to the main local window; got {labels:?}"
    );

    let perms = permission_strings(&json);
    // Named application IPC surface (permissions/desktop-ipc.toml).
    assert!(
        perms.iter().any(|p| p == "allow-desktop-ipc"),
        "expected allow-desktop-ipc for named app commands; got {perms:?}"
    );
    // Event listen for terminal/auth events (no opener/deep-link/stronghold).
    assert!(
        perms
            .iter()
            .any(|p| p == "core:event:default" || p.starts_with("core:event:")),
        "expected core event permission for desktopListen; got {perms:?}"
    );

    // Must not grant remote / broad plugin surfaces.
    let raw_lower = raw.to_ascii_lowercase();
    for forbidden in ["opener:", "deep-link:", "stronghold:", "shell:", "http:"] {
        assert!(
            !raw_lower.contains(forbidden),
            "capabilities/default.json must not contain {forbidden:?}"
        );
    }
}

#[test]
fn desktop_ipc_permission_lists_exact_named_commands() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("permissions/desktop-ipc.toml");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "read {}: {e} (Task 10 named IPC permission)",
            path.display()
        )
    });
    // Exact allowlist body — keep in sync with Admin DESKTOP_IPC_COMMANDS.
    for cmd in [
        "auth_begin_logto",
        "auth_logout",
        "auth_session_status",
        "auth_on_unauthorized",
        "vault_status",
        "vault_init",
        "vault_unlock",
        "vault_lock",
        "vault_import",
        "vault_list_meta",
        "vault_delete_local",
        "local_ssh_open",
        "local_ssh_write",
        "local_ssh_resize",
        "local_ssh_close",
        "cloud_terminal_open",
        "cloud_terminal_write",
        "cloud_terminal_resize",
        "cloud_terminal_close",
        "request_cloud_upload",
        "request_cloud_delete",
        "cloud_request",
        "open_external_route",
    ] {
        assert!(
            raw.contains(&format!("\"{cmd}\"")) || raw.contains(&format!("'{cmd}'")),
            "permissions/desktop-ipc.toml must allow {cmd}"
        );
    }
    let lower = raw.to_ascii_lowercase();
    assert!(
        !lower.contains("plugin-opener")
            && !lower.contains("opener:")
            && !lower.contains("\"open_url\"")
            && !lower.contains("'open_url'"),
        "desktop-ipc permission must not grant opener plugin / open_url"
    );
}
