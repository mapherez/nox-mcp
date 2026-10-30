use nox_mcp::{
    load_tools, suite::*, tool_result, ExecutionContext, Executor, McpServer, ServerOptions,
};
use rmcp::{
    model::{CallToolRequestParams, CallToolResult},
    ServiceExt,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicI64, AtomicUsize, Ordering},
        Arc,
    },
};

fn fixture() -> (Value, VerifiedSuiteIdentity) {
    let c: Value =
        serde_json::from_str(include_str!("../contracts/suite-conformance.json")).unwrap();
    let c = c["crypto"].clone();
    let key = serde_json::from_value(c["publicKey"].clone()).unwrap();
    let keys = HashMap::from([("fixture-es256".to_string(), key)]);
    let b = &c["options"];
    let options = SuiteVerificationOptions {
        issuer: b["issuer"].as_str().unwrap(),
        audience: b["audience"].as_str().unwrap(),
        product_id: b["productId"].as_str().unwrap(),
        association_id: b["associationId"].as_str().unwrap(),
        gateway_service_id: b["gatewayServiceId"].as_str().unwrap(),
        registration_revision: b["registrationRevision"].as_str(),
        service_credential_revision: b["serviceCredentialRevision"].as_str(),
        keys: &keys,
        now_ms: b["nowMs"].as_i64().unwrap(),
        kind: None,
    };
    let identity = verify_suite_token(c["userToken"].as_str().unwrap(), &options).unwrap();
    (c, identity)
}
#[derive(Clone)]
struct Echo(Arc<AtomicUsize>);
impl Executor for Echo {
    async fn execute(&self, _: String, input: Value, context: ExecutionContext) -> CallToolResult {
        assert_eq!(context.user_id.as_deref(), Some("user-1"));
        assert_eq!(context.scopes, vec!["nox:inspect"]);
        self.0.fetch_add(1, Ordering::SeqCst);
        tool_result(input, false)
    }
}
#[tokio::test]
async fn suite_runtime_checks_signed_and_dynamic_policy() {
    let (c, identity) = fixture();
    let count = Arc::new(AtomicUsize::new(0));
    let schema = json!({"type":"object"});
    let tools=load_tools(&json!({"schemaVersion":1,"protocolVersion":"2.0","tools":(["inspect","dynamic","write","unclassified"].map(|name|json!({"name":name,"title":name,"description":name,"inputSchema":schema,"outputSchema":schema,"annotations":{}})))}).to_string()).unwrap();
    let inspect = load_suite_policy(
        r#"{"version":"1.0","requiredScopes":["nox:inspect"],"argumentDependent":false}"#,
    )
    .unwrap();
    let mut dynamic = inspect.clone();
    dynamic.argument_dependent = true;
    let mut write = inspect.clone();
    write.required_scopes.push("nox:write".into());
    let now = c["options"]["nowMs"].as_i64().unwrap();
    let config = SuiteRuntimeOptions {
        policies: HashMap::from([
            ("inspect".into(), inspect),
            ("dynamic".into(), dynamic),
            ("write".into(), write),
        ]),
        identity_resolver: Some(Arc::new(move |_| Ok(identity.clone()))),
        clock: Some(Arc::new(move || now)),
        additional_scopes: Some(Arc::new(|_, input, _| {
            Box::pin(async move {
                Ok(if input["write"] == true {
                    vec!["nox:write".into()]
                } else {
                    vec![]
                })
            })
        })),
        ..Default::default()
    };
    let unclassified = tools
        .iter()
        .find(|tool| tool.name == "unclassified")
        .unwrap()
        .clone();
    let mut server = McpServer::new(
        "fixture".into(),
        "1".into(),
        Arc::new(tools),
        Echo(count.clone()),
        ServerOptions::default(),
    )
    .unwrap()
    .with_suite(config)
    .unwrap();
    // The public native tool registry may be replaced by a host after construction.
    // That must not give an unclassified tool Suite authority.
    let mut changed = server.tools.as_ref().clone();
    changed.push(unclassified);
    server.tools = Arc::new(changed);

    let (client_io, server_io) = tokio::io::duplex(8192);
    let (client, server) = tokio::join!(().serve(client_io), server.serve(server_io));
    let client = client.unwrap();
    let server = server.unwrap();
    let listed = client.list_tools(None).await.unwrap();
    assert_eq!(
        listed
            .tools
            .iter()
            .map(|t| t.name.as_ref())
            .collect::<Vec<_>>(),
        ["inspect", "dynamic"]
    );
    assert!(!client
        .call_tool(CallToolRequestParams::new("inspect").with_arguments(Default::default()))
        .await
        .unwrap()
        .is_error
        .unwrap_or(false));
    for name in ["dynamic", "write"] {
        let result = client
            .call_tool(
                CallToolRequestParams::new(name)
                    .with_arguments(json!({"write":true}).as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(true));
    }
    assert!(client
        .call_tool(CallToolRequestParams::new("unclassified").with_arguments(Default::default()))
        .await
        .unwrap()
        .is_error
        .unwrap_or(false));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    client.cancel().await.unwrap();
    server.cancel().await.unwrap();
}
#[test]
fn suite_http_admission_validates_headers_and_probe_batch() {
    let (c, _) = fixture();
    let key = serde_json::from_value(c["publicKey"].clone()).unwrap();
    let keys = HashMap::from([("fixture-es256".into(), key)]);
    let b = &c["options"];
    let options = SuiteVerificationOptions {
        issuer: b["issuer"].as_str().unwrap(),
        audience: b["audience"].as_str().unwrap(),
        product_id: b["productId"].as_str().unwrap(),
        association_id: b["associationId"].as_str().unwrap(),
        gateway_service_id: b["gatewayServiceId"].as_str().unwrap(),
        registration_revision: b["registrationRevision"].as_str(),
        service_credential_revision: b["serviceCredentialRevision"].as_str(),
        keys: &keys,
        now_ms: b["nowMs"].as_i64().unwrap(),
        kind: None,
    };
    let (mut parts, _) = http::Request::builder()
        .header(
            "authorization",
            format!("Bearer {}", c["probeToken"].as_str().unwrap()),
        )
        .body(())
        .unwrap()
        .into_parts();
    let body=br#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"tools/list"}]"#;
    assert_eq!(
        admit_suite_http_request(&mut parts, body, &options, 20000)
            .unwrap_err()
            .0,
        "FORBIDDEN"
    );
    assert!(parts.extensions.get::<VerifiedSuiteIdentity>().is_none());
    let (mut parts, _) = http::Request::builder()
        .header(
            "authorization",
            format!("Bearer {}", c["userToken"].as_str().unwrap()),
        )
        .body(())
        .unwrap()
        .into_parts();
    assert_eq!(
        admit_suite_http_request(&mut parts, br#"{"method":"tools/call"}"#, &options, 20000)
            .unwrap_err()
            .0,
        "INVALID_REQUEST_CONTROLS"
    );
    assert!(
        admit_suite_http_request(&mut parts, br#"{"method":"tools/list"}"#, &options, 20000)
            .is_ok()
    );
    assert!(parts.extensions.get::<VerifiedSuiteIdentity>().is_some());
}
fn partition(c: &Value) -> SuiteAuthorizationPartition {
    let b = &c["options"];
    SuiteAuthorizationPartition {
        credential_partition: "A".repeat(43),
        issuer: b["issuer"].as_str().unwrap().into(),
        audience: b["audience"].as_str().unwrap().into(),
        product_id: b["productId"].as_str().unwrap().into(),
        association_id: b["associationId"].as_str().unwrap().into(),
        gateway_service_id: b["gatewayServiceId"].as_str().unwrap().into(),
        registration_revision: b["registrationRevision"].as_str().unwrap().into(),
        service_credential_revision: b["serviceCredentialRevision"].as_str().unwrap().into(),
        kind: "user".into(),
    }
}
#[tokio::test]
async fn cache_coalesces_cleans_cancellation_and_rejects_late_invalidated_commits() {
    let (c, id) = fixture();
    let now = Arc::new(AtomicI64::new(c["options"]["nowMs"].as_i64().unwrap()));
    let wall = now.clone();
    let cache = SuiteAuthorizationCache::with_clock(
        SuiteCacheOptions {
            max_entries: 1,
            ..Default::default()
        },
        Arc::new(move || wall.load(Ordering::SeqCst)),
    )
    .unwrap();
    let p = partition(&c);
    let count = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let entered = Arc::new(tokio::sync::Notify::new());
    let mut work = vec![];
    for _ in 0..20 {
        let (cache, p, id, count, gate, entered) = (
            cache.clone(),
            p.clone(),
            id.clone(),
            count.clone(),
            gate.clone(),
            entered.clone(),
        );
        work.push(tokio::spawn(async move {
            cache
                .refresh(&p, || async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    entered.notify_one();
                    let _ = gate.acquire().await.unwrap();
                    Ok(id)
                })
                .await
        }));
    }
    entered.notified().await;
    gate.add_permits(1);
    for task in work {
        task.await.unwrap().unwrap();
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    cache
        .invalidate(&SuiteInvalidation {
            all: true,
            ..Default::default()
        })
        .unwrap();
    let task = {
        let (cache, p) = (cache.clone(), p.clone());
        tokio::spawn(async move { cache.refresh(&p, || std::future::pending()).await })
    };
    tokio::task::yield_now().await;
    assert_eq!(cache.stats().unwrap().pending, 1);
    task.abort();
    let _ = task.await;
    assert_eq!(cache.stats().unwrap().pending, 0);
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let task = {
        let (cache, p, id, gate) = (cache.clone(), p.clone(), id.clone(), gate.clone());
        tokio::spawn(async move {
            cache
                .refresh(&p, || async move {
                    let _ = gate.acquire().await.unwrap();
                    Ok(id)
                })
                .await
        })
    };
    tokio::task::yield_now().await;
    cache
        .invalidate(&SuiteInvalidation {
            all: true,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        cache
            .refresh(&p, || async { Ok(id.clone()) })
            .await
            .unwrap_err()
            .0,
        "CACHE_LIMIT"
    );
    gate.add_permits(1);
    assert_eq!(
        task.await.unwrap().unwrap_err().0,
        "AUTHORIZATION_INVALIDATED"
    );
    assert_eq!(cache.stats().unwrap().entries, 0);
    cache
        .refresh(&p, || async { Ok(id.clone()) })
        .await
        .unwrap();
    now.store(id.expires_at_ms(), Ordering::SeqCst);
    assert!(cache.get(&p).unwrap().is_none());
}
