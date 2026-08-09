//! Recursive response sanitizer — strip secrets before returning to WebView.

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::fmt;

const STRIP_NORMALIZED: &[&str] = &[
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
    "idtoken",
    "sessiontoken",
    "bearer",
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

#[allow(clippy::result_unit_err)]
pub fn sanitize_response_json(raw: &str) -> Result<Value, ()> {
    let mut value = parse_json_reject_duplicate_keys(raw)?;
    sanitize_value(&mut value);
    Ok(value)
}

#[allow(clippy::result_unit_err)]
fn parse_json_reject_duplicate_keys(raw: &str) -> Result<Value, ()> {
    let mut de = serde_json::Deserializer::from_str(raw);
    let value = NoDupValue::deserialize(&mut de)
        .map(|v| v.0)
        .map_err(|_| ())?;
    de.end().map_err(|_| ())?;
    Ok(value)
}

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
        Ok(Value::Number(v.into()))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        Ok(Value::Number(v.into()))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        serde_json::Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| de::Error::custom("invalid float"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }
    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut out = Vec::new();
        while let Some(NoDupValue(v)) = seq.next_element()? {
            out.push(v);
        }
        Ok(Value::Array(out))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut obj = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if obj.contains_key(&key) {
                return Err(de::Error::custom("duplicate object key"));
            }
            let NoDupValue(v) = map.next_value()?;
            obj.insert(key, v);
        }
        Ok(Value::Object(obj))
    }
}
