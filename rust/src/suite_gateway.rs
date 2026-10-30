use crate::discovery::{canonicalize, fingerprint, interpret_cli};
use crate::suite::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub fn suite_authorization_view_key(
    identity: &VerifiedSuiteIdentity,
    credential_partition: &str,
    policy_revision: &str,
) -> SuiteResult<String> {
    if credential_partition.len() != 43
        || !credential_partition
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || policy_revision.is_empty()
    {
        return suite_error("INVALID_INTEGRATION");
    }
    let c = identity.context();
    let subject = if identity.kind() == "user" {
        &c["userId"]
    } else {
        &c["serviceId"]
    };
    let revision = if identity.kind() == "user" {
        &c["authRevision"]
    } else {
        &c["serviceCredentialRevision"]
    };
    let mut scopes = c["scopes"]
        .as_array()
        .map(|a| a.iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>())
        .unwrap_or_default();
    scopes.sort_unstable();
    fingerprint(&json!([
        credential_partition,
        identity.claims()["iss"],
        subject,
        c["keyId"],
        revision,
        scopes,
        policy_revision
    ]))
    .map_err(|_| SuiteError("INVALID_INTEGRATION"))
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteGatewayOptions {
    pub server_id: String,
    pub authorization_view_id: String,
    pub registry_revision: String,
    pub sources: Vec<SuiteGatewaySource>,
    pub now_ms: i64,
    pub authorization_expires_at_ms: i64,
    #[serde(default)]
    pub policy_revision: Option<String>,
    #[serde(default)]
    pub max_bytes: Option<usize>,
}
fn rewrite_cli(input: &Value, names: &HashMap<String, String>) -> SuiteResult<Value> {
    interpret_cli(input).map_err(|_| SuiteError("INVALID_CLI"))?;
    let mut result = input.clone();
    fn source(value: &mut Value, names: &HashMap<String, String>) -> SuiteResult<()> {
        let name = value["tool"].as_str().ok_or(SuiteError("INVALID_CLI"))?;
        let alias = names.get(name).ok_or(SuiteError("INVALID_CLI"))?;
        value["tool"] = json!(alias);
        Ok(())
    }
    if let Some(parameters) = result.get_mut("parameters").and_then(Value::as_object_mut) {
        for parameter in parameters.values_mut() {
            if let Some(options) = parameter.get_mut("options") {
                source(options, names)?
            }
        }
    }
    if let Some(preview) = result.get_mut("preview") {
        source(preview, names)?
    }
    if let Some(steps) = result.get_mut("workflow").and_then(Value::as_array_mut) {
        for step in steps {
            if step["type"] == "call" {
                source(step, names)?
            }
        }
    }
    Ok(result)
}
pub fn compose_suite_gateway(options: &SuiteGatewayOptions) -> SuiteResult<SuiteGatewaySnapshot> {
    let max_bytes = options
        .max_bytes
        .unwrap_or(MAX_GATEWAY_SNAPSHOT_BYTES as usize);
    let invalid = || SuiteError("INVALID_GATEWAY");
    if max_bytes == 0
        || options.server_id.is_empty()
        || options.registry_revision.is_empty()
        || options.authorization_view_id.len() != 43
        || !options
            .authorization_view_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(invalid());
    }
    if options.authorization_expires_at_ms <= options.now_ms {
        return suite_error("INVALID_DELEGATION");
    }
    let mut seen_products = HashSet::new();
    let mut sources = vec![];
    for source in &options.sources {
        let value = serde_json::to_value(source).map_err(|_| invalid())?;
        validate_suite_document("gateway-source", &value)?;
        let id = value["registration"]["productId"].as_str().unwrap();
        if !seen_products.insert(id.to_string()) {
            return Err(invalid());
        }
        sources.push(value)
    }
    sources.sort_by(|a, b| {
        a["registration"]["productId"]
            .as_str()
            .cmp(&b["registration"]["productId"].as_str())
    });
    let (mut definitions, mut routes, mut diagnostics, mut components, mut products, mut views) =
        (vec![], vec![], vec![], vec![], vec![], vec![]);
    let mut aliases = HashSet::new();
    let mut total = 0;
    let mut ttl = (options.authorization_expires_at_ms - options.now_ms).min(30000);
    struct Original {
        definition: Value,
        hash: String,
        alias: String,
    }
    for source in sources {
        total += canonicalize(&source).map_err(|_| invalid())?.len();
        if total > max_bytes {
            return suite_error("PAYLOAD_LIMIT");
        }
        let product = &source["registration"];
        let id = product["productId"].as_str().unwrap();
        let path = product["declaration"]["capabilities"]["suiteMcp"]["path"]
            .as_str()
            .ok_or_else(invalid)?;
        let endpoint =
            resolve_suite_endpoint(product["connection"]["baseUrl"].as_str().unwrap(), path)?;
        let mut originals = HashMap::new();
        let mut entries = vec![];
        for definition in source["definitions"].as_array().unwrap() {
            let name = definition["tool"]["name"].as_str().unwrap();
            if originals.contains_key(name) {
                return Err(invalid());
            }
            let mut bundle = json!({"tool":definition["tool"]});
            if let Some(cli) = definition.get("cli") {
                bundle["cli"] = cli.clone()
            }
            let hash = fingerprint(&bundle).map_err(|_| invalid())?;
            if definition
                .get("fingerprint")
                .is_some_and(|v| v.as_str() != Some(hash.as_str()))
            {
                return suite_error("STALE_DEFINITION");
            }
            let alias = suite_tool_alias(id, name)?;
            let mut entry = json!({"name":name,"fingerprint":hash});
            if let Some(availability) = definition.get("availability") {
                entry["availability"] = availability.clone()
            }
            entries.push(entry);
            originals.insert(
                name.to_string(),
                Original {
                    definition: definition.clone(),
                    hash,
                    alias,
                },
            );
        }
        entries.sort_by(|a, b| {
            a["name"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .cmp(b["name"].as_str().unwrap().encode_utf16())
        });
        let mut payload =
            json!({"serverId":source["serverId"],"viewId":source["viewId"],"tools":entries});
        if let Some(presentation) = source.get("presentation") {
            payload["presentation"] = presentation.clone()
        }
        let source_catalog = fingerprint(&payload).map_err(|_| invalid())?;
        if source
            .get("catalog")
            .is_some_and(|v| v.as_str() != Some(source_catalog.as_str()))
        {
            return suite_error("STALE_CATALOG");
        }
        let mut names = HashMap::new();
        for (name, original) in &originals {
            let meta = &original.definition["tool"]["_meta"];
            let code = if meta.get("nox/gateway").is_some() {
                Some("RESERVED_METADATA")
            } else if meta.get("nox/authorization").is_none() {
                Some("UNCLASSIFIED_TOOL")
            } else if validate_suite_document("policy", &meta["nox/authorization"]).is_err() {
                Some("INVALID_POLICY")
            } else {
                None
            };
            if let Some(code) = code {
                diagnostics.push(json!({"productId":id,"toolName":name,"code":code}));
                continue;
            }
            if !aliases.insert(original.alias.clone()) {
                return Err(invalid());
            }
            names.insert(name.clone(), original.alias.clone());
        }
        for (name, alias) in &names {
            let original = &originals[name];
            let definition = &original.definition;
            let mut tool = definition["tool"].clone();
            tool["name"] = json!(alias);
            tool["_meta"]["nox/gateway"] = json!({"version":"1.0","productId":id,"toolName":name,"serverId":source["serverId"],"registrationRevision":product["revision"],"sourceFingerprint":original.hash});
            let mut bundle = json!({"tool":tool});
            if let Some(cli) = definition.get("cli") {
                match rewrite_cli(cli, &names) {
                    Ok(cli) => bundle["cli"] = cli,
                    Err(_) => diagnostics
                        .push(json!({"productId":id,"toolName":name,"code":"INVALID_CLI"})),
                }
            }
            let hash = fingerprint(&bundle).map_err(|_| invalid())?;
            let mut aggregate = bundle;
            aggregate["fingerprint"] = json!(hash);
            if let Some(availability) = definition.get("availability") {
                aggregate["availability"] = availability.clone()
            }
            definitions.push(aggregate);
            routes.push(json!({"alias":alias,"productId":id,"registrationRevision":product["revision"],"associationId":product["associationId"],"serverId":source["serverId"],"viewId":source["viewId"],"toolName":name,"endpoint":endpoint,"sourceFingerprint":original.hash,"fingerprint":hash,"availability":definition.get("availability").unwrap_or(&json!("available"))}));
        }
        components.push(json!({"productId":id,"registrationRevision":product["revision"],"serverId":source["serverId"],"viewId":source["viewId"],"catalog":source_catalog}));
        let mut presentation =
            json!({"productId":id,"displayName":product["declaration"]["displayName"]});
        if let Some(p) = source.get("presentation") {
            presentation["presentation"] = p.clone()
        }
        products.push(presentation);
        views.push(json!([
            id,
            product["associationId"],
            product["revision"],
            source["serverId"],
            source["viewId"]
        ]));
        if let Some(value) = source["ttlMs"].as_u64() {
            ttl = ttl.min(value as i64)
        }
    }
    definitions.sort_by(|a, b| a["tool"]["name"].as_str().cmp(&b["tool"]["name"].as_str()));
    routes.sort_by(|a, b| a["alias"].as_str().cmp(&b["alias"].as_str()));
    diagnostics.sort_by(|a, b| {
        let left = canonicalize(&json!([a["productId"], a["toolName"], a["code"]])).unwrap();
        let right = canonicalize(&json!([b["productId"], b["toolName"], b["code"]])).unwrap();
        left.encode_utf16().cmp(right.encode_utf16())
    });
    let view_hash=fingerprint(&json!({"authorizationViewId":options.authorization_view_id,"policyRevision":options.policy_revision.as_deref().unwrap_or("1.0"),"products":views})).map_err(|_|invalid())?;
    let view_id = format!("view-{view_hash}");
    let presentation = json!({"gateway":{"version":"1.0","registryRevision":options.registry_revision,"products":components},"products":products});
    let tools = definitions
        .iter()
        .map(|definition| {
            let mut entry =
                json!({"name":definition["tool"]["name"],"fingerprint":definition["fingerprint"]});
            if let Some(availability) = definition.get("availability") {
                entry["availability"] = availability.clone()
            }
            entry
        })
        .collect::<Vec<_>>();
    let catalog_hash=fingerprint(&json!({"serverId":options.server_id,"viewId":view_id,"tools":tools,"presentation":presentation})).map_err(|_|invalid())?;
    let catalog = json!({"resultType":"complete","serverId":options.server_id,"viewId":view_id,"tools":tools,"presentation":presentation,"cacheScope":"private","ttlMs":ttl,"catalog":catalog_hash});
    let snapshot = json!({"contractVersion":"1.0","serverId":options.server_id,"viewId":view_id,"registryRevision":options.registry_revision,"catalog":catalog,"definitions":definitions,"routes":routes,"diagnostics":diagnostics});
    validate_suite_document_with_limit("gateway-snapshot", &snapshot, max_bytes)?;
    serde_json::from_value(snapshot).map_err(|_| invalid())
}
pub fn select_suite_route(
    snapshot: &SuiteGatewaySnapshot,
    alias: &str,
    expected_fingerprint: Option<&str>,
) -> SuiteResult<SuiteGatewayRoute> {
    let route = snapshot
        .routes
        .iter()
        .find(|r| r.alias == alias)
        .ok_or(SuiteError("FORBIDDEN"))?;
    if expected_fingerprint.is_some_and(|fp| route.fingerprint != fp) {
        return suite_error("STALE_DEFINITION");
    }
    if route.availability != "available" {
        return suite_error("UNAVAILABLE");
    }
    Ok(route.clone())
}
