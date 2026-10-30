use nox_mcp::suite::*;
use serde_json::{json, Value};

#[test]
fn shared_suite_conformance() {
    let corpus: Value =
        serde_json::from_str(include_str!("../contracts/suite-conformance.json")).unwrap();
    let mut report = json!({"documents":[],"origins":[],"paths":[],"raw":[]});
    for example in corpus["schemaCases"].as_array().unwrap() {
        let result = load_suite_document(
            example["schema"].as_str().unwrap(),
            &example["data"].to_string(),
        );
        let actual = match result {
            Ok(value) => {
                assert!(example.get("error").is_none(), "{} accepted", example["id"]);
                assert_eq!(value, example["data"], "{} transformed", example["id"]);
                value
            }
            Err(error) => {
                assert_eq!(
                    Some(error.0),
                    example["error"].as_str(),
                    "{}",
                    example["id"]
                );
                json!({"error":error.0})
            }
        };
        report["documents"].as_array_mut().unwrap().push(actual);
    }
    for name in ["origins", "paths"] {
        for example in corpus[name].as_array().unwrap() {
            let input = example["input"].as_str().unwrap();
            let result = if name == "origins" {
                normalize_suite_origin(input)
            } else {
                normalize_suite_path(input)
            };
            let actual = match result {
                Ok(value) => {
                    assert_eq!(
                        Some(value.as_str()),
                        example["expect"].as_str(),
                        "{name}: {input}"
                    );
                    json!(value)
                }
                Err(error) => {
                    assert_eq!(Some(error.0), example["error"].as_str(), "{name}: {input}");
                    json!({"error":error.0})
                }
            };
            report[name].as_array_mut().unwrap().push(actual);
        }
    }
    for example in corpus["rawCases"].as_array().unwrap() {
        let error = parse_suite_json(example["input"].as_str().unwrap()).unwrap_err();
        assert_eq!(Some(error.0), example["error"].as_str());
        report["raw"]
            .as_array_mut()
            .unwrap()
            .push(json!({"error":error.0}));
    }

    report["budgets"] = json!([]);
    for ex in corpus["budgetCases"].as_array().unwrap() {
        let controls = serde_json::from_value(ex["controls"].clone()).unwrap();
        let actual = match suite_request_budget(
            &controls,
            ex["nowMs"].as_i64().unwrap(),
            ex["localMaxMs"].as_i64().unwrap(),
            ex["clockUncertaintyMs"].as_i64().unwrap(),
        ) {
            Ok(v) => serde_json::to_value(v).unwrap(),
            Err(e) => json!({"error":e.0}),
        };
        assert_eq!(
            actual,
            ex.get("error")
                .map_or(ex["expect"].clone(), |v| json!({"error":v}))
        );
        report["budgets"].as_array_mut().unwrap().push(actual);
    }
    state_vectors(&corpus, &mut report);
    crypto_vectors(&corpus, &mut report);
    gateway_vectors(&corpus, &mut report);
    if let Ok(path) = std::env::var("NOX_SUITE_REPORT") {
        std::fs::write(path, report.to_string()).unwrap();
    }
}
fn gateway_vectors(corpus: &Value, report: &mut Value) {
    report["gateway"] = json!([]);
    for example in corpus["gatewayCases"].as_array().unwrap() {
        let options: SuiteGatewayOptions =
            serde_json::from_value(example["input"].clone()).unwrap();
        let actual = match compose_suite_gateway(&options) {
            Ok(snapshot) => {
                assert!(example.get("error").is_none(), "{} accepted", example["id"]);
                assert_eq!(snapshot.contract_version, "1.0");
                for route in &snapshot.routes {
                    assert!(route.alias.len() <= 64);
                    if route.availability == "available" {
                        assert_eq!(
                            select_suite_route(&snapshot, &route.alias, Some(&route.fingerprint))
                                .unwrap()
                                .tool_name,
                            route.tool_name
                        );
                        assert!(
                            select_suite_route(&snapshot, &route.alias, Some(&"A".repeat(43)))
                                .is_err()
                        );
                    } else {
                        assert!(select_suite_route(&snapshot, &route.alias, None).is_err());
                    }
                }
                serde_json::to_value(snapshot).unwrap()
            }
            Err(error) => {
                assert_eq!(
                    Some(error.0),
                    example["error"].as_str(),
                    "{}",
                    example["id"]
                );
                json!({"error":error.0})
            }
        };
        report["gateway"].as_array_mut().unwrap().push(actual);
    }
}

