//! Task D1 — sole conf/path/CSP contract test for desktop Tauri.
//! Forbidden: node-side conf readers for this boundary.

use std::path::{Path, PathBuf};
use std::process::Command;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Tauri CLI package root: `apps/desktop` (parent of `src-tauri`).
/// `beforeBuildCommand` is executed with this directory as cwd, not CARGO_MANIFEST_DIR.
fn desktop_cli_cwd() -> PathBuf {
    manifest_dir()
        .parent()
        .expect("src-tauri parent is apps/desktop")
        .to_path_buf()
}

fn conf_path() -> PathBuf {
    manifest_dir().join("tauri.conf.json")
}

/// Extract the script path argument from `bash <path> ...`.
fn before_build_script_arg(cmd: &str) -> &str {
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    assert!(
        parts.len() >= 2 && parts[0] == "bash",
        "beforeBuildCommand must be `bash <script>`; got {cmd:?}"
    );
    parts[1]
}

fn load_conf() -> serde_json::Value {
    let path = conf_path();
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn csp_string(conf: &serde_json::Value) -> String {
    conf.pointer("/app/security/csp")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn connect_src_tokens(csp: &str) -> Vec<String> {
    // Find connect-src directive contents until next directive or end.
    let lower = csp;
    let Some(idx) = lower.find("connect-src") else {
        return Vec::new();
    };
    let rest = &lower[idx + "connect-src".len()..];
    let end = rest.find(';').unwrap_or(rest.len());
    rest[..end]
        .split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

#[test]
fn frontend_dist_is_local_admin_dist_relative_path() {
    let conf = load_conf();
    let dist = conf
        .pointer("/build/frontendDist")
        .and_then(|v| v.as_str())
        .expect("build.frontendDist must be set");
    assert_eq!(
        dist, "../../admin/dist",
        "frontendDist must be exact relative path from src-tauri to apps/admin/dist"
    );
    assert!(
        !dist.starts_with("https://") && !dist.starts_with("http://"),
        "frontendDist must not be a remote URL; got {dist}"
    );
    assert!(
        !dist.contains("app.itops.sh"),
        "frontendDist must not point at app.itops.sh; UI is local assets only"
    );
}

#[test]
fn before_build_command_resolves_script_from_apps_desktop_cli_cwd() {
    // Tauri runs beforeBuildCommand with cwd = apps/desktop (CLI package),
    // not apps/desktop/src-tauri (CARGO_MANIFEST_DIR). Paths must resolve there.
    let conf = load_conf();
    let cmd = conf
        .pointer("/build/beforeBuildCommand")
        .and_then(|v| v.as_str())
        .expect("build.beforeBuildCommand must be set");
    assert!(
        cmd.starts_with("bash "),
        "beforeBuildCommand must invoke bash; got {cmd:?}"
    );

    let script_rel = before_build_script_arg(cmd);
    assert!(
        !Path::new(script_rel).is_absolute(),
        "beforeBuildCommand script path must be relative for portable builds; got {script_rel}"
    );

    let cli_cwd = desktop_cli_cwd();
    let resolved = cli_cwd.join(script_rel);
    assert!(
        resolved.is_file(),
        "beforeBuildCommand script must exist when resolved from apps/desktop cwd; \
         cwd={}, rel={script_rel}, resolved={} (CARGO_MANIFEST_DIR={})",
        cli_cwd.display(),
        resolved.display(),
        manifest_dir().display()
    );

    // Dry-run from the same cwd Tauri uses — proves hook can execute.
    let output = Command::new("bash")
        .arg(script_rel)
        .arg("--dry-run")
        .current_dir(&cli_cwd)
        .output()
        .unwrap_or_else(|e| panic!("spawn beforeBuildCommand dry-run from apps/desktop: {e}"));
    assert!(
        output.status.success(),
        "beforeBuildCommand dry-run from apps/desktop must exit 0; stderr={} stdout={}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    assert!(
        line.ends_with("/apps/admin/dist"),
        "dry-run must print absolute admin dist; got {line:?}"
    );
}

#[test]
fn csp_connect_src_is_self_only() {
    let conf = load_conf();
    let csp = csp_string(&conf);
    assert!(
        !csp.is_empty(),
        "app.security.csp must be a non-empty string"
    );

    // No wildcard connect-src (either bare * token or connect-src *).
    assert!(
        !csp.contains("connect-src *") && !csp.contains("connect-src*"),
        "CSP must not use connect-src wildcard; got {csp}"
    );

    let tokens = connect_src_tokens(&csp);
    assert!(
        !tokens.is_empty(),
        "CSP must declare connect-src; full csp={csp}"
    );
    assert!(
        !tokens.iter().any(|t| t == "*"),
        "connect-src must not contain *; tokens={tokens:?}"
    );
    // Task 10: WebView must not open direct cloud sockets — only 'self' (local assets / IPC).
    assert_eq!(
        tokens,
        vec!["'self'".to_string()],
        "connect-src must be exactly 'self'; got {tokens:?} (full csp={csp})"
    );
    assert!(
        !csp.contains("https://app.itops.sh") && !csp.contains("wss://app.itops.sh"),
        "CSP must not allow direct app.itops.sh / wss connections; got {csp}"
    );
}

#[test]
fn desktop_build_admin_dist_script_dry_run_prints_absolute_admin_dist() {
    // Script lives at <repo>/scripts/desktop-build-admin-dist.sh
    // CARGO_MANIFEST_DIR = <repo>/apps/desktop/src-tauri
    let script = manifest_dir()
        .join("../../../scripts/desktop-build-admin-dist.sh")
        .canonicalize()
        .unwrap_or_else(|_| {
            // canonicalize fails if missing — still surface path for red evidence
            manifest_dir().join("../../../scripts/desktop-build-admin-dist.sh")
        });

    assert!(
        Path::new(&script).exists()
            || manifest_dir()
                .join("../../../scripts/desktop-build-admin-dist.sh")
                .exists(),
        "scripts/desktop-build-admin-dist.sh must exist; looked for {}",
        script.display()
    );

    let script_path = if script.exists() {
        script
    } else {
        manifest_dir().join("../../../scripts/desktop-build-admin-dist.sh")
    };

    let output = Command::new("bash")
        .arg(&script_path)
        .arg("--dry-run")
        .output()
        .unwrap_or_else(|e| panic!("spawn dry-run: {e}"));

    assert!(
        output.status.success(),
        "dry-run must exit 0; stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    assert!(
        line.ends_with("/apps/admin/dist"),
        "dry-run must print absolute path ending with /apps/admin/dist; got {line:?}\nfull stdout:\n{stdout}"
    );
    assert!(
        Path::new(line).is_absolute(),
        "dry-run path must be absolute; got {line:?}"
    );
}

#[test]
fn deep_link_desktop_scheme_is_exactly_opsmate() {
    let conf = load_conf();
    let schemes = conf
        .pointer("/plugins/deep-link/desktop/schemes")
        .and_then(|v| v.as_array())
        .expect("plugins.deep-link.desktop.schemes must be an array");
    let as_str: Vec<&str> = schemes.iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(
        as_str,
        vec!["opsmate"],
        "desktop deep-link schemes must be exactly [\"opsmate\"]; got {as_str:?}"
    );
}

#[test]
fn app_with_global_tauri_is_disabled() {
    let conf = load_conf();
    // Task 10: official `@tauri-apps/api` only — no window.__TAURI__ global injection.
    let with_global = conf.pointer("/app/withGlobalTauri");
    if let Some(v) = with_global {
        let enabled = v
            .as_bool()
            .unwrap_or_else(|| panic!("app.withGlobalTauri must be a boolean when present"));
        assert!(
            !enabled,
            "app.withGlobalTauri must be false (use @tauri-apps/api); got true"
        );
    }
    // Absence is also acceptable (Tauri default is false).
}

/// Task 22 / macOS MVP: unsigned pre-sign `.app` must be producible via bundling.
/// `bundle.active=false` only builds a bare binary and blocks UAT package evidence.
#[test]
fn macos_mvp_bundle_active_with_app_target_only() {
    let conf = load_conf();

    let active = conf
        .pointer("/bundle/active")
        .and_then(|v| v.as_bool())
        .expect("bundle.active must be set");
    assert!(
        active,
        "bundle.active must be true so `tauri build` produces a macOS .app under target/release/bundle"
    );

    let identifier = conf
        .pointer("/identifier")
        .and_then(|v| v.as_str())
        .expect("root identifier must be set");
    assert_eq!(
        identifier, "sh.itops.opsmate",
        "bundle identifier must remain sh.itops.opsmate; got {identifier}"
    );

    let dist = conf
        .pointer("/build/frontendDist")
        .and_then(|v| v.as_str())
        .expect("frontendDist must remain set");
    assert_eq!(
        dist, "../../admin/dist",
        "local frontendDist must stay ../../admin/dist; got {dist}"
    );

    // Prefer deterministic macOS app bundle only — not "all" installers (dmg/pkg/…).
    let targets = conf
        .pointer("/bundle/targets")
        .expect("bundle.targets must be set");
    let target_list: Vec<String> = if let Some(s) = targets.as_str() {
        if s == "all" {
            Vec::new()
        } else {
            vec![s.to_string()]
        }
    } else if let Some(arr) = targets.as_array() {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect()
    } else {
        panic!("bundle.targets must be a string or array; got {targets:?}");
    };

    assert!(
        !target_list.is_empty(),
        "bundle.targets must not be \"all\"; use a deterministic macOS app target (e.g. [\"app\"]); got {targets:?}"
    );
    assert!(
        target_list.iter().any(|t| t == "app"),
        "bundle.targets must include macOS \"app\" for pre-sign .app UAT; got {target_list:?}"
    );
    assert!(
        target_list.iter().all(|t| t == "app"),
        "macOS MVP should only package \"app\" (avoid building every installer); got {target_list:?}"
    );
}
