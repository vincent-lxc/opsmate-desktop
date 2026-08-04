//! OpsMate Desktop library entry — foundation shell only.
//!
//! Capability boundary (foundation stage):
//! - WebView gets `core:default` only.
//! - No shell / opener / deep-link / stronghold plugins registered.
//! - Cloud transport is allowlist-only (`cloud_transport::operations`); HTTP client later.

pub mod cloud_transport;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running OpsMate Desktop");
}

#[cfg(test)]
mod tests {
    #[test]
    fn foundation_crate_builds() {
        // Smoke test so `cargo test` exercises the rlib target.
        assert_eq!(env!("CARGO_PKG_NAME"), "opsmate-desktop");
    }

    #[test]
    fn frontend_dist_is_independent_dist() {
        let conf = include_str!("../tauri.conf.json");
        assert!(
            conf.contains("\"frontendDist\": \"../dist\""),
            "frontendDist must be independent ../dist"
        );
        assert!(
            !conf.contains("../../admin/dist"),
            "must not reference monorepo admin/dist"
        );
        assert!(
            !conf.contains("ops-ai/apps/admin"),
            "must not reference ops-ai admin path"
        );
    }

    #[test]
    fn foundation_csp_is_self_only_connect() {
        let conf = include_str!("../tauri.conf.json");
        assert!(
            conf.contains("connect-src 'self'"),
            "foundation CSP connect-src must be self only"
        );
        assert!(
            !conf.contains("connect-src https://app.itops.sh"),
            "cloud connect-src is deferred until native transport lands"
        );
    }

    #[test]
    fn default_capability_has_no_shell_or_opener() {
        let cap = include_str!("../capabilities/default.json");
        assert!(cap.contains("core:default"));
        assert!(!cap.contains("shell:"));
        assert!(!cap.contains("opener:"));
        assert!(!cap.contains("stronghold:"));
        assert!(!cap.contains("deep-link:"));
    }
}
