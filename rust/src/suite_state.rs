use super::*;
use std::cmp::Ordering;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteObservationBinding {
    pub product_id: String,
    pub registration_revision: String,
    pub association_id: String,
    pub source: String,
    pub producer_id: String,
    pub producer_epoch: String,
    pub managed_by: Option<SuiteRegistrationRecordManagedBy>,
}
#[derive(Clone, Debug, Serialize)]
pub struct SuiteAcceptedObservation {
    pub accepted: bool,
    pub envelope: SuiteObservationEnvelope,
}
fn same_fields(a: &Value, b: &Value, keys: &[&str]) -> bool {
    keys.iter().all(|k| a[*k] == b[*k])
}
fn timestamp(ms: i64) -> SuiteResult<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|v| v.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or(SuiteError("INVALID_INTEGRATION"))
}
pub fn accept_suite_observation(
    binding: &SuiteObservationBinding,
    input: &Value,
    received_at_ms: i64,
    previous: Option<&SuiteObservationEnvelope>,
    freshness_ms: i64,
) -> SuiteResult<SuiteAcceptedObservation> {
    validate_suite_document("observation", input)?;
    if received_at_ms < 0 || freshness_ms <= 0 {
        return suite_error("INVALID_OBSERVATION");
    }
    let bound = serde_json::to_value(binding).map_err(|_| SuiteError("INVALID_OBSERVATION"))?;
    if !same_fields(
        &bound,
        input,
        &[
            "productId",
            "registrationRevision",
            "associationId",
            "source",
            "producerId",
            "producerEpoch",
        ],
    ) {
        return suite_error("STALE_OBSERVATION");
    }
    if input["source"] == "yard"
        && (binding.managed_by.is_none()
            || !same_fields(
                &bound["managedBy"],
                &input["managedBy"],
                &["productId", "deploymentId"],
            ))
    {
        return suite_error("STALE_OBSERVATION");
    }
    let observed_at = parse_suite_timestamp(input["observedAt"].as_str().unwrap())?;
    if observed_at > received_at_ms.saturating_add(CLOCK_SAFETY_MS as i64) {
        return suite_error("INVALID_OBSERVATION");
    }
    if let Some(previous) = previous {
        let value =
            serde_json::to_value(previous).map_err(|_| SuiteError("INVALID_OBSERVATION"))?;
        validate_suite_document("observation-envelope", &value)?;
        let old = &value["observation"];
        if same_fields(
            old,
            input,
            &[
                "productId",
                "registrationRevision",
                "associationId",
                "source",
                "producerId",
                "producerEpoch",
            ],
        ) {
            let order = compare_suite_sequences(
                input["sequence"].as_str().unwrap(),
                old["sequence"].as_str().unwrap(),
            )?;
            if order == Ordering::Equal && canonicalize(input).ok() != canonicalize(old).ok() {
                return suite_error("OBSERVATION_CONFLICT");
            }
            if order != Ordering::Greater {
                return Ok(SuiteAcceptedObservation {
                    accepted: false,
                    envelope: previous.clone(),
                });
            }
        }
    }
    let value = json!({"observation":input,"receivedAt":timestamp(received_at_ms)?,"freshUntil":timestamp(received_at_ms.min(observed_at).checked_add(freshness_ms).ok_or(SuiteError("INVALID_OBSERVATION"))?)?});
    validate_suite_document("observation-envelope", &value)?;
    Ok(SuiteAcceptedObservation {
        accepted: true,
        envelope: serde_json::from_value(value).map_err(|_| SuiteError("INVALID_OBSERVATION"))?,
    })
}
pub fn suite_observation_state(
    envelope: &SuiteObservationEnvelope,
    now_ms: i64,
) -> SuiteResult<&str> {
    let value = serde_json::to_value(envelope).map_err(|_| SuiteError("INVALID_OBSERVATION"))?;
    validate_suite_document("observation-envelope", &value)?;
    Ok(if now_ms >= parse_suite_timestamp(&envelope.fresh_until)? {
        "unknown"
    } else {
        &envelope.observation.state
    })
}

