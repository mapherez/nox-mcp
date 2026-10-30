# NoX Suite — Gateway and shared integration contract

Consolidated on **October 29, 2026**. Contract compatibility version: **`1.0`**.

Status, updated **October 30, 2026**: **shared SDK mechanisms published in NoX MCP `0.7.0`; service implementation pending**. The authoritative schemas, native SDK APIs, runtime admission, and conformance tests implement the shared portions of this contract. See [SDK integration](INTEGRATION.md) for consumption, exact APIs, and host responsibilities, and the [Backend work sequence](NOX_SUITE_IMPLEMENTATION_PLAN.md#19-current-delivery-and-next-work-backend) for the next scope. Backend management routes, persistence/issuance, Gateway, CLI, Portal, and product adaptations remain separate service work. Contract `1.0` is a wire-compatibility identifier, not a provisional product release.

## 1. Purpose, applicability, and boundaries

This contract applies to **any present or future product** that joins NoX Suite. Products may serve any business domain and use different implementation languages, storage systems, frontends, or internal execution models. Examples use fictional products and are not an allowed-product list. The SDK, Gateway, CLI, and Portal must not contain business rules, menus, routing branches, or schemas specific to an individual product.

The deployment scope is one Backend authority and one registered product of each type on the environment's network, with multiple approved Google accounts. This does not limit the number of distinct product types. A product may own many internal workspaces, accounts, or tenants; those are domain contexts, not a new module/instance registry hierarchy. Federation, several copies of the same product, and cross-network product tunnels are outside the agreed deployment scope.

Gateway, CLI, and Portal **do not exist yet**. This contract guides their construction. Existing products must adapt the relevant integrations; their current architecture does not constrain the shared design. A pilot with unchanged Backend/Yard implementations is not a prerequisite for finishing or implementing this contract.

This document specifies service trust, delegated authorization, registry synchronization, availability, aggregation, and execution through the Gateway. It does not select the future Portal UI loader, the CLI's own MCP-server transport/process model, AI providers, or product storage adapters. Product registration remains valid without MCP or a Portal contribution. Products retain their independent applications and direct MCP policies.

In this document, **must** and **must not** identify conformance requirements; **should** permits a documented deployment exception with equivalent safety. Portable JSON validation preserves complete documents, unknown optional data, and absence of fields. Unknown optional data grants no behavior. Unknown required features or incompatible contract versions must fail explicitly.

## 2. Authorities and distinct identities

| Value or responsibility | Authority and meaning |
| --- | --- |
| Backend issuer | Persistent identifier of the configured Backend authority; survives normal restart |
| `productId` | Stable product identity from the verified declaration and Backend registry |
| Registration `revision` | Opaque accepted-configuration revision; never reused, including after re-enrollment |
| `associationId` | Backend-issued opaque binding to the paired service/deployment; internal trust state, not another functional entity |
| `serviceId` / service credential revision | Backend-issued technical identity and revocable credential generation |
| Backend user ID / `keyId` / `authRevision` | User, personal API-key identifier, and authorization revision; raw keys are secrets |
| MCP `serverId` / `viewId` | Product discovery identity and authorized tool view; not registry identifiers |
| Original definition/catalog fingerprints | Product discovery values under the existing discovery contract |
| Aggregated fingerprints/snapshot | Gateway's transformed, authorized definitions and the component versions it published |
| Event cursor | Opaque position in the Backend event log; not a registration revision, timestamp, or tool hash |
| Producer epoch/sequence | Authorized observation source generation and ordering within that source |

Backend owns membership, accounts, API keys, service grants, and central capability mapping. Products own tool definitions and domain authorization. Gateway owns reconstructible routing/cache state and its observations of actual MCP availability. Yard owns deployment operations and reports their lifecycle. Future consumers render or execute published contracts without becoming authorities for these values.

No component may infer identity from a display name, hostname, IP address, claimed product prefix, client-supplied `_meta`, or a UI selection. Different values above must not be substituted for one another merely because both are strings.

## 3. Addresses and authenticated transport

### 3.1 Origin and path rules

The administrator/authorized installer supplies the HTTPS origin. Products cannot self-redirect registration to another origin. Accept IP/hostname with an optional port and dedicated domains/subdomains. Reject user information, query, fragment, and non-root base paths such as `/apps/inventory`. Normalize a trailing root slash consistently; scheme and ASCII DNS host are case-insensitive, port 443 normalizes to the HTTPS default, and IPv6 literals remain bracketed. Configuration uses ASCII DNS names (IDNs must be supplied as ASCII A-labels), canonical four-part decimal IPv4, or IPv6 literals; ports are integers from 1 to 65535. Reject HTTP Suite origins, ambiguous numeric IP spellings/leading-zero IPv4, backslashes, control characters, malformed escapes, and whitespace rather than relying on divergent URL parsers.

`GET /nox/integration` is the declaration endpoint. The protected Suite MCP path comes from `capabilities.suiteMcp.path`. It starts with exactly one `/`; reject query/fragment, `.`/`..` segments, encoded separators/dot traversal, backslashes, and scheme-relative paths. Path composition must preserve the configured origin byte-for-byte after canonical normalization. The conformance corpus must contain positive and negative resolution examples for all three languages.

For example, a fictional product may declare `/mcp` on either `https://192.168.10.10:8443` or `https://inventory.example.com`. Its canonical Suite resource URI is that origin plus the accepted path. The IP, port, DNS name, and listener configuration are deployment settings, not SDK constants.

### 3.2 TLS and target validation

Authenticated client/Gateway, service/Backend, and Gateway/product communication uses HTTPS. A deployment may use normal certificate-chain validation or an explicitly provisioned leaf public-key pin. Private addresses do not disable TLS validation. Pins and Backend issuer/signing-key trust are installed by authorized pairing/configuration, not learned from arbitrary responses or token headers.

A reverse proxy may terminate TLS on a configured, trusted transport boundary. Credential headers and authenticated context must not cross an untrusted plaintext hop or be accepted from arbitrary forwarded headers. This does not require an additional application port. Direct MCP has its own product policy; it must not be mistaken for a protected Suite endpoint.

Validate the origin, permitted ports/network ranges, resolved targets, and redirects before enrollment and on connection changes/reconnects. Never send a personal key, service credential, or delegation to an unapproved target. Do not follow redirects for credential-bearing requests. Backend and Gateway adapters bound DNS/connect/read time, body size, and concurrent verification. Product JSON is data, not an instruction to fetch another host.

## 4. Pairing and service credentials

### 4.1 Scoped service identities

The Backend generates a cryptographically random service credential with at least 256 bits of entropy, stores a verifier rather than its plaintext for ordinary authentication, and assigns `serviceId`, credential revision, and explicit service grants. Service credentials are distinct from personal API keys and do not inherit the administrator's full session.

| Service grant | Permitted use |
| --- | --- |
| `registry.read` | Read privileged registry/configuration needed for assigned communication |
| `registry.manage-associated` | Register/update/remove only products bound to the caller's authorized deployments |
| `authorization.delegate` | Gateway-only exchange of a valid personal API key for a product-specific delegated context |
| `events.read` | Read only event categories and targets permitted to that service |
| `lifecycle.report` | Report authorized deployment associations, not MCP readiness or membership removal |
| `mcp.report` | Gateway-only reports of MCP readiness, not deployment ownership |
| `mcp.probe` | Gateway-only, product-bound protocol readiness checks without user tools or data |
| `pairing.manage-associated` | Create/resume pairing for an authorized deployment |

These are technical grants, not new user roles. Backend maps actual existing roles to Suite capabilities. Each caller is checked against its active credential/grants on every Backend management request using Backend-local state. A product receives only the grants it needs; an ordinary product cannot mint user delegations or enroll unrelated products. Gateway cannot independently enroll products. The Backend's own tools use the same verified user/capability semantics through a local adapter where appropriate, without requiring an HTTP call to itself.

### 4.2 Pairing flow

1. An authenticated administrator creates foundation-service pairings through Backend administration/APIs. An already paired installer can create product pairings only for deployments it is authorized to manage.
2. Backend creates a pending pairing intent bound to the expected product/service purpose, approved origin, deployment association when applicable, and a fresh nonce. It returns a single-use secret with a **10-minute maximum lifetime**. The intent has no active registry membership or execution authority.
3. For automatic deployment, the installer supplies the secret and trusted Backend connection information through a protected file/secret mount. Manual foundation configuration supplies equivalent information explicitly. The SDK has no Docker or installer dependency.
4. The participant contacts the trusted Backend over HTTPS and completes a challenge-response proof using HMAC-SHA-256 over the nonce, pairing ID, product ID, declaration fingerprint, approved origin, and its TLS leaf public-key fingerprint. Canonicalization is JCS; the secret is the HMAC key. The Backend verifies the expected fields and caller/deployment association. It can then verify the declared product at the approved HTTPS endpoint against the proven TLS key or an already trusted certificate chain. A declaration alone never activates a service.
5. Backend provisions the scoped service credential and trust material through this authenticated pairing exchange. The participant persists the credential before acknowledging completion. The personal administrator key is not installed into the product.
6. Backend verifies the declaration and completed association before accepting the conditional registration operation. Membership, idempotency result, and registry event commit together. A paired credential grants no integrated execution unless its required association/registration is active.

Proofs are valid only for their pending intent and bound data; accepting one must not authorize a different origin, deployment, or product. Successful completion consumes the secret for establishing authority; only retrieval of the already bound provisioning outcome remains eligible for the recovery below. Cancellation/expiry invalidates it. Competing completions cannot establish different active credentials for the same intent.

Pairing is resumable after a lost response. Backend may retain the same encrypted provisioning response in its separate secret store until acknowledgment or intent expiry and return it only to the same proven pairing exchange. It must not mint another credential on an identical retry, put secrets in the registry/idempotency log, or permit replay after completion to establish new authority. An unresolved/expired attempt requires authorized reconciliation and replacement; it must not be reported as successful integration.

### 4.3 Management operations and rotation

These are Backend management routes, not new MCP methods. They use the management error body and idempotency/precondition discipline from the integration design.

| Operation | Route | Authorization/result |
| --- | --- | --- |
| Create pairing intent | `POST /api/nox/pairings` | Administrator or `pairing.manage-associated`; returns pending intent and one-time secret |
| Complete/resume pairing | `POST /api/nox/pairings/{pairingId}/complete` | Bound challenge-response over trusted TLS; returns the same provisioning result on an eligible retry |
| Acknowledge persisted provisioning | `POST /api/nox/pairings/{pairingId}/ack` | Newly issued service credential; deletes recoverable plaintext-equivalent provisioning material |
| Cancel pending pairing | `DELETE /api/nox/pairings/{pairingId}` | Authorized issuer/administrator; idempotent cancellation |
| Rotate a service credential | `POST /api/nox/services/{serviceId}/credentials` | Current service or authorized administrator; conditional credential revision and durable idempotency |
| Revoke a credential/service | `DELETE /api/nox/services/{serviceId}/credentials/{credentialId}` | Current service for itself or authorized administrator; emits invalidation |
| Read issuer signing keys | `GET /api/nox/keys` | Trusted configured Backend origin; public verification keys only |

Rotation provisions the replacement before retiring the previous credential. The overlap is bounded to five minutes and ends earlier on acknowledgment. Revocation is checked immediately at the Backend and emits a service invalidation event. Already issued delegations have the bounded residual lifetime in section 6. Credential loss does not reset a persisted association automatically; administrator/authorized-installer recovery is required. TLS pin changes require a verified old association or explicit administrator re-pairing, never trust-on-first-use during reconnect.

Service credentials, issuer signing keys, pairings, revisions, and trust anchors survive ordinary restart. Issuer key rotation advertises the new public key before use and retains old verification keys through outstanding delegation expiry; revocation of a compromised key invalidates affected caches. Private signing keys remain exclusively in the Backend. Secrets and personal keys are excluded from telemetry, URL parameters, event payloads, tool metadata, and ordinary management representations.

## 5. Delegated identity and capability representation

### 5.1 Authorization exchange

Gateway receives the personal API key in the client's configured authorization header. On a cache miss it calls `POST /api/nox/authorizations`, authenticating with its own service credential. The personal key is sent only in the protected request body to Backend, is redacted from logging, and is never forwarded to products.

Example body (all identifiers are illustrative):

```json
{
  "contractVersion": "1.0",
  "apiKey": "<personal-api-key>",
  "productId": "example-inventory",
  "registrationRevision": "reg-b7"
}
```

Backend resolves the key, approved account, current role/capabilities, Gateway service grants, active product association, and current registration revision from its own state. The caller cannot supply a trusted user ID, capabilities, role, audience, or a longer lifetime. A mismatched registration requires registry reconciliation before any dispatch. A removed/incompatible destination cannot receive a new delegation.

The response contains `contractVersion`, `tokenType: "Bearer"`, `accessToken`, `expiresAt`, and a non-secret context containing `userId`, `keyId`, `authRevision`, `gatewayServiceId`, `productId`, `registrationRevision`, `associationId`, and granted `scopes`. The context must agree with the signed token. It comes from the authenticated Backend response, not the client. Gateway may inspect/validate the token for the expected downstream audience but must not accept that product token as a personal API key at its own public endpoint.

Authorization exchanges are on-demand reads of current authority state. They do not repeat Google login, create personal keys, authorize a business mutation, or require the product's tool definitions to be stored in Backend. The Backend does not implement per-user/per-tool configuration.

### 5.2 Signed delegation

Use compact JWS/JWT with **ES256**, a trusted `kid`, and explicit `typ: "nox-delegation+jwt"`. Validators allow only that algorithm/type for this purpose. They verify the signature, configured issuer, exact canonical Suite resource audience, subject, actor, required claims, and expiry. They never follow `jku`, `x5u`, or key URLs from a token. Public keys come from configured/pinned issuer trust and controlled key updates.

Illustrative claims for a five-minute inspection grant:

```json
{
  "iss": "urn:nox:backend:example-authority",
  "aud": "https://inventory.example.com/mcp",
  "sub": "user-42",
  "act": { "sub": "service-gateway-7" },
  "iat": 1793275200,
  "nbf": 1793275200,
  "exp": 1793275500,
  "jti": "delegation-opaque-unique-id",
  "nox": {
    "contractVersion": "1.0",
    "keyId": "key-12",
    "authRevision": "auth-9",
    "serviceCredentialRevision": "cred-4",
    "productId": "example-inventory",
    "registrationRevision": "reg-b7",
    "associationId": "association-15"
  },
  "scope": "nox:inspect"
}
```

`sub` is a Backend user ID, not an email or client assertion. The signed `act` identifies the Gateway to which Backend delegated the user context. The `nox` claim is private signed-token data; it does not introduce `_meta.nox` or a functional entity hierarchy. Gateway/client metadata cannot override any signed claim. Unknown optional claims are inert; incompatible required semantics fail validation.

`exp - iat` must not exceed **300 seconds**. Expiry is also bounded by any earlier personal/service credential validity. `jti` identifies the issued grant; it does **not** mean one-time use or idempotent business execution. The grant is intentionally reusable for several calls to its product under its scopes. It is **not bound to a single tool or argument hash**. This replaces the earlier 30-second per-request suggestion.

Product adapters project the verified context into native execution/auth APIs. User and scopes must be request-local, including when HTTP server factories or concurrent users share a process. Existing static constructor auth is not a shared mutable per-user store. A product verifies its own association/resource binding and applies local invalidation information when available; a valid signature alone is insufficient if audience, association, or lifetime fails.

### 5.3 Time and long sessions

Clocks must be synchronized within the deployment's allowed five-second uncertainty. Validators may tolerate an `iat`/`nbf` up to five seconds ahead but must **not** extend `exp` or the five-minute lifetime. Unknown key/trust state, significant clock rollback, or invalid time claims fail closed until reconciled. Cache lifetime uses a monotonic deadline bounded by the verified wall-clock expiry; changing a local clock cannot refresh it.

For admission and cache expiry, subtract the five-second clock safety margin: reject when local time is at or beyond `exp - 5 seconds`, and bound the monotonic cache duration by that remaining interval. Do not use a JWT library's symmetric leeway if it also accepts tokens after expiry. The conservative margin can shorten reuse slightly; it prevents the allowed clock difference from extending the stated five-minute revocation bound.

Five minutes is the authorization reuse bound, not a CLI session timeout. Waiting at a form, reviewing a preview, or working for three hours does not itself renew a delegation or trigger another Google login. Expiry is checked before each operation; renewal is automatic only when subsequent use needs it. Product-specific preview/revision validity is independent. A token valid at admission does not shorten an already accepted operation to five minutes; execution follows its own deadline.

### 5.4 Readiness without a user session

Background readiness must not require a user's API key or an administrator identity. With `mcp.probe`, Gateway calls `POST /api/nox/service-authorizations` under its service credential, providing `contractVersion`, `productId`, and current `registrationRevision`. Backend validates the service grant and active association and issues a product-bound **service probe token** with the same five-minute maximum lifetime and expiry safety margin.

Use ES256 with `typ: "nox-service+jwt"`, the configured `iss`/resource `aud`, `sub` equal to Gateway's service ID, `iat`/`nbf`/`exp`/`jti`, and `scope: "nox:mcp-probe"`. Its `nox` object contains `contractVersion`, `purpose: "mcp-probe"`, `productId`, `registrationRevision`, `associationId`, and `serviceCredentialRevision`. User-only `act`, `keyId`, and `authRevision` are absent. It has no user subject and no inspection, write, or sensitive-read authority. Its validation rules are separate from user delegations; neither token type may be reinterpreted as the other.

The Suite endpoint accepts this token only for protocol readiness methods: `initialize`, its initialization notification, `ping`, and `server/discover` when supported. It must reject `tools/list`, `tools/call`, `nox/tools/catalog`, definition retrieval, subscriptions, and business methods under the probe token. Check every message in an accepted batch, not just a method header or its first message. Probe responses contain protocol/server capabilities, not a user's tool view or domain data. Actual discovery for a user uses that user's delegation.

Gateway reuses the probe grant across scheduled checks and renews it as needed while running; this is per service/product, not per user. If Backend is unavailable after probe authority expires, report readiness as unknown due to unavailable authority rather than claiming the product itself stopped. A still-valid user delegation can independently perform its authorized call. Ordinary probes never issue personal API keys or reauthenticate with Google.

## 6. Authorization reuse, invalidation, and Backend outages

### 6.1 Cache boundaries

Gateway caches authorization in memory using at least the exact credential's process-keyed digest, Backend issuer, Gateway service/credential revision, target product, association, and registration revision. The entry records Backend `keyId`, user ID, authorization revision, scopes, and original expiry. Never key only by role, user-provided ID, product, connection, or a display label. Never persist raw personal keys or delegated access tokens in ordinary disk caches.

Coalesce simultaneous renewal for the same partition. Different credentials/users/products cannot inherit the result. If a request was invalidated while renewal was in flight, the old response cannot repopulate the cache: use an invalidation generation/barrier and recheck authority state. Renew only through an authenticated successful Backend response. No sliding expiry, local re-signing, or disconnected renewal is permitted.

Each request still checks the presented credential against its own partition and enforces the verified capabilities locally. Cached tool definitions or an open connection do not grant permission. Backend authorization refusal discards the affected entry; it must not fall back to an older positive result.

### 6.2 Invalidation and visibility

Backend changes affecting accounts, key validity, roles, service credentials, signing keys, product association, or membership produce transactional events. Gateway applies them to cached grants, authorized views, and routes before accepting later work based on the affected entry. New permissions require a fresh Backend grant; an event containing a role/capability label is not itself a delegation.

Notifications normally shorten revocation latency. They do not provide instantaneous distributed revocation: if an event is delayed/lost, an issued delegation may remain usable until its original expiry, **at most five minutes**. Product-side domain checks still run for every call. Existing in-flight effects are not rolled back by key revocation.

On product removal/replacement, invalidate every matching old association, not just a name. After complete snapshot reconciliation, absent products are removed from local state. No new delegation is issued for a removed registration. While disconnected, stale route use is bounded by the remaining valid authorization, never by an unrelated tool-cache TTL.

### 6.3 Outage and restart behavior

| Situation | Required behavior |
| --- | --- |
| Backend temporarily unreachable/5xx, matching unexpired grant | Existing authorized calls may proceed within the original scopes, association, and expiry |
| No grant, expired grant, changed target, or known invalidation | No new integrated execution until successful authorization; return authority unavailability when that is the cause |
| Explicit Backend 401/403 or a relevant revocation event | Reject/invalidate; do not treat denial as a network outage |
| Backend role/key change while disconnected | Residual authority ends at expiry; do not promise immediate effect without notification |
| Gateway restart | Discard in-memory authorizations; reauthenticate on first use; persisted definition/registry copies grant no access |
| Backend restart | Recover identities, keys, registry, idempotency results, and event log from persistent local state |
| Internet unavailable, required local services running | Existing prepared accounts/keys continue working; no per-call Google contact |
| Yard unavailable | Existing registrations and Gateway execution remain usable independently |

On recovery, resume ordered events/reconciliation before treating the authority view as synchronized. A refused or expired event cursor causes complete registry reconciliation and clearing of affected authorization state; it cannot silently preserve possibly missed revocations. Cached data may remain for diagnosis but cannot be presented as a fresh authorized catalog after its authorization becomes invalid.

## 7. Tool classification and domain enforcement

### 7.1 Shared capabilities

| Capability | Meaning |
| --- | --- |
| `nox:inspect` | Normal, non-sensitive inspection |
| `nox:write` | Operations that mutate product or external state |
| `nox:sensitive-read` | Reads exposing secrets, credentials, private diagnostics, or other product-classified sensitive data |

Backend grants inspection to approved non-admin accounts and all three capabilities to administrators, following its actual role model. No new user role enum or per-user/per-tool administration matrix is introduced. A combined write/sensitive operation requires both capabilities plus inspection. Confirmation and MCP annotations are not permission grants.

Every Suite-exposed tool has an explicit trusted classification. Reuse `requiredScopes` with these capability strings for the baseline. A read requires inspection; a write adds write; a sensitive read adds sensitive-read. Absence of classification is not normal-read permission: exclude an unclassified tool from Suite catalogs and reject Suite execution until adapted. Legacy/direct MCP remains subject to its independently configured product policy.

The SDK projects trusted effective policy into an additive tool metadata field for discovery:

```json
{
  "nox/authorization": {
    "version": "1.0",
    "requiredScopes": ["nox:inspect"],
    "argumentDependent": true
  }
}
```

The example is an `_meta` fragment whose `nox/authorization` value describes the policy; it is not a replacement for `_meta.cli`. It is generated from application-approved policy. Metadata cannot weaken required execution scopes. If application bindings and a manifest both require scopes, use their union. Unknown application scopes are not automatically granted by a central administrator role; the product's trusted identity/domain adapter must satisfy its local requirements explicitly.

### 7.2 Argument-dependent operations and views

Trusted product code may calculate additional requirements after schema validation and before execution. For example, listing ordinary records can require inspection, while requesting secret fields adds sensitive-read. The calculated requirements can add restrictions, never remove the declared baseline. No expressions, scripts, or permission assertions received from clients are executed as policy.

Products generate their authorized tool views using the verified user/scopes and local domain policy. A conditional tool may be visible for its normal inspection behavior while rejecting privileged argument combinations. Permission checks happen again at execution even if a tool appeared in an earlier catalog. Product-owned object/tenant ownership, validity, preview binding, revision conflicts, and external-service restrictions remain effective for administrators too.

Multiple internal workspaces or tenants are represented through product schemas, authorized options, and domain checks. The Gateway does not embed product-specific tenant selection, translate Google identities into an invented domain account, or infer ownership from a central role. Any required local identity association is a product adapter responsibility.

## 8. Registry events, lifecycle, and availability

### 8.1 Durable event feed

Backend stores accepted membership/configuration mutations, idempotency outcomes, and corresponding registry events in one transaction. Authorization changes and invalidation events are also committed atomically. Observation persistence and its event commit together. Registry revisions change only for registry/configuration mutations, not every heartbeat.

`GET /api/nox/products` returns authorized records with `registryRevision`. A privileged synchronization response additionally includes observations and a `cursor` from the same consistent database snapshot. User views retain role filtering and never expose service credentials, internal connection details, or event categories beyond their authorization.

Services consume `GET /api/nox/events?after=<cursor>&waitMs=25000&limit=256` under their own service credentials. `waitMs` is an integer from 0 to 25000; `limit` is from 1 to 256. If no permitted event is ready, wait until an event arrives or the interval ends, then return JSON. Empty responses and timeout completions are normal, not authentication failures. This is management long polling, **not MCP Go SSE support**.

Example event response:

```json
{
  "contractVersion": "1.0",
  "cursor": "cursor-after-page",
  "hasMore": false,
  "events": [
    {
      "eventId": "event-opaque-42",
      "type": "product.removed",
      "occurredAt": "2026-10-29T12:00:00Z",
      "data": {
        "productId": "example-inventory",
        "retiredRevision": "reg-b7",
        "associationId": "association-15",
        "registryRevision": "registry-21"
      }
    }
  ]
}
```

The cursor advances past the scanned page, including unauthorized events, without exposing their contents. Consumers process delivered events in feed order, apply changes, then commit their cursor. Repeated delivery is safe. A consumer must not compare the spelling of cursors/event IDs or order sources by wall-clock timestamps. `hasMore` requires immediate bounded draining before the next wait.

Required event types are `product.upserted` (accepted record), `product.removed` (retired revision/association tombstone), `authorization.invalidated` (affected user/key, or all grants when necessary), `service.invalidated`, `signing-keys.changed`, `observation.updated`, and `producer.reassociated`. Targets are filtered by service grants; payloads contain no raw keys/tokens. Removal events retire an association and never create/recreate membership.

Keep event storage bounded independently from the minimum 24-hour mutation-idempotency retention. The default feed retention is up to seven days or 100,000 events, whichever limit is reached first. If a cursor was truncated, belongs to another Backend/log generation, or cannot be resumed consistently, return **410 `EVENT_CURSOR_EXPIRED`**. The consumer atomically replaces its local registry/observation snapshot and cursor, invalidates potentially missed authorization changes, and continues. Normal restart preserves the log generation; restoring/replacing authority state requires explicit reconciliation. Never merge an incomplete snapshot into a local registry and retain absent products.

Long polling is one shared operational subscription per consumer service, not one subscription per user/tool. Producers persist pending management operations and retry with their original idempotency keys. Transport failures use exponential backoff with jitter, from one to at most 30 seconds; successful responses reset it. Explicit credential denial stops the loop and requires credential recovery, not an aggressive retry cycle.

### 8.2 Ordered observations

Submit `POST /api/nox/products/{productId}/observations` under the corresponding reporting grant. The JSON body contains:

```json
{
  "contractVersion": "1.0",
  "productId": "example-inventory",
  "registrationRevision": "reg-b7",
  "associationId": "association-15",
  "source": "gateway",
  "producerId": "service-gateway-7",
  "producerEpoch": "producer-epoch-2",
  "sequence": "108",
  "observedAt": "2026-10-29T12:00:00Z",
  "state": "ready"
}
```

Yard observations additionally identify their matching `managedBy` deployment. States remain those in the integration design: Yard `starting/running/stopping/stopped/restarting/recreating/updating/unknown`; Gateway `ready/unreachable/notReady/incompatible/unknown`.

`sequence` is a canonical unsigned 64-bit decimal **string** (no sign or leading zero except `"0"`), compared numerically, not lexically or through floating point. Its scope is `(producerId, producerEpoch, associationId, source)`. Producers persist the sequence before sending. Backend verifies producer identity/grant, current registration/association, and epoch; duplicate/older sequences are ignored without creating another event. The same epoch/sequence with conflicting content is a conflict, not a second observation.

After loss/reset of sequence state, obtain a fresh Backend-issued epoch through `POST /api/nox/products/{productId}/observation-epochs`, authorized for that producer/association, and reconcile actual state. Old epochs cannot update the new one. An epoch change does not enroll a product or bypass a lost service credential.

### 8.3 Freshness and readiness

Checks/reports default to **15 seconds**, freshness to **45 seconds**, configurable per deployment. A Gateway checks MCP readiness without invoking business mutations. Yard reports operation transitions promptly and refreshes its observations while active. Requests do not multiply by the number of CLI sessions; reports may be batched without changing per-observation sequencing.

Backend records receive time and computes `freshUntil` as the earlier of receive time plus freshness and observed time plus freshness. Reject timestamps beyond the permitted future clock uncertainty; a delayed old report must not become fresh merely because it arrived now. Consumers derive `unknown` after `freshUntil` without changing membership or inventing a producer sequence. A fresh connection failure immediately marks the destination unavailable for that attempt; it does not wait for 45 seconds.

Retain deployment operation and MCP observation separately. A running container cannot override an MCP failure. An expired Yard observation does not block a fresh Gateway connection. A stale observation is not proof that a reachable process stopped: perform an on-demand readiness check when needed. Ordinary failure affects that product, not the entire catalog or other products' execution. Reconnecting to a changed endpoint requires rechecking its trusted association and discovery identity before reusing definitions.

## 9. Tool identity, origin, and reference transformation

### 9.1 Deterministic aggregated names

The product's canonical tool name never changes. Gateway assigns an alias:

1. Use `productId + "__" + canonicalToolName` when it is at most 64 ASCII characters and contains only letters, digits, `_`, `-`, and `.`.
2. Otherwise use `"_" + base64url(SHA-256(JCS([productId, canonicalToolName])))`, with no padding (44 ASCII characters).
3. Treat names case-sensitively. Detect any collision before publishing; fail the conflicting route explicitly rather than picking the last definition or silently changing an alias. The hash namespace starts with `_`, which a declared `productId` cannot start with.

Examples: `example-inventory__record_list` and `example-calendar__record_list` are distinct without product-specific routing code. A very long or Unicode canonical name uses the hash form. Aliases do not depend on connection order, token lifetime, label, or tool-schema revision.

The route table binds an alias to product ID, current registration/association, original MCP server ID, canonical tool name, authorized view, original definition fingerprint, and aggregate fingerprint. A table entry is reconstructible cache state. It is never permission to route to an unregistered or unverified replacement.

### 9.2 Origin and preserved metadata

Preserve original schemas, annotations, titles, descriptions, content semantics, `_meta.cli`, and unknown metadata. Add `_meta["nox/gateway"]` containing `version: "1.0"`, `productId`, `toolName`, `serverId`, `registrationRevision`, and `sourceFingerprint`. This is generated Gateway origin data; products must not preclaim that reserved field. A conflicting source field invalidates the affected definition instead of being silently overwritten. Do not publish internal addresses, deployment IDs, API keys, service credentials, or delegated tokens in origin metadata.

Gateway does not infer command names from business types or rewrite `_meta.cli` text. Future CLI navigation uses a generic product boundary keyed by `productId`, with its human label and existing descriptor paths below it. Product IDs/labels are data. A node may have an action and children under the existing CLI foundation. Ambiguous action paths within one product disable the affected advanced action with a diagnostic; they do not select an arbitrary tool or hide unrelated conventional tools.

### 9.3 Auxiliary references

Rewrite only schema-defined tool references in descriptor `parameters[*].options.tool`, `preview.tool`, and workflow call steps, including references in workflow input-parameter descriptors where defined. Resolve each original reference against the **same source product/server and authorized snapshot** before mapping its alias. Product-provided descriptors cannot target another product by guessing its Gateway alias.

Preserve JSON Pointer bindings, argument literals, workflow step IDs, confirmation text, and unknown optional data. Never recursively replace arbitrary strings. An unknown required descriptor feature blocks that advanced path under the existing CLI rules. If an auxiliary tool is missing, unauthorized, or inconsistent, disable the dependent advanced path; do not escalate permissions, switch products, or synthesize business behavior. The main tool can remain conventionally available when its own policy/schema permits.

Confirmation remains tied to reviewed arguments and preview revision/fingerprint. Changing arguments invalidates that confirmation under existing descriptor semantics. Waiting at a confirmation does not consume an execution deadline or force a Google login. The final call receives current authorization, and the product validates any preview/revision token regardless of which client invoked it.

## 10. Discovery, fingerprints, snapshots, and private caches

### 10.1 Source synchronization

Gateway negotiates each source's MCP protocol/capabilities. Use `nox/discovery` when advertised and supported; otherwise use conventional `tools/list`, including all pages. Conventional MCP fallback does not infer advanced descriptors, Suite classification, or trust. A Suite product must still supply verified identity/policy metadata even if it does not implement incremental discovery. An external non-Suite server configured in the future CLI stays outside Backend enrollment and this trust path.

Definitions and catalogs are synchronized atomically per source using existing snapshot/hash integrity checks. Never replace a valid cache with a partial response. A changed `serverId`, association, origin, or authorized view invalidates affected reuse. Product view changes can occur independently of Backend role changes; source guards and local domain checks remain necessary.

### 10.2 Fingerprint composition

The original fingerprint is the product's hash of its complete original `{tool, cli?}` bundle, excluding availability as defined by existing discovery. For conventional sources, Gateway computes that bundle's JCS/SHA-256 fingerprint from the actual advertised tool; it cannot advertise source-side fingerprint enforcement that the source lacks.

The aggregate fingerprint is JCS/SHA-256 of the complete transformed `{tool, cli?}` bundle, including the alias, origin metadata, and rewritten descriptor references. It is distinct from the original and is never forwarded upstream as if it were the source fingerprint. No fingerprint contains itself. Unknown preserved fields continue to affect the relevant complete-bundle hash.

When a client supplies `nox/discovery.expectedFingerprint`, Gateway first compares the aggregate fingerprint, then maps it to the pinned original fingerprint for the source call when the source supports that guard. For a conventional source, recheck the advertised definition before guarded dispatch; this detects known drift but cannot provide an atomic product-side definition/call guarantee. Products enforce domain preview/revision tokens at execution. Clients not supplying fingerprints receive conventional MCP behavior with current schema/policy checks, not a fabricated stale-review guarantee.

### 10.3 Aggregate snapshot

Reuse the existing discovery catalog algorithm and schema. Gateway has its own persisted discovery `serverId`; `viewId` is a non-secret opaque identifier derived from the authenticated user's key/policy partition and product-authorized views. Signature bytes, `jti`, renewed expiry timestamps, and raw credentials must not perturb an otherwise identical catalog or appear in its identity.

Place component-version data in `presentation.gateway` with `version: "1.0"`, `registryRevision`, and an ordered `products` array of `productId`, registration revision, MCP server/view IDs, and source catalog fingerprint. For conventional sources, use the verified complete source-catalog hash. This data participates in the existing hash of `{serverId, viewId, tools, presentation?}`. Source entries are ordered by product ID; tool entries follow existing discovery ordering. Only authorized product/component information is included.

Publish the complete aggregate route table, transformed definitions, catalog, and component vector atomically after their dependencies are checked. This records exactly which source versions were combined; it is not a distributed transaction across products. If a source changes during preparation, retry bounded discovery or report it unavailable; do not publish a mixed source snapshot. A later tool call still checks its pinned routing/definition requirements.

### 10.4 Partitioning, availability, and cache lifetime

Partition caches by Backend issuer, exact validated credential partition, user/authorization revision, capability set, Gateway policy revision, product association, and source `viewId`. Separate private cache objects or equally strong partitions are required. Identical roles do not imply identical product-domain visibility. In-flight cache work cannot commit across invalidation generations. Enforce bounded cache entries/bytes and return defensive copies at public helper boundaries.

Definition freshness and authorization validity are independent. Renewing the same authorization does not download unchanged definitions. An available catalog's `ttlMs` is bounded by the minimum participating source freshness and remaining authorization validity; it never extends authorization. Do not insert synthetic grants into complete documents.

An unavailable product can remain visible with unavailable tools only in a still-valid matching authorized partition. A newly changed role/view cannot inherit its former definitions. On authorization expiry/denial, stop presenting those tools as currently authorized until renewal; retained diagnostic data is not an executable catalog. Membership persists during failure. A removed product disappears when its tombstone/snapshot is applied, and its cached authorization cannot be renewed.

## 11. Execution across Gateway and product

### 11.1 Admission and context

For each call, Gateway validates the presented personal credential against the relevant cached/fresh authorization, current known membership/association, alias mapping, policy, limits, and any expected aggregate fingerprint. It then forwards the canonical product name and the product-specific delegation. It must not trust caller-supplied user/scopes/actor, destination URLs, downstream authorization headers, or origin metadata.

Gateway generates a UUID correlation ID for the execution and propagates `Nox-Request-Id`, `Nox-Deadline-At` (RFC3339 UTC), and `Nox-Timeout-Ms` (positive remaining integer milliseconds). These are trusted transport controls set by Gateway; strip/replace conflicting client values. The product projects them into native context while preserving native cancellation semantics. They are not credentials or a claim of business idempotency.

Products verify delegated identity/resource/association, schema, baseline and argument-dependent scopes, and domain restrictions before side effects. They recheck cancellation/deadline immediately before committing after asynchronous work. Catalog visibility, a previous preview, or a successful prior call never bypasses execution checks.

### 11.2 Deadlines and limits

The Gateway establishes one total deadline at admission. Time spent obtaining authorization, checking definitions, validating, and forwarding consumes it. On each hop, the effective deadline is the earliest of the received absolute deadline, the received remaining budget, and the local configured maximum. Convert that bound to a local monotonic timer; never restart a full timeout after each hop. An already expired/cancelled request does not start the product executor. Deployments must satisfy the clock discipline in section 5; clock uncertainty may shorten a budget, not justify extending the original deadline.

Gateway defaults are a 20,000 ms call budget, 2 MiB tool input/result payload limit, and 32 concurrent forwarded executions, configurable by deployment. Bound transport envelopes separately and respect the lower actual downstream body bound. The defaults are also available through the shared Suite defaults; direct SDK APIs retain their existing configuration. Sources may impose tighter limits; larger/long-running operations require explicit configured budgets or product-defined asynchronous operations.

Concurrency capacity is shared across **all HTTP requests and per-request server factories**, not reset with each new auth context or connection. Product execution limits remain global to the configured runtime as well. Reject overload before dispatch without an unbounded queue. Cancellation does not release product capacity while non-cooperating work still runs in implementations that retain such work. Payload rejection, overload, and deadline checks must not depend on which user happened to create a runtime instance.

### 11.3 Cancellation, failures, and long work

Propagate caller cancellation, disconnect, and Gateway shutdown through the actual downstream transport/runtime cancellation mechanisms. Delivery is best effort. An accepted write may already have effects; cancellation, removal, token expiry, or a broken connection does not prove rollback. Revoking authorization does not retroactively undo an admitted operation.

Preserve successful content/`structuredContent`, valid product tool errors, and domain details under existing contracts. Distinguish a known pre-dispatch rejection from loss of the result after possible dispatch. For writes or other operations not explicitly known to be read-only, timeouts/cancellation/uncertain transport failure carry `retryable: false` and `details.outcome: "unknown"`. Where non-execution is certain, report it without pretending an unknown effect occurred. Preserve existing SDK behavior for explicitly marked reads; Gateway still performs no automatic retry of tool calls.

Metadata/discovery/event requests may retry within bounded budgets because they do not execute business tools. Each dynamic-option request, preview, workflow call, progress query, and cancellation tool call is separately checked against valid authorization; a matching five-minute grant is reused locally rather than exchanged per step.

A multi-hour CLI session is not a multi-hour RPC. A product may expose generic tool-described start/status/cancel operations and an opaque operation ID for long work. Their naming, persistence, and business behavior belong to the product, not hardcoded Gateway branches. A client resumes through those tools under current authorization. If a product instead supports a single long call, its configured end-to-end budget must cover it; a token accepted at admission is not periodically renewed to keep that call alive.

## 12. Error surfaces, MCP compatibility, and consumers

| Boundary/case | Required behavior |
| --- | --- |
| Invalid personal credential or invalid delegated token | HTTP 401 at the authentication boundary; never execute a tool |
| No valid authorization and Backend temporarily unavailable | HTTP 503 with a sanitized transport error identifying `INTEGRATION_UNAVAILABLE`; never reuse an expired grant |
| Verified identity lacks a tool capability/domain permission | Existing MCP tool error `FORBIDDEN`, without successful `structuredContent` |
| Stale aggregated/source definition | Existing discovery `STALE_DEFINITION` / `STALE_CATALOG` reason and JSON-RPC boundary; respect SDK-specific HTTP mappings |
| Destination known unavailable before dispatch | Sanitized tool `UNAVAILABLE`; identify known non-execution when certain |
| Timeout/cancellation/unknown write outcome | Existing `TIMEOUT` / `CANCELLED` or transport-failure code with unknown-outcome semantics from section 11 |
| Invalid classification/required feature/declaration | Explicit incompatibility diagnostic; no unauthorized fallback |
| Expired event cursor | Management HTTP 410 `EVENT_CURSOR_EXPIRED`; reconcile snapshot |
| Expired/mismatched pairing | Management error `PAIRING_EXPIRED` / `PAIRING_CONFLICT`; no membership activation |

Management responses use the separate `{error:{code,message,retryable}}` envelope from the integration design. They are not MCP tool errors. Transport errors must not contain raw credentials, tokens, internal exception traces, or unfiltered connection configuration. An unavailable Backend is not a false `FORBIDDEN`, and an authorization denial is not a retryable outage.

Preserve conventional `initialize`, `tools/list`, and `tools/call`, their schemas and metadata. Do not require clients to enroll products or understand Gateway management APIs. Modern clients negotiate `nox/discovery` with existing metadata/version rules; use existing JSON-RPC negotiation codes, not registration codes. A Gateway may advertise `nox/gateway` version `1.0` as origin/aggregation support, but basic calls require only conventional MCP plus the configured credential.

HTTP JSON is the default normal-exchange mode. Supported streaming/progress paths must preserve notifications only when negotiated and deliverable; JSON mode retains terminal results under existing SDK behavior. Dedicated supported subscription streams retain their protocol semantics. This contract does not promote Go MCP SSE out of **Investigating / Future Support**, mandate a fork, or invent a JSON/SSE conversion layer.

NoX personal API-key authentication is the configured NoX access profile. Conventional clients that can supply the configured authorization header can use it; this is not a claim that every OAuth-only client can discover or obtain a NoX API key automatically. Google account approval/key issuance remains in Backend, not an SDK OAuth adapter. Future CLI's own MCP server and external connections have their separately designed caller/transport lifecycle and must retain these user restrictions when proxying NoX calls.

Gateway should notify connected consumers of changed tool lists through negotiated standard MCP mechanisms. Notifications invalidate cached presentation; clients still re-read definitions and supply fingerprints where supported. They do not carry permission grants or execute workflows. Future Portal reads registered contributions under its separate UI contract; no HTML loader or product-specific UI bridge is implied here.

## 13. Product adaptation and SDK implementation boundaries

All participating products, existing and future, implement the same declaration, pairing, Suite identity, classification, and execution rules appropriate to their declared capabilities. A product with no `suiteMcp` can register without tools. Domain-specific tenant/workspace models and asynchronous operations stay in that product. A desktop or browser-backed product must supply a real reachable adapter/executor for advertised capabilities; retained bridge code or a dependency update alone does not establish conformance.

Direct MCP and Suite MCP share trusted tool executors/business rules but have independent exposure/authentication configuration. Disabling direct MCP cannot disable the protected Suite endpoint. Plan migration for any existing URL already serving a different policy: retain it until explicitly migrated, or declare a distinct Suite path on the main listener. Never silently reinterpret an existing direct `/mcp` URL as Suite access. A declared path may differ from `/mcp`; no third listener is required. Preserve existing public capabilities or document the explicit compatibility migration; preserving behavior does not freeze old integrations permanently.

Implementation work in NoX MCP adds separate authoritative schemas/corpora for integration, pairing management, delegated claims/context, policy projection, events, observations, and Gateway origin/presentation data. Add complete-document types/loaders and helpers in TypeScript, Go, and Rust, synchronize generated native copies, and test portable URL/JCS/sequence/policy behavior. Do not repurpose `server.schema.json`, change discovery hash algorithms, replace `_meta.cli`, or alter bridge protocols for this work.

SDK helpers validate/project verified data; they do not issue API keys, approve Google accounts, persist a registry/outbox, manage service secrets, renew tokens in a background singleton, deploy containers, render UI, or run a Gateway. Hosts implement storage, HTTPS, issuance, timers, network requests, and trusted key lookup using the shared contracts. Native consumers must build without Node or access to root schemas. Public API names and generated artifacts belong to implementation work; no current constructor/export is claimed by this document.

Implementation order: shared contracts/helpers; Backend authority/management; installer and product adapters plus Gateway service against those contracts; future manual CLI; separately scoped Portal/AI/CLI MCP work. Components can be developed in dependency-aware parallel work once authorized, without making their current behavior a design prerequisite. Releases, SDK version changes, and cross-repository migrations require their own scope.

## 14. Required conformance and end-to-end flows

Portable contract fixtures must use varied fictional products and exercise each shared rule in all three languages. No existing product's endpoint names, tenants, tool counts, or menu conventions may become an implicit schema restriction.

| Flow/case | Required observable result |
| --- | --- |
| Unknown conforming product is registered and discovered | Appears through contracts/data; no SDK/Gateway/CLI product-specific code |
| Product declares no Suite MCP | Membership accepted; no invented tools or Portal loader |
| Arbitrary product-owned tenant/workspace schemas | Arguments/options route unchanged; product enforces ownership |
| Pairing proof wrong, expired, replayed for another target, or self-announced | No service association or membership authority |
| Lost provisioning/enrollment response and ordinary restart | Same eligible outcome resumes; no second credential or duplicate registration |
| Service tries another installer's deployment or reports another producer | Denied before mutation |
| Wrong JWT issuer, algorithm/type, audience, actor/association, time, or unknown key | Rejected before execution; token-supplied key URLs ignored |
| Admin/non-admin and argument-dependent sensitive access | Same policy enforced in catalogs and execution; annotations cannot grant authority |
| Concurrent calls from different keys/users through one runtime | Identity, scopes, caches, and limits remain isolated/shared at their correct scopes |
| Three-hour session with active calls and long idle periods | No 30-second authorization churn or repeat Google login; renewal on demand at expiry |
| Many calls within one grant | Local checks reuse grant; unchanged definitions are not downloaded per call |
| Readiness checks without any active user | Reuse a restricted service probe grant; cannot list/call user tools or impersonate a user |
| Role/key/service revocation event, including during renewal | Affected state invalidated; late renewal cannot repopulate it |
| Lost invalidation followed by Backend outage | Only original matching grants remain usable, never beyond five minutes |
| Expired grant during outage, explicit denial, or Gateway restart | No stale positive fallback or authorization from disk definitions |
| Offline Internet and restarted local services | Prepared users/keys work with persistent Backend authority; new Google login remains Internet-dependent |
| Cursor page duplication, unknown event generation, truncation, or interrupted snapshot | Safe repeated delivery or complete replacement; no membership resurrection or missed-revocation fallback |
| Observation sequence above JavaScript's exact integer range | Exact decimal-string comparison agrees across languages |
| Old producer epoch, wrong association, delayed observation | Cannot overwrite replacement/current state or refresh stale readiness |
| Yard stopped while Gateway/product remain ready | Existing authorized execution continues |
| Product offline/restarting/recreated | Membership survives; source identity checked before cache reuse |
| Removal/re-enrollment and a delayed old uninstall/call | Old association cannot delete or silently route to replacement; expired old grants do not renew |
| Duplicate canonical tool names across products; long/Unicode names | Stable aliases under 64 characters, with deterministic hash fallback and collision rejection |
| Auxiliary references, literals, unknown optional fields, and missing permissions | Rewrite only known same-source references; no permission escalation or arbitrary string substitution |
| Original/aggregate fingerprints, pagination, and source change during assembly | Existing hash rules preserved; no partial/mixed source commit |
| Two equal roles with distinct domain visibility | No cross-user/view catalog leakage |
| Conventional source/client without NoX discovery | Correct basic MCP behavior; no fabricated atomic stale-definition guarantee |
| Concurrent HTTP requests exceed configured capacity | Limit applies across factories/connections, not only within a batch |
| Delayed authorization/discovery then product execution | One shrinking total deadline; no timeout reset |
| Disconnect/cancel/shutdown or uncertain write transport outcome | Best-effort propagation, sanitized error, no automatic tool retry or false rollback |
| Direct MCP disabled, Suite credential valid | Suite remains available; direct and Suite policies cannot substitute for one another |

Run SDK conformance/packaging/regression checks after implementation. End-to-end certification uses the newly implemented/adapted components and failure paths, not an assumption that unchanged existing products already implement this contract. Source-only documentation review is not runtime certification.

## 15. Technical references and decision provenance

The project-specific decisions are the five-minute reusable grant, on-demand renewal, bounded outage/revocation behavior, service pairing/grants, namespace mapping, event transport, and operational defaults specified above. External standards provide the underlying mechanisms; they do not independently require these NoX timing choices.

- [JWT best current practices, RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html): fixed validation rules, trusted issuer/key handling, explicit token purpose, and audience validation.
- [JWS algorithms, RFC 7518](https://www.rfc-editor.org/rfc/rfc7518.html): ES256 encoding/algorithm; use maintained cryptographic libraries rather than implementing signing primitives.
- [Token exchange and actor representation, RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html): distinct subject/actor semantics. The NoX management exchange is not a claim of implementing every OAuth token-exchange grant.
- [Bearer token usage, RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html): protected credential handling and authenticated transport.
- [JCS, RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html): portable canonical JSON for proofs and hashes, as already used by NoX discovery.
- [MCP HTTP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization): per-request credential presentation/validation; this does not require a new remote issuer consultation on every request.

The approved origin-only address model, general applicability to future products, and non-existence of Gateway/CLI/Portal are requirements, not illustrative implementation assumptions. There is no separate per-request 30-second grant, mandatory live authorization call for every tool invocation, or Backend/Yard pilot gate in this baseline.
