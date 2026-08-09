//! Outbound redaction for POST `/api/servers/{id}/terminal/ai` only.
//!
//! Copies and sanitizes the request JSON body before transport — never mutates
//! WebView state and never logs original or redacted secret material.

use super::error::ProxyError;
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

/// UTF-8 **byte** cap for `terminal_output` (right-trim; always on a char boundary).
pub const MAX_TERMINAL_AI_OUTPUT_BYTES: usize = 12_000;

const REDACTED: &str = "[REDACTED_SECRET]";
const REDACTED_BEARER: &str = "Bearer [REDACTED_SECRET]";

/// PEM private-key blocks with **matching** BEGIN/END labels (non-greedy).
/// Separate patterns (rustc `regex` has no backrefs): each label pairs with itself.
/// Order: more-specific labels before bare `PRIVATE KEY` (PKCS#8).
fn pem_res() -> &'static [Regex] {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    RES.get_or_init(|| {
        const LABELS: &[&str] = &[
            "OPENSSH PRIVATE KEY",
            "RSA PRIVATE KEY",
            "EC PRIVATE KEY",
            "DSA PRIVATE KEY",
            "ENCRYPTED PRIVATE KEY",
            "PRIVATE KEY",
        ];
        LABELS
            .iter()
            .map(|label| {
                Regex::new(&format!(
                    r"(?s)-----BEGIN {label}-----\r?\n.*?-----END {label}-----"
                ))
                .expect("pem label regex")
            })
            .collect()
    })
    .as_slice()
}

/// Object keys that always redact their string value (even without `=`/`:` assignment).
fn is_secret_object_key(key: &str) -> bool {
    let n: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    matches!(
        n.as_str(),
        "password"
            | "passwd"
            | "passphrase"
            | "secret"
            | "token"
            | "apikey"
            | "privatekey"
            | "sshprivatekey"
            | "privatekeypem"
    ) || n.contains("password")
        || n.contains("passphrase")
        || n == "secret"
        || n.ends_with("token")
        || n.ends_with("secret")
        || n.contains("apikey")
        || n.contains("privatekey")
}

fn bearer_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9\-._~+/=]+").expect("bearer regex"))
}

/// Bare assignments: `password=…`, `passphrase: '…'`, `token: …`
fn password_assign_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\b(password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key)\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)"#,
        )
        .expect("password assign regex")
    })
}

/// Quoted JSON object keys: `"password": "…"`, `"passphrase": "…"`, `"token": "…"`.
fn json_secret_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)("(?:password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key)"\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\s]+)"#,
        )
        .expect("json secret key regex")
    })
}

/// Redact free text: PEM, Bearer, bare assignments, and quoted JSON secret keys.
pub fn redact_terminal_ai_text(input: &str) -> String {
    let mut out = input.to_string();
    for re in pem_res() {
        out = re.replace_all(&out, REDACTED).into_owned();
    }
    out = bearer_re().replace_all(&out, REDACTED_BEARER).into_owned();
    out = password_assign_re()
        .replace_all(&out, |caps: &regex::Captures| {
            format!("{}{}{}", &caps[1], &caps[2], REDACTED)
        })
        .into_owned();
    out = json_secret_key_re()
        .replace_all(&out, |caps: &regex::Captures| {
            format!("{}\"{}\"", &caps[1], REDACTED)
        })
        .into_owned();
    out
}

/// Right-cap to at most `max_bytes` UTF-8 bytes, always on a character boundary.
pub fn cap_terminal_output_bytes(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_string();
    }
    let mut start = input.len().saturating_sub(max_bytes);
    while start < input.len() && !input.is_char_boundary(start) {
        start += 1;
    }
    input[start..].to_string()
}

/// True when path is the terminal AI route family.
pub fn is_terminal_ai_path(method: &str, path: &str) -> bool {
    method.eq_ignore_ascii_case("POST")
        && path.starts_with("/api/servers/")
        && path.ends_with("/terminal/ai")
        && !path.contains('?')
        && !path.contains('#')
}

