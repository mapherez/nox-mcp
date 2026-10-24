# NoX Suite — Product integration and registration proposal

Status: **proposed for approval; not implemented**.

Prepared on **October 24, 2026**, against the [general implementation plan](NOX_SUITE_IMPLEMENTATION_PLAN.md). This document defines the next design step. Example field names, paths, versions, and error codes below are proposals, not existing SDK APIs. Approval of this document alone does not authorize changes to consumer repositories.

## 1. Scope and existing foundation

Define how an independent product announces integration support and becomes registered in the environment administered by the Backend. Keep registration, operational availability, and tool discovery separate.

The repository already supplies tool manifests, CLI descriptors, `nox/discovery`, and authorization hooks. In particular:

- `contracts/manifest.schema.json` describes **tools**, not installed products.
- `contracts/server.schema.json` describes existing **bridge frames**, despite its generic filename. It must not be repurposed as a product/server registration schema.
- `contracts/discovery-catalog.schema.json` identifies an MCP discovery server and authorized view. Its `serverId`, `viewId`, and catalog fingerprints are not registry identifiers or registration revisions.
- Existing `requiredScopes` and authentication context can enforce requirements; they do not establish Gateway trust or define the new shared permission classification.

This proposal adds a separate contract. It does not change those documents, MCP methods, fingerprints, `_meta.cli`, public constructors, authentication flows, or bridge protocols.

Initial scope remains one registered product of each type per Backend environment. No application/module/instance hierarchy, distributed registry, remote-network discovery, or Docker dependency in the shared SDK.

## 2. Responsibilities and sources of truth

| Information or action | Authority |
| --- | --- |
| Product identity and advertised integration support | Product declaration, verified during authorized enrollment |
| Accepted membership, configured address, connection association, registration revision | Backend |
| Account, API key, current role, and central permissions | Backend |
| Deployment identity and known deployment operations | Yard |
| Actual MCP reachability and readiness | Gateway observation |
| Tool definitions, schemas, descriptors, and domain rules | Product |
| Aggregated presentation and execution | Future CLI; future Portal for UI contributions |

Yard initiates integration; it does not become a second registry. Gateway receives reconstructible registry data and reports observations; it cannot independently enroll products. Product announcements are data, not proof of trust.

Foundation products are associated through the Backend's existing native administrative UI and equivalent APIs. That explicit administrative path precedes automatic Yard integration and does not require Portal.

## 3. Product declaration

Propose a small JSON declaration served by an integration-capable host product at **`GET /nox/integration`**, on its main application listener. NoX integration is opt-in; ordinary applications and existing MCP servers need not implement this endpoint.

This is a product bootstrap/management API, **not an MCP extension or a replacement for `server/discover`**. It provides the information needed before the Gateway can establish an MCP connection. Tool discovery continues over existing MCP transports.

Minimal example:

```json
{
  "contractVersion": "1.0",
  "productId": "nox-example",
  "productVersion": "1.0.0",
  "displayName": "NoX Example",
  "capabilities": {
    "suiteMcp": { "path": "/mcp" }
  }
}
```

| Field | Proposed rule |
| --- | --- |
| `contractVersion` | Exact supported integration contract version, initially `1.0`; independent of SDK, MCP, bridge, and product versions |
| `productId` | Stable product identifier, 1–64 ASCII characters, pattern `^[a-z0-9]+(?:-[a-z0-9]+)*$`; unique within this Backend |
| `productVersion` | Non-empty display/diagnostic string, up to 64 characters; not used to infer contract or tool compatibility |
| `displayName` | Non-empty human label, up to 120 Unicode code points; never an identity or routing key |
| `capabilities` | Object; absence of a capability means it is not advertised |
| `capabilities.suiteMcp.path` | Origin-relative path for the protected Suite MCP endpoint on the main listener |

All five top-level fields are required. `capabilities: {}` is valid for registration, but makes no tools available. Do not advertise `suiteMcp` until the product implements the Suite access path. Multiple transports/endpoints per product are outside this first contract.

The declaration contains no credentials, accounts, tool lists, schemas, CLI paths, descriptors, or tool hashes. The native frontend and direct MCP endpoint are not configuration inputs for central execution.