/// Commit the returned snapshot with authorization invalidations under the host admission lock.
pub fn reduce_suite_registry(
    input: &SuiteRegistrySnapshot,
    page: &Value,
    expected_cursor: &str,
) -> SuiteResult<SuiteRegistrySnapshot> {
    let mut snapshot =
        serde_json::to_value(input).map_err(|_| SuiteError("INVALID_INTEGRATION"))?;
    validate_suite_document("registry-snapshot", &snapshot)?;
    validate_suite_document("event-page", page)?;
    if page["cursor"] == snapshot["cursor"] && expected_cursor != input.cursor {
        return Ok(input.clone());
    }
    if input.cursor != expected_cursor
        || page["cursor"] == snapshot["cursor"] && !page["events"].as_array().unwrap().is_empty()
    {
        return suite_error("STALE_EVENT_CURSOR");
    }
    let mut products: HashMap<String, Value> = snapshot["products"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["productId"].as_str().unwrap().to_string(), p.clone()))
        .collect();
    let mut observations = snapshot["observations"].as_array().unwrap().clone();
    for event in page["events"].as_array().unwrap() {
        let data = &event["data"];
        match event["type"].as_str().unwrap() {
            "product.upserted" => {
                let p = &data["record"];
                products.insert(p["productId"].as_str().unwrap().to_string(), p.clone());
                snapshot["registryRevision"] = data["registryRevision"].clone();
                observations.retain(|e| {
                    e["observation"]["productId"] != p["productId"]
                        || e["observation"]["associationId"] == p["associationId"]
                            && e["observation"]["registrationRevision"] == p["revision"]
                });
            }
            "product.removed" => {
                let id = data["productId"].as_str().unwrap();
                if products.get(id).is_some_and(|p| {
                    p["revision"] == data["retiredRevision"]
                        && p["associationId"] == data["associationId"]
                }) {
                    products.remove(id);
                    observations.retain(|e| {
                        !same_fields(&e["observation"], data, &["productId", "associationId"])
                    });
                }
                snapshot["registryRevision"] = data["registryRevision"].clone();
            }
            "observation.updated" => {
                let o = &data["observation"];
                if products
                    .get(o["productId"].as_str().unwrap())
                    .is_some_and(|p| {
                        p["associationId"] == o["associationId"]
                            && p["revision"] == o["registrationRevision"]
                    })
                {
                    observations.retain(|e| {
                        !same_fields(
                            &e["observation"],
                            o,
                            &["productId", "associationId", "source", "producerId"],
                        )
                    });
                    observations.push(data.clone());
                }
            }
            "producer.reassociated" => observations.retain(|e| {
                !same_fields(
                    &e["observation"],
                    data,
                    &["productId", "associationId", "source", "producerId"],
                )
            }),
            _ => {}
        }
    }
    let mut products: Vec<Value> = products.into_values().collect();
    products.sort_by(|a, b| a["productId"].as_str().cmp(&b["productId"].as_str()));
    observations.sort_by_key(|e| {
        canonicalize(&json!([
            e["observation"]["productId"],
            e["observation"]["source"],
            e["observation"]["producerId"],
            e["observation"]["producerEpoch"]
        ]))
        .unwrap()
    });
    snapshot["products"] = json!(products);
    snapshot["observations"] = json!(observations);
    snapshot["cursor"] = page["cursor"].clone();
    serde_json::from_value(snapshot).map_err(|_| SuiteError("INVALID_INTEGRATION"))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteRequestControls {
    pub request_id: String,
    pub deadline_at: String,
    pub timeout_ms: i64,
}
pub fn suite_request_budget(
    controls: &SuiteRequestControls,
    now_ms: i64,
    local_max_ms: i64,
    clock_uncertainty_ms: i64,
) -> SuiteResult<SuiteRequestControls> {
    let id = controls.request_id.as_bytes();
    let valid_id = id.len() == 36
        && id.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
        && (b'1'..=b'8').contains(&id[14])
        && [b'8', b'9', b'a', b'b'].contains(&id[19].to_ascii_lowercase());
    if !valid_id
        || controls.timeout_ms <= 0
        || now_ms < 0
        || local_max_ms <= 0
        || !(0..=CLOCK_SAFETY_MS as i64).contains(&clock_uncertainty_ms)
    {
        return suite_error("INVALID_REQUEST_CONTROLS");
    }
    let remaining = controls
        .timeout_ms
        .min(parse_suite_timestamp(&controls.deadline_at)? - now_ms - clock_uncertainty_ms)
        .min(local_max_ms);
    if remaining <= 0 {
        return suite_error("TIMEOUT");
    }
    Ok(SuiteRequestControls {
        request_id: controls.request_id.clone(),
        timeout_ms: remaining,
        deadline_at: timestamp(now_ms + remaining)?,
    })
}