/// Copy + deep-redact outbound JSON for terminal AI. Fail closed on non-object bodies.
///
/// All string values are text-redacted; secret-named object keys force value
/// replacement even when the string has no assignment prefix. Only
/// `terminal_output` is additionally byte-capped.
pub fn redact_terminal_ai_request_body(body: &Value) -> Result<Value, ProxyError> {
    let obj = body.as_object().ok_or(ProxyError::InvalidInput)?;
    let mut out = Map::new();
    for (k, v) in obj {
        if k == "terminal_output" {
            let s = match v {
                Value::String(s) => s.as_str(),
                Value::Null => {
                    out.insert(k.clone(), Value::Null);
                    continue;
                }
                _ => return Err(ProxyError::InvalidInput),
            };
            let redacted = redact_terminal_ai_text(s);
            let capped = cap_terminal_output_bytes(&redacted, MAX_TERMINAL_AI_OUTPUT_BYTES);
            debug_assert!(capped.len() <= MAX_TERMINAL_AI_OUTPUT_BYTES);
            debug_assert!(capped.is_char_boundary(0) || capped.is_empty());
            out.insert(k.clone(), Value::String(capped));
        } else {
            out.insert(k.clone(), redact_json_value(k, v));
        }
    }
    Ok(Value::Object(out))
}

