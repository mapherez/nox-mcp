//! Product-independent Suite validation and helpers. No issuance, network or persistence.
use crate::discovery::{canonicalize, fingerprint};
use serde::de::{DeserializeOwned, MapAccess, SeqAccess, Visitor};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fmt,
    net::{Ipv4Addr, Ipv6Addr},
    sync::OnceLock,
};

include!("suite_types.generated.rs");
#[path = "suite_auth.rs"]
mod auth;
pub use auth::*;
#[path = "suite_cache.rs"]
mod cache;
pub use cache::*;
#[path = "suite_gateway.rs"]
mod gateway;
#[path = "suite_runtime.rs"]
mod runtime;
#[path = "suite_state.rs"]
mod state;
pub use gateway::*;
pub use runtime::*;
pub use state::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuiteError(pub &'static str);
impl fmt::Display for SuiteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for SuiteError {}
pub type SuiteResult<T> = std::result::Result<T, SuiteError>;
pub(crate) fn suite_error<T>(code: &'static str) -> SuiteResult<T> {
    Err(SuiteError(code))
}
pub fn suite_capabilities() -> [&'static str; 3] {
    ["nox:inspect", "nox:write", "nox:sensitive-read"]
}
pub fn valid_suite_product_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

struct StrictJson(Value);
impl<'de> Deserialize<'de> for StrictJson {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct StrictVisitor;
        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = StrictJson;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(StrictJson(Value::Null))
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                v: bool,
            ) -> std::result::Result<Self::Value, E> {
                Ok(StrictJson(json!(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Self::Value, E> {
                Ok(StrictJson(json!(v)))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Self::Value, E> {
                Ok(StrictJson(json!(v)))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Self::Value, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| StrictJson(Value::Number(n)))
                    .ok_or_else(|| E::custom("non-finite JSON"))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                v: &str,
            ) -> std::result::Result<Self::Value, E> {
                Ok(StrictJson(json!(v)))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                v: String,
            ) -> std::result::Result<Self::Value, E> {
                Ok(StrictJson(json!(v)))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut access: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some(key) = access.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(serde::de::Error::custom("duplicate JSON key"));
                    }
                    let v: StrictJson = access.next_value()?;
                    values.insert(key, v.0);
                }
                Ok(StrictJson(Value::Object(values)))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut access: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = vec![];
                while let Some(v) = access.next_element::<StrictJson>()? {
                    values.push(v.0)
                }
                Ok(StrictJson(Value::Array(values)))
            }
        }
        deserializer.deserialize_any(StrictVisitor)
    }
}
fn check_depth(value: &Value, depth: u64) -> SuiteResult<()> {
    if depth > MAX_DOCUMENT_DEPTH {
        return suite_error("INVALID_INTEGRATION");
    }
    match value {
        Value::Array(a) => {
            for v in a {
                check_depth(v, depth + 1)?
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                check_depth(v, depth + 1)?
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn parse_suite_json(input: &str) -> SuiteResult<Value> {
    parse_suite_json_with_limit(input, MAX_PAYLOAD_BYTES as usize)
}
pub fn parse_suite_json_with_limit(input: &str, max_bytes: usize) -> SuiteResult<Value> {
    if max_bytes == 0 || input.len() > max_bytes {
        return suite_error("INVALID_INTEGRATION");
    }
    let mut deserializer = serde_json::Deserializer::from_str(input);
    let value = StrictJson::deserialize(&mut deserializer)
        .map_err(|_| SuiteError("INVALID_INTEGRATION"))?
        .0;
    deserializer
        .end()
        .map_err(|_| SuiteError("INVALID_INTEGRATION"))?;
    check_depth(&value, 0)?;
    Ok(value)
}

pub fn normalize_suite_origin(input: &str) -> SuiteResult<String> {
    let invalid = || SuiteError("INVALID_ORIGIN");
    if input.len() > 2048
        || input.len() < 9
        || !input.bytes().all(|b| (0x21..=0x7e).contains(&b))
        || !input[..8].eq_ignore_ascii_case("https://")
    {
        return Err(invalid());
    }
    let authority = input[8..].strip_suffix('/').unwrap_or(&input[8..]);
    let (host, port) = if authority.starts_with('[') {
        let close = authority.find(']').ok_or_else(invalid)?;
        let host = &authority[1..close];
        let tail = &authority[close + 1..];
        let port = if tail.is_empty() {
            None
        } else {
            Some(tail.strip_prefix(':').ok_or_else(invalid)?)
        };
        let ip: Ipv6Addr = host.parse().map_err(|_| invalid())?;
        (format!("[{}]", suite_ipv6(ip.segments())), port)
    } else {
        let (host, port) = authority
            .split_once(':')
            .map_or((authority, None), |(h, p)| (h, Some(p)));
        let host = host.to_ascii_lowercase();
        if host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
            host.parse::<Ipv4Addr>().map_err(|_| invalid())?;
        } else {
            let labels = host.split('.').collect::<Vec<_>>();
            if host.len() > 253
                || labels
                    .last()
                    .is_some_and(|label| label.bytes().all(|b| b.is_ascii_digit()))
                || host.strip_prefix("0x").is_some_and(|tail| {
                    !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_hexdigit())
                })
            {
                return Err(invalid());
            }
            for label in labels {
                if label.is_empty()
                    || label.len() > 63
                    || !label.as_bytes()[0].is_ascii_alphanumeric()
                    || !label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                    || !label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                {
                    return Err(invalid());
                }
            }
        }
        (host, port)
    };
    let suffix = if let Some(port) = port {
        let number = port.parse::<u16>().map_err(|_| invalid())?;
        if number == 0 || number.to_string() != port {
            return Err(invalid());
        }
        if number == 443 {
            String::new()
        } else {
            format!(":{number}")
        }
    } else {
        String::new()
    };
    Ok(format!("https://{host}{suffix}"))
}
fn suite_ipv6(groups: [u16; 8]) -> String {
    let (mut best_start, mut best_len) = (None, 1);
    let mut i = 0;
    while i < 8 {
        if groups[i] != 0 {
            i += 1;
            continue;
        }
        let mut end = i;
        while end < 8 && groups[end] == 0 {
            end += 1
        }
        if end - i > best_len {
            best_start = Some(i);
            best_len = end - i
        }
        i = end
    }
    let values = groups.map(|v| format!("{v:x}"));
    match best_start {
        Some(start) => format!(
            "{}::{}",
            values[..start].join(":"),
            values[start + best_len..].join(":")
        ),
        None => values.join(":"),
    }
}
pub fn normalize_suite_path(input: &str) -> SuiteResult<String> {
    let invalid = || SuiteError("INVALID_SUITE_PATH");
    if input.len() > 2048 || !input.starts_with('/') || input.starts_with("//") {
        return Err(invalid());
    }
    let mut decoded = Vec::new();
    let mut normalized = String::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            let pair = input.get(i + 1..i + 3).ok_or_else(invalid)?;
            let value = u8::from_str_radix(pair, 16).map_err(|_| invalid())?;
            if value < 128 {
                return Err(invalid());
            }
            decoded.push(value);
            normalized.push('%');
            normalized.push_str(&pair.to_ascii_uppercase());
            i += 3;
        } else {
            if !b.is_ascii_alphanumeric() && !b"_~.!$&'()*+,;=:@/-".contains(&b) {
                return Err(invalid());
            }
            decoded.push(b);
            normalized.push(b as char);
            i += 1;
        }
    }
    let decoded = String::from_utf8(decoded).map_err(|_| invalid())?;
    if decoded.split('/').any(|s| s == "." || s == "..")
        || decoded
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\u{feff}')
    {
        return Err(invalid());
    }
    Ok(normalized)
}
pub fn resolve_suite_endpoint(origin: &str, path: &str) -> SuiteResult<String> {
    Ok(normalize_suite_origin(origin)? + &normalize_suite_path(path)?)
}
pub fn normalize_suite_resource(resource: &str) -> SuiteResult<String> {
    let offset = resource
        .get(8..)
        .and_then(|s| s.find('/'))
        .map(|n| n + 8)
        .ok_or(SuiteError("INVALID_ORIGIN"))?;
    resolve_suite_endpoint(&resource[..offset], &resource[offset..])
}
pub fn parse_suite_timestamp(value: &str) -> SuiteResult<i64> {
    let invalid = || SuiteError("INVALID_INTEGRATION");
    let bytes = value.as_bytes();
    if !value.is_ascii() || bytes.len() < 20 || bytes.len() > 24 || bytes.last() != Some(&b'Z') {
        return Err(invalid());
    }
    for (i, b) in bytes[..19].iter().enumerate() {
        let expected = match i {
            4 | 7 => Some(b'-'),
            10 => Some(b'T'),
            13 | 16 => Some(b':'),
            _ => None,
        };
        if expected.map_or(!b.is_ascii_digit(), |e| *b != e) {
            return Err(invalid());
        }
    }
    if bytes.len() != 20
        && (bytes[19] != b'.'
            || bytes.len() < 22
            || !bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit))
    {
        return Err(invalid());
    }
    if value[17..19].parse::<u8>().map_err(|_| invalid())? > 59 {
        return Err(invalid());
    }
    let parsed = chrono::DateTime::parse_from_rfc3339(value).map_err(|_| invalid())?;
    Ok(parsed.timestamp_millis())
}
pub fn compare_suite_sequences(left: &str, right: &str) -> SuiteResult<std::cmp::Ordering> {
    fn parse(s: &str) -> SuiteResult<u64> {
        if s.is_empty()
            || s.len() > 20
            || (s.len() > 1 && s.starts_with('0'))
            || !s.bytes().all(|b| b.is_ascii_digit())
        {
            return suite_error("INVALID_SEQUENCE");
        }
        s.parse().map_err(|_| SuiteError("INVALID_SEQUENCE"))
    }
    Ok(parse(left)?.cmp(&parse(right)?))
}

