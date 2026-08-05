//! Recursive response sanitizer — strip secrets/internal fields before React.
//! Also rejects duplicate object keys at the raw JSON parse boundary (fail closed).

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::fmt;

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
    STRIP_NORMALIZED.contains(&normalized.as_str())
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

/// Parse JSON and return a sanitized value.
/// Rejects duplicate object keys at any nesting level (no last-wins).
/// Invalid JSON or duplicate keys → `Err(())` (caller maps to `InvalidResponse`).
/// Unit err is intentional: no parse-body leakage into public error types.
#[allow(clippy::result_unit_err)]
pub fn sanitize_response_json(raw: &str) -> Result<Value, ()> {
    let mut value = parse_json_reject_duplicate_keys(raw)?;
    sanitize_value(&mut value);
    Ok(value)
}

/// Deserialize JSON into `Value`, failing if any object has a repeated key.
/// Requires the stream to end after one value (rejects trailing JSON/garbage).
#[allow(clippy::result_unit_err)] // maps to fixed InvalidResponse; no body in Err
fn parse_json_reject_duplicate_keys(raw: &str) -> Result<Value, ()> {
    let mut de = serde_json::Deserializer::from_str(raw);
    let value = NoDupValue::deserialize(&mut de)
        .map(|v| v.0)
        .map_err(|_| ())?;
    de.end().map_err(|_| ())?;
    Ok(value)
}

/// Wrapper that deserializes JSON with duplicate-key rejection.
struct NoDupValue(Value);

impl<'de> Deserialize<'de> for NoDupValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(NoDupVisitor).map(NoDupValue)
    }
}

struct NoDupVisitor;

impl<'de> Visitor<'de> for NoDupVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any valid JSON value without duplicate object keys")
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        Ok(v.into())
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        Ok(v.into())
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        Ok(serde_json::Number::from_f64(v)
            .map(Value::Number)
            .unwrap_or(Value::Null))
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }

    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }

    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut out = Vec::new();
        while let Some(elem) = seq.next_element::<NoDupValue>()? {
            out.push(elem.0);
        }
        Ok(Value::Array(out))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("duplicate object key"));
            }
            let value = map.next_value::<NoDupValue>()?;
            values.insert(key, value.0);
        }
        Ok(Value::Object(values))
    }
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

    #[test]
    fn rejects_duplicate_keys_top_level() {
        // Last-wins would silently pick srv-1; we must fail closed.
        let raw = r#"{"id":"srv-A","id":"srv-1","tenant_id":"t","ip":"10.0.0.1"}"#;
        assert!(
            sanitize_response_json(raw).is_err(),
            "duplicate top-level id must be InvalidResponse"
        );
    }

    #[test]
    fn rejects_duplicate_keys_nested() {
        let raw = r#"{"ok":1,"nested":{"x":1,"x":2,"token":"sekrit"}}"#;
        assert!(
            sanitize_response_json(raw).is_err(),
            "nested duplicate keys must fail before secret strip"
        );
    }

    #[test]
    fn rejects_duplicate_keys_in_array_objects() {
        let raw = r#"{"items":[{"id":"a","id":"b"}]}"#;
        assert!(sanitize_response_json(raw).is_err());
    }

    #[test]
    fn accepts_unique_keys_and_still_strips_secrets() {
        let raw = r#"{"id":"srv-1","token":"LEAK","nested":{"ok":true,"password":"p"}}"#;
        let v = sanitize_response_json(raw).expect("unique keys ok");
        assert_eq!(v["id"], "srv-1");
        assert!(v.get("token").is_none());
        assert_eq!(v["nested"]["ok"], true);
        assert!(v["nested"].get("password").is_none());
    }

    #[test]
    fn invalid_json_still_errors() {
        assert!(sanitize_response_json("not-json{{{").is_err());
    }

    #[test]
    fn rejects_trailing_object_after_valid_value() {
        assert!(sanitize_response_json(r#"{"ok":true}{"x":1}"#).is_err());
    }

    #[test]
    fn rejects_trailing_scalar_after_valid_value() {
        assert!(sanitize_response_json(r#"{"ok":true}1"#).is_err());
        assert!(sanitize_response_json(r#"{"ok":true}true"#).is_err());
    }

    #[test]
    fn rejects_trailing_garbage_after_valid_value() {
        assert!(sanitize_response_json(r#"{"ok":true} garbage"#).is_err());
        assert!(sanitize_response_json(r#"[1,2] trailing"#).is_err());
    }

    #[test]
    fn accepts_single_value_with_trailing_whitespace() {
        let v = sanitize_response_json("{\"ok\":true}\n  ").expect("ws after value ok");
        assert_eq!(v["ok"], true);
    }
}
