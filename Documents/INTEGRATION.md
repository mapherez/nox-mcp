# NoX Suite SDK integration

The working tree implements the shared Suite `1.0` contracts in TypeScript, Go, and Rust. The [Gateway Contract](GATEWAY_CONTRACT.md) defines the normative behavior; this guide describes the available SDK mechanisms. Product identity is open to any conforming product. No product names, business permissions, menus, or database layouts are built into the SDK.

Gateway, CLI, and Portal are separate applications and do not exist in this repository. Backend management routes, token issuance, persistent registry/outbox, enrollment transactions, HTTPS deployment, and product migrations remain service work. No SDK version or release was created by this implementation.

## Documents and validation

`contracts/suite-*.schema.json` is authoritative. `suite-defaults.json` contains timing and resource defaults. `suite-conformance.json` contains shared document, crypto, address, namespace, observation, registry, and aggregation cases. Run `npm run contracts:sync` after editing these sources; commit the generated native copies and DTOs together. `npm run contracts:check` rejects drift.

| Operation | TypeScript root export | Go package `noxmcp` | Rust module `nox_mcp::suite` |
| --- | --- | --- | --- |
| Complete declaration loader | `loadSuiteDocument('product-declaration', input)` | `LoadSuiteProductDeclaration(bytes)` | `load_suite_product_declaration(json)` |
| Other complete documents | `loadSuiteDocument(name, input)` | `LoadSuiteDocument(name, bytes)` or `LoadSuite…` | `load_suite_document(name, json)` or `load_suite_…` |
| Canonical origin/path | `normalizeSuiteOrigin`, `normalizeSuitePath` | `NormalizeSuiteOrigin`, `NormalizeSuitePath` | `normalize_suite_origin`, `normalize_suite_path` |
| Pairing proof | `createSuitePairingProof`, `verifySuitePairingProof` | `CreateSuitePairingProof`, `VerifySuitePairingProof` | `create_suite_pairing_proof`, `verify_suite_pairing_proof` |
| Verify delegated authority | `verifySuiteToken`, `verifySuiteAuthorizationResponse` | `VerifySuiteToken`, `VerifySuiteAuthorizationResponse` | `verify_suite_token`, `verify_suite_authorization_response` |
| Reusable authorization | `SuiteAuthorizationCache` | `NewSuiteAuthorizationCache` | `SuiteAuthorizationCache` |
| Aggregate discovery | `composeSuiteGateway`, `selectSuiteRoute` | `ComposeSuiteGateway`, `SelectSuiteRoute` | `compose_suite_gateway`, `select_suite_route` |
| Accept producer observation | `acceptSuiteObservation` | `AcceptSuiteObservation` | `accept_suite_observation` |
| Apply a registry event page | `reduceSuiteRegistry` | `ReduceSuiteRegistry` | `reduce_suite_registry` |
| Shrinking call budget | `suiteRequestBudget` | `SuiteRequestBudget` | `suite_request_budget` |
| Product Suite execution | `createSuiteHttpHandler` | `NewSuite` and `Runtime.HTTPHandler()` | `McpServer::with_suite`, `admit_suite_http_request` |

Loaders validate the complete document without defaults, coercion, or property removal. Generated native DTOs retain unknown fields through `Extra`/`extra`; optional absence stays absent. Constructing a DTO or parsing claims is not cryptographic verification. Only a verifier-produced `VerifiedSuiteIdentity` carries authority. Its ordinary debug/serialization representation does not expose its bearer token; `accessToken()` / `AccessToken()` / `access_token()` explicitly returns the secret when forwarding requires it. Wire DTOs containing credentials are still secrets and must not be logged.

Existing discovery catalog/bundle envelopes retain their closed property sets; extensible product and tool metadata remains preserved.

The strict JSON entry points reject duplicate keys, malformed UTF-8, isolated surrogates, non-finite numbers, trailing content, and depth over 64. Default document size is 2 MiB; explicit `…WithLimit` / `…_with_limit` overloads and the TypeScript loader's third argument allow a caller-selected bound. Gateway snapshots default to 8 MiB. Times use UTC `YYYY-MM-DDTHH:mm:ss[.SSS]Z`, with one to three fractional digits when present. Observation sequences are canonical decimal **strings**, covering the full unsigned 64-bit range without JavaScript number rounding.

A deployment address is an HTTPS origin, such as `https://192.168.10.10:8443` or `https://product.example.com`. It has no application prefix. A trailing root slash/default port is removed, and DNS names/IPv6 are canonicalized. User information, queries, fragments, ambiguous IPv4 spellings, leading-zero ports, and zone identifiers are rejected. Endpoint paths start with one `/`; no query, fragment, dot traversal, backslash, raw Unicode, control/whitespace, or escaped ASCII bytes are accepted. Non-ASCII path characters may use valid UTF-8 percent encoding, normalized to uppercase escapes. This conservative profile prevents different URL parsers from interpreting the same audience differently.

