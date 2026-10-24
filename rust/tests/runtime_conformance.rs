use nox_mcp::{tool_result, ExecutionContext, Executor, McpServer, ServerOptions};
use rmcp::{model::*, service::RequestContext, ServerHandler, ServiceExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct ExampleExecutor {
    example: Value,
    started: Arc<Notify>,
    executed: Arc<AtomicBool>,
}
impl Executor for ExampleExecutor {
    async fn execute(&self, _: String, input: Value, context: ExecutionContext) -> CallToolResult {
        self.started.notify_one();
        self.executed.store(true, Ordering::SeqCst);
        match self.example["behavior"].as_str() {
            Some("pre-cancel") => panic!("pre-cancelled request executed"),
            Some("invalid-error") => {
                tool_result(json!({"code":"","message":"Invalid error"}), true)
            }
            Some("custom-error") => tool_result(
                json!({"code":"CONFLICT","message":"Domain conflict","details":{"version":2}}),
                true,
            ),
            Some("panic") => {
                // Exercise sanitization beyond the old, unrelated 30 ms deadline.
                tokio::time::sleep(Duration::from_millis(
                    self.example["delayMs"].as_u64().unwrap_or(0),
                ))
                .await;
                panic!("PRIVATE SECRET")
            }
            Some("timeout" | "cancel") => {
                context.cancellation.cancelled().await;
                tool_result(json!({"value":"late"}), false)
            }
            _ => {
                assert_eq!(input, self.example["input"]);
                tool_result(self.example["result"].clone(), false)
            }
        }
    }
}
fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|values| {
            values
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn shared_runtime_conformance() {
    let corpus: Value =
        serde_json::from_str(include_str!("../contracts/conformance.json")).unwrap();
    let mut report = vec![];
    for example in corpus["runtimeCases"].as_array().unwrap() {
        let mut manifest = corpus["runtimeManifest"].clone();
        manifest["tools"][0]["requiredScopes"] = json!(strings(&example["requiredScopes"]));
        if example["scope"].is_string() {
            manifest["tools"][0]["scope"] = example["scope"].clone();
        }
        manifest["tools"][0]["annotations"]["readOnlyHint"] =
            json!(example["readOnly"].as_bool().unwrap_or(true));
        let started = Arc::new(Notify::new());
        let executed = Arc::new(AtomicBool::new(false));
        let executor = ExampleExecutor {
            example: example.clone(),
            started: started.clone(),
            executed: executed.clone(),
        };
        let options = ServerOptions {
            app_id: "conformance".into(),
            // Only deadline scenarios need a short execution budget. In all
            // other cases scheduling/panic-hook delays must not decide the error.
            timeout: Duration::from_millis(
                corpus["runtimeTestPolicy"][if example["behavior"] == "timeout" {
                    "timeoutCaseMs"
                } else {
                    "normalTimeoutMs"
                }]
                .as_u64()
                .unwrap(),
            ),
            max_payload_bytes: example["maxPayloadBytes"]
                .as_u64()
                .unwrap_or(nox_mcp::MAX_PAYLOAD_BYTES as u64)
                as usize,
            scopes: strings(&example["grants"]),
            required_scopes: HashMap::from([(
                "echo".into(),
                strings(&example["appRequiredScopes"]),
            )]),
            ..Default::default()
        };
        let server = McpServer::from_manifest(
            "conformance".into(),
            "1".into(),
            &manifest.to_string(),
            executor,
            options,
        )
        .unwrap();
        let (client_io, server_io) = tokio::io::duplex(8192);
        let (client, connection) =
            tokio::join!(().serve(client_io), server.clone().serve(server_io));
        let client = client.unwrap();
        let connection = connection.unwrap();
        let listed = client.list_tools(None).await.unwrap();
        let listed = serde_json::to_value(&listed.tools[0]).unwrap();
        for key in ["_meta", "inputSchema", "outputSchema"] {
            assert_eq!(listed[key], manifest["tools"][0][key], "discovery: {key}");
        }
        for (hint, fallback) in [
            ("readOnlyHint", false),
            ("destructiveHint", true),
            ("idempotentHint", false),
            ("openWorldHint", true),
        ] {
            assert_eq!(
                listed["annotations"][hint].as_bool().unwrap_or(fallback),
                manifest["tools"][0]["annotations"][hint]
                    .as_bool()
                    .unwrap_or(fallback),
                "annotation default: {hint}"
            );
        }
        let cancellation = CancellationToken::new();
        if example["behavior"] == "pre-cancel" {
            cancellation.cancel();
        }
        let mut context = RequestContext::new(RequestId::Number(1), connection.peer().clone());
        context.ct = cancellation.clone();
        let request = CallToolRequestParams::new("echo")
            .with_arguments(example["input"].as_object().unwrap().clone());
        let mut call = Box::pin(server.call_tool(request, context));
        if example["behavior"] == "cancel" {
            tokio::select! {_=started.notified()=>cancellation.cancel(),result=&mut call=>panic!("cancel example completed before execution: {result:?}")}
        }
        let response = call.await.unwrap();
        let CallToolResponse::Complete(response) = response else {
            panic!("unexpected interactive result")
        };
        let wire = serde_json::to_value(response).unwrap();
        let body: Value =
            serde_json::from_str(wire["content"][0]["text"].as_str().unwrap()).unwrap();
        let failed = wire["isError"].as_bool().unwrap_or(false);
        if failed {
            assert!(wire.get("structuredContent").is_none());
        } else {
            assert_eq!(wire["structuredContent"], body);
        }
        let mut actual =
            json!({"id":example["id"],"isError":failed,"executed":executed.load(Ordering::SeqCst)});
        if failed {
            actual["code"] = body["code"].clone();
            actual["retryable"] = body["retryable"].clone();
            if body.get("details").is_some() {
                actual["details"] = body["details"].clone();
            }
            assert!(!wire.to_string().contains("PRIVATE SECRET"));
        } else {
            actual["body"] = body.clone();
        }
        let mut expected = example["expect"].clone();
        expected["id"] = example["id"].clone();
        assert_eq!(actual, expected, "{}", example["id"]);
        report.push(actual);
        client.cancel().await.unwrap();
        connection.cancel().await.unwrap();
    }
    if let Ok(file) = std::env::var("NOX_CONFORMANCE_REPORT") {
        std::fs::write(file, serde_json::to_vec(&report).unwrap()).unwrap();
    }
}
