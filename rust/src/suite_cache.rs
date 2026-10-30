use crate::discovery::{canonicalize, fingerprint};
use crate::suite::*;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;

#[derive(Clone, Debug)]
pub struct SuiteAuthorizationPartition {
    pub credential_partition: String,
    pub issuer: String,
    pub audience: String,
    pub gateway_service_id: String,
    pub service_credential_revision: String,
    pub product_id: String,
    pub association_id: String,
    pub registration_revision: String,
    pub kind: String,
}
pub fn suite_authorization_partition_key(p: &SuiteAuthorizationPartition) -> SuiteResult<String> {
    let kind = if p.kind.is_empty() {
        "user"
    } else {
        p.kind.as_str()
    };
    let parts = [
        p.credential_partition.as_str(),
        &p.issuer,
        &p.audience,
        &p.gateway_service_id,
        &p.service_credential_revision,
        &p.product_id,
        &p.association_id,
        &p.registration_revision,
        kind,
    ];
    if parts.iter().any(|p| p.is_empty())
        || p.credential_partition.len() != 43
        || !p
            .credential_partition
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || !valid_suite_product_id(&p.product_id)
        || !["user", "probe"].contains(&kind)
        || normalize_suite_resource(&p.audience)? != p.audience
    {
        return suite_error("INVALID_INTEGRATION");
    }
    fingerprint(&json!(parts)).map_err(|_| SuiteError("INVALID_INTEGRATION"))
}
pub fn validate_suite_authorization_partition(
    p: &SuiteAuthorizationPartition,
    id: &VerifiedSuiteIdentity,
    now_ms: i64,
) -> SuiteResult<()> {
    suite_authorization_partition_key(p)?;
    let context = id.context();
    let claims = id.claims();
    let kind = if p.kind.is_empty() {
        "user"
    } else {
        p.kind.as_str()
    };
    let actor = if id.kind() == "user" {
        &context["gatewayServiceId"]
    } else {
        &context["serviceId"]
    };
    if id.kind() != kind
        || claims["iss"] != p.issuer
        || claims["aud"] != p.audience
        || context["productId"] != p.product_id
        || context["associationId"] != p.association_id
        || context["registrationRevision"] != p.registration_revision
        || context["serviceCredentialRevision"] != p.service_credential_revision
        || actor.as_str() != Some(p.gateway_service_id.as_str())
        || now_ms >= id.expires_at_ms()
        || now_ms < id.admitted_at_ms() - CLOCK_SAFETY_MS as i64
    {
        return suite_error("INVALID_DELEGATION");
    }
    Ok(())
}
#[derive(Clone, Default, Debug)]
pub struct SuiteInvalidation {
    pub all: bool,
    pub user_id: Option<String>,
    pub key_id: Option<String>,
    pub service_id: Option<String>,
    pub credential_revision: Option<String>,
    pub product_id: Option<String>,
    pub association_id: Option<String>,
}
impl SuiteInvalidation {
    fn valid(&self) -> bool {
        self.all
            || [
                &self.user_id,
                &self.key_id,
                &self.service_id,
                &self.credential_revision,
                &self.product_id,
                &self.association_id,
            ]
            .iter()
            .any(|v| v.as_ref().is_some_and(|s| !s.is_empty()))
    }
    fn matches(&self, id: &VerifiedSuiteIdentity) -> bool {
        if self.all {
            return true;
        }
        let context = id.context();
        let actor = if id.kind() == "user" {
            &context["gatewayServiceId"]
        } else {
            &context["serviceId"]
        };
        [
            (&self.user_id, &context["userId"]),
            (&self.key_id, &context["keyId"]),
            (&self.service_id, actor),
            (
                &self.credential_revision,
                &context["serviceCredentialRevision"],
            ),
            (&self.product_id, &context["productId"]),
            (&self.association_id, &context["associationId"]),
        ]
        .iter()
        .all(|(expected, actual)| expected.as_ref().is_none_or(|s| actual.as_str() == Some(s)))
    }
}
#[derive(Clone, Debug)]
pub struct SuiteCacheOptions {
    pub max_entries: usize,
    pub max_bytes: usize,
}
impl Default for SuiteCacheOptions {
    fn default() -> Self {
        Self {
            max_entries: MAX_AUTHORIZATION_ENTRIES as usize,
            max_bytes: MAX_AUTHORIZATION_BYTES as usize,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuiteCacheStats {
    pub entries: usize,
    pub bytes: usize,
    pub pending: usize,
}
struct Entry {
    identity: VerifiedSuiteIdentity,
    deadline: Instant,
    bytes: usize,
    used: u64,
}
type Renewal = SuiteResult<VerifiedSuiteIdentity>;
struct Pending {
    generation: u64,
    sender: watch::Sender<Option<Renewal>>,
}
struct State {
    entries: HashMap<String, Entry>,
    pending: HashMap<String, Arc<Pending>>,
    pending_count: usize,
    bytes: usize,
    generation: u64,
    tick: u64,
    last_wall: i64,
}
#[derive(Clone)]
pub struct SuiteAuthorizationCache {
    state: Arc<Mutex<State>>,
    options: SuiteCacheOptions,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
}
impl Default for SuiteAuthorizationCache {
    fn default() -> Self {
        Self::with_clock(
            SuiteCacheOptions::default(),
            Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as i64)
            }),
        )
        .expect("valid default cache")
    }
}
impl std::fmt::Debug for SuiteAuthorizationCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SuiteAuthorizationCache")
            .field("stats", &self.stats())
            .finish()
    }
}
fn remove(state: &mut State, key: &str) {
    if let Some(entry) = state.entries.remove(key) {
        state.bytes -= entry.bytes
    }
}
fn invalidate(state: &mut State, selector: &SuiteInvalidation) {
    state.generation = state.generation.wrapping_add(1);
    let keys = state
        .entries
        .iter()
        .filter_map(|(key, entry)| selector.matches(&entry.identity).then_some(key.clone()))
        .collect::<Vec<_>>();
    for key in keys {
        remove(state, &key)
    }
}
fn clock(state: &mut State, now: i64) -> SuiteResult<()> {
    if now < 0 {
        return suite_error("INVALID_INTEGRATION");
    }
    if now < state.last_wall - CLOCK_SAFETY_MS as i64 {
        invalidate(
            state,
            &SuiteInvalidation {
                all: true,
                ..Default::default()
            },
        );
        state.last_wall = now;
        return suite_error("AUTHORIZATION_INVALIDATED");
    }
    state.last_wall = state.last_wall.max(now);
    Ok(())
}
fn get(
    state: &mut State,
    key: &str,
    p: &SuiteAuthorizationPartition,
    now: i64,
) -> SuiteResult<Option<VerifiedSuiteIdentity>> {
    clock(state, now)?;
    state.tick = state.tick.wrapping_add(1);
    let tick = state.tick;
    if let Some(entry) = state.entries.get_mut(key) {
        if now >= entry.identity.expires_at_ms() || Instant::now() >= entry.deadline {
            remove(state, key);
            return Ok(None);
        }
        validate_suite_authorization_partition(p, &entry.identity, now)?;
        entry.used = tick;
        return Ok(Some(entry.identity.clone()));
    }
    Ok(None)
}
struct RefreshGuard {
    state: Arc<Mutex<State>>,
    key: String,
    pending: Arc<Pending>,
    active: bool,
}
impl Drop for RefreshGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            if state
                .pending
                .get(&self.key)
                .is_some_and(|p| Arc::ptr_eq(p, &self.pending))
            {
                state.pending.remove(&self.key);
            }
            state.pending_count = state.pending_count.saturating_sub(1);
        }
        self.pending
            .sender
            .send_replace(Some(Err(SuiteError("AUTHORIZATION_INVALIDATED"))));
    }
}
impl SuiteAuthorizationCache {
    pub fn with_clock(
        options: SuiteCacheOptions,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> SuiteResult<Self> {
        if options.max_entries == 0 || options.max_bytes == 0 {
            return suite_error("INVALID_INTEGRATION");
        }
        Ok(Self {
            state: Arc::new(Mutex::new(State {
                entries: HashMap::new(),
                pending: HashMap::new(),
                pending_count: 0,
                bytes: 0,
                generation: 0,
                tick: 0,
                last_wall: -1,
            })),
            options,
            now,
        })
    }
    pub fn stats(&self) -> SuiteResult<SuiteCacheStats> {
        let state = self.state.lock().map_err(|_| SuiteError("CACHE_FAILURE"))?;
        Ok(SuiteCacheStats {
            entries: state.entries.len(),
            bytes: state.bytes,
            pending: state.pending_count,
        })
    }
    pub fn get(
        &self,
        p: &SuiteAuthorizationPartition,
    ) -> SuiteResult<Option<VerifiedSuiteIdentity>> {
        let key = suite_authorization_partition_key(p)?;
        let mut state = self.state.lock().map_err(|_| SuiteError("CACHE_FAILURE"))?;
        get(&mut state, &key, p, (self.now)())
    }
    pub fn invalidate(&self, selector: &SuiteInvalidation) -> SuiteResult<()> {
        if !selector.valid() {
            return suite_error("INVALID_INTEGRATION");
        }
        let mut state = self.state.lock().map_err(|_| SuiteError("CACHE_FAILURE"))?;
        invalidate(&mut state, selector);
        Ok(())
    }
    pub async fn refresh<F, Fut>(&self, p: &SuiteAuthorizationPartition, load: F) -> Renewal
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Renewal>,
    {
        let key = suite_authorization_partition_key(p)?;
        let (pending, owner) = {
            let mut state = self.state.lock().map_err(|_| SuiteError("CACHE_FAILURE"))?;
            if let Some(value) = get(&mut state, &key, p, (self.now)())? {
                return Ok(value);
            }
            if let Some(pending) = state
                .pending
                .get(&key)
                .filter(|p| p.generation == state.generation)
            {
                (pending.clone(), false)
            } else {
                if state.pending_count >= self.options.max_entries {
                    return suite_error("CACHE_LIMIT");
                }
                let (sender, _) = watch::channel(None);
                let pending = Arc::new(Pending {
                    generation: state.generation,
                    sender,
                });
                state.pending.insert(key.clone(), pending.clone());
                state.pending_count += 1;
                (pending, true)
            }
        };
        if !owner {
            let mut receiver = pending.sender.subscribe();
            loop {
                if let Some(result) = receiver.borrow().clone() {
                    return result;
                }
                receiver
                    .changed()
                    .await
                    .map_err(|_| SuiteError("AUTHORIZATION_INVALIDATED"))?;
            }
        }
        let mut guard = RefreshGuard {
            state: self.state.clone(),
            key: key.clone(),
            pending: pending.clone(),
            active: true,
        };
        let result = load().await;
        let result = (|| {
            let mut state = self.state.lock().map_err(|_| SuiteError("CACHE_FAILURE"))?;
            if pending.generation != state.generation {
                return suite_error("AUTHORIZATION_INVALIDATED");
            }
            let now = (self.now)();
            clock(&mut state, now)?;
            let identity = result?;
            validate_suite_authorization_partition(p, &identity, now)?;
            let size = identity.access_token().len()
                + canonicalize(&identity.claims())
                    .map_err(|_| SuiteError("INVALID_DELEGATION"))?
                    .len()
                + canonicalize(&identity.context())
                    .map_err(|_| SuiteError("INVALID_DELEGATION"))?
                    .len();
            if size > self.options.max_bytes {
                return suite_error("CACHE_LIMIT");
            }
            while state.entries.len() >= self.options.max_entries
                || state.bytes + size > self.options.max_bytes
            {
                let oldest = state
                    .entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.used)
                    .map(|(key, _)| key.clone())
                    .ok_or(SuiteError("CACHE_LIMIT"))?;
                remove(&mut state, &oldest)
            }
            state.tick = state.tick.wrapping_add(1);
            let used = state.tick;
            let remaining =
                (identity.expires_at_ms() - now).min(AUTHORIZATION_LIFETIME_MS as i64) as u64;
            state.entries.insert(
                key.clone(),
                Entry {
                    identity: identity.clone(),
                    bytes: size,
                    used,
                    deadline: Instant::now() + Duration::from_millis(remaining),
                },
            );
            state.bytes += size;
            Ok(identity)
        })();
        {
            let mut state = self.state.lock().map_err(|_| SuiteError("CACHE_FAILURE"))?;
            if state
                .pending
                .get(&key)
                .is_some_and(|p| Arc::ptr_eq(p, &pending))
            {
                state.pending.remove(&key);
            }
            state.pending_count = state.pending_count.saturating_sub(1);
        }
        pending.sender.send_replace(Some(result.clone()));
        guard.active = false;
        result
    }
    pub fn apply_event(&self, event: &Value) -> SuiteResult<()> {
        validate_suite_document("event", event)?;
        let data = &event["data"];
        let string = |key: &str| data[key].as_str().map(String::from);
        let selector = match event["type"].as_str() {
            Some("authorization.invalidated") => Some(SuiteInvalidation {
                all: data["all"] == true,
                user_id: string("userId"),
                key_id: string("keyId"),
                service_id: string("serviceId"),
                product_id: string("productId"),
                association_id: string("associationId"),
                ..Default::default()
            }),
            Some("service.invalidated") => Some(SuiteInvalidation {
                service_id: string("serviceId"),
                credential_revision: string("credentialRevision"),
                ..Default::default()
            }),
            Some("signing-keys.changed") => Some(SuiteInvalidation {
                all: true,
                ..Default::default()
            }),
            Some("product.upserted") => Some(SuiteInvalidation {
                product_id: data["record"]["productId"].as_str().map(String::from),
                ..Default::default()
            }),
            Some("product.removed") => Some(SuiteInvalidation {
                product_id: string("productId"),
                association_id: string("associationId"),
                ..Default::default()
            }),
            _ => None,
        };
        if let Some(selector) = selector {
            self.invalidate(&selector)?
        }
        Ok(())
    }
}
