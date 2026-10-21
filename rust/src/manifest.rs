use crate::{BrokerError, BRIDGE_PROTOCOL_VERSION, MAX_PAYLOAD_BYTES};
use serde_json::Value;
use std::collections::HashSet;

fn invalid<T>() -> Result<T, BrokerError> {
    Err(BrokerError::InvalidRequest)
}
fn contains(policy: &Value, key: &str, name: &str) -> bool {
    policy[key].as_array().unwrap().iter().any(|v| v == name)
}
fn pattern(value: &Value, policy: &Value) -> Result<String, BrokerError> {
    let source = value.as_str().ok_or(BrokerError::InvalidRequest)?;
    let mut result = String::new();
    let mut inside = false;
    let mut chars = source.chars().peekable();
    while let Some(char) = chars.next() {
        if char == '\\' {
            let next = chars.next().ok_or(BrokerError::InvalidRequest)?;
            let lower = next.to_ascii_lowercase().to_string();
            if let Some(range) = policy["asciiClasses"][&lower].as_str() {
                if inside && next.is_uppercase() {
                    return invalid();
                }
                if inside {
                    result.push_str(range);
                } else {
                    result.push('[');
                    if next.is_uppercase() {
                        result.push('^');
                    }
                    result.push_str(range);
                    result.push(']');
                }
            } else if r"nrtfv.^$|?*+()[]{}\".contains(next) {
                result.push('\\');
                result.push(next);
            } else if next == '/' {
                result.push('/');
            } else if next == '-' {
                result.push_str(r"\x2d");
            } else if next == 'x' {
                let a = chars.next().ok_or(BrokerError::InvalidRequest)?;
                let b = chars.next().ok_or(BrokerError::InvalidRequest)?;
                if !a.is_ascii_hexdigit() || !b.is_ascii_hexdigit() {
                    return invalid();
                }
                result.push_str(r"\x");
                result.push(a);
                result.push(b);
            } else {
                return invalid();
            }
        } else {
            let tail = chars.clone().collect::<String>();
            if !inside
                && char == '('
                && (tail.starts_with('*') || (tail.starts_with('?') && !tail.starts_with("?:")))
            {
                return invalid();
            }
            if inside
                && (char == '[' || (['&', '-', '~'].contains(&char) && chars.peek() == Some(&char)))
            {
                return invalid();
            }
            if char == '[' {
                if tail.starts_with(']') || tail.starts_with("^]") {
                    return invalid();
                }
                inside = true;
            }
            if char == ']' {
                inside = false;
            }
            if !inside && char == '.' {
                result.push_str("[^\n\r\u{2028}\u{2029}]");
            } else {
                result.push(char);
            }
        }
    }
    Ok(result)
}