fn suite_validators() -> &'static HashMap<&'static str, (Value, jsonschema::Validator)> {
    static VALIDATORS: OnceLock<HashMap<&'static str, (Value, jsonschema::Validator)>> =
        OnceLock::new();
    VALIDATORS.get_or_init(|| {
        SUITE_SCHEMAS
            .iter()
            .map(|(name, source)| {
                let schema: Value = serde_json::from_str(source).expect("generated Suite schema");
                let validator = jsonschema::validator_for(&schema).expect("valid Suite schema");
                (*name, (schema, validator))
            })
            .collect()
    })
}
fn suite_walk(schema: &Value, value: &Value, preflight: bool) -> SuiteResult<()> {
    if value.is_null() {
        return Ok(());
    }
    if schema["type"] == "array" {
        if let Some(values) = value.as_array() {
            for child in values {
                suite_walk(&schema["items"], child, preflight)?
            }
        }
    }
    if schema["type"] == "object" && value.is_object() {
        let props = schema["properties"].as_object();
        if preflight {
            for name in ["contractVersion", "version"] {
                if schema["properties"][name]["const"] == "1.0"
                    && value[name].as_str().is_some_and(|s| s != "1.0")
                {
                    return suite_error("UNSUPPORTED_INTEGRATION");
                }
            }
            if props.is_some_and(|p| p.contains_key("requires"))
                && value["requires"].as_array().is_some_and(|a| !a.is_empty())
            {
                return suite_error("UNSUPPORTED_INTEGRATION");
            }
        }
        if let Some(props) = props {
            for (key, child) in props {
                if let Some(value) = value.get(key) {
                    suite_walk(child, value, preflight)?
                }
            }
        }
        if let Some(branches) = schema["oneOf"].as_array() {
            for branch in branches {
                if let Some(props) = branch["properties"].as_object() {
                    let literals = props
                        .iter()
                        .filter_map(|(key, node)| node.get("const").map(|constant| (key, constant)))
                        .collect::<Vec<_>>();
                    if !literals.is_empty()
                        && literals
                            .iter()
                            .all(|(key, constant)| value.get(*key) == Some(*constant))
                    {
                        suite_walk(branch, value, preflight)?
                    }
                }
            }
        }
    }
    if preflight {
        return Ok(());
    }
    if schema["properties"].get("declaration").is_some()
        && schema["properties"].get("productId").is_some()
        && value["productId"] != value["declaration"]["productId"]
    {
        return suite_error("INVALID_INTEGRATION");
    }
    match schema["x-nox-kind"].as_str() {
        Some("product-id") => {
            if !value.as_str().is_some_and(valid_suite_product_id) {
                return suite_error("INVALID_INTEGRATION");
            }
        }
        Some("origin") => {
            normalize_suite_origin(value.as_str().ok_or(SuiteError("INVALID_INTEGRATION"))?)?;
        }
        Some("path") => {
            normalize_suite_path(value.as_str().ok_or(SuiteError("INVALID_INTEGRATION"))?)?;
        }
        Some("timestamp") => {
            parse_suite_timestamp(value.as_str().ok_or(SuiteError("INVALID_INTEGRATION"))?)?;
        }
        Some("sequence") => {
            let s = value.as_str().ok_or(SuiteError("INVALID_INTEGRATION"))?;
            compare_suite_sequences(s, s)?;
        }
        _ => {}
    }
    Ok(())
}
pub fn load_suite_document(name: &str, input: &str) -> SuiteResult<Value> {
    load_suite_document_with_limit(name, input, MAX_PAYLOAD_BYTES as usize)
}
pub fn load_suite_document_with_limit(
    name: &str,
    input: &str,
    max_bytes: usize,
) -> SuiteResult<Value> {
    let value = parse_suite_json_with_limit(input, max_bytes)?;
    validate_suite_document_with_limit(name, &value, max_bytes)?;
    Ok(value)
}
pub fn validate_suite_document(name: &str, value: &Value) -> SuiteResult<()> {
    validate_suite_document_with_limit(name, value, MAX_PAYLOAD_BYTES as usize)
}
pub fn validate_suite_document_with_limit(
    name: &str,
    value: &Value,
    max_bytes: usize,
) -> SuiteResult<()> {
    let result = (|| {
        check_depth(value, 0)?;
        if max_bytes == 0
            || canonicalize(value)
                .map_err(|_| SuiteError("INVALID_INTEGRATION"))?
                .len()
                > max_bytes
        {
            return suite_error("INVALID_INTEGRATION");
        }
        let (schema, validator) = suite_validators()
            .get(name)
            .ok_or(SuiteError("INVALID_INTEGRATION"))?;
        suite_walk(schema, value, true)?;
        if !validator.is_valid(value) {
            return suite_error("INVALID_INTEGRATION");
        }
        suite_walk(schema, value, false)?;
        match name {
            "registration-record" => {
                if value["productId"] != value["declaration"]["productId"] {
                    return suite_error("INVALID_INTEGRATION");
                }
            }
            "delegation-claims" | "probe-claims" => {
                let (iat, nbf, exp) = (
                    value["iat"].as_u64().unwrap(),
                    value["nbf"].as_u64().unwrap(),
                    value["exp"].as_u64().unwrap(),
                );
                let aud = value["aud"].as_str().unwrap();
                if exp <= iat
                    || exp - iat > 300
                    || nbf < iat
                    || nbf >= exp
                    || normalize_suite_resource(aud)? != aud
                {
                    return suite_error("INVALID_INTEGRATION");
                }
                if name == "delegation-claims" {
                    let scopes = value["scope"]
                        .as_str()
                        .unwrap()
                        .split(' ')
                        .collect::<Vec<_>>();
                    let unique = scopes.iter().collect::<HashSet<_>>();
                    if !scopes.contains(&"nox:inspect")
                        || unique.len() != scopes.len()
                        || scopes.iter().any(|s| !suite_capabilities().contains(s))
                    {
                        return suite_error("INVALID_INTEGRATION");
                    }
                }
            }
            "provisioning" => {
                let origin = normalize_suite_origin(value["backendOrigin"].as_str().unwrap())?;
                let uri = value["signingKeysUri"].as_str().unwrap();
                if normalize_suite_resource(uri)? != uri || !uri.starts_with(&(origin + "/")) {
                    return suite_error("INVALID_INTEGRATION");
                }
            }
            "registry-snapshot" | "gateway-presentation" => {
                let mut seen = HashSet::new();
                for product in value["products"].as_array().unwrap() {
                    let id = product["productId"].as_str().unwrap();
                    if !seen.insert(id)
                        || (name == "registry-snapshot"
                            && product["productId"] != product["declaration"]["productId"])
                    {
                        return suite_error("INVALID_INTEGRATION");
                    }
                }
            }
            _ => {}
        }
        Ok(())
    })();
    result.map_err(|e| {
        if e.0 == "UNSUPPORTED_INTEGRATION" {
            e
        } else {
            SuiteError("INVALID_INTEGRATION")
        }
    })
}
fn load_suite_typed<T: DeserializeOwned>(name: &str, input: &str) -> SuiteResult<T> {
    let value = load_suite_document(name, input)?;
    serde_json::from_value(value).map_err(|_| SuiteError("INVALID_INTEGRATION"))
}
pub fn suite_tool_alias(product_id: &str, name: &str) -> SuiteResult<String> {
    if !valid_suite_product_id(product_id) || name.is_empty() || name.chars().count() > 64 {
        return suite_error("INVALID_GATEWAY");
    }
    let alias = format!("{product_id}__{name}");
    if alias.len() <= 64
        && alias
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return Ok(alias);
    }
    Ok(format!(
        "_{}",
        fingerprint(&json!([product_id, name])).map_err(|_| SuiteError("INVALID_GATEWAY"))?
    ))
}
pub fn suite_policy(required: &[String], argument_dependent: bool) -> SuiteResult<SuitePolicy> {
    let mut scopes = vec![];
    for scope in required {
        if !scopes.contains(scope) {
            scopes.push(scope.clone())
        }
    }
    load_suite_policy(
        &json!({"version":"1.0","requiredScopes":scopes,"argumentDependent":argument_dependent})
            .to_string(),
    )
}
pub fn require_suite_scopes(
    grants: &[String],
    policy: &SuitePolicy,
    additional: &[String],
) -> SuiteResult<Vec<String>> {
    validate_suite_document(
        "policy",
        &serde_json::to_value(policy).map_err(|_| SuiteError("INVALID_INTEGRATION"))?,
    )?;
    let mut required = vec![];
    for scope in policy.required_scopes.iter().chain(additional) {
        if scope.is_empty() || !grants.contains(scope) {
            return suite_error("FORBIDDEN");
        }
        if !required.contains(scope) {
            required.push(scope.clone())
        }
    }
    Ok(required)
}
