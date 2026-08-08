//! Native-only short-lived WSS token parse (never WebView / never sanitized JSON Value).
//!
//! Security: move response bytes into [`Zeroizing`], deserialize a typed body, then
//! **move** the `String` into `Zeroizing<String>` (no clone of the secret).

use super::error::ProxyError;
use serde::Deserialize;
use zeroize::Zeroizing;

/// Upper bound for short-lived WS tokens (JWT-scale; fail closed if larger).
pub const MAX_WS_TOKEN_LEN: usize = 4096;

#[derive(Deserialize)]
struct NativeWsTokenBody {
    token: String,
}

/// Validate token is non-empty, bounded, and a safe opaque ASCII shape (JWT / base64url-ish).
pub fn validate_ws_token_shape(token: &str) -> bool {
    if token.is_empty() || token.len() > MAX_WS_TOKEN_LEN {
        return false;
    }
    token.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'_' | b'.' | b'~' | b'+' | b'/' | b'=' | b':')
    })
}

/// Parse mint response body. Consumes Zeroizing bytes; returns Zeroizing token.
///
/// Token is moved into [`Zeroizing`] **before** shape validation so reject paths
/// wipe plaintext on drop (no plain `String` left live after validation fails).
pub fn parse_ws_token_body(body: Zeroizing<Vec<u8>>) -> Result<Zeroizing<String>, ProxyError> {
    let raw = std::str::from_utf8(body.as_slice()).map_err(|_| ProxyError::InvalidResponse)?;
    let parsed: NativeWsTokenBody =
        serde_json::from_str(raw).map_err(|_| ProxyError::InvalidResponse)?;
    // Wipe raw body before handling token.
    drop(body);
    // Move secret into Zeroizing immediately — reject must not drop a bare String.
    let token = Zeroizing::new(parsed.token);
    if !validate_ws_token_shape(token.as_str()) {
        // Explicit wipe on reject (Zeroizing Drop also zeroizes; keep intent clear).
        drop(token);
        return Err(ProxyError::InvalidResponse);
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_moves_token_without_value_path() {
        let body =
            Zeroizing::new(br#"{"token":"abc.def_GHI-012","expires_in_seconds":60}"#.to_vec());
        let tok = parse_ws_token_body(body).unwrap();
        assert_eq!(tok.as_str(), "abc.def_GHI-012");
    }

    #[test]
    fn parse_rejects_empty_oversize_and_illegal_shape() {
        assert!(parse_ws_token_body(Zeroizing::new(br#"{"token":""}"#.to_vec())).is_err());
        let huge = format!(r#"{{"token":"{}"}}"#, "a".repeat(MAX_WS_TOKEN_LEN + 1));
        assert!(parse_ws_token_body(Zeroizing::new(huge.into_bytes())).is_err());
        assert!(
            parse_ws_token_body(Zeroizing::new(br#"{"token":"evil token"}"#.to_vec())).is_err()
        );
        assert!(parse_ws_token_body(Zeroizing::new(br#"{"token":"a\nb"}"#.to_vec())).is_err());
    }

    #[test]
    fn reject_path_wraps_in_zeroizing_before_validate() {
        // Behavioral: illegal token is rejected; success path returns Zeroizing.
        // Source order invariant: Zeroizing::new happens before validate_ws_token_shape.
        let bad = parse_ws_token_body(Zeroizing::new(br#"{"token":"bad token"}"#.to_vec()));
        assert!(bad.is_err());
        let good =
            parse_ws_token_body(Zeroizing::new(br#"{"token":"ok-token_1"}"#.to_vec())).unwrap();
        assert_eq!(good.as_str(), "ok-token_1");
    }

    #[test]
    fn source_has_no_serde_json_value_or_token_clone() {
        let src = include_str!("ws_token.rs");
        // Exclude this test's string literals by scanning only the production region.
        let prod = src.split("#[cfg(test)]").next().unwrap();
        assert!(
            !prod.contains("serde_json::Value") && !prod.contains("Value::"),
            "ws_token parse must not use serde_json::Value"
        );
        assert!(
            !prod.contains(".clone()") && !prod.contains("token.to_"),
            "must move token String into Zeroizing without clone helpers"
        );
        assert!(
            prod.contains("Zeroizing::new(parsed.token)"),
            "must wrap parsed.token immediately"
        );
        // Zeroizing wrap must precede shape validation.
        let wrap = prod.find("Zeroizing::new(parsed.token)").expect("wrap");
        let validate = prod
            .find("validate_ws_token_shape(token.as_str())")
            .expect("validate");
        assert!(
            wrap < validate,
            "wrap before validate so reject wipes Zeroizing"
        );
        assert!(prod.contains("drop(token)"), "explicit drop on reject path");
        assert!(prod.contains("struct NativeWsTokenBody"));
    }
}
