use rmcp::{
    model::*,
    service::{RequestContext, RoleServer},
    ErrorData, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;

mod defaults;
pub use defaults::*;
pub mod discovery;
mod manifest;
pub mod suite;
pub use manifest::{compile_tool_schema, load_manifest, validate_tool_value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEvent {
    pub request_id: String,
    pub command: String,
    pub input: Value,
    pub deadline_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub generation: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrokerError {
    InvalidRequest,
    Overloaded,
    RendererUnavailable,
    Timeout,
    Cancelled,
    UnknownRequest,
}
impl std::fmt::Display for BrokerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for BrokerError {}

#[derive(Clone)]
pub struct BrokerOptions {
    pub id_prefix: String,
    pub timeout: Duration,
    pub max_payload_bytes: usize,
    pub max_in_flight: usize,
}
impl Default for BrokerOptions {
    fn default() -> Self {
        Self {
            id_prefix: "nox-mcp-".into(),
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
            max_payload_bytes: MAX_PAYLOAD_BYTES,
            max_in_flight: MAX_IN_FLIGHT_REQUESTS,
        }
    }
}
struct BrokerInner<T> {
    pending: Mutex<HashMap<String, oneshot::Sender<Result<T, BrokerError>>>>,
    next_id: AtomicU64,
    options: BrokerOptions,
}
pub struct RequestBroker<T> {
    inner: Arc<BrokerInner<T>>,
}
impl<T> Clone for RequestBroker<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn parse_deadline(value: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .and_then(|v| u64::try_from(v.timestamp_millis()).ok())
}
impl<T: Serialize + Send> RequestBroker<T> {
    pub fn new(options: BrokerOptions) -> Self {
        Self {
            inner: Arc::new(BrokerInner {
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                options,
            }),
        }
    }
    pub async fn is_pending(&self, id: &str) -> bool {
        self.inner
            .pending
            .lock()
            .await
            .get(id)
            .is_some_and(|sender| !sender.is_closed())
    }
    pub async fn dispatch(
        &self,
        command: String,
        input: Value,
        emit: impl FnOnce(&RequestEvent) -> Result<(), BrokerError>,
    ) -> Result<T, BrokerError> {
        if command.is_empty()
            || command.len() > 64
            || serde_json::to_vec(&input)
                .map_err(|_| BrokerError::InvalidRequest)?
                .len()
                > self.inner.options.max_payload_bytes
        {
            return Err(BrokerError::InvalidRequest);
        }
        let id = format!(
            "{}{}",
            self.inner.options.id_prefix,
            self.inner.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.inner.pending.lock().await;
            pending.retain(|_, sender| !sender.is_closed());
            if pending.len() >= self.inner.options.max_in_flight {
                return Err(BrokerError::Overloaded);
            }
            pending.insert(id.clone(), sender);
        }
        let event = RequestEvent {
            request_id: id.clone(),
            command,
            input,
            deadline_at: (now_ms() + self.inner.options.timeout.as_millis() as u64).to_string(),
            generation: None,
        };
        if serde_json::to_vec(&event)
            .map_err(|_| BrokerError::InvalidRequest)?
            .len()
            > self.inner.options.max_payload_bytes
        {
            self.inner.pending.lock().await.remove(&id);
            return Err(BrokerError::InvalidRequest);
        }
        if let Err(error) = emit(&event) {
            self.inner.pending.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(self.inner.options.timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(BrokerError::Cancelled),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(BrokerError::Timeout)
            }
        }
    }
    pub async fn respond(&self, id: &str, response: T) -> Result<(), BrokerError> {
        if serde_json::to_vec(&response)
            .map_err(|_| BrokerError::InvalidRequest)?
            .len()
            > self.inner.options.max_payload_bytes
        {
            return Err(BrokerError::InvalidRequest);
        }
        self.inner
            .pending
            .lock()
            .await
            .remove(id)
            .ok_or(BrokerError::UnknownRequest)?
            .send(Ok(response))
            .map_err(|_| BrokerError::UnknownRequest)
    }
    pub async fn cancel(&self, id: &str) {
        if let Some(sender) = self.inner.pending.lock().await.remove(id) {
            let _ = sender.send(Err(BrokerError::Cancelled));
        }
    }
    pub async fn cancel_all(&self) {
        for (_, sender) in self.inner.pending.lock().await.drain() {
            let _ = sender.send(Err(BrokerError::Cancelled));
        }
    }
}

pub struct ExecutionRegistry {
    generation: String,
    active: HashMap<String, u64>,
    seen: HashMap<String, u64>,
    max_in_flight: usize,
}
impl Default for ExecutionRegistry {
    fn default() -> Self {
        Self {
            generation: String::new(),
            active: HashMap::new(),
            seen: HashMap::new(),
            max_in_flight: MAX_IN_FLIGHT_REQUESTS,
        }
    }
}
impl ExecutionRegistry {
    pub fn with_limit(max_in_flight: usize) -> Result<Self, BrokerError> {
        if max_in_flight == 0 {
            return Err(BrokerError::InvalidRequest);
        }
        Ok(Self {
            max_in_flight,
            ..Self::default()
        })
    }
    pub fn register_for(
        &mut self,
        generation: &str,
        id: &str,
        deadline_ms: u64,
    ) -> Result<String, BrokerError> {
        if generation != self.generation {
            return Err(BrokerError::InvalidRequest);
        }
        self.register(id, deadline_ms)
    }
    pub fn open(&mut self, generation: String) {
        self.clear();
        self.generation = generation;
    }
    pub fn register(&mut self, id: &str, deadline_ms: u64) -> Result<String, BrokerError> {
        let now = now_ms();
        self.active.retain(|_, deadline| *deadline > now);
        self.seen.retain(|_, deadline| *deadline > now);
        if self.generation.is_empty() || deadline_ms <= now || self.seen.contains_key(id) {
            return Err(BrokerError::InvalidRequest);
        }
        if self.active.len() >= self.max_in_flight || self.seen.len() >= 4096 {
            return Err(BrokerError::Overloaded);
        }
        self.active.insert(id.into(), deadline_ms);
        self.seen.insert(id.into(), deadline_ms);
        Ok(self.generation.clone())
    }
    pub fn is_pending(&self, id: &str, generation: &str) -> bool {
        generation == self.generation
            && self
                .active
                .get(id)
                .is_some_and(|deadline| *deadline > now_ms())
    }
    pub fn cancel(&mut self, id: &str) {
        self.active.remove(id);
    }
    pub fn clear(&mut self) {
        self.generation.clear();
        self.active.clear();
        self.seen.clear();
    }
    pub fn generation(&self) -> &str {
        &self.generation
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    title: String,
    description: String,
    #[serde(rename = "_meta")]
    meta: Option<MetaObject>,
    input_schema: Map<String, Value>,
    output_schema: Map<String, Value>,
    annotations: ToolAnnotations,
}
pub fn load_tools(json: &str) -> Result<Vec<Tool>, BrokerError> {
    let manifest = load_manifest(json)?;
    // This legacy projection cannot carry requirements. Never silently discard them.
    if manifest["tools"].as_array().unwrap().iter().any(|tool| {
        tool["requiredScopes"]
            .as_array()
            .is_some_and(|scopes| !scopes.is_empty())
    }) {
        return Err(BrokerError::InvalidRequest);
    }
    project_tools(&manifest)
}
fn project_tools(manifest: &Value) -> Result<Vec<Tool>, BrokerError> {
    manifest["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            let e: Entry =
                serde_json::from_value(value.clone()).map_err(|_| BrokerError::InvalidRequest)?;
            let mut tool = Tool::new(e.name, e.description, e.input_schema)
                .with_title(e.title)
                .with_annotations(e.annotations);
            tool.output_schema = Some(Arc::new(e.output_schema));
            tool.meta = e.meta;
            Ok(tool)
        })
        .collect()
}
pub fn tool_result(value: Value, is_error: bool) -> CallToolResult {
    let mut result = if is_error {
        CallToolResult::structured_error(value.clone())
    } else {
        CallToolResult::structured(value.clone())
    };
    result.content = vec![ContentBlock::text(value.to_string())];
    if is_error {
        result.structured_content = None;
    }
    result
}
pub fn error_result(code: &str, message: &str, retryable: bool) -> CallToolResult {
    tool_result(
        serde_json::json!({ "code": code, "message": message, "retryable": retryable }),
        true,
    )
}

#[derive(Clone)]
pub struct ExecutionContext {
    pub request_id: String,
    pub app_id: String,
    pub user_id: Option<String>,
    pub scopes: Vec<String>,
    pub deadline_ms: u64,
    pub cancellation: CancellationToken,
}
impl ExecutionContext {
    pub fn is_active(&self) -> bool {
        !self.cancellation.is_cancelled() && self.deadline_ms > now_ms()
    }
}
#[derive(Clone)]
pub struct ServerOptions {
    pub app_id: String,
    pub timeout: Duration,
    pub max_payload_bytes: usize,
    pub max_in_flight: usize,
    pub user_id: Option<String>,
    pub scopes: Vec<String>,
    pub required_scopes: HashMap<String, Vec<String>>,
}
impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            app_id: "nox".into(),
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
            max_payload_bytes: MAX_PAYLOAD_BYTES,
            max_in_flight: MAX_IN_FLIGHT_REQUESTS,
            user_id: None,
            scopes: vec![],
            required_scopes: HashMap::new(),
        }
    }
}
pub trait Executor: Clone + Send + Sync + 'static {
    fn execute(
        &self,
        name: String,
        input: Value,
        context: ExecutionContext,
    ) -> impl Future<Output = CallToolResult> + Send;
}
#[derive(Clone)]
pub struct McpServer<E: Executor> {
    pub name: String,
    pub version: String,
    pub instructions: String,
    pub tools: Arc<Vec<Tool>>,
    pub executor: E,
    options: ServerOptions,
    in_flight: Arc<AtomicUsize>,
    next_id: Arc<AtomicU64>,
    portable_validators: Arc<HashMap<String, (jsonschema::Validator, jsonschema::Validator)>>,
    discovery: Option<discovery::ServerDiscovery>,
    suite: Option<Arc<suite::SuiteRuntimeOptions>>,
}
impl<E: Executor> McpServer<E> {
    /// Bind an independent Suite endpoint to trusted additive tool policy.
    pub fn with_suite(mut self, config: suite::SuiteRuntimeOptions) -> suite::SuiteResult<Self> {
        for policy in config.policies.values() {
            let value =
                serde_json::to_value(policy).map_err(|_| suite::SuiteError("INVALID_POLICY"))?;
            suite::validate_suite_document("policy", &value)?;
            if policy.argument_dependent && config.additional_scopes.is_none() {
                return Err(suite::SuiteError("INVALID_POLICY"));
            }
        }
        let mut tools = vec![];
        for tool in self.tools.iter() {
            let Some(policy) = config.policies.get(tool.name.as_ref()) else {
                continue;
            };
            let mut value =
                serde_json::to_value(tool).map_err(|_| suite::SuiteError("INVALID_POLICY"))?;
            if value.get("_meta").is_none() {
                value["_meta"] = serde_json::json!({})
            }
            value["_meta"]["nox/authorization"] = serde_json::to_value(policy).unwrap();
            tools.push(
                serde_json::from_value(value).map_err(|_| suite::SuiteError("INVALID_POLICY"))?,
            );
            let required = self
                .options
                .required_scopes
                .entry(tool.name.to_string())
                .or_default();
            for scope in &policy.required_scopes {
                if !required.contains(scope) {
                    required.push(scope.clone())
                }
            }
        }
        self.tools = Arc::new(tools);
        self.suite = Some(Arc::new(config));
        Ok(self)
    }
    fn authorized_tools(
        &self,
        context: &RequestContext<RoleServer>,
        method: &str,
    ) -> Result<Vec<Tool>, ErrorData> {
        let Some(config) = &self.suite else {
            return Ok(self.tools.as_ref().clone());
        };
        let (_, scopes) = config
            .authorize(context, method)
            .map_err(|e| ErrorData::invalid_params(e.0, None))?;
        Ok(self
            .tools
            .iter()
            .filter(|tool| {
                config
                    .policies
                    .get(tool.name.as_ref())
                    .is_some_and(|policy| {
                        policy
                            .required_scopes
                            .iter()
                            .all(|scope| scopes.contains(scope))
                    })
                    && self
                        .options
                        .required_scopes
                        .get(tool.name.as_ref())
                        .is_none_or(|required| required.iter().all(|s| scopes.contains(s)))
            })
            .cloned()
            .collect())
    }
    fn discovery_view(
        &self,
        context: &RequestContext<RoleServer>,
    ) -> Result<discovery::View, ErrorData> {
        let allowed = self.authorized_tools(context, "tools/list")?;
        let d = self
            .discovery
            .as_ref()
            .ok_or_else(|| ErrorData::invalid_params("Discovery unavailable", None))?;
        let mut view = d
            .view(context, &self.tools)
            .map_err(discovery::protocol_error)?;
        if let Some(config) = &self.suite {
            let (identity, scopes) = config
                .authorize(context, "tools/list")
                .map_err(|e| ErrorData::invalid_params(e.0, None))?;
            view.definitions.retain(|v| {
                allowed
                    .iter()
                    .any(|t| Some(t.name.as_ref()) == v["tool"]["name"].as_str())
            });
            view.id = discovery::fingerprint(&serde_json::json!([
                view.id,
                identity.claims()["iss"],
                identity.context(),
                scopes
            ]))
            .map_err(discovery::protocol_error)?;
        }
        Ok(view)
    }
    pub fn with_discovery(mut self, discovery: discovery::ServerDiscovery) -> Self {
        self.discovery = Some(discovery);
        self
    }
    /// Explicitly bind a prepared manifest to a trusted executor and authenticated grants.
    /// Declared requirements are unioned with application policy, never with granted scopes.
    pub fn from_manifest(
        name: String,
        version: String,
        json: &str,
        executor: E,
        mut options: ServerOptions,
    ) -> Result<Self, BrokerError> {
        let manifest = load_manifest(json)?;
        for tool in manifest["tools"].as_array().unwrap() {
            if let Some(scopes) = tool["requiredScopes"].as_array() {
                let required = options
                    .required_scopes
                    .entry(tool["name"].as_str().unwrap().into())
                    .or_default();
                for scope in scopes {
                    let scope = scope.as_str().unwrap().to_string();
                    if !required.contains(&scope) {
                        required.push(scope);
                    }
                }
            }
        }
        let mut server = Self::new(
            name,
            version,
            Arc::new(project_tools(&manifest)?),
            executor,
            options,
        )?;
        let mut validators = HashMap::new();
        for tool in manifest["tools"].as_array().unwrap() {
            validators.insert(
                tool["name"].as_str().unwrap().to_string(),
                (
                    compile_tool_schema(&tool["inputSchema"])?,
                    compile_tool_schema(&tool["outputSchema"])?,
                ),
            );
        }
        server.portable_validators = Arc::new(validators);
        Ok(server)
    }
    pub fn new(
        name: String,
        version: String,
        tools: Arc<Vec<Tool>>,
        executor: E,
        options: ServerOptions,
    ) -> Result<Self, BrokerError> {
        if name.is_empty()
            || options.app_id.is_empty()
            || options.timeout.is_zero()
            || options.max_payload_bytes == 0
            || options.max_in_flight == 0
        {
            return Err(BrokerError::InvalidRequest);
        }
        let mut names = HashSet::new();
        for tool in tools.iter() {
            if tool.name.is_empty()
                || tool.name.chars().count() > 64
                || !names.insert(tool.name.as_ref())
            {
                return Err(BrokerError::InvalidRequest);
            }
            // Native APIs may use the SDK's wider schema dialects; reject invalid schemas early.
            for schema in std::iter::once(&tool.input_schema).chain(tool.output_schema.iter()) {
                if jsonschema::options()
                    .should_validate_formats(true)
                    .build(&Value::Object(schema.as_ref().clone()))
                    .is_err()
                {
                    return Err(BrokerError::InvalidRequest);
                }
            }
        }
        if options.required_scopes.iter().any(|(name, scopes)| {
            !names.contains(name.as_str()) || scopes.iter().any(|scope| scope.is_empty())
        }) {
            return Err(BrokerError::InvalidRequest);
        }
        Ok(Self {
            name,
            version,
            instructions: String::new(),
            tools,
            executor,
            options,
            in_flight: Arc::new(AtomicUsize::new(0)),
            next_id: Arc::new(AtomicU64::new(1)),
            portable_validators: Arc::new(HashMap::new()),
            discovery: None,
            suite: None,
        })
    }
}
struct ExecutionGuard {
    active: Arc<AtomicUsize>,
    cancellation: CancellationToken,
}
impl Drop for ExecutionGuard {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.active.fetch_sub(1, Ordering::Relaxed);
    }
}
impl<E: Executor> ServerHandler for McpServer<E> {
    fn get_info(&self) -> ServerConfig {
        let mut capabilities = ServerCapabilities::builder().enable_tools().build();
        if self.discovery.is_some() {
            capabilities.extensions = Some(
                serde_json::from_value(
                    serde_json::json!({discovery::EXTENSION:discovery::capability()}),
                )
                .unwrap(),
            );
        }
        ServerConfig::new(capabilities)
            .with_server_info(Implementation::new(self.name.clone(), self.version.clone()))
            .with_instructions(self.instructions.clone())
    }
    fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, ErrorData>> + Send + '_ {
        std::future::ready((|| {
            let tools = if self.discovery.is_some() {
                self.discovery_view(&context)?
                    .definitions
                    .into_iter()
                    .map(|v| {
                        serde_json::from_value(v["tool"].clone())
                            .map_err(|_| ErrorData::invalid_params("Invalid tool", None))
                    })
                    .collect::<Result<Vec<Tool>, _>>()?
            } else {
                self.authorized_tools(&context, "tools/list")?
            };
            Ok(ListToolsResult::with_all_items(tools))
        })())
    }
    async fn on_custom_request(
        &self,
        request: CustomRequest,
        context: RequestContext<RoleServer>,
    ) -> Result<CustomResult, ErrorData> {
        let Some(d) = &self.discovery else {
            return Err(ErrorData::new(
                ErrorCode::METHOD_NOT_FOUND,
                request.method,
                None,
            ));
        };
        let mut params = request.params.unwrap_or_else(|| serde_json::json!({}));
        // rmcp lifts request metadata into the context for custom methods.
        let meta = serde_json::to_value(&context.meta).unwrap();
        discovery::negotiated(&meta).map_err(discovery::protocol_error)?;
        if let Some(p) = params.as_object_mut() {
            p.remove("_meta");
        }
        if let Some(config) = &self.suite {
            config
                .authorize(&context, &request.method)
                .map_err(|e| ErrorData::invalid_params(e.0, None))?;
        }
        let view = self.discovery_view(&context)?;
        let result = match request.method.as_str() {
            "nox/tools/catalog" => d.service.catalog(&view, &params),
            "nox/tools/definitions" => d.service.definitions(&view, &params),
            _ => return Err(ErrorData::invalid_params("Unknown extension method", None)),
        };
        result
            .map(CustomResult::new)
            .map_err(discovery::protocol_error)
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tools.iter().find(|tool| tool.name == name).cloned()
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let (user_id, scopes) = if let Some(config) = &self.suite {
            match config.authorize(&context, "tools/call") {
                Ok((identity, scopes)) => (
                    identity.context()["userId"].as_str().map(str::to_string),
                    scopes,
                ),
                Err(_) => {
                    return Ok(error_result(
                        "FORBIDDEN",
                        "The requested operation is not allowed",
                        false,
                    )
                    .into())
                }
            }
        } else {
            (self.options.user_id.clone(), self.options.scopes.clone())
        };
        let tool = self
            .get_tool(request.name.as_ref())
            .ok_or_else(|| ErrorData::invalid_params("Unknown tool", None))?;
        if self.suite.as_ref().is_some_and(|config| {
            config
                .policies
                .get(request.name.as_ref())
                .is_none_or(|policy| {
                    policy
                        .required_scopes
                        .iter()
                        .any(|scope| !scopes.contains(scope))
                })
        }) {
            return Ok(
                error_result("FORBIDDEN", "The requested operation is not allowed", false).into(),
            );
        }
        if let Some(d) = &self.discovery {
            let view = self.discovery_view(&context)?;
            d.service
                .guard(
                    &view,
                    request.name.as_ref(),
                    &serde_json::to_value(&context.meta).unwrap(),
                )
                .map_err(discovery::protocol_error)?;
        }
        let mut deadline = now_ms() + self.options.timeout.as_millis() as u64;
        let mut request_id = format!("nox-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        if self.suite.is_some() {
            if let Some(controls) = context
                .extensions
                .get::<suite::SuiteRequestControls>()
                .or_else(|| {
                    context
                        .extensions
                        .get::<http::request::Parts>()
                        .and_then(|parts| parts.extensions.get::<suite::SuiteRequestControls>())
                })
            {
                match suite::suite_request_budget(
                    controls,
                    now_ms() as i64,
                    self.options.timeout.as_millis() as i64,
                    0,
                ) {
                    Ok(budget) => {
                        request_id = budget.request_id;
                        deadline = suite::parse_suite_timestamp(&budget.deadline_at)
                            .map_err(|e| ErrorData::invalid_params(e.0, None))?
                            as u64;
                    }
                    Err(_) => return Ok(ended_result("TIMEOUT", false).into()),
                }
            }
        }
        if self
            .options
            .required_scopes
            .get(request.name.as_ref())
            .is_some_and(|required| required.iter().any(|scope| !scopes.contains(scope)))
        {
            return Ok(
                error_result("FORBIDDEN", "The requested operation is not allowed", false).into(),
            );
        }
        let read_only = tool
            .annotations
            .as_ref()
            .is_some_and(|a| a.read_only_hint == Some(true));
        if context.ct.is_cancelled() {
            return Ok(ended_result("CANCELLED", read_only).into());
        }
        if now_ms() >= deadline {
            return Ok(ended_result("TIMEOUT", read_only).into());
        }
        let input = Value::Object(request.arguments.unwrap_or_default());
        if serde_json::to_vec(&input)
            .map_or(true, |data| data.len() > self.options.max_payload_bytes)
            || !self
                .portable_validators
                .get(request.name.as_ref())
                .map_or_else(
                    || validate_schema(&Value::Object(tool.input_schema.as_ref().clone()), &input),
                    |validators| validators.0.is_valid(&input),
                )
        {
            return Ok(error_result("INVALID_INPUT", "Invalid input", false).into());
        }
        if now_ms() >= deadline {
            return Ok(ended_result("TIMEOUT", read_only).into());
        }
        if self
            .in_flight
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |active| {
                (active < self.options.max_in_flight).then_some(active + 1)
            })
            .is_err()
        {
            return Ok(error_result("OVERLOADED", "Too many requests", true).into());
        }
        let cancellation = context.ct.child_token();
        let _guard = ExecutionGuard {
            active: self.in_flight.clone(),
            cancellation: cancellation.clone(),
        };
        let execution = ExecutionContext {
            request_id,
            app_id: self.options.app_id.clone(),
            user_id,
            scopes,
            deadline_ms: deadline,
            cancellation: cancellation.clone(),
        };
        let executor = self.executor.clone();
        let tool_name = request.name.into_owned();
        let suite = self.suite.clone();
        let mut work = tokio::spawn(async move {
            if !execution.is_active() {
                return ended_result(
                    if now_ms() >= execution.deadline_ms {
                        "TIMEOUT"
                    } else {
                        "CANCELLED"
                    },
                    read_only,
                );
            }
            if let Some(config) = suite {
                if let Some(additional) = &config.additional_scopes {
                    match additional(tool_name.clone(), input.clone(), execution.clone()).await {
                        Ok(required)
                            if required
                                .iter()
                                .all(|s| !s.is_empty() && execution.scopes.contains(s)) => {}
                        _ => {
                            return error_result(
                                "FORBIDDEN",
                                "The requested operation is not allowed",
                                false,
                            )
                        }
                    }
                    if !execution.is_active() {
                        return ended_result(
                            if now_ms() >= execution.deadline_ms {
                                "TIMEOUT"
                            } else {
                                "CANCELLED"
                            },
                            read_only,
                        );
                    }
                }
            }
            executor.execute(tool_name, input, execution).await
        });
        let result = tokio::select! {
            _ = cancellation.cancelled() => ended_result("CANCELLED", read_only),
            value = tokio::time::timeout(Duration::from_millis(deadline.saturating_sub(now_ms())), &mut work) => match value {
                Ok(Ok(result))=>result,
                Ok(Err(_))=>error_result("INTERNAL","An internal error occurred",false),
                Err(_)=>ended_result("TIMEOUT",read_only),
            },
        };
        work.abort();
        if now_ms() >= deadline {
            return Ok(ended_result("TIMEOUT", read_only).into());
        }
        if cancellation.is_cancelled() {
            return Ok(ended_result("CANCELLED", read_only).into());
        }
        if serde_json::to_vec(&result)
            .map_or(true, |data| data.len() > self.options.max_payload_bytes)
        {
            return Ok(error_result("INTERNAL", "Result exceeds the payload limit", false).into());
        }
        if result.is_error != Some(true)
            && tool.output_schema.as_ref().is_some_and(|schema| {
                !result.structured_content.as_ref().is_some_and(|value| {
                    self.portable_validators
                        .get(tool.name.as_ref())
                        .map_or_else(
                            || validate_schema(&Value::Object(schema.as_ref().clone()), value),
                            |validators| validators.1.is_valid(value),
                        )
                })
            })
        {
            return Ok(error_result("INTERNAL", "Invalid tool result", false).into());
        }
        if result.is_error == Some(true) {
            // Accept existing executor implementations using structured_error,
            // as well as the text-only public error_result/tool_result helpers.
            let Some(mut body) = result.structured_content.clone().or_else(|| {
                let wire = serde_json::to_value(&result).ok()?;
                serde_json::from_str(wire["content"][0]["text"].as_str()?).ok()
            }) else {
                return Ok(error_result("INTERNAL", "Invalid tool error", false).into());
            };
            let schema: Value =
                serde_json::from_str(include_str!("../contracts/error.schema.json")).unwrap();
            if !validate_schema(&schema, &body) {
                return Ok(error_result("INTERNAL", "Invalid tool error", false).into());
            }
            if body.get("retryable").is_none() {
                body["retryable"] = Value::Bool(false);
            }
            let normalized = tool_result(body, true);
            if serde_json::to_vec(&normalized)
                .map_or(true, |data| data.len() > self.options.max_payload_bytes)
            {
                return Ok(
                    error_result("INTERNAL", "Result exceeds the payload limit", false).into(),
                );
            }
            return Ok(normalized.into());
        }
        if now_ms() >= deadline {
            return Ok(ended_result("TIMEOUT", read_only).into());
        }
        if cancellation.is_cancelled() {
            return Ok(ended_result("CANCELLED", read_only).into());
        }
        if self.portable_validators.contains_key(tool.name.as_ref()) {
            if let Some(value) = result.structured_content {
                let normalized = tool_result(value, false);
                if serde_json::to_vec(&normalized)
                    .map_or(true, |data| data.len() > self.options.max_payload_bytes)
                {
                    return Ok(
                        error_result("INTERNAL", "Result exceeds the payload limit", false).into(),
                    );
                }
                return Ok(normalized.into());
            }
        }
        Ok(result.into())
    }
}
pub fn validate_schema(schema: &Value, value: &Value) -> bool {
    jsonschema::options()
        .should_validate_formats(true)
        .build(schema)
        .is_ok_and(|validator| validator.is_valid(value))
}
fn ended_result(code: &str, read_only: bool) -> CallToolResult {
    let mut body = serde_json::json!({"code":code,"message":"The request ended before a confirmed result","retryable":read_only});
    if !read_only {
        body["details"] = serde_json::json!({"outcome":"unknown"});
    }
    tool_result(body, true)
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    Authenticated,
    Request {
        #[serde(rename = "requestId")]
        request_id: String,
        command: String,
        input: Value,
        #[serde(rename = "deadlineAt")]
        deadline_at: String,
    },
    Cancel {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    SessionRevoked {
        reason: String,
    },
}
pub fn parse_server_frame(bytes: &[u8], max_bytes: usize) -> Result<ServerFrame, BrokerError> {
    if bytes.len() > max_bytes {
        return Err(BrokerError::InvalidRequest);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| BrokerError::InvalidRequest)?;
    let schema: Value = serde_json::from_str(include_str!("../contracts/server.schema.json"))
        .map_err(|_| BrokerError::InvalidRequest)?;
    if !validate_schema(&schema, &value) {
        return Err(BrokerError::InvalidRequest);
    }
    serde_json::from_value(value).map_err(|_| BrokerError::InvalidRequest)
}
impl ServerFrame {
    pub fn into_request(self) -> Option<RequestEvent> {
        match self {
            Self::Request {
                request_id,
                command,
                input,
                deadline_at,
            } => Some(RequestEvent {
                request_id,
                command,
                input,
                deadline_at,
                generation: None,
            }),
            _ => None,
        }
    }
}
pub trait CredentialStore<T>: Send + Sync {
    type Error;
    fn load(&self) -> Result<Option<T>, Self::Error>;
    fn save(&self, credential: &T) -> Result<(), Self::Error>;
    fn delete(&self) -> Result<(), Self::Error>;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connection_replacement_invalidates_old_work() {
        let mut registry = ExecutionRegistry::default();
        registry.open("one".into());
        registry.register("request", now_ms() + 20000).unwrap();
        assert!(registry.is_pending("request", "one"));
        registry.cancel("request");
        assert!(!registry.is_pending("request", "one"));
        assert!(registry.register("request", now_ms() + 20000).is_err());
        registry.open("two".into());
        assert!(!registry.is_pending("request", "one"));
    }
    #[tokio::test]
    async fn broker_cancellation_rejects_late_responses() {
        let broker = RequestBroker::<Value>::new(BrokerOptions::default());
        let task_broker = broker.clone();
        let (tx, rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            task_broker
                .dispatch("echo".into(), serde_json::json!({}), |event| {
                    tx.send(event.request_id.clone()).unwrap();
                    Ok(())
                })
                .await
        });
        let id = rx.await.unwrap();
        broker.cancel_all().await;
        assert_eq!(task.await.unwrap(), Err(BrokerError::Cancelled));
        assert_eq!(
            broker.respond(&id, Value::Null).await,
            Err(BrokerError::UnknownRequest)
        );
    }
}