An unknown optional property is preserved as JSON but grants no behavior or authority. Unknown capabilities are not activated. An optional `requires` array identifies features essential to interpreting the declaration: version 1.0 initially recognizes no additional required features, so any non-empty array is rejected as unsupported. This permits inert extensions without silently ignoring future mandatory semantics.

The initial declaration does **not** define a Portal bundle URL or loading technology. The future contribution contract can add an optional capability with explicit compatibility rules. Registering a product now must not depend on Portal or imply that its native HTML can safely be loaded into Portal.

### Address and identity rules

- The authorized installer/configuration supplies `baseUrl`, for example `http://example:8080`. The product cannot redirect enrollment to an arbitrary self-advertised host.
- In version 1.0, `baseUrl` is an HTTP(S) origin: scheme, host, and optional port, without user information, query, fragment, or non-root path. Path-prefixed reverse-proxy deployment is deferred rather than interpreted inconsistently.
- `suiteMcp.path` starts with a single `/`; reject scheme-relative URLs, query/fragment, traversal, and ambiguous encodings that escape the configured origin. URL construction must produce the same target in all three languages.
- Validate addresses against the administrator-approved local network/deployment policy before fetching. A LAN address or a `nox-*` name is not evidence of trust. Do not follow redirects to an unapproved destination; revalidate resolved targets on reconnect.
- Validate the fetched declaration, bind it to the intended deployment, and establish the authorized service association before activating membership. The exact proof/credential exchange is a blocking dependency of the Gateway Contract, not something this JSON can solve.
- Product updates and container recreation retain `productId`. A different product cannot overwrite that registration. Address or ownership-of-connection changes require an explicitly authorized update.

The fixed bootstrap path and origin-only restriction need approval before implementation. They introduce no changes to current application routes in this phase.

## 4. Backend registration record

The Backend stores the accepted declaration and connection configuration. It returns an opaque `revision` for conditional changes. Example of an **administrative** representation:

```json
{
  "contractVersion": "1.0",
  "productId": "nox-example",
  "revision": "reg-7c42",
  "declaration": {
    "contractVersion": "1.0",
    "productId": "nox-example",
    "productVersion": "1.0.0",
    "displayName": "NoX Example",
    "capabilities": { "suiteMcp": { "path": "/mcp" } }
  },
  "connection": { "baseUrl": "http://example:8080" },
  "managedBy": { "productId": "nox-yard", "deploymentId": "project-42" }
}
```

`managedBy` is optional: it associates a Yard deployment with a product already defined by `productId`; it is not another product hierarchy. The deployment ID is an opaque Yard reference, not a Docker-specific schema. Administratively configured foundation products can omit it.

Proposed revision semantics:

- Revision changes on accepted material changes to declaration, connection, or management association, not on every probe or repeated identical update.
- It is opaque and never reused, including after removal and re-enrollment. Do not compare its spelling, increment it client-side, or treat it as a tool fingerprint.
- Membership and accepted configuration are durably committed together. Gateway reachability is not a prerequisite for retaining membership.
- Secret service credentials are stored separately and are never returned in this representation. The Gateway Contract will define how authorized components obtain/use them.
- Non-admin views expose only permitted product identity, labels, and summarized availability. They do not expose internal addresses, deployment details, diagnostics, or credentials by default.

Do not require the current MCP discovery `serverId` to equal `productId`. The Gateway must detect a changed discovery identity and invalidate the relevant cache under the existing discovery rules. Enrollment does not rewrite that identity.

## 5. Proposed management operations

Use an authenticated Backend management API, separate from standard MCP tool discovery. The SDK defines portable payloads and validation; Backend adapters own HTTP routes, persistence, and transactions.

| Operation | Proposed Backend route | Preconditions and result |
| --- | --- | --- |
| Read registry | `GET /api/nox/products` | Authorized, role-filtered view; complete list initially, with a consistent registry revision |
| Read registration | `GET /api/nox/products/{productId}` | Authorized representation and its revision |
| Create | `PUT /api/nox/products/{productId}` | `If-None-Match: *`; authorized admin/Yard enrollment; `201` after durable acceptance |
| Update | Same `PUT` route | `If-Match: "<revision>"`; `200` on accepted update or identical configuration |
| Remove | `DELETE /api/nox/products/{productId}` | `If-Match: "<revision>"`; explicit authorized removal; `204` after durable removal |

