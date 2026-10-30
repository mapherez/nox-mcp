use crate::discovery::canonicalize;
use crate::suite::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{collections::HashMap, fmt};

pub struct SuiteVerificationOptions<'a> {
    pub issuer: &'a str,
    pub audience: &'a str,
    pub product_id: &'a str,
    pub association_id: &'a str,
    pub gateway_service_id: &'a str,
    pub registration_revision: Option<&'a str>,
    pub service_credential_revision: Option<&'a str>,
    /// Trusted local keys, refreshed outside verification; never use token key URLs.
    pub keys: &'a HashMap<String, SuiteSigningKey>,
    pub now_ms: i64,
    pub kind: Option<&'a str>,
}
#[derive(Clone)]
pub struct VerifiedSuiteIdentity {
    token: String,
    kind: &'static str,
    claims: Value,
    context: Value,
    admitted_at_ms: i64,
    expires_at_ms: i64,
}
impl fmt::Debug for VerifiedSuiteIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VerifiedSuiteIdentity")
            .field("kind", &self.kind)
            .field("expires_at_ms", &self.expires_at_ms)
            .field("token", &"redacted")
            .finish()
    }
}
impl VerifiedSuiteIdentity {
    pub fn kind(&self) -> &str {
        self.kind
    }
    pub fn context(&self) -> Value {
        self.context.clone()
    }
    pub fn claims(&self) -> Value {
        self.claims.clone()
    }
    pub fn expires_at_ms(&self) -> i64 {
        self.expires_at_ms
    }
    pub(crate) fn admitted_at_ms(&self) -> i64 {
        self.admitted_at_ms
    }
    /// Secret. Forward only to its bound product; never log or persist it.
    pub fn access_token(&self) -> &str {
        &self.token
    }
}
fn base64(value: &str, max: usize) -> SuiteResult<Vec<u8>> {
    if value.is_empty()
        || value.len() > (max * 4 + 2) / 3
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return suite_error("INVALID_DELEGATION");
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| SuiteError("INVALID_DELEGATION"))?;
    if bytes.len() > max || URL_SAFE_NO_PAD.encode(&bytes) != value {
        return suite_error("INVALID_DELEGATION");
    }
    Ok(bytes)
}
pub fn verify_suite_token(
    token: &str,
    options: &SuiteVerificationOptions<'_>,
) -> SuiteResult<VerifiedSuiteIdentity> {
    let result = (|| {
        let invalid = || SuiteError("INVALID_DELEGATION");
        if options.now_ms < 0
            || token.len() > MAX_TOKEN_BYTES as usize
            || options.issuer.is_empty()
            || options.product_id.is_empty()
            || options.association_id.is_empty()
            || options.gateway_service_id.is_empty()
            || normalize_suite_resource(options.audience)? != options.audience
        {
            return Err(invalid());
        }
        let parts = token.split('.').collect::<Vec<_>>();
        if parts.len() != 3 {
            return Err(invalid());
        }
        let header_bytes = base64(parts[0], MAX_TOKEN_BYTES as usize)?;
        let header = parse_suite_json(std::str::from_utf8(&header_bytes).map_err(|_| invalid())?)?;
        let kind = match header["typ"].as_str() {
            Some("nox-delegation+jwt") => "user",
            Some("nox-service+jwt") => "probe",
            _ => return Err(invalid()),
        };
        let kid = header["kid"].as_str().ok_or_else(invalid)?;
        if header["alg"] != "ES256"
            || kid.is_empty()
            || kid.chars().count() > 256
            || options.kind.is_some_and(|expected| expected != kind)
            || ["crit", "b64", "jku", "x5u", "jwk", "x5c"]
                .iter()
                .any(|key| header.get(*key).is_some())
        {
            return Err(invalid());
        }
        let key = options.keys.get(kid).ok_or_else(invalid)?;
        validate_suite_document(
            "signing-key",
            &serde_json::to_value(key).map_err(|_| invalid())?,
        )?;
        if key.kid.as_ref().is_some_and(|expected| expected != kid) {
            return Err(invalid());
        }
        let (x, y) = (base64(&key.x, 32)?, base64(&key.y, 32)?);
        if x.len() != 32 || y.len() != 32 {
            return Err(invalid());
        }
        let mut point = vec![4];
        point.extend(x);
        point.extend(y);
        let public = VerifyingKey::from_sec1_bytes(&point).map_err(|_| invalid())?;
        let bytes = base64(parts[2], 64)?;
        if bytes.len() != 64 {
            return Err(invalid());
        }
        let signature = Signature::from_slice(&bytes).map_err(|_| invalid())?;
        public
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .map_err(|_| invalid())?;
        let payload = base64(parts[1], MAX_TOKEN_BYTES as usize)?;
        let claims = load_suite_document(
            if kind == "user" {
                "delegation-claims"
            } else {
                "probe-claims"
            },
            std::str::from_utf8(&payload).map_err(|_| invalid())?,
        )?;
        let bound = &claims["nox"];
        let actor = if kind == "user" {
            &claims["act"]["sub"]
        } else {
            &claims["sub"]
        };
        if claims["iss"] != options.issuer
            || claims["aud"] != options.audience
            || bound["productId"] != options.product_id
            || bound["associationId"] != options.association_id
            || actor != options.gateway_service_id
            || options
                .registration_revision
                .is_some_and(|v| bound["registrationRevision"] != v)
            || options
                .service_credential_revision
                .is_some_and(|v| bound["serviceCredentialRevision"] != v)
        {
            return Err(invalid());
        }
        let expiry = claims["exp"]
            .as_u64()
            .unwrap()
            .checked_mul(1000)
            .and_then(|n| n.checked_sub(CLOCK_SAFETY_MS))
            .ok_or_else(invalid)?;
        if expiry > 9007199254740991
            || options.now_ms as u64 >= expiry
            || claims["iat"].as_u64().unwrap().saturating_mul(1000)
                > (options.now_ms as u64).saturating_add(CLOCK_SAFETY_MS)
            || claims["nbf"].as_u64().unwrap().saturating_mul(1000)
                > (options.now_ms as u64).saturating_add(CLOCK_SAFETY_MS)
        {
            return Err(invalid());
        }
        let mut context = json!({"contractVersion":"1.0","productId":bound["productId"],"registrationRevision":bound["registrationRevision"],"associationId":bound["associationId"],"serviceCredentialRevision":bound["serviceCredentialRevision"]});
        if kind == "user" {
            context["userId"] = claims["sub"].clone();
            context["keyId"] = bound["keyId"].clone();
            context["authRevision"] = bound["authRevision"].clone();
            context["gatewayServiceId"] = actor.clone();
            context["scopes"] = json!(claims["scope"]
                .as_str()
                .unwrap()
                .split(' ')
                .collect::<Vec<_>>());
        } else {
            context["serviceId"] = actor.clone();
            context["purpose"] = json!("mcp-probe");
        }
        Ok(VerifiedSuiteIdentity {
            token: token.into(),
            kind,
            claims,
            context,
            admitted_at_ms: options.now_ms,
            expires_at_ms: expiry as i64,
        })
    })();
    result.map_err(|_| SuiteError("INVALID_DELEGATION"))
}
pub fn verify_suite_authorization_response(
    input: &str,
    options: &SuiteVerificationOptions<'_>,
) -> SuiteResult<VerifiedSuiteIdentity> {
    let result = (|| {
        let schema = if options.kind == Some("probe") {
            "probe-response"
        } else {
            "authorization-response"
        };
        let response = load_suite_document(schema, input)?;
        let identity = verify_suite_token(response["accessToken"].as_str().unwrap(), options)?;
        if (schema == "authorization-response" && identity.kind != "user")
            || (schema == "probe-response" && identity.kind != "probe")
        {
            return suite_error("INVALID_DELEGATION");
        }
        for (key, expected) in identity.context.as_object().unwrap() {
            if key == "scopes" {
                let mut left = expected
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect::<Vec<_>>();
                let mut right = response["context"][key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect::<Vec<_>>();
                left.sort_unstable();
                right.sort_unstable();
                if left != right {
                    return suite_error("INVALID_DELEGATION");
                }
            } else if response["context"][key] != *expected {
                return suite_error("INVALID_DELEGATION");
            }
        }
        if parse_suite_timestamp(response["expiresAt"].as_str().unwrap())? as u64
            != identity.claims["exp"].as_u64().unwrap() * 1000
        {
            return suite_error("INVALID_DELEGATION");
        }
        Ok(identity)
    })();
    result.map_err(|_| SuiteError("INVALID_DELEGATION"))
}
pub fn require_suite_method(
    identity: &VerifiedSuiteIdentity,
    method: &str,
    now_ms: i64,
) -> SuiteResult<()> {
    if now_ms < identity.admitted_at_ms - CLOCK_SAFETY_MS as i64 || now_ms >= identity.expires_at_ms
    {
        return suite_error("INVALID_DELEGATION");
    }
    if identity.kind == "probe"
        && ![
            "initialize",
            "notifications/initialized",
            "ping",
            "server/discover",
        ]
        .contains(&method)
    {
        return suite_error("FORBIDDEN");
    }
    Ok(())
}
pub fn create_suite_pairing_proof(
    secret: &[u8],
    binding: &SuitePairingBinding,
) -> SuiteResult<String> {
    if secret.len() < 32 || secret.len() > 96 {
        return suite_error("PAIRING_CONFLICT");
    }
    let value = serde_json::to_value(binding).map_err(|_| SuiteError("INVALID_INTEGRATION"))?;
    validate_suite_document("pairing-binding", &value)?;
    let canonical = canonicalize(&value).map_err(|_| SuiteError("INVALID_INTEGRATION"))?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret).map_err(|_| SuiteError("PAIRING_CONFLICT"))?;
    mac.update(canonical.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}
pub fn verify_suite_pairing_proof(
    secret: &[u8],
    binding: &SuitePairingBinding,
    proof: &str,
) -> bool {
    let result = (|| {
        if secret.len() < 32 || secret.len() > 96 {
            return suite_error("PAIRING_CONFLICT");
        }
        let value = serde_json::to_value(binding).map_err(|_| SuiteError("INVALID_INTEGRATION"))?;
        validate_suite_document("pairing-binding", &value)?;
        let canonical = canonicalize(&value).map_err(|_| SuiteError("INVALID_INTEGRATION"))?;
        let bytes = base64(proof, 32)?;
        if bytes.len() != 32 {
            return suite_error("PAIRING_CONFLICT");
        }
        let mut mac =
            Hmac::<Sha256>::new_from_slice(secret).map_err(|_| SuiteError("PAIRING_CONFLICT"))?;
        mac.update(canonical.as_bytes());
        mac.verify_slice(&bytes)
            .map_err(|_| SuiteError("PAIRING_CONFLICT"))
    })();
    result.is_ok()
}
pub fn suite_credential_partition(api_key: &str, process_secret: &[u8]) -> SuiteResult<String> {
    if api_key.is_empty() || api_key.len() > 4096 || process_secret.len() < 32 {
        return suite_error("INVALID_INTEGRATION");
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(process_secret)
        .map_err(|_| SuiteError("INVALID_INTEGRATION"))?;
    mac.update(b"nox:credential-partition:1.0\0");
    mac.update(api_key.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}
