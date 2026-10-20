use nox_mcp::{load_tools, parse_server_frame, validate_schema};
use serde_json::Value;

fn schema(name: &str) -> Value {
    let json = match name {
        "manifest" => include_str!("../contracts/manifest.schema.json"),
        "error" => include_str!("../contracts/error.schema.json"),
        "request" => include_str!("../contracts/request.schema.json"),
        "response" => include_str!("../contracts/response.schema.json"),
        "desktop" => include_str!("../contracts/desktop.schema.json"),
        "server" => include_str!("../contracts/server.schema.json"),
        _ => panic!("unknown corpus schema: {name}"),
    };
    serde_json::from_str(json).unwrap()
}

#[test]
fn shared_contract_conformance() {
    let corpus: Value =
        serde_json::from_str(include_str!("../contracts/conformance.json")).unwrap();
    assert_eq!(corpus["version"], 1);
    let mut covered = std::collections::HashSet::new();
    for example in corpus["cases"].as_array().unwrap() {
        let name = example["schema"].as_str().unwrap();
        covered.insert(name);
        assert_eq!(
            validate_schema(&schema(name), &example["data"]),
            example["valid"].as_bool().unwrap(),
            "{}",
            example["id"]
        );
        let bytes = serde_json::to_vec(&example["data"]).unwrap();
        if name == "server" {
            assert_eq!(
                parse_server_frame(&bytes, nox_mcp::MAX_PAYLOAD_BYTES).is_ok(),
                example["valid"].as_bool().unwrap(),
                "parser: {}",
                example["id"]
            );
        }
        if name == "manifest" {
            // A loader is intentionally stricter than a structural contract validator.
            let result = load_tools(std::str::from_utf8(&bytes).unwrap());
            assert_eq!(
                result.is_ok(),
                example["loadTools"].as_bool().unwrap(),
                "loader: {}",
                example["id"]
            );
            if let Ok(tools) = result {
                for (tool, entry) in tools
                    .iter()
                    .zip(example["data"]["tools"].as_array().unwrap())
                {
                    let tool = serde_json::to_value(tool).unwrap();
                    assert_eq!(tool["inputSchema"], entry["inputSchema"]);
                    assert_eq!(tool["outputSchema"], entry["outputSchema"]);
                    assert_eq!(tool["_meta"], entry["_meta"]);
                }
            }
        }
    }
    assert_eq!(covered.len(), 6);
    for example in corpus["schemaCases"].as_array().unwrap() {
        assert_eq!(
            validate_schema(&example["schema"], &example["data"]),
            example["valid"].as_bool().unwrap(),
            "tool schema: {}",
            example["id"]
        );
    }
}
