use super::*;
use crate::ExecutionContext;
use rmcp::service::{RequestContext, RoleServer};
use std::{future::Future, pin::Pin, sync::Arc};

type ScopeResolver = Arc<dyn Fn(&VerifiedSuiteIdentity) -> SuiteResult<Vec<String>> + Send + Sync>;
type IdentityResolver =
    Arc<dyn Fn(&RequestContext<RoleServer>) -> SuiteResult<VerifiedSuiteIdentity> + Send + Sync>;
type ActiveResolver = Arc<dyn Fn(&VerifiedSuiteIdentity) -> bool + Send + Sync>;
pub type SuiteAdditionalScopes = Arc<
    dyn Fn(
            String,
            Value,
            ExecutionContext,
        ) -> Pin<Box<dyn Future<Output = SuiteResult<Vec<String>>> + Send>>
        + Send
        + Sync,
>;
/// Transport hosts verify the bearer token and insert the resulting private identity into request extensions.
/// An identity_resolver may instead perform that verification against a local trust snapshot.
#[derive(Clone, Default)]
pub struct SuiteRuntimeOptions {
    pub policies: HashMap<String, SuitePolicy>,
    pub identity_resolver: Option<IdentityResolver>,
    pub local_scopes: Option<ScopeResolver>,
    pub is_active: Option<ActiveResolver>,
    pub additional_scopes: Option<SuiteAdditionalScopes>,
    pub clock: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
}
impl SuiteRuntimeOptions {
    pub fn authorize(
        &self,
        context: &RequestContext<RoleServer>,
        method: &str,
    ) -> SuiteResult<(VerifiedSuiteIdentity, Vec<String>)> {
        let identity = match &self.identity_resolver {
            Some(resolve) => resolve(context)?,
            None => context
                .extensions
                .get::<VerifiedSuiteIdentity>()
                .or_else(|| {
                    context
                        .extensions
                        .get::<http::request::Parts>()
                        .and_then(|parts| parts.extensions.get::<VerifiedSuiteIdentity>())
                })
                .cloned()
                .ok_or(SuiteError("INVALID_DELEGATION"))?,
        };
        let now = self
            .clock
            .as_ref()
            .map_or_else(|| crate::now_ms() as i64, |clock| clock());
        require_suite_method(&identity, method, now)?;
        if self
            .is_active
            .as_ref()
            .is_some_and(|active| !active(&identity))
        {
            return suite_error("INVALID_DELEGATION");
        }
        let mut scopes = identity.context()["scopes"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if let Some(resolve) = &self.local_scopes {
            for scope in resolve(&identity)? {
                if scope.is_empty() || scope.starts_with("nox:") {
                    return suite_error("INVALID_INTEGRATION");
                };
                if !scopes.contains(&scope) {
                    scopes.push(scope)
                }
            }
        }
        Ok((identity, scopes))
    }
}
/// Verify the method before dispatch, including batch members. Probe tokens never enumerate tools.
pub fn admit_suite_request(
    identity: &VerifiedSuiteIdentity,
    method: &str,
    now_ms: i64,
) -> SuiteResult<()> {
    require_suite_method(identity, method, now_ms)
}

/// HTTP hosts call this before rmcp dispatch and preserve Parts in the native request extensions.
/// Body buffering must already have a transport limit; this function also enforces the Suite payload bound.
pub fn admit_suite_http_request(
    parts: &mut http::request::Parts,
    body: &[u8],
    verification: &SuiteVerificationOptions<'_>,
    local_max_ms: i64,
) -> SuiteResult<VerifiedSuiteIdentity> {
    let header = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or(SuiteError("INVALID_DELEGATION"))?;
    let mut fields = header.split_ascii_whitespace();
    if !fields
        .next()
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("Bearer"))
    {
        return suite_error("INVALID_DELEGATION");
    }
    let bearer = fields.next().ok_or(SuiteError("INVALID_DELEGATION"))?;
    if fields.next().is_some() {
        return suite_error("INVALID_DELEGATION");
    }
    let identity = verify_suite_token(bearer, verification)?;
    if body.len() > MAX_PAYLOAD_BYTES as usize {
        return suite_error("PAYLOAD_LIMIT");
    }
    let input = parse_suite_json(
        std::str::from_utf8(body).map_err(|_| SuiteError("INVALID_INTEGRATION"))?,
    )?;
    let messages = if let Some(a) = input.as_array() {
        a.clone()
    } else {
        vec![input]
    };
    if messages.is_empty() {
        return suite_error("INVALID_INTEGRATION");
    }
    let mut call = false;
    for message in &messages {
        let method = message["method"]
            .as_str()
            .ok_or(SuiteError("INVALID_INTEGRATION"))?;
        require_suite_method(&identity, method, verification.now_ms)?;
        call |= method == "tools/call";
    }
    if call {
        let header = |name: &str| {
            parts
                .headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .ok_or(SuiteError("INVALID_REQUEST_CONTROLS"))
        };
        let raw = header("nox-timeout-ms")?;
        let timeout_ms = raw
            .parse::<i64>()
            .map_err(|_| SuiteError("INVALID_REQUEST_CONTROLS"))?;
        if timeout_ms.to_string() != raw {
            return suite_error("INVALID_REQUEST_CONTROLS");
        }
        let controls = suite_request_budget(
            &SuiteRequestControls {
                request_id: header("nox-request-id")?.into(),
                deadline_at: header("nox-deadline-at")?.into(),
                timeout_ms,
            },
            crate::now_ms() as i64,
            local_max_ms,
            CLOCK_SAFETY_MS as i64,
        )?;
        parts.extensions.insert(controls);
    }
    parts.extensions.insert(identity.clone());
    Ok(identity)
}
pub fn suite_http_error_status(error: &SuiteError) -> u16 {
    match error.0 {
        "INVALID_DELEGATION" | "AUTHORIZATION_INVALIDATED" => 401,
        "FORBIDDEN" => 403,
        "TIMEOUT" => 408,
        "PAYLOAD_LIMIT" => 413,
        _ => 400,
    }
}
