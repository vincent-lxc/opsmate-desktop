//! Recursive response sanitizer — strip secrets/internal fields before React.

use serde_json::{Map, Value};

/// Normalized (lowercase, separators removed) exact secret field names to strip.
/// Exact match only — so `token_usage`, `password_policy`, `private_key_status`
/// and ordinary `endpoint` metadata are preserved.
const STRIP_NORMALIZED: &[&str] = &[
    // Core secrets
    "token",
    "accesstoken",
    "refreshtoken",
    "authorization",
    "privatekey",
    "privatekeypem",
    "sshprivatekey",
    "passphrase",
    "sshkeypassphrase",
    "codeverifier",
    "clientsecret",
    "password",
    "currentpassword",
    "newpassword",
    "passwordhash",
    // Session / OIDC
    "idtoken",
    "sessiontoken",
    "bearer",
    // Internal Logto / admin config leakage
    "logtoadmin",
    "adminendpoint",
    "logtoendpoint",
    "logtoadminendpoint",
];

fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn should_strip_key(key: &str) -> bool {
    let normalized = normalize_key(key);
    STRIP_NORMALIZED.iter().any(|s| *s == normalized.as_str())
}

/// Recursively remove secret/internal fields from a JSON value (in place).
/// Preserves safe business data. Does not log.
pub fn sanitize_value(value: &mut Value) {
    match value {
        Value::Object(map) => sanitize_object(map),
        Value::Array(items) => {
            for item in items.iter_mut() {
                sanitize_value(item);
            }
        }
        _ => {}
    }
}

fn sanitize_object(map: &mut Map<String, Value>) {
    let keys: Vec<String> = map.keys().cloned().collect();
    for key in keys {
        if should_strip_key(&key) {
            map.remove(&key);
            continue;
        }
        if let Some(child) = map.get_mut(&key) {
            sanitize_value(child);
        }
    }
}

/// Parse JSON and return a sanitized value. Invalid JSON → caller maps error.
pub fn sanitize_response_json(raw: &str) -> Result<Value, ()> {
    let mut value: Value = serde_json::from_str(raw).map_err(|_| ())?;
    sanitize_value(&mut value);
    Ok(value)
}

#[cfg(test)]
mod sanitize_unit_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_case_and_nested_secrets() {
        let mut v = json!({
            "username": "alice",
            "Token": "secret-a",
            "nested": {
                "ACCESS_TOKEN": "secret-b",
                "ok": 1,
                "deeper": { "codeVerifier": "pkce", "id": "x" }
            },
            "items": [
                { "refresh_token": "r", "name": "n" },
                { "Authorization": "Bearer z" }
            ],
            "password": "p",
            "admin_endpoint": "https://evil",
            "logto_admin": true
        });
        sanitize_value(&mut v);
        assert_eq!(v["username"], "alice");
        assert!(v.get("Token").is_none());
        assert!(v.get("password").is_none());
        assert!(v.get("admin_endpoint").is_none());
        assert!(v.get("logto_admin").is_none());
        assert_eq!(v["nested"]["ok"], 1);
        assert!(v["nested"].get("ACCESS_TOKEN").is_none());
        assert_eq!(v["nested"]["deeper"]["id"], "x");
        assert!(v["nested"]["deeper"].get("codeVerifier").is_none());
        assert_eq!(v["items"][0]["name"], "n");
        assert!(v["items"][0].get("refresh_token").is_none());
        assert!(v["items"][1].get("Authorization").is_none());
    }
}