## Product endpoints

Expose the ordinary application/direct MCP path using the product's existing policy. Mount the Suite handler at the path declared by `/nox/integration`. The Suite endpoint remains available when the user disables direct MCP.

The host supplies an immutable local trust/registry snapshot: issuer, exact audience, product/association, Gateway service, registration revision, credential revision, and trusted ES256 public keys indexed by `kid`. Refresh keys out of band from the configured Backend; JWT headers never select a key URL. Require both revisions in production verification options. The SDK deliberately does not fetch keys or consult Google/Backend on each tool call.

`nox:inspect` is mandatory in every classified tool policy. `nox:write` and `nox:sensitive-read` are additional capabilities. Application-local requirements are unioned with this policy. A local scope mapper may grant domain scopes from verified identity and local configuration, but cannot grant any `nox:*` capability. Argument-dependent requirements only add restrictions. Configure the callback whenever a policy sets `argumentDependent: true`; unclassified tools are omitted from Suite exposure.

TypeScript, using application-supplied `tools` and a local trust store:

```ts
import { createSuiteHttpHandler, suitePolicy } from '@nox/mcp';

const suite = createSuiteHttpHandler({
  appId: 'example-product', name: 'example-product', version: '1', tools,
  verification: () => trustStore.current(),
  policies: {
    record_list: suitePolicy(['nox:inspect']),
    record_update: suitePolicy(['nox:inspect', 'nox:write'], true),
  },
  isActive: identity => revocations.isActive(identity.context()),
  additionalScopes: async (name, input, context) =>
    localPolicy.additionalRequirements(name, input, context),
  discovery: {
    serverId: 'example-product-mcp',
    resolveView: (context, tools) => localPolicy.discoveryView(context, tools),
  },
});
// Mount suite.fetch using the existing Node or Web Request adapter.
```

The handler verifies the HTTP bearer token itself, disregards caller-supplied `authInfo`, rejects forbidden probe methods including batch members, filters standard discovery, projects trusted authorization metadata, partitions private discovery views, and shares execution capacity across requests. A dynamic check runs inside the same execution deadline and capacity limit as its executor. Use the host callbacks to impose domain visibility and ownership as well.

Go:

```go
inspect, err := noxmcp.NewSuitePolicy([]string{"nox:inspect"}, false)
if err != nil { return err }
runtime, err := noxmcp.NewSuite(productOptions, noxmcp.SuiteRuntimeOptions{
    Verification: trustStore.Current,
    Policies: map[string]noxmcp.SuitePolicy{"record_list": inspect},
    IsActive: revocations.IsActive,
}, productDiscovery)
if err != nil { return err }
// Mount runtime.HTTPHandler() at the declared Suite path behind HTTPS.
```

`NewSuite` installs protected discovery and method admission, and `HTTPHandler()` verifies bearer credentials before dispatch. An optional `DiscoveryOptions` preserves product descriptors and local visibility. Without it, the SDK supplies a basic private discovery view. Direct calls to `Runtime.Execute` also require verifier-produced authority via `SuiteTokenInfo`, rechecked against the runtime's own pinned verification snapshot; arbitrary `auth.TokenInfo.Scopes` do not grant Suite access. The regular `New`/`Protect` APIs retain their existing independent authentication behavior.

Rust:

```rust
use nox_mcp::suite::{SuiteRuntimeOptions, load_suite_policy};

let inspect = load_suite_policy(
    r#"{"version":"1.0","requiredScopes":["nox:inspect"],"argumentDependent":false}"#,
)?;
let server = product_server.with_suite(SuiteRuntimeOptions {
    policies: [("record_list".into(), inspect)].into(),
    is_active: Some(revocations.clone()),
    ..Default::default()
})?;
```

The Rust host owns its Axum/Tower HTTP service. Before passing a request to rmcp, buffer its body with a strict limit and call `admit_suite_http_request(&mut parts, &body, &verification, local_max_ms)`. On error, `suite_http_error_status` supplies the HTTP status. On success, reconstruct the request **with those same Parts and original body**, then dispatch. This helper inserts the verified identity and bounded controls into `Parts.extensions`. rmcp supplies those Parts in native request extensions; `with_suite` reads them and applies signed identity and trusted policy. It also supports directly inserted typed extensions, or an explicitly trusted `identity_resolver` for another native transport adapter. Never use deserialized metadata or unverified claims as that resolver's result.

Keep `with_discovery` when the product advertises `nox/discovery`; Suite filtering and private identity partitioning apply to the product's view. `additional_scopes` is an async local policy callback running inside the same execution task/deadline. No Rust host needs Node.js.