/// Deep-sanitize a JSON value. `parent_key` is the object key that held `v`.
fn redact_json_value(parent_key: &str, v: &Value) -> Value {
    match v {
        Value::String(s) => {
            if is_secret_object_key(parent_key) {
                Value::String(REDACTED.to_string())
            } else {
                Value::String(redact_terminal_ai_text(s))
            }
        }
        Value::Array(items) => {
            // Array elements inherit no key name for secret-key checks.
            Value::Array(
                items
                    .iter()
                    .map(|child| redact_json_value("", child))
                    .collect(),
            )
        }
        Value::Object(map) => {
            let mut o = Map::new();
            for (k, child) in map {
                o.insert(k.clone(), redact_json_value(k, child));
            }
            Value::Object(o)
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => v.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_pem_bearer_and_password_patterns() {
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
        let text = format!(
            "key={pem}\nAuthorization: Bearer super.secret.token\npassword=hunter2\npassphrase: 'secret'\n"
        );
        let out = redact_terminal_ai_text(&text);
        assert!(!out.contains("MIIE"));
        assert!(!out.contains("super.secret.token"));
        assert!(!out.contains("hunter2"));
        assert!(out.contains(REDACTED) || out.contains(REDACTED_BEARER));
        assert!(out.contains("Bearer [REDACTED_SECRET]") || out.contains(REDACTED));
    }

    #[test]
    fn redacts_pkcs8_and_encrypted_pkcs8_pem_blocks() {
        let pkcs8 = "-----BEGIN PRIVATE KEY-----\nPKCS8SECRETMATERIAL\n-----END PRIVATE KEY-----";
        let enc = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nENCRYPTEDSECRETMATERIAL\n-----END ENCRYPTED PRIVATE KEY-----";
        let openssh = "-----BEGIN OPENSSH PRIVATE KEY-----\nOPENSSHMATERIAL\n-----END OPENSSH PRIVATE KEY-----";
        let text = format!("{pkcs8}\n{enc}\n{openssh}\n");
        let out = redact_terminal_ai_text(&text);
        assert!(
            !out.contains("PKCS8SECRETMATERIAL"),
            "generic PKCS#8 must be redacted, got {out}"
        );
        assert!(
            !out.contains("ENCRYPTEDSECRETMATERIAL"),
            "encrypted PKCS#8 must be redacted, got {out}"
        );
        assert!(!out.contains("OPENSSHMATERIAL"));
        assert!(out.contains(REDACTED));
        // Mismatched BEGIN/END labels must not over-consume adjacent text.
        let mismatch = "-----BEGIN PRIVATE KEY-----\nX\n-----END RSA PRIVATE KEY-----\nKEEP_ME";
        let out2 = redact_terminal_ai_text(mismatch);
        // If labels don't match, block is left (or partially handled) but KEEP_ME stays.
        assert!(out2.contains("KEEP_ME"));
    }

    #[test]
    fn deep_redacts_secret_named_fields_outside_messages_and_terminal_output() {
        let original = json!({
            "messages": [{"role": "user", "content": "hi"}],
            "terminal_output": "ok",
            "password": "top-secret-pw",
            "api_key": "ak_live_xxx",
            "nested": { "passphrase": "nested-secret", "label": "safe" },
            "notes": "Bearer nested.jwt.here",
            "keep_number": 7
        });
        let redacted = redact_terminal_ai_request_body(&original).unwrap();
        // Original untouched.
        assert_eq!(original["password"], "top-secret-pw");
        assert_eq!(original["api_key"], "ak_live_xxx");
        assert_eq!(original["nested"]["passphrase"], "nested-secret");
        // Copied outbound redacted.
        assert_eq!(redacted["password"], REDACTED);
        assert_eq!(redacted["api_key"], REDACTED);
        assert_eq!(redacted["nested"]["passphrase"], REDACTED);
        assert_eq!(redacted["nested"]["label"], "safe");
        assert!(!redacted["notes"]
            .as_str()
            .unwrap()
            .contains("nested.jwt.here"));
        assert_eq!(redacted["keep_number"], 7);
    }

    #[test]
    fn redacts_quoted_json_password_passphrase_token_keys() {
        let text = r#"{"password":"p@ss","passphrase":"ph rase","token":"t0k","other":"ok"}"#;
        let out = redact_terminal_ai_text(text);
        assert!(!out.contains("p@ss"));
        assert!(!out.contains("ph rase"));
        assert!(!out.contains("t0k"));
        assert!(out.contains(r#""password":"[REDACTED_SECRET]""#));
        assert!(out.contains(r#""passphrase":"[REDACTED_SECRET]""#));
        assert!(out.contains(r#""token":"[REDACTED_SECRET]""#));
        assert!(out.contains(r#""other":"ok""#));
    }

    #[test]
    fn caps_terminal_output_utf8_byte_bounded_on_char_boundary() {
        // Multi-byte chars (3 bytes each for 文) so byte cap ≠ char count.
        let s = "文".repeat(MAX_TERMINAL_AI_OUTPUT_BYTES); // way over in bytes
        let capped = cap_terminal_output_bytes(&s, MAX_TERMINAL_AI_OUTPUT_BYTES);
        assert!(capped.len() <= MAX_TERMINAL_AI_OUTPUT_BYTES);
        assert!(capped.is_char_boundary(0));
        assert!(std::str::from_utf8(capped.as_bytes()).is_ok());
        // Force mid-char start: 文 is 3 bytes; max_bytes not multiple of 3.
        let s2 = format!("a{}", "文".repeat(100));
        let c2 = cap_terminal_output_bytes(&s2, 10);
        assert!(c2.len() <= 10);
        assert!(c2.is_char_boundary(0));
        assert!(std::str::from_utf8(c2.as_bytes()).is_ok());
    }

    #[test]
    fn redact_request_body_only_mutates_copy_and_fails_closed_on_array() {
        let original = json!({
            "messages": [{"role": "user", "content": "hi Bearer abc.def"}],
            "terminal_output": format!("x{}", "y".repeat(MAX_TERMINAL_AI_OUTPUT_BYTES + 10)),
            "keep": 1
        });
        let redacted = redact_terminal_ai_request_body(&original).unwrap();
        assert!(original["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("Bearer abc.def"));
        let out_s = redacted["terminal_output"].as_str().unwrap();
        assert!(out_s.len() <= MAX_TERMINAL_AI_OUTPUT_BYTES);
        assert!(!out_s.contains("Bearer abc.def") || out_s.contains("REDACTED"));
        assert_eq!(redacted["keep"], 1);
        assert!(redact_terminal_ai_request_body(&json!([])).is_err());
        assert!(redact_terminal_ai_request_body(&json!("x")).is_err());
    }

    #[test]
    fn is_terminal_ai_path_strict() {
        assert!(is_terminal_ai_path(
            "POST",
            "/api/servers/srv_1/terminal/ai"
        ));
        assert!(!is_terminal_ai_path(
            "GET",
            "/api/servers/srv_1/terminal/ai"
        ));
        assert!(!is_terminal_ai_path("POST", "/api/servers/srv_1/terminal"));
        assert!(!is_terminal_ai_path(
            "POST",
            "/api/servers/srv_1/terminal/ai?x=1"
        ));
    }
}