fn prepare(
    node: &Value,
    root: &Value,
    policy: &Value,
    refs: &HashSet<String>,
    depth: u64,
) -> Result<Value, BrokerError> {
    if depth > policy["maxDepth"].as_u64().unwrap() {
        return invalid();
    }
    if node.is_boolean() {
        return Ok(node.clone());
    }
    let mut object = node.as_object().ok_or(BrokerError::InvalidRequest)?.clone();
    for key in object.keys() {
        if !contains(policy, "keywords", key) && !key.starts_with("x-") {
            return invalid();
        }
    }
    if let Some(dialect) = object.get("$schema") {
        if dialect != &policy["dialect"] {
            return invalid();
        }
    }
    let mut referenced = None;
    if let Some(reference) = object.get("$ref") {
        let reference = reference.as_str().ok_or(BrokerError::InvalidRequest)?;
        if !reference.starts_with("#/") || refs.contains(reference) {
            return invalid();
        }
        if object.keys().any(|key| {
            !["$ref", "$schema", "definitions"].contains(&key.as_str())
                && !contains(policy, "annotations", key)
                && !key.starts_with("x-")
        }) {
            return invalid();
        }
        let mut target = root;
        for part in reference[2..].split('/') {
            let mut chars = part.chars();
            while let Some(char) = chars.next() {
                if char == '~' && !matches!(chars.next(), Some('0' | '1')) {
                    return invalid();
                }
            }
            let key = part.replace("~1", "/").replace("~0", "~");
            target = if let Some(array) = target.as_array() {
                let index: usize = key.parse().map_err(|_| BrokerError::InvalidRequest)?;
                if index.to_string() != key {
                    return invalid();
                }
                array.get(index).ok_or(BrokerError::InvalidRequest)?
            } else {
                target
                    .as_object()
                    .and_then(|value| value.get(&key))
                    .ok_or(BrokerError::InvalidRequest)?
            };
        }
        let mut next = refs.clone();
        next.insert(reference.to_string());
        referenced = Some(prepare(target, root, policy, &next, depth + 1)?);
    }
    if let Some(value) = object.get("pattern") {
        object.insert("pattern".into(), Value::String(pattern(value, policy)?));
    }
    if let Some(value) = object.get("multipleOf") {
        let number = value.as_f64().ok_or(BrokerError::InvalidRequest)?;
        if number <= 0.0 || number > 9007199254740991.0 || number.fract() != 0.0 {
            return invalid();
        }
    }
    if let Some(value) = object.get("patternProperties") {
        let mut normalized = serde_json::Map::new();
        for (key, child) in value.as_object().ok_or(BrokerError::InvalidRequest)? {
            if normalized
                .insert(pattern(&Value::String(key.clone()), policy)?, child.clone())
                .is_some()
            {
                return invalid();
            }
        }
        object.insert("patternProperties".into(), Value::Object(normalized));
    }
    for key in policy["maps"].as_array().unwrap() {
        let key = key.as_str().unwrap();
        if let Some(value) = object.get_mut(key) {
            for (_, child) in value.as_object_mut().ok_or(BrokerError::InvalidRequest)? {
                *child = prepare(child, root, policy, refs, depth + 1)?;
            }
        }
    }
    for key in policy["single"].as_array().unwrap() {
        let key = key.as_str().unwrap();
        if let Some(child) = object.get_mut(key) {
            *child = prepare(child, root, policy, refs, depth + 1)?;
        }
    }
    for key in policy["arrays"].as_array().unwrap() {
        let key = key.as_str().unwrap();
        if let Some(value) = object.get_mut(key) {
            let children = value.as_array_mut().ok_or(BrokerError::InvalidRequest)?;
            if children.is_empty() {
                return invalid();
            }
            for child in children {
                *child = prepare(child, root, policy, refs, depth + 1)?;
            }
        }
    }
    if let Some(format) = object.get("format") {
        let format = format.as_str().ok_or(BrokerError::InvalidRequest)?;
        let regex = policy["formats"][format]
            .as_str()
            .ok_or(BrokerError::InvalidRequest)?;
        let alternatives = object
            .entry("allOf")
            .or_insert_with(|| Value::Array(vec![]))
            .as_array_mut()
            .ok_or(BrokerError::InvalidRequest)?;
        alternatives.push(serde_json::json!({"pattern":regex}));
    }
    Ok(referenced.unwrap_or(Value::Object(object)))
}

pub fn compile_tool_schema(schema: &Value) -> Result<jsonschema::Validator, BrokerError> {
    let policy: Value =
        serde_json::from_str(include_str!("../contracts/tool-schema-policy.json")).unwrap();
    let mut prepared = prepare(schema, schema, &policy, &HashSet::new(), 0)?;
    if let Some(object) = prepared.as_object_mut() {
        object.insert("$schema".into(), policy["dialect"].clone());
    }
    jsonschema::options()
        .should_validate_formats(false)
        .build(&prepared)
        .map_err(|_| BrokerError::InvalidRequest)
}
pub fn validate_tool_value(schema: &Value, value: &Value) -> bool {
    compile_tool_schema(schema).is_ok_and(|validator| validator.is_valid(value))
}

/// Full, lossless manifest preparation. Scopes describe requirements, never grants.
pub fn load_manifest(json: &str) -> Result<Value, BrokerError> {
    if json.len() > MAX_PAYLOAD_BYTES {
        return invalid();
    }
    let value: Value = serde_json::from_str(json).map_err(|_| BrokerError::InvalidRequest)?;
    let schema: Value =
        serde_json::from_str(include_str!("../contracts/manifest.schema.json")).unwrap();
    if !crate::validate_schema(&schema, &value)
        || value["protocolVersion"] != BRIDGE_PROTOCOL_VERSION
    {
        return invalid();
    }
    let mut names = HashSet::new();
    for tool in value["tools"].as_array().unwrap() {
        if !names.insert(tool["name"].as_str().unwrap()) {
            return invalid();
        }
        for key in ["inputSchema", "outputSchema"] {
            if tool[key]["type"] != "object" {
                return invalid();
            }
            compile_tool_schema(&tool[key])?;
        }
    }
    Ok(value)
}
