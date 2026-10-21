// Test-only host. test/policy simulates a trusted host authorization resolver.
use nox_mcp::{
    discovery::{Discovery, ServerDiscovery, View},
    tool_result, ExecutionContext, Executor, McpServer, ServerOptions,
};
use rmcp::{model::*, service::RequestContext, ErrorData, RoleServer, ServerHandler, ServiceExt};
use serde_json::{json, Value};
use std::sync::Arc;
#[derive(Clone)]
struct Echo;
impl Executor for Echo {
    async fn execute(&self, _: String, input: Value, _: ExecutionContext) -> CallToolResult {
        tool_result(json!({"name":input["id"]}), false)
    }
}
#[derive(Clone)]
struct Fixture(McpServer<Echo>);
impl ServerHandler for Fixture {
    fn get_info(&self) -> ServerConfig {
        self.0.get_info()
    }
    async fn list_tools(
        &self,
        params: Option<PaginatedRequestParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        self.0.list_tools(params, ctx).await
    }
    async fn call_tool(
        &self,
        params: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        self.0.call_tool(params, ctx).await
    }
    async fn on_custom_request(
        &self,
        req: CustomRequest,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CustomResult, ErrorData> {
        if req.method == "test/stream-capability" {
            // Test-only late failure after committing a progress notification to SSE.
            let params =
                serde_json::from_value(json!({"progressToken":"late","progress":1})).unwrap();
            ctx.peer
                .send_notification(ServerNotification::ProgressNotification(
                    ProgressNotification::new(params),
                ))
                .await
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            return Err(ErrorData::missing_required_client_capability(
                serde_json::from_value(json!({"extensions":{"nox/discovery":{"version":"1.0"}}}))
                    .unwrap(),
            ));
        }
        self.0.on_custom_request(req, ctx).await
    }
}
fn server() -> Fixture {
    let c: Value =
        serde_json::from_str(include_str!("../contracts/discovery-conformance.json")).unwrap();
    let tools = vec![serde_json::from_value(c["tool"].clone()).unwrap()];
    let cli = c["cli"].clone();
    Fixture(
        McpServer::new(
            "fixture".into(),
            "0.5.0".into(),
            Arc::new(tools),
            Echo,
            ServerOptions::default(),
        )
        .unwrap()
        .with_discovery(ServerDiscovery {
            service: Discovery::new("fixture").unwrap(),
            resolve_view: Arc::new(move |ctx, tools| {
                let meta = serde_json::to_value(&ctx.meta).unwrap();
                let policy = meta["test/policy"].as_str().unwrap_or("allowed");
                let mut definitions = vec![];
                if policy != "revoked" {
                    for tool in tools {
                        let mut d = json!({"tool":tool,"cli":cli});
                        if policy == "unavailable" {
                            d["availability"] = json!("unavailable")
                        };
                        definitions.push(d);
                    }
                }
                Ok(View {
                    id: policy.into(),
                    definitions,
                    presentation: None,
                })
            }),
        }),
    )
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    if std::env::args().any(|a| a == "--http") {
        use rmcp::transport::streamable_http_server::{
            session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
        };
        let mut config = StreamableHttpServerConfig::default();
        config.legacy_session_mode = false;
        config.json_response = !std::env::args().any(|a| a == "--sse");
        let shared = server();
        let service = StreamableHttpService::new(
            move || Ok(shared.clone()),
            Arc::new(LocalSessionManager::default()),
            config,
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        println!("http://{}/mcp", listener.local_addr().unwrap());
        axum::serve(listener, axum::Router::new().nest_service("/mcp", service))
            .await
            .unwrap();
    } else {
        server()
            .serve(rmcp::transport::stdio())
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap();
    }
}
