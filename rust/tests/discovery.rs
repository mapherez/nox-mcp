use nox_mcp::discovery::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
fn corpus() -> Value {
    serde_json::from_str(include_str!("../contracts/discovery-conformance.json")).unwrap()
}
fn view(c: &Value) -> View {
    View {
        id: "user-a:policy-1".into(),
        definitions: vec![json!({"tool":c["tool"],"cli":c["cli"]})],
        presentation: None,
    }
}
#[test]
fn shared_discovery_conformance() {
    let c = corpus();
    let mut report = json!({"jcs":[],"cli":[],"schemas":[]});
    for fixture in c["schemaCases"].as_array().unwrap() {
        let valid = validate(fixture["schema"].as_str().unwrap(), &fixture["data"]).is_ok();
        assert_eq!(valid, fixture["valid"].as_bool().unwrap());
        report["schemas"].as_array_mut().unwrap().push(json!(valid));
    }
    for fixture in c["jcs"].as_array().unwrap() {
        let canonical = canonicalize(&fixture["input"]).unwrap();
        assert_eq!(canonical, fixture["canonical"].as_str().unwrap());
        report["jcs"]
            .as_array_mut()
            .unwrap()
            .push(json!({"canonical":canonical,"hash":fingerprint(&fixture["input"]).unwrap()}));
    }
    for fixture in c["cliCases"].as_array().unwrap() {
        let result = interpret_cli(&fixture["value"]);
        assert_eq!(
            result.is_ok(),
            fixture["valid"].as_bool().unwrap(),
            "{}: {:?}",
            fixture["name"],
            result
        );
        report["cli"].as_array_mut().unwrap().push(match result {
            Ok(v) => v,
            Err(e) => json!({"error":e.0}),
        });
    }
    let s = Discovery::new("test-installation").unwrap();
    let mut v = view(&c);
    let initial = s.catalog(&v, &json!({})).unwrap();
    report["initial"] = initial.clone();
    report["definitions"] = s
        .definitions(
            &v,
            &json!({"catalog":initial["catalog"],"tools":initial["tools"]}),
        )
        .unwrap();
    let old = v.definitions[0]["tool"]["description"].as_str().unwrap();
    v.definitions[0]["tool"]["description"] = json!(format!("{old} Alterado."));
    let mut new = c["tool"].clone();
    new["name"] = json!("new_tool");
    v.definitions.push(json!({"tool":new}));
    report["changed"] = s.catalog(&v, &json!({})).unwrap();
    if let Ok(path) = std::env::var("NOX_DISCOVERY_REPORT") {
        std::fs::write(path, report.to_string()).unwrap();
    }
}
#[tokio::test]
async fn cache_updates_removes_and_rejects_partial_or_tampered_results() {
    let c = corpus();
    let s = Discovery::new("srv").unwrap();
    let current = Arc::new(Mutex::new(view(&c)));
    let downloads = Arc::new(Mutex::new(Vec::<String>::new()));
    let broken = Arc::new(Mutex::new(false));
    let tampered = Arc::new(Mutex::new(false));
    let mut cache = Cache::new("origin", "credential-a").unwrap();
    let request = |method: &'static str, mut params: Value| {
        let v = current.lock().unwrap().clone();
        let result = if method == "nox/tools/catalog" {
            params["limit"] = json!(1);
            s.catalog(&v, &params)
        } else if *broken.lock().unwrap() {
            Err(DiscoveryError("DISCONNECTED"))
        } else {
            for entry in params["tools"].as_array().unwrap() {
                downloads
                    .lock()
                    .unwrap()
                    .push(entry["name"].as_str().unwrap().to_string());
            }
            s.definitions(&v, &params).map(|mut r| {
                if *tampered.lock().unwrap() {
                    r["definitions"][0]["tool"]["description"] = json!("tampered")
                };
                r
            })
        };
        std::future::ready(result)
    };
    cache.sync(request).await.unwrap();
    assert_eq!(*downloads.lock().unwrap(), vec!["example_item_get"]);
    downloads.lock().unwrap().clear();
    cache.sync(request).await.unwrap();
    assert!(downloads.lock().unwrap().is_empty());
    let mut added = c["tool"].clone();
    added["name"] = json!("added");
    current
        .lock()
        .unwrap()
        .definitions
        .push(json!({"tool":added}));
    cache.sync(request).await.unwrap();
    assert_eq!(*downloads.lock().unwrap(), vec!["added"]);
    downloads.lock().unwrap().clear();
    current.lock().unwrap().definitions[0]["tool"]["description"] = json!("changed");
    cache.sync(request).await.unwrap();
    assert_eq!(*downloads.lock().unwrap(), vec!["example_item_get"]);
    downloads.lock().unwrap().clear();
    current.lock().unwrap().definitions[0]["availability"] = json!("unavailable");
    cache.sync(request).await.unwrap();
    assert!(downloads.lock().unwrap().is_empty());
    current.lock().unwrap().definitions.truncate(1);
    cache.sync(request).await.unwrap();
    assert_eq!(cache.definitions().len(), 1);
    let before = cache.definitions().clone();
    current.lock().unwrap().definitions[0]["tool"]["description"] = json!("changed-again");
    *broken.lock().unwrap() = true;
    assert!(cache.sync(request).await.is_err());
    assert_eq!(&before, cache.definitions());
    *broken.lock().unwrap() = false;
    *tampered.lock().unwrap() = true;
    assert_eq!(
        cache.sync(request).await.unwrap_err().0,
        "INVALID_FINGERPRINT"
    );
    assert_eq!(&before, cache.definitions());
    *tampered.lock().unwrap() = false;
    current.lock().unwrap().id = "user-b".into();
    cache.sync(request).await.unwrap();
    current.lock().unwrap().id = "revoked".into();
    current.lock().unwrap().definitions.clear();
    cache.sync(request).await.unwrap();
    assert!(cache.definitions().is_empty());
}
#[test]
fn snapshot_permissions_guard_and_bounds() {
    let s = Discovery::new("srv").unwrap();
    let mut v = view(&corpus());
    let catalog = s.catalog(&v, &json!({})).unwrap();
    let reference = &catalog["tools"][0];
    let name = reference["name"].as_str().unwrap();
    s.guard(
        &v,
        name,
        &json!({EXTENSION:{"expectedFingerprint":reference["fingerprint"]}}),
    )
    .unwrap();
    assert_eq!(
        s.guard(
            &v,
            name,
            &json!({EXTENSION:{"expectedFingerprint":"stale"}})
        )
        .unwrap_err()
        .0,
        "STALE_DEFINITION"
    );
    v.id = "revoked".into();
    v.definitions.clear();
    assert_eq!(
        s.definitions(
            &v,
            &json!({"catalog":catalog["catalog"],"tools":[reference]})
        )
        .unwrap_err()
        .0,
        "STALE_CATALOG"
    );
    assert_eq!(s.guard(&v, name, &json!({})).unwrap_err().0, "FORBIDDEN");
    assert!(s.catalog(&v, &json!({"cursor":1})).is_err());
    assert!(s.catalog(&v, &json!({"unknown":1})).is_err());
    let mut small = s;
    small.max_bytes = 1;
    assert_eq!(
        small.catalog(&v, &json!({})).unwrap_err().0,
        "PAYLOAD_LIMIT"
    );
    assert_eq!(
        canonicalize(&json!(9007199254740993u64)).unwrap(),
        "9007199254740992"
    );
}