fn crypto_vectors(corpus: &Value, report: &mut Value) {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use std::collections::HashMap;
    let c = &corpus["crypto"];
    let key: SuiteSigningKey = serde_json::from_value(c["publicKey"].clone()).unwrap();
    let base = &c["options"];
    report["crypto"] = json!([]);
    for example in c["cases"].as_array().unwrap() {
        let mut key = key.clone();
        match example["keyVariant"].as_str() {
            Some("private") => {
                key.extra.insert("d".into(), json!("A".repeat(43)));
            }
            Some("point") => key.y = "A".repeat(43),
            Some("purpose") => key.use_ = Some("enc".into()),
            _ => {}
        }
        let keys = HashMap::from([("fixture-es256".into(), key)]);
        let overrides = &example["options"];
        let options = SuiteVerificationOptions {
            issuer: base["issuer"].as_str().unwrap(),
            audience: base["audience"].as_str().unwrap(),
            product_id: base["productId"].as_str().unwrap(),
            association_id: base["associationId"].as_str().unwrap(),
            gateway_service_id: base["gatewayServiceId"].as_str().unwrap(),
            registration_revision: base["registrationRevision"].as_str(),
            service_credential_revision: base["serviceCredentialRevision"].as_str(),
            keys: &keys,
            now_ms: overrides["nowMs"]
                .as_i64()
                .unwrap_or(base["nowMs"].as_i64().unwrap()),
            kind: overrides["kind"].as_str(),
        };
        let actual = match verify_suite_token(example["token"].as_str().unwrap(), &options) {
            Ok(identity) => {
                json!({"kind":identity.kind(),"context":identity.context(),"expiresAtMs":identity.expires_at_ms()})
            }
            Err(error) => json!({"error":error.0}),
        };
        assert_eq!(actual, example["expect"], "{}", example["id"]);
        report["crypto"].as_array_mut().unwrap().push(actual);
    }
    let keys = HashMap::from([("fixture-es256".into(), key)]);
    let options = SuiteVerificationOptions {
        issuer: base["issuer"].as_str().unwrap(),
        audience: base["audience"].as_str().unwrap(),
        product_id: base["productId"].as_str().unwrap(),
        association_id: base["associationId"].as_str().unwrap(),
        gateway_service_id: base["gatewayServiceId"].as_str().unwrap(),
        registration_revision: base["registrationRevision"].as_str(),
        service_credential_revision: base["serviceCredentialRevision"].as_str(),
        keys: &keys,
        now_ms: base["nowMs"].as_i64().unwrap(),
        kind: None,
    };

    report["viewKeys"] = json!([]);
    for name in [
        "valid-user",
        "valid-probe",
        "valid-other-user",
        "valid-renewed-authorization",
    ] {
        let ex = c["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == name)
            .unwrap();
        let identity = verify_suite_token(ex["token"].as_str().unwrap(), &options).unwrap();
        let key = suite_authorization_view_key(
            &identity,
            c["pairing"]["partition"].as_str().unwrap(),
            "1.0",
        )
        .unwrap();
        report["viewKeys"].as_array_mut().unwrap().push(json!(key));
    }
    report["methods"] = json!([]);
    for example in c["methods"].as_array().unwrap() {
        let identity = verify_suite_token(
            c[format!("{}Token", example["kind"].as_str().unwrap())]
                .as_str()
                .unwrap(),
            &options,
        )
        .unwrap();
        let actual = match require_suite_method(
            &identity,
            example["method"].as_str().unwrap(),
            options.now_ms,
        ) {
            Ok(()) => json!(true),
            Err(error) => json!({"error":error.0}),
        };
        assert_eq!(
            actual,
            example
                .get("error")
                .map_or(json!(true), |error| json!({"error":error}))
        );
        report["methods"].as_array_mut().unwrap().push(actual);
    }
    let pair = &c["pairing"];
    let secret = URL_SAFE_NO_PAD
        .decode(pair["secret"].as_str().unwrap())
        .unwrap();
    let mut binding = load_suite_pairing_binding(&pair["binding"].to_string()).unwrap();
    let proof = create_suite_pairing_proof(&secret, &binding).unwrap();
    assert_eq!(proof, pair["proof"]);
    assert!(verify_suite_pairing_proof(&secret, &binding, &proof));
    binding.product_id = "different".into();
    assert!(!verify_suite_pairing_proof(&secret, &binding, &proof));
    let partition = suite_credential_partition("fictional-api-key", &secret).unwrap();
    assert_eq!(partition, pair["partition"]);
    report["pairing"] = json!({"proof":proof,"partition":partition});
    report["aliases"] = json!([]);
    for example in corpus["aliases"].as_array().unwrap() {
        let alias = suite_tool_alias(
            example["productId"].as_str().unwrap(),
            example["toolName"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(alias, example["expect"]);
        report["aliases"].as_array_mut().unwrap().push(json!(alias));
    }
    let identity = verify_suite_token(c["userToken"].as_str().unwrap(), &options).unwrap();
    assert!(!format!("{identity:?}").contains(identity.access_token()));
    let mut context = identity.context();
    context["scopes"] = json!(["nox:write"]);
    assert_eq!(identity.context()["scopes"], json!(["nox:inspect"]));
    assert!(require_suite_method(&identity, "tools/call", identity.expires_at_ms()).is_err());
}
#[test]
fn typed_documents_preserve_extensions() {
    let input = r#"{"contractVersion":"1.0","productId":"example-project","productVersion":"1","displayName":"Example","capabilities":{"suiteMcp":{"path":"/mcp","custom":false},"unknown":{"present":null}},"custom":[null,false,{}]}"#;
    let document = load_suite_product_declaration(input).unwrap();
    let value = serde_json::to_value(document).unwrap();
    assert_eq!(value, serde_json::from_str::<Value>(input).unwrap());
}

fn state_vectors(corpus: &Value, report: &mut Value) {
    report["observations"] = json!([]);
    for ex in corpus["observationCases"].as_array().unwrap() {
        let binding = serde_json::from_value(ex["binding"].clone()).unwrap();
        let previous: Option<SuiteObservationEnvelope> = ex
            .get("previous")
            .map(|v| serde_json::from_value(v.clone()).unwrap());
        let actual = match accept_suite_observation(
            &binding,
            &ex["input"],
            ex["receivedAtMs"].as_i64().unwrap(),
            previous.as_ref(),
            OBSERVATION_FRESHNESS_MS as i64,
        ) {
            Ok(result) => serde_json::to_value(result).unwrap(),
            Err(e) => json!({"error":e.0}),
        };
        if let Some(error) = ex.get("error") {
            assert_eq!(actual, json!({"error":error}), "{}", ex["id"])
        };
        report["observations"].as_array_mut().unwrap().push(actual);
    }
    report["registry"] = json!([]);
    for ex in corpus["registryCases"].as_array().unwrap() {
        let input = serde_json::from_value(ex["snapshot"].clone()).unwrap();
        let actual = match reduce_suite_registry(
            &input,
            &ex["page"],
            ex["expectedCursor"].as_str().unwrap(),
        ) {
            Ok(result) => serde_json::to_value(result).unwrap(),
            Err(e) => json!({"error":e.0}),
        };
        if let Some(error) = ex.get("error") {
            assert_eq!(actual, json!({"error":error}), "{}", ex["id"])
        };
        report["registry"].as_array_mut().unwrap().push(actual);
    }
}

#[test]
fn typed_source_preserves_authorization_metadata() {
    let c: Value =
        serde_json::from_str(include_str!("../contracts/suite-conformance.json")).unwrap();
    let input = &c["gatewayCases"][0]["input"]["sources"][0];
    let source = load_suite_gateway_source(&input.to_string()).unwrap();
    assert_eq!(serde_json::to_value(source).unwrap(), *input);
}