Gateway sets `Nox-Request-Id` (UUID), `Nox-Deadline-At` (UTC), and `Nox-Timeout-Ms` (positive integer). The TypeScript/Go Suite HTTP handlers and Rust HTTP admission helper require these for tool calls. Transport controls do not grant identity or business idempotency. The effective budget is the minimum of the remaining budget, absolute deadline less clock uncertainty, and local limit. A product must check cancellation immediately before a mutation after asynchronous work.

## Gateway and Backend adapters

Verify a Backend authorization response before inserting it in the memory cache. Build its partition with a process-secret HMAC of the personal API key, pinned issuer/audience/Gateway credential revision, and product/association/registration revision. Use `suiteCredentialPartition` / `SuiteCredentialPartition` / `suite_credential_partition`; never use a plain key hash or the raw key as a cache key.

`refresh` / `Refresh` coalesces renewal for one partition, enforces bounded entries/bytes/pending work, and rejects late commits across invalidation. The callback performs the host's authorization HTTP request and cryptographic verification. It runs only when an operation needs a grant that is not already usable. Apply Backend events through `applyEvent` / `ApplyEvent` / `apply_event` and atomically update the registry and admission/revocation state. On an expired cursor, replace the registry from a consistent snapshot and invalidate affected grants before admitting further operations. The SDK does not start an event poller.

User grants remain usable for at most five minutes, with a five-second conservative expiry margin. Clock rollback beyond the allowed uncertainty invalidates cache reuse. Probe grants have a separate token purpose and cache partition and cannot enumerate/call tools or open subscriptions. A Backend outage does not extend expiry: current verified grants can continue until their original bound; later operations fail if renewal cannot complete. There is no 30-second user grant, automatic token renewal while idle, or repeated Google login during a long session.

For each product, authenticate and retrieve its private conventional/incremental discovery. Enforce each source grant against the classified tool requirements before composition; a source document or view ID is not a grant. Build a `SuiteGatewaySource` from its accepted registration, original source identity/view, and complete authorized definitions; include source hashes to detect stale definitions/catalogs. Set `authorizationExpiresAtMs` to the earliest usable grant expiry across the included sources, and include only sources whose identity/association and private view still match that authority. `composeSuiteGateway` and its native equivalents create a private aggregate snapshot with collision-checked aliases, original/aggregate fingerprints, rewritten known auxiliary tool references, component revisions, provenance, and routing data. Unclassified tools are excluded. Invalid/unavailable auxiliary references disable that advanced descriptor while preserving the main tool. Literal product arguments and unknown metadata remain unchanged.

Use `suiteAuthorizationViewKey` / `SuiteAuthorizationViewKey` / `suite_authorization_view_key` for an opaque private view partition derived from verified authority, the credential partition, and policy revision. Supplying an arbitrary view ID or source document does not authenticate a client. The host must authenticate the public Gateway even when there are no source products, using the Backend's authenticated role-filtered registry access. Empty aggregation must not become anonymous access. Prevent a Gateway's aggregate public endpoint from being registered as one of its own sources.

`selectSuiteRoute` validates selection against a snapshot and expected aggregate fingerprint, but does not authorize forwarding. Before dispatch, the host obtains current verified authority for the bound product, checks current registration/revocation, converts any aggregate precondition back to its original source fingerprint, forwards the original tool name, and propagates the shrinking deadline. Never automatically replay tool calls after an uncertain transport failure.

`acceptSuiteObservation` rejects the wrong association/producer/epoch, compares exact sequences, and prevents duplicate reports from refreshing freshness. The host must supply the authorized binding and enforce service roles. `suiteObservationState` returns `unknown` after freshness expires without deleting registration. `reduceSuiteRegistry` is a pure staged event-page reducer; the host commits its returned snapshot/cursor together with corresponding authorization invalidations under its own admission lock. It does not provide durable storage, event delivery, producer epoch allocation, or crash transactions.

## Verification and next service work

`npm run test:suite` compares actual normalized outputs from all three native implementations, including complete documents, signed token rejection, HMAC, aliases, aggregate catalogs, observation ordering, and registry changes. Ordinary SDK tests also cover HTTP admission, additive policy, refresh coalescing/invalidation/cancellation, payload/deadline limits, and existing direct integrations. Existing package/consumer checks exercise installed exports and native schema inclusion.

The required minimum/latest consumer jobs execute Suite behavior against each consumer's dependency graph: the complete Go SDK test package from the external module, Rust's integration tests against the external dependency, and all TypeScript Suite tests through installed public exports. The standalone Go/Rust package checks also execute their SDK tests. Linux conformance runs the Go race detector. Successful local checks do not replace the required GitHub jobs for the exact commit being released.

The next service implementation is the Backend authority: persistence, pairing/credential issuance, ES256 signing/key rotation, registry transactions and durable events, then the Gateway against these SDK mechanisms. After that, implement the CLI and adapt every participating product against the same contracts. Portal contribution loading and the CLI's own MCP-server lifecycle are separate product contracts already identified in the implementation plan.