The read-list `registryRevision` is an opaque Backend token changed by registration changes. Availability has separate observations. It is not a JCS hash and must not be confused with an MCP discovery snapshot. Notification delivery and incremental registry reads will be defined with the Gateway; a second incremental tool-discovery protocol is unnecessary.

Administrative reads of a single registration return a strong `ETag` containing its quoted revision, using a stable representation without live observations. Filtered user views must not reuse that validator for different content. Successful PUT responses return the accepted record/revision in JSON, without `ETag` or `Last-Modified`, because enrollment enriches the submitted configuration. These conditional/validator rules follow [HTTP Semantics, RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-conditional-requests); the missing-precondition status follows [RFC 6585, section 3](https://www.rfc-editor.org/rfc/rfc6585.html#section-3).

Create/update body:

```json
{
  "contractVersion": "1.0",
  "baseUrl": "http://example:8080",
  "managedBy": { "productId": "nox-yard", "deploymentId": "project-42" }
}
```

The Backend fetches and validates the declaration; caller-supplied labels or identity claims do not replace verification. The route identifier must match the verified product. Updating accepted metadata requires another verified read; no automatic trust is granted by version comparison.

`managedBy` must match the authenticated Yard service and a deployment it is authorized to enroll; it is not a caller-controlled assertion of ownership. The administrative foundation path is separately authorized. Bound request/response size, fetch duration, redirects, and concurrent verification work in the service adapters; no unbounded network fetch is implied by the contract.

All mutations require an `Idempotency-Key`, scoped to the authenticated service/account and operation. Propose retaining outcomes for at least **24 hours**, durably across Backend restart:

- Same key, target, preconditions, and body returns the original committed outcome without a second mutation. Recognize a valid replay before rejecting its now-stale revision.
- The same key with different request contents returns a conflict. Store the accepted declaration/outcome; do not refetch and accidentally reinterpret an already committed retry.
- Recheck current caller authorization before returning a replay. An idempotency entry is not a reusable permission grant.
- Preserve removal outcomes for that window so a lost response can be resolved. An old removal request must never remove a newly enrolled registration.
- After the retention window, clients reconcile by reading current registration and obtaining fresh intent/preconditions; they do not blindly replay an uncertain operation. Do not promise indefinite exactly-once execution.

Membership commit and idempotency outcome must share a transaction. Concurrent requests for the same product/key cannot both create independent outcomes.

Only administrators and explicitly authorized service operations may mutate the registry. Do not hand Yard a user's persistent personal API key or an unrestricted admin session by default. Service credential format, provisioning, revocation, and permitted operations are decided in the Gateway Contract before this path can be implemented securely.

## 6. End-to-end flows

### Installation and initial discovery

1. An administrator deploys an integration-capable product through Yard.
2. Yard waits for its application bootstrap endpoint to answer; container existence alone is insufficient.
3. Yard requests enrollment with the approved address, deployment association, and a fresh idempotency key.
4. Backend validates the caller, network target, contract, identity/deployment association, and service trust setup. No client-supplied permission bypass is accepted.
5. Backend atomically commits the registration and outcome, then makes its new registry revision observable. If verification fails, deployment can remain installed but is reported as **not integrated**.
6. Gateway learns the accepted record, establishes the protected MCP connection, and performs standard discovery or optional `nox/discovery` negotiation. It reports effective readiness separately.
7. CLI can display the registered product and its current availability. Tools become usable only after authorization and effective MCP readiness.

NoX support is absent or the bootstrap endpoint returns 404: Yard completes ordinary installation without registration. A malformed declaration from a product claiming integration produces a visible integration failure; it is not reported as successful integration or silently mistaken for an ordinary app.

Creating the same container manually does not initiate these steps. Administrators configure foundation associations explicitly; extending manual enrollment to other products is not required for this first version.

### Update, restart, and recreate

Yard reports the intended lifecycle operation before disruption when possible. Registration remains. Gateway marks unavailable/unknown according to observations and refuses execution when it cannot reach the product. Neither component executes cached definitions against an unverified replacement endpoint.

After recovery, Gateway verifies effective MCP readiness and resynchronizes discovery using existing fingerprints/snapshots. A tool-only change does not require a registry update. Changed declaration/address requires a verified conditional update. An incompatible integration contract preserves the last accepted record but blocks the incompatible integration until resolved.

### Explicit removal

Yard confirms successful removal of the associated deployment, then requests conditional registry removal. Failed Docker removal does not imply deregistration. A failed Backend removal leaves a visible pending cleanup operation for retry/reconciliation; it must not be described as completed integration cleanup.

After Backend removal, Gateway stops accepting new calls for that registration, invalidates its routing/cache association, and informs connected consumers through the mechanism to be defined. Portal removes its contribution when implemented. Existing in-flight operations may already have external effects: cancellation/rollback is not guaranteed.

An administrator can explicitly remove a registration without deleting application data. This is distinct from Yard uninstall and must be presented as such. A delayed uninstall from an old deployment cannot remove a replacement: require both the matching association and revision.

## 7. Availability and lifecycle observations

Keep source observations separate instead of letting the last message overwrite a single authoritative `online` flag.

| Source | Proposed values | Meaning |
| --- | --- | --- |
| Yard lifecycle | `starting`, `running`, `stopping`, `stopped`, `restarting`, `recreating`, `updating`, `unknown` | Deployment state/intent, not MCP readiness |
| Gateway MCP observation | `ready`, `unreachable`, `notReady`, `incompatible`, `unknown` | Effective MCP connection/protocol state, not membership |

Each observation carries its source, product/deployment association, observation time, and a source-local increasing sequence. The producer persists its sequence; a lost/reset sequence requires explicit re-association and reconciliation rather than accepting arbitrary older events. Timestamps explain age, but clock ordering does not resolve conflicts between sources.

Backend rejects updates from the wrong producer/association and ignores duplicate or older sequences. Stale observations become `unknown` according to an operational freshness policy, never automatic registration removal. Exact event transport, sequence wire format, frequency, and freshness thresholds remain Gateway design work; these semantics are requirements for that design.

If Yard disappears, its management observation becomes unknown; a fresh Gateway `ready` observation can still permit calls. If Gateway disappears, Backend cannot claim fresh MCP readiness. If reports disagree, retain both and show the known operation alongside observed readiness; do not fabricate certainty. A fresh failed MCP connection blocks execution regardless of a `running` container report.

Registry deletion is an explicit management mutation, never a heartbeat expiry or unauthenticated lifecycle event. Removing a product is propagated with a revision/tombstone mechanism to be specified with registry notifications so missed events cannot resurrect it.

## 8. Error and compatibility rules

Propose a management error body independent of tool errors and JSON-RPC:

```json
{
  "error": {
    "code": "REGISTRATION_CONFLICT",
    "message": "The product is already registered.",
    "retryable": false
  }
}
```

| Situation | Proposed HTTP | Proposed code / action |
| --- | --- | --- |
| Malformed body, identifier, or address | 400 | `INVALID_REGISTRATION` |
| Missing/invalid caller credentials | 401 | `UNAUTHENTICATED` |
| Caller lacks permission or target violates policy | 403 | `FORBIDDEN` |
| Registration absent on an authorized read/update | 404 | `PRODUCT_NOT_REGISTERED` |
| Unsupported integration version/required feature | 422 | `UNSUPPORTED_INTEGRATION` |
| Existing enrollment, identity mismatch, or reused key with different contents | 409 | `REGISTRATION_CONFLICT` |
| Missing conditional header | 428 | `PRECONDITION_REQUIRED` |
| Stale update/removal revision, or failed create precondition | 412 | `REGISTRATION_PRECONDITION_FAILED`; read/reconcile |
| Product unreachable during verification | 503 | `PRODUCT_UNREACHABLE`; retryable, with bounded retries |
| Required Backend dependency temporarily unavailable | 503 | `INTEGRATION_UNAVAILABLE`; no false success |

For create, a matching existing identity/deployment still fails `If-None-Match` with 412 unless it is a recognized idempotent replay. The 409 enrollment conflict covers attempts to replace a different verified identity/association rather than a simple failed conditional write.

Authentication and permission checks precede disclosure of registry/target details. Invalid product declarations are `INVALID_REGISTRATION`; do not confuse them with an unreachable endpoint. Backend failures after an uncertain commit require reconciliation with the same key; `retryable` alone does not authorize issuing a new mutation.

These statuses/codes do not change `error.schema.json`, MCP `isError` results, or JSON-RPC negotiation codes. No new registration calls are inserted into standard `tools/list` or `tools/call`.

Existing products and SDK consumers continue working unchanged before migration. An absent declaration means no automatic Suite integration, not a broken legacy MCP server. Suite and direct MCP share product executors, with independent exposure/authentication: disabling direct MCP cannot disable the authorized Suite endpoint.

## 9. SDK implementation after approval

| Area | Planned work; no implementation in this proposal |
| --- | --- |
| `contracts/` | Separate product declaration, registration request/record, and management error schemas; shared integration corpus |
| `scripts/sync-contracts.mjs` | Generate/package native copies and TypeScript validators without repurposing existing schemas |
| `typescript/src/`, `go/`, `rust/src/` | Additive portable types, complete-document loaders/validators, URL rules, and management contract helpers; names reviewed before publication |
| Shared conformance runners | Compare normalized accepted documents, errors, optional/unknown field preservation, and address validation |
| Existing packaging/CI | Ship schemas in external native packages without Node; retain all supported blocking jobs |
| Documentation | Final contract reference, migration/integration examples, explicit support boundaries |

The SDK does not persist the registry, run Docker, decide Google account approval, probe products on a background timer, render menus, load Portal code, or embed Backend-specific HTTP handlers. Backend/Yard/Gateway adapters implement those actions against the approved contracts.

## 10. Acceptance and approval gates

Shared TypeScript/Go/Rust contract tests must cover:

- Minimal valid declaration, empty capabilities, unknown optional fields, missing fields, invalid types/nulls, unsupported contract versions and required features.
- Identifier/path/URL boundaries, Unicode length behavior, traversal/encoding cases, invalid origins, and identical endpoint resolution.
- Distinct product identity, registration revision, MCP `serverId`, discovery view, catalog, and tool fingerprints.
- Full preservation without inserting defaults, coercing types, or dropping optional/custom fields.
- Existing manifest, CLI metadata, discovery, authorization, error, stdio/HTTP JSON, and packaging regression suites. Go SSE remains Investigating.

Real integration tests, once service adapters exist, must cover:

- Authorized deployment → verified enrollment → MCP discovery → allowed call, including direct MCP disabled.
- Untrusted/self-announced product, forbidden target, unauthorized enrollment, and rejected service impersonation.
- Admin/non-admin catalog and execution behavior, including write/sensitive-read rejection and revoked credentials. Precise capability representation belongs to the next contract.
- Concurrent creates, stale revisions, retries after lost responses, restart-persistent idempotency, mismatched-key reuse, and removal/re-enrollment with a delayed old request.
- Installation without integration, partial registration failures, update/recreate with retained identity, offline recovery without duplicate enrollment, and failed removal cleanup.
- Duplicated/out-of-order lifecycle events, stale observations, readiness separate from container state, and continued product access while Yard is stopped.
- Prepared account/API key operation without Internet after restart; native application operation without Suite services; no Portal dependency.

Fixtures can validate SDK behavior first. They do not certify real products; consumer changes and real integration tests require their own authorized scope.

Before implementation, approve these concrete choices:

1. Separate version-1.0 product declaration; stable `productId`; optional `suiteMcp`; no tool duplication or Portal loader specification.
2. Product bootstrap at `/nox/integration` and an origin-only configured address for the initial host deployment model.
3. Backend management operations above, conditional revisions, durable idempotency with a minimum 24-hour retention, and role-filtered read representations.
4. Yard association and observation semantics; registration survives outages and only explicit removal deletes membership.
5. Additive SDK schemas/helpers in all three languages, followed by separately scoped service adapters.

Then complete the **Gateway Contract** before coding enrollment/execution trust: service credential provisioning, verifiable delegated user capabilities, normal-read/write/sensitive-read classification (including argument-dependent cases), revocation, registry propagation, routing, cache isolation, and behavior during Backend outage. None of those is implicitly resolved by this proposal or by MCP annotations.

Approval produces a design baseline for those remaining flows, not a release, version change, or automatic migration of existing applications.
