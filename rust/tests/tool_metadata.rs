use nox_mcp::{
    load_tools, tool_result, ExecutionContext, Executor, McpServer, ServerOptions,
    BRIDGE_PROTOCOL_VERSION,
};
use rmcp::{
    model::{CallToolRequestParams, CallToolResult},
    ServiceExt,
};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
struct Echo;

impl Executor for Echo {
    async fn execute(
        &self,
        name: String,
        input: Value,
        context: ExecutionContext,
    ) -> CallToolResult {
        assert_eq!(name, "create_something");
        assert_eq!(context.app_id, "test");
        assert_eq!(context.user_id.as_deref(), Some("user"));
        assert_eq!(context.scopes, ["resource:write"]);
        assert!(!context.request_id.is_empty());
        assert!(context.is_active());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(context.deadline_ms > now && context.deadline_ms <= now + 1000);
        tool_result(input, false)
    }
}

async fn check_tool_metadata(metadata: Option<Value>) {
    let schema = json!({"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]});
    let mut entry = json!({
        "name": "create_something", "title": "Test tool", "description": "Test description",
        "inputSchema": schema, "outputSchema": schema,
        "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
    });
    if let Some(metadata) = metadata.as_ref() {
        entry["_meta"] = metadata.clone();
    }
    let manifest = json!({"schemaVersion": 1, "protocolVersion": BRIDGE_PROTOCOL_VERSION, "tools": [entry.clone()]});
    let tools = Arc::new(load_tools(&manifest.to_string()).unwrap());
    assert_eq!(serde_json::to_value(&tools[0]).unwrap(), entry);
    let options = ServerOptions {
        app_id: "test".into(),
        timeout: Duration::from_secs(1),
        user_id: Some("user".into()),
        scopes: vec!["resource:write".into()],
        required_scopes: [("create_something".into(), vec!["resource:write".into()])].into(),
        ..Default::default()
    };
    for authorized in [true, false] {
        let mut options = options.clone();
        if !authorized {
            options.scopes.clear();
        }
        let server =
            McpServer::new("test".into(), "1.0.0".into(), tools.clone(), Echo, options).unwrap();
        let (client_io, server_io) = tokio::io::duplex(8192);
        let (client, server) = tokio::join!(().serve(client_io), server.serve(server_io));
        let client = client.unwrap();
        let server = server.unwrap();
        let listed = client.list_tools(None).await.unwrap();
        assert_eq!(listed.tools.len(), 1);
        let wire = serde_json::to_value(&listed).unwrap();
        assert_eq!(wire["tools"][0], entry);
        if let Some(metadata) = metadata.as_ref() {
            assert_eq!(&wire["tools"][0]["_meta"], metadata);
        } else {
            assert!(wire["tools"][0].get("_meta").is_none());
        }
        let input = json!({"value": "hello"});
        let result = client
            .call_tool(
                CallToolRequestParams::new("create_something")
                    .with_arguments(input.as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        if authorized {
            assert_eq!(
                serde_json::to_value(&result).unwrap(),
                json!({"content": [{"type": "text", "text": input.to_string()}], "isError": false, "structuredContent": input})
            );
            let invalid = client
                .call_tool(
                    CallToolRequestParams::new("create_something")
                        .with_arguments(Default::default()),
                )
                .await
                .unwrap();
            assert_eq!(invalid.is_error, Some(true));
            assert_eq!(invalid.structured_content.unwrap()["code"], "INVALID_INPUT");
        } else {
            assert_eq!(result.is_error, Some(true));
            assert_eq!(result.structured_content.unwrap()["code"], "FORBIDDEN");
        }
        client.cancel().await.unwrap();
        server.cancel().await.unwrap();
    }
}

#[tokio::test]
async fn tools_list_preserves_arbitrary_metadata() {
    tokio::time::timeout(
        Duration::from_secs(5),
        check_tool_metadata(Some(json!({
            "cli": "resource create",
            "custom": {"flags": ["one", "two"], "enabled": true, "count": 2, "value": null}
        }))),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn tools_without_metadata_work_normally() {
    tokio::time::timeout(Duration::from_secs(5), check_tool_metadata(None))
        .await
        .unwrap();
}

#[tokio::test]
async fn tools_list_preserves_empty_metadata() {
    tokio::time::timeout(Duration::from_secs(5), check_tool_metadata(Some(json!({}))))
        .await
        .unwrap();
}
