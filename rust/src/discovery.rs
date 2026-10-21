//! Optional NoX discovery contracts. No terminal rendering or workflow execution.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{Arc, Mutex, OnceLock},
};

pub const EXTENSION: &str = "nox/discovery";
pub const VERSION: &str = "1.0";
pub const PROTOCOL: &str = "2026-07-28";
pub type Result<T> = std::result::Result<T, DiscoveryError>;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryError(pub &'static str);
impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for DiscoveryError {}
fn error<T>(reason: &'static str) -> Result<T> {
    Err(DiscoveryError(reason))
}
pub fn capability() -> Value {
    json!({"versions":[VERSION],"maxBatchSize":64})
}
pub fn request_meta() -> Value {
    json!({"io.modelcontextprotocol/protocolVersion":PROTOCOL,"io.modelcontextprotocol/clientCapabilities":{"extensions":{EXTENSION:{"version":VERSION}}}})
}
pub fn validate(name: &str, value: &Value) -> Result<()> {
    static VALIDATORS: OnceLock<HashMap<&'static str, jsonschema::Validator>> = OnceLock::new();
    let validators = VALIDATORS.get_or_init(|| {
        [
            ("cli", include_str!("../contracts/cli.schema.json")),
            (
                "discovery-catalog-request",
                include_str!("../contracts/discovery-catalog-request.schema.json"),
            ),
            (
                "discovery-definitions-request",
                include_str!("../contracts/discovery-definitions-request.schema.json"),
            ),
            (
                "discovery-catalog",
                include_str!("../contracts/discovery-catalog.schema.json"),
            ),
            (
                "discovery-definitions",
                include_str!("../contracts/discovery-definitions.schema.json"),
            ),
        ]
        .into_iter()
        .map(|(name, schema)| {
            (
                name,
                jsonschema::validator_for(&serde_json::from_str::<Value>(schema).unwrap()).unwrap(),
            )
        })
        .collect()
    });
    if validators.get(name).is_some_and(|v| v.is_valid(value)) {
        Ok(())
    } else {
        error("INVALID_DISCOVERY")
    }
}
/// RFC 8785; serde_json rejects invalid Unicode, ryu-js supplies ECMAScript numbers.
pub fn canonicalize(value: &Value) -> Result<String> {
    match value {
        Value::Null => Ok("null".into()),
        Value::Bool(v) => Ok(v.to_string()),
        Value::String(v) => Ok(serde_json::to_string(v).unwrap()),
        Value::Number(v) => {
            let f = v.as_f64().ok_or(DiscoveryError("INVALID_JCS"))?;
            // JCS numbers use binary64, including JSON integer tokens. Domain
            // identifiers requiring greater precision must be JSON strings.
            if !f.is_finite() {
                return error("INVALID_JCS");
            };
            Ok(ryu_js::Buffer::new().format(f).into())
        }
        Value::Array(v) => Ok(format!(
            "[{}]",
            v.iter()
                .map(canonicalize)
                .collect::<Result<Vec<_>>>()?
                .join(",")
        )),
        Value::Object(v) => {
            let mut keys = v.keys().collect::<Vec<_>>();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            Ok(format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonicalize(&v[key])?
                    )))
                    .collect::<Result<Vec<_>>>()?
                    .join(",")
            ))
        }
    }
}
pub fn fingerprint(value: &Value) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(canonicalize(value)?.as_bytes())))
}
fn source(value: &Value) -> Result<()> {
    if value.get("input").is_some() && value.get("arguments").is_some() {
        error("INVALID_CLI")
    } else {
        Ok(())
    }
}
fn confirmation(value: &Value) -> Result<()> {
    if value["mode"] == "typed" && !value["matchPointer"].is_string() {
        error("INVALID_CLI")
    } else {
        Ok(())
    }
}
pub fn interpret_cli(value: &Value) -> Result<Value> {
    validate("cli", value)?;
    let mut cli = value.clone();
    if cli["requires"].as_array().is_some_and(|v| {
        v.iter().any(|f| {
            !matches!(
                f.as_str(),
                Some("dynamic-options" | "preview" | "confirmation" | "workflow")
            )
        })
    }) {
        return error("UNSUPPORTED_FEATURE");
    }
    if cli.get("workflow").is_some()
        && (cli.get("preview").is_some() || cli.get("confirmation").is_some())
    {
        return error("INVALID_CLI");
    }
    if let Some(parameters) = cli.get_mut("parameters").and_then(Value::as_object_mut) {
        for parameter in parameters.values_mut() {
            if parameter.get("options").is_some() {
                source(&parameter["options"])?;
                parameter
                    .as_object_mut()
                    .unwrap()
                    .entry("control")
                    .or_insert(json!("select"));
                for (key, value) in [
                    ("itemsPointer", "/items"),
                    ("valuePointer", "/id"),
                    ("labelPointer", "/name"),
                ] {
                    parameter["options"]
                        .as_object_mut()
                        .unwrap()
                        .entry(key)
                        .or_insert(json!(value));
                }
            }
        }
    }
    source(&cli["preview"])?;
    confirmation(&cli["confirmation"])?;
    let mut steps = HashSet::new();
    if let Some(workflow) = cli["workflow"].as_array() {
        for step in workflow {
            let id = step["id"].as_str().unwrap();
            if steps.contains(id) {
                return error("INVALID_CLI");
            };
            source(step)?;
            match step["type"].as_str() {
                Some("call") if step.get("tool").is_none() => return error("INVALID_CLI"),
                Some("input") if step.get("parameters").is_none() => return error("INVALID_CLI"),
                Some("confirm") if step.get("confirmation").is_none() => {
                    return error("INVALID_CLI")
                }
                _ => (),
            };
            if let Some(bindings) = step["arguments"].as_object() {
                for b in bindings.values() {
                    if b["from"] == "step" && !steps.contains(b["step"].as_str().unwrap()) {
                        return error("INVALID_CLI");
                    }
                }
            };
            confirmation(&step["confirmation"])?;
            steps.insert(id);
        }
    }
    Ok(cli)
}
#[derive(Clone, Debug)]
pub struct View {
    pub id: String,
    pub definitions: Vec<Value>,
    pub presentation: Option<Value>,
}
#[derive(Clone, Debug)]
pub struct Discovery {
    pub server_id: String,
    pub ttl_ms: u64,
    pub max_bytes: usize,
    hashes: Arc<Mutex<HashMap<String, (Value, String)>>>,
}
impl Discovery {
    pub fn new(server_id: impl Into<String>) -> Result<Self> {
        let server_id = server_id.into();
        if server_id.is_empty() {
            return error("INVALID_DISCOVERY");
        };
        Ok(Self {
            server_id,
            ttl_ms: 30000,
            max_bytes: 4 * 1024 * 1024,
            hashes: Arc::new(Mutex::new(HashMap::new())),
        })
    }
    fn snapshot(&self, view: &View) -> Result<(Vec<Value>, Vec<Value>, String)> {
        if view.id.is_empty() {
            return error("INVALID_DISCOVERY");
        };
        let mut defs = view.definitions.clone();
        for def in &defs {
            if let Some(cli) = def.get("cli") {
                interpret_cli(cli)?;
            }
            validate(
                "discovery-definitions",
                &json!({"resultType":"complete","catalog":"check","definitions":[{"tool":def["tool"],"fingerprint":"a".repeat(43)}]}),
            )?;
        }
        defs.sort_by(|a, b| {
            a["tool"]["name"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .cmp(b["tool"]["name"].as_str().unwrap().encode_utf16())
        });
        let mut seen = HashSet::new();
        let mut rows = vec![];
        for def in &defs {
            let name = def["tool"]["name"].as_str().unwrap();
            if !seen.insert(name) {
                return error("INVALID_DISCOVERY");
            };
            let mut bundle = json!({"tool":def["tool"]});
            if let Some(cli) = def.get("cli") {
                bundle["cli"] = cli.clone();
            };
            let hash = {
                let mut cache = self
                    .hashes
                    .lock()
                    .map_err(|_| DiscoveryError("INVALID_DISCOVERY"))?;
                match cache.get(name) {
                    Some((old, hash)) if old == &bundle => hash.clone(),
                    _ => {
                        let hash = fingerprint(&bundle)?;
                        if cache.len() >= 4096 {
                            cache.clear()
                        };
                        cache.insert(name.to_string(), (bundle, hash.clone()));
                        hash
                    }
                }
            };
            let mut row = json!({"name":name,"fingerprint":hash});
            if let Some(a) = def.get("availability") {
                if a != "available" && a != "unavailable" {
                    return error("INVALID_DISCOVERY");
                };
                row["availability"] = a.clone()
            };
            rows.push(row);
        }
        let mut identity = json!({"serverId":self.server_id,"viewId":view.id,"tools":rows});
        if let Some(p) = &view.presentation {
            identity["presentation"] = p.clone()
        };
        let hash = fingerprint(&identity)?;
        Ok((defs, rows, hash))
    }
    fn bounded(&self, value: Value) -> Result<Value> {
        if serde_json::to_vec(&value).unwrap().len() > self.max_bytes {
            error("PAYLOAD_LIMIT")
        } else {
            Ok(value)
        }
    }
    pub fn catalog(&self, view: &View, params: &Value) -> Result<Value> {
        validate("discovery-catalog-request", params)?;
        let (_, rows, hash) = self.snapshot(view)?;
        let mut out = json!({"resultType":"complete","serverId":self.server_id,"viewId":view.id,"catalog":hash,"ttlMs":self.ttl_ms,"cacheScope":"private"});
        if params.get("catalog").is_some() && params["catalog"] != hash {
            return error("STALE_CATALOG");
        };
        if params.get("cursor").is_some()
            && (params.get("catalog").is_none() || params.get("ifCatalog").is_some())
        {
            return error("INVALID_DISCOVERY");
        };
        if params["ifCatalog"] == hash {
            out["notModified"] = json!(true);
            return self.bounded(out);
        }
        let cursor = params["cursor"].as_u64().unwrap_or(0) as usize;
        let limit = params["limit"].as_u64().unwrap_or(1000) as usize;
        if cursor > rows.len() {
            return error("INVALID_DISCOVERY");
        };
        let end = (cursor + limit).min(rows.len());
        out["tools"] = json!(rows[cursor..end]);
        if end < rows.len() {
            out["nextCursor"] = json!(end)
        };
        if let Some(p) = &view.presentation {
            out["presentation"] = p.clone()
        };
        self.bounded(out)
    }
    pub fn definitions(&self, view: &View, params: &Value) -> Result<Value> {
        validate("discovery-definitions-request", params)?;
        let (defs, rows, hash) = self.snapshot(view)?;
        if params["catalog"] != hash {
            return error("STALE_CATALOG");
        };
        let mut seen = HashSet::new();
        let mut out = vec![];
        for reference in params["tools"].as_array().unwrap() {
            let name = reference["name"].as_str().unwrap();
            if !seen.insert(name) {
                return error("INVALID_DISCOVERY");
            };
            let Some(index) = rows.iter().position(|row| {
                row["name"] == name && row["fingerprint"] == reference["fingerprint"]
            }) else {
                return error("STALE_CATALOG");
            };
            let mut def =
                json!({"tool":defs[index]["tool"],"fingerprint":rows[index]["fingerprint"]});
            if let Some(cli) = defs[index].get("cli") {
                def["cli"] = cli.clone()
            };
            out.push(def);
        }
        self.bounded(json!({"resultType":"complete","catalog":hash,"definitions":out}))
    }
    pub fn guard(&self, view: &View, name: &str, meta: &Value) -> Result<()> {
        let Some(def) = view.definitions.iter().find(|d| d["tool"]["name"] == name) else {
            return error("FORBIDDEN");
        };
        if def["availability"] == "unavailable" {
            return error("UNAVAILABLE");
        };
        if let Some(settings) = meta.get(EXTENSION) {
            let mut bundle = json!({"tool":def["tool"]});
            if let Some(cli) = def.get("cli") {
                bundle["cli"] = cli.clone()
            };
            if settings["expectedFingerprint"] != fingerprint(&bundle)? {
                return error("STALE_DEFINITION");
            }
        };
        Ok(())
    }
}
pub fn negotiated(meta: &Value) -> Result<()> {
    if meta["io.modelcontextprotocol/protocolVersion"] != PROTOCOL
        || meta["io.modelcontextprotocol/clientCapabilities"]["extensions"][EXTENSION]["version"]
            != VERSION
    {
        error("EXTENSION_NOT_NEGOTIATED")
    } else {
        Ok(())
    }
}
/// One instance per trusted origin and credential partition. All-or-nothing sync.
#[derive(Clone, Debug)]
pub struct Cache {
    pub origin: String,
    pub credential_partition: String,
    catalog: Option<Value>,
    definitions: HashMap<String, Value>,
}
impl Cache {
    pub fn new(origin: impl Into<String>, credential_partition: impl Into<String>) -> Result<Self> {
        let origin = origin.into();
        let credential_partition = credential_partition.into();
        if origin.is_empty() || credential_partition.is_empty() {
            return error("INVALID_DISCOVERY");
        };
        Ok(Self {
            origin,
            credential_partition,
            catalog: None,
            definitions: HashMap::new(),
        })
    }
    pub fn clear(&mut self) {
        self.catalog = None;
        self.definitions.clear()
    }
    pub fn definitions(&self) -> &HashMap<String, Value> {
        &self.definitions
    }
    pub fn catalog(&self) -> Option<&Value> {
        self.catalog.as_ref()
    }
    pub async fn sync<F, Fut>(&mut self, mut request: F) -> Result<()>
    where
        F: FnMut(&'static str, Value) -> Fut,
        Fut: Future<Output = Result<Value>>,
    {
        let mut params = json!({"_meta":request_meta()});
        if let Some(c) = &self.catalog {
            params["ifCatalog"] = c["catalog"].clone()
        };
        let first = request("nox/tools/catalog", params).await?;
        validate("discovery-catalog", &first)?;
        if first["notModified"] == true {
            let Some(old) = &mut self.catalog else {
                return error("INVALID_DISCOVERY");
            };
            if first["catalog"] != old["catalog"]
                || first["serverId"] != old["serverId"]
                || first["viewId"] != old["viewId"]
            {
                return error("INVALID_DISCOVERY");
            };
            old["ttlMs"] = first["ttlMs"].clone();
            return Ok(());
        }
        let mut entries = first["tools"].as_array().unwrap().clone();
        let mut page = first.clone();
        while let Some(cursor) = page.get("nextCursor") {
            if cursor.as_u64() != Some(entries.len() as u64) || entries.len() > 100000 {
                return error("INVALID_DISCOVERY");
            };
            page = request(
                "nox/tools/catalog",
                json!({"catalog":first["catalog"],"cursor":cursor,"_meta":request_meta()}),
            )
            .await?;
            validate("discovery-catalog", &page)?;
            if page["catalog"] != first["catalog"]
                || page["serverId"] != first["serverId"]
                || page["viewId"] != first["viewId"]
                || page["tools"].as_array().is_none_or(Vec::is_empty)
            {
                return error("STALE_CATALOG");
            };
            entries.extend(page["tools"].as_array().unwrap().clone());
        }
        let mut identity =
            json!({"serverId":first["serverId"],"viewId":first["viewId"],"tools":entries});
        if let Some(p) = first.get("presentation") {
            identity["presentation"] = p.clone()
        };
        if fingerprint(&identity)? != first["catalog"] {
            return error("INVALID_CATALOG");
        }
        let same = self.catalog.as_ref().is_some_and(|old| {
            old["serverId"] == first["serverId"] && old["viewId"] == first["viewId"]
        });
        let mut next = HashMap::new();
        let mut missing = vec![];
        let mut seen = HashSet::new();
        for entry in &entries {
            let name = entry["name"].as_str().unwrap();
            if !seen.insert(name) {
                return error("INVALID_DISCOVERY");
            };
            if let Some(cached) = self
                .definitions
                .get(name)
                .filter(|d| same && d["fingerprint"] == entry["fingerprint"])
            {
                next.insert(name.to_string(), cached.clone());
            } else {
                missing.push(json!({"name":name,"fingerprint":entry["fingerprint"]}));
            }
        }
        for batch in missing.chunks(64) {
            let response = request(
                "nox/tools/definitions",
                json!({"catalog":first["catalog"],"tools":batch,"_meta":request_meta()}),
            )
            .await?;
            validate("discovery-definitions", &response)?;
            if response["catalog"] != first["catalog"]
                || response["definitions"].as_array().unwrap().len() != batch.len()
            {
                return error("STALE_CATALOG");
            };
            for d in response["definitions"].as_array().unwrap() {
                let name = d["tool"]["name"].as_str().unwrap();
                let mut bundle = json!({"tool":d["tool"]});
                if let Some(cli) = d.get("cli") {
                    interpret_cli(cli)?;
                    bundle["cli"] = cli.clone()
                };
                if next.contains_key(name)
                    || !batch
                        .iter()
                        .any(|r| r["name"] == name && r["fingerprint"] == d["fingerprint"])
                    || d["fingerprint"] != fingerprint(&bundle)?
                {
                    return error("INVALID_FINGERPRINT");
                };
                next.insert(name.to_string(), d.clone());
            }
        }
        let mut catalog = first;
        catalog["tools"] = json!(entries);
        catalog.as_object_mut().unwrap().remove("nextCursor");
        self.catalog = Some(catalog);
        self.definitions = next;
        Ok(())
    }
}

pub type ViewResolver = std::sync::Arc<
    dyn Fn(&rmcp::service::RequestContext<rmcp::RoleServer>, &[rmcp::model::Tool]) -> Result<View>
        + Send
        + Sync,
>;
#[derive(Clone)]
pub struct ServerDiscovery {
    pub service: Discovery,
    pub resolve_view: ViewResolver,
}
impl ServerDiscovery {
    /// The resolver may filter tools and add descriptors/availability, but cannot replace definitions.
    pub fn view(
        &self,
        context: &rmcp::service::RequestContext<rmcp::RoleServer>,
        tools: &[rmcp::model::Tool],
    ) -> Result<View> {
        let view = (self.resolve_view)(context, tools)?;
        for d in &view.definitions {
            let Some(tool) = tools
                .iter()
                .find(|t| Some(t.name.as_ref()) == d["tool"]["name"].as_str())
            else {
                return error("INVALID_DISCOVERY");
            };
            if serde_json::to_value(tool).map_err(|_| DiscoveryError("INVALID_DISCOVERY"))?
                != d["tool"]
            {
                return error("INVALID_DISCOVERY");
            }
        }
        Ok(view)
    }
}
pub fn protocol_error(e: DiscoveryError) -> rmcp::ErrorData {
    rmcp::ErrorData::invalid_params(e.0, Some(json!({"reason":e.0})))
}
