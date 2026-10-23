> **Archived historical document.** The versions, results, and status statements below apply to the revisions described. See the [current documentation](../README.md).

# NoX MCP — Compatibility baseline

Date: October 20, 2026. Scope: local code analysis without changes to implementations, dependencies, schemas, or configuration.

Later authorized update: the specific identity integration was removed from the SDK. References to that API have been removed below; remaining observations and versions are historical, not current requirements. Consult README.md and COMPATIBILITY_AUDIT.md for the current state.

## 1. Conclusion and audit scope

NoX MCP already supplies infrastructure used by four products: tool registration and discovery, validation, structured results, execution controls, and transport integration. NoteX also depends on desktop bridges and Rust brokers. **Compatibility to preserve includes these behaviors, import paths, and product-specific integrations; it is not limited to JSON schemas.**

There is a useful foundation for studying new contracts, but no uniform compatibility guarantee across languages and versions yet. NoteX uses different versions, manifest handling has actual differences, and critical paths have uneven coverage. Passing library tests alone cannot establish that updating all consumers together would be safe.

The following repository working trees were reviewed, initially without changes reported by `git status`:

| Local repository | Reviewed commit |
| --- | --- |
| `nox-mcp` | `f19da3383dba682d8bfb9a613918786a4d6cb3e9` (`v0.4.3`) |
| `nox-backend` | `c5d945155b6a12130daba62b8534ab0f7129eeb0` |
| `nox-yard` | `253fff86e24e8056b9adccdd48e174b9d9b2ff28` |
| `notex` | `ce80f24395d4ca562449eb1f1bea47b7bcd46d67` |
| `nox-bot` | `fc1d4743c4785fdc160a4465526da3515a4932b6` |

The direct-reference search covered tracked files in 30 repositories under `D:/Projects_2`, including these five. No other direct consumers were identified in searchable files, including `nox-sync`, `nox-mobile`, `nox-AI`, `nox-bookmarks`, and `notex_OLD`. This does not exclude remote consumers, indirect dependencies, or untracked files. In `metro-motion`, two working-tree files (`packages/shared-types/package.json` and `packages/shared-utils/package.json`) returned permission errors; searching manifests/lockfiles in its `HEAD` found no references. All four requested consumers were accessible.

Production installations were not consulted and running versions were not confirmed. Versions below are those declared/resolved in local code. Remote branches or registries were not queried to infer newer versions.

## 2. Current architecture

The repository is a multi-language library without a central cross-product routing service:

- `contracts/`: six JSON Schema draft-07 schemas and a defaults file.
- `typescript/`: ESM package `@nox/mcp`, with Zod-based tools, MCP server, HTTP, Node integration, application-supplied authorization context, and WebSocket bridge client/server.
- `go/`: package `github.com/mapherez/nox-mcp/go`, with tool runtime, HTTP/stdio, Bearer/JWT authorization, frame validation, and WebSocket bridge client.
- `rust/`: `nox-mcp` crate, with an `rmcp`-based server, tool loading, results, validation, renderer broker, and generation-based execution registry. NoteX assembles its own concrete HTTP transport and WebSocket connection.
- `scripts/` and `.github/workflows/release.yml`: version synchronization, tests, package validation, and tag-triggered publication.

The six schemas in `contracts/`, `go/contracts/`, and `rust/contracts/` are currently identical. TypeScript defaults and `contracts/defaults.json` are semantically equal; Go and Rust maintain their own constants for some values. No dedicated test was found to prevent these copies from drifting.

Implementations share concepts but **do not expose fully equivalent APIs or validation mechanisms**. The library's own infrastructure centers on tools; there are no shared contracts for menus, workflows, pages, or Portal modules. TypeScript `GatewayOptions`/`installBridgeServer` refer to the existing desktop bridge, not the future NoX MCP Gateway.

## 3. Public API to preserve

### TypeScript / Node.js

The [package.json](../../package.json) `exports` map is part of the installation contract. There is no public `@nox/mcp/http` entry point or CommonJS `require` export.

| Public entry point | Exposed API |
| --- | --- |
| `@nox/mcp` | `createServer`, `createHttpHandler`; types `ExecutionContext`, `ToolDefinition`, `ServerOptions`, `HttpHandlerOptions`; `contract` re-exports |
| `@nox/mcp/contract` | `defaults`; constants `BRIDGE_PROTOCOL_VERSION`, `LEGACY_BRIDGE_PROTOCOL_VERSION`, `BRIDGE_REQUEST_TIMEOUT_MS`, `BRIDGE_HEARTBEAT_INTERVAL_MS`, `BRIDGE_OFFLINE_AFTER_MS`, `BRIDGE_TICKET_TTL_SECONDS`, `MAX_BRIDGE_FRAME_BYTES`, `MAX_IN_FLIGHT_REQUESTS`; `bridgeDeliveryPolicy`; `McpError`/`McpErrorBody`; schemas and functions below |
| `@nox/mcp/bridge` | `BridgeRegistry`; interfaces `BridgeSocket`, `SessionStore`, `BridgeConnection`, `BridgeOptions` |
| `@nox/mcp/bridge/client` | `connectBridge`, `BridgeClientOptions`; returns an object with asynchronous `close()` |
| `@nox/mcp/bridge/server` | `installBridgeServer`, `closeSocket`, `GatewayOptions`, `GatewayLogger`; installation returns an asynchronous shutdown function |
| `@nox/mcp/node` | SDK re-exports `toNodeHandler` and `serveStdio` |

Public members of `contract` include `bridgeErrorSchema`, `bridgeTicketSchema`, `bridgeAuthenticateSchema`, `bridgeReadySchema`, `bridgeRequestSchema`, `bridgeCancelSchema`, `bridgeResponseSchema`, `serverBridgeMessageSchema`, `desktopBridgeMessageSchema`, `toolManifestSchema`, `createResponseSchema`, `parseFrame`, and types `BridgeRequest`, `BridgeResponse`, `BridgeFrame`, `ToolManifestEntry`, `ToolManifest`.

`ToolDefinition` accepts name, optional title, description, arbitrary `_meta`, input/output Zod schemas, scopes, annotations, and `execute`. Context provides `requestId`, `appId`, `userId`, scopes, ISO deadline, and `AbortSignal`. `ServerOptions` configures identity, tools, authentication, limits, and `formatError`. `createServer` returns the SDK `McpServer` directly, exposing that dependency to consumers as well.

`BridgeRegistry` is extensible: NoteX subclasses it. Public methods are `issueTicket`, `consumeTicket`, `attach`, `markReady`, `markPong`, `getPresence`, `dispatch`, `acceptResponse`, `detach`, `revokeUserConnection`, `closeStaleConnections`, and `close`. Integration also includes callbacks for sessions, input/output validation, read classification, response schema, and error factory. Public `BridgeConnection` fields include identity, socket, state, version, generation, heartbeat, and pending requests.

Sources: [index.ts](../../typescript/src/index.ts), [contract.ts](../../typescript/src/contract.ts), [http.ts](../../typescript/src/http.ts), [bridge.ts](../../typescript/src/bridge.ts), [bridge-client.ts](../../typescript/src/bridge-client.ts), [bridge-server.ts](../../typescript/src/bridge-server.ts).

### Go

| Public API | Current contract |
| --- | --- |
| `Error` | `Code`, `Message`, `Retryable`, `Details`, and `Error()` method; JSON serialization with camelCase names |
| `Tool`, `Options`, `New` | `*jsonschema.Schema` schemas, `Meta` metadata, scopes, `ReadOnly`/`Destructive`/`Idempotent` flags, executor, and limits |
| `Runtime` | Public `Server *mcp.Server` field; `Execute`, `HTTPHandler`, `ServeStdio` methods |
| `ExecutionContext` | Embeds `context.Context`; exposes `RequestID`, `AppID`, `UserID`, `Scopes`, `DeadlineAt`, and `CheckActive()` |
| `Protect`, `JWTVerifier` | Authentication adapters; depend on SDK types and `jwt.Keyfunc` |
| `Contracts`, `ValidateFrame`, `ValidateFrameWithLimit` | Embedded schemas and named validation (`desktop`, `error`, `manifest`, `request`, `response`, `server`) |
| `BridgeOptions`, `RunBridge` | Single-connection WebSocket client with application-supplied runtime and identity |
| `CredentialStore[T]` | `Load`, `Save`, `Delete` with `context.Context`; concrete storage belongs to the product |
| Constants | `BridgeProtocolVersion`, `DefaultTimeoutMS`, `MaxPayloadBytes`, `MaxInFlightRequests` |

Executors accept/return `map[string]any`. `Execute` supports direct execution without transport; HTTP adds the MCP envelope. Go exposes neither a server connection registry equivalent to `BridgeRegistry` nor a function equivalent to Rust `load_tools` here.

Sources: [nox.go](../../go/nox.go), [contracts.go](../../go/contracts.go), [jwt.go](../../go/jwt.go), [bridge.go](../../go/bridge.go), [defaults.go](../../go/defaults.go).

### Rust

| Public API | Current contract |
| --- | --- |
| `RequestEvent` | `request_id`, `command`, `input`, `deadline_at`, `generation`; camelCase serialization |
| `BrokerError`, `BrokerOptions`, `RequestBroker<T>` | Errors `InvalidRequest`, `Overloaded`, `RendererUnavailable`, `Timeout`, `Cancelled`, `UnknownRequest`; methods `new`, `is_pending`, `dispatch`, `respond`, `cancel`, `cancel_all` |
| `ExecutionRegistry` | `default`, `with_limit`, `open`, `register`, `register_for`, `is_pending`, `cancel`, `clear`, `generation`; generation, duplicate, and deadline control |
| `now_ms`, `parse_deadline`, `validate_schema` | Millisecond time, RFC3339 parsing, and JSON Schema validation with formats |
| `load_tools` | JSON manifest to `Vec<rmcp::model::Tool>`; requires schema `1`, bridge protocol `2.0`, unique names, and object tool schemas |
| `tool_result`, `error_result` | Structured `CallToolResult` construction with JSON text copy |
| `ExecutionContext`, `ServerOptions`, `Executor` | Context with identity, scopes, numeric deadline, and `CancellationToken`; `is_active()`; required scopes configured by tool name |
| `McpServer<E>` | `new`, `ServerHandler` implementation; public `name`, `version`, `instructions`, `tools`, `executor` fields |
| `ServerFrame`, `parse_server_frame` | Frames received from the server; `into_request()` converts a request to `RequestEvent` |
| `CredentialStore<T>` | Trait with associated `Error` type and `load`, `save`, `delete` methods |
| Constants | `BRIDGE_PROTOCOL_VERSION`, `DEFAULT_TIMEOUT_MS`, `MAX_PAYLOAD_BYTES`, `MAX_IN_FLIGHT_REQUESTS` |

Source: [lib.rs](../../rust/src/lib.rs) and [defaults.rs](../../rust/src/defaults.rs). `Tool` and `CallToolResult` belong to `rmcp`; they are not SDK-independent contracts.

## 4. Existing behaviors and contracts

### Tools, results, and execution

- Preserve canonical names, input/output schemas, titles/descriptions, annotations, and discovered metadata. `_meta` is optional and arbitrary; all four products already use `_meta.cli` as an application-local command path. No versioned menu or workflow convention exists yet.
- Preserve `structuredContent` and equivalent JSON text content. Tool errors use `isError` and a structured body; transport HTTP/JSON-RPC errors are a different boundary.
- The base error has `code`, `message`, `retryable`, and optional `details`. Codes are extensible, not a closed library enum. Products add codes and, in NoteX, `currentVersion` through their own schemas/callbacks.
- Preserve input/output validation, refusal to execute without required scopes, payload and concurrency limits, timeout, cancellation, and internal-error sanitization. These controls do not replace product domain authorization.
- Timeout/cancellation do not guarantee rollback. In ordinary early-termination paths, writes may return `details.outcome = "unknown"`, while reads may be retryable. Executors remain responsible for checking activity before effects after asynchronous work.
- TypeScript and Go retain execution capacity until executor work ends, even after a client receives a timeout. In Rust, timeout/cancellation stops waiting for the future; product-spawned detached tasks still require their own handling.
- Execution identifiers have no single cross-language format: UUID in TypeScript, hexadecimal in the Go runtime, and `nox-N` in the Rust server. Mandatory UUID format in bridge frames is a separate contract.

### Desktop bridge and defaults

| Value | Baseline |
| --- | --- |
| Current / legacy bridge protocol | `2.0` / `1.0` |
| Manifest schema version | `1` |
| Request timeout | 20 000 ms |
| Heartbeat / offline state | 15 000 ms / 45 000 ms |
| Ticket validity | 30 seconds |
| Payload / simultaneous requests | 2 097 152 bytes / 32 |

Desktop frames: `authenticate`, `ready`, `response`. Server frames: `authenticated`, `request`, `cancel`, `session_revoked`. Requests carry `requestId`, `command`, `input`, `deadlineAt`; responses distinguish `ok: true/result` from `ok: false/error`. Tickets are 32–512 characters long using the base64url alphabet. UUID, UTF-8, size, and deadline are validated at their respective boundaries.

The declared TypeScript policy is no queue, no replay, fail pending requests on disconnect, and single-use tickets. A new connection replaces the user's previous connection. Remote cancellation is sent only to protocol `2.0` connections; the registry also accepts `1.0`. Session revocation, heartbeat, and late responses must not reactivate old work. TypeScript/Go bridge clients require `wss`, allowing `ws` on loopback.

**Do not confuse the two uses of `RequestEvent`:** the local Rust broker generates prefixed IDs and `deadlineAt` as a millisecond string; WebSocket frames require UUID and RFC3339 time. NoteX's renderer accepts both. Unifying formats without accounting for consumers would break local integration.

### HTTP and authentication

TypeScript `0.4.3` HTTP is stateless, with JSON by default and optional SSE. It supports legacy (`initialize`, `tools/list`, `tools/call`) and modern (`server/discover` and tool calls) flows. Legacy initialization notifications receive an empty `202`; GET/DELETE receive `405`. Negotiation respects `Accept`, including `q=0` exclusions; incompatible requests receive `406` before tool execution. Modern subscriptions still use SSE. JSON does not deliver intermediate notifications. The handler exposes `fetch`, `notify`, `bus`, and `close`; disconnect/shutdown cancels active work and settles pending exchanges.

TypeScript HTTP bodies have a separate 4 MiB bound; `maxPayloadBytes` limits tool input and response. The envelope duplicates results in text and structure, so domain-object size does not directly equal final response size. Go uses stateless HTTP with `JSONResponse: true`, bounds the body by the configured value, and advertises MCP protocols `2025-11-25` and `2026-07-28`. NoteX configures Rust HTTP in the product itself.

`Protect` requires active authorization checks per request in addition to token validity. `JWTVerifier` requires issuer, audience, expiry, and subject, with RS256/ES256/EdDSA algorithms and application-trusted key resolution. These adapters are not a universal API-key mechanism: Backend, Yard, NoteX, and Bot have different boundaries described below. The specific TypeScript identity integration originally identified has since been removed from the SDK.

Limits belong to runtime/server instances. In particular, the TypeScript HTTP factory creates servers for requests; `maxInFlightRequests` must not be interpreted as an automatic global service quota. Yard adds its own global HTTP limit.

## 5. Consumers and effective versions in code

| Product / component | Language | Declared dependency and local resolution |
| --- | --- | --- |
| NoX Backend, `backend/` | Go | `github.com/mapherez/nox-mcp v0.4.3`, confirmed in `go.mod`/`go.sum`; no local `replace` |
| NoX Yard | Go | Same module `v0.4.3`, confirmed in `go.mod`/`go.sum`; no local `replace` |
| NoX Bot | TypeScript | GitHub Release tarball `v0.4.3`; lockfile resolves `@nox/mcp 0.4.3` |
| NoteX, root | TypeScript | Tarball `v0.4.3`; lockfile resolves `node_modules/@nox/mcp` to `0.4.3` |
| NoteX, `backend/` | TypeScript | Tarball `v0.4.1`; lockfile retains `backend/node_modules/@nox/mcp 0.4.1` |
| NoteX, `packages/notex-mcp-contract/` | TypeScript | Tarball `v0.4.1`; lockfile retains a `0.4.1` copy in this workspace |
| NoteX, `src-tauri/` | Rust | Git dependency without tag/rev in the manifest; lockfile pins `fd1b688d700b37caf96961c15f6d7022a09ab7a4`, with internal crate version `0.1.0` |

Updating NoteX's root dependency alone does not necessarily update its backend or contract package. `scripts/update-nox-mcp.mjs` searches declarations across workspaces; manifests currently remain mixed. Cargo resolves the Rust dependency separately.

### NoX Backend

[mcp.go](../../../nox-backend/backend/internal/app/mcp.go) imports the Go package and uses `New`, `Tool`, `Options`, `Runtime.HTTPHandler`, `ExecutionContext.CheckActive`, and `Error`. It builds schemas from the same Go types used in execution. It exposes ten tools: health, information, identity, six vault operations, and file listing. It assigns `_meta.cli` to all and rejects missing/duplicate mappings.

The `/mcp` endpoint uses default limits. Health and information are public; other operations resolve the API key through Backend code and carry the user/error in a private context. They do not use library `Protect`/`JWTVerifier`. Structured `AUTH_REQUIRED`/`AUTH_FAILED` errors, owner authorization, and domain codes must remain instead of a global OAuth requirement for the whole catalog. Result conversion preserves `int64` revisions/sizes without `float64` rounding.

### NoX Yard

[server.go](../../../nox-yard/internal/mcpapi/server.go) uses `Tool`, `New`, `Runtime`, `Error`, and Go context to adapt the application facade. It exposes inventory, configuration, container/project, Compose, removal, job, and update tools with `_meta.cli` and explicit annotations. Its own limits are **60 seconds, 8 MiB, and 32 executions**.

Authentication is in [machine.go](../../../nox-yard/internal/httpapi/machine.go): a dedicated MCP listener, `/mcp`, disabled by default, with a machine Bearer token or explicitly configured anonymous mode. A supplied invalid credential never falls back to anonymous. `Write`/`Secrets` policies filter discovery and are rechecked during execution. `NewHandler` prepares four catalogs and adds a global 32-request HTTP limit. Describing the current endpoint as always enabled and anonymous would be incorrect.

Preserve facade errors and partial results, target identifiers, destructive-operation confirmations/fingerprints, job tracking, and the update tool's legacy `intervalMinutes` field. A timeout does not confirm a mutation's outcome.

### NoteX

The [MCP backend](../../../notex/backend/src/mcp.ts) uses `createHttpHandler`, `resolveAuth`, `requiredScopes`, and `formatError`. In the historical audit, a specific identity integration protected MCP and the desktop API with active authorization checks; that integration is no longer part of the SDK. Scopes are `notex:read`, `notex:create`, `notex:edit`, and `notex:delete`; identity is passed through `authInfo.extra.userId`. This revision neither changed nor reinspected that product.

The [bridge registry](../../../notex/backend/src/bridge/registry.ts) subclasses `BridgeRegistry`, supplies custom schemas/errors, and adapts offline presence in `notex_status`. [WebSocket installation](../../../notex/backend/src/bridge/server.ts) supplies its own `parseDesktopFrame`. Sessions, tickets, revocation, and connection replacement are part of the actual integration.

The [NoteX contract package](../../../notex/packages/notex-mcp-contract/src/index.ts) imports constants, defaults, `createResponseSchema`, ticket, and `parseFrame`; it defines 34 tools, CLI aliases, domain schemas, and its own manifest. The backend converts these definitions into TypeScript tools; desktop loads the manifest through Rust `load_tools`.

On desktop, [mcp_local_server.rs](../../../notex/src-tauri/src/mcp_local_server.rs) implements `Executor`, creates `McpServer`, and mounts stateless HTTP JSON on loopback. [mcp_request_broker.rs](../../../notex/src-tauri/src/mcp_request_broker.rs) uses `RequestBroker<DesktopResponse>` with prefix `local-mcp-`. [mcp_bridge.rs](../../../notex/src-tauri/src/mcp_bridge.rs) implements credential storage and uses `ExecutionRegistry`, `ServerFrame`, `parse_server_frame`, and `parse_deadline`. The renderer checks numeric or ISO deadlines and request activity before mutations.

Preserve `expectedVersion`, `currentVersion`, conflicts, pending local edits, offline error translation, and separation of local/remote operations. NoteX maps `APP_OFFLINE`/`CANCELLED` to `NOTEX_OFFLINE`; its custom errors do not preserve every base error `details` field. This is an existing difference, not a uniform guarantee of uncertain-outcome information.

### NoX Bot

[mcp.ts](../../../nox-bot/src/services/mcp.ts) uses `ToolDefinition`, `ExecutionContext`, `McpError`, and `toNodeHandler`. It exposes 14 tools for status, guild, channels, messaging, plugins, and Quick Commands. All have `_meta.cli`; inputs use strict Zod objects. Domain errors are adapted by `formatError`, including `WRITE_UNCONFIRMED` with unknown outcome.

The `/mcp/guilds/:guildId` endpoint is mounted on the dashboard listener without its own authentication. Execution is tied to the URL's guild and revalidates installation and relevant permissions. Preserve revisions, guild isolation, secret redaction, cancellation before sending messages, and shutdown that waits for accepted operations.

Despite already depending on `0.4.3`, [mcpHttp.ts](../../../nox-bot/src/services/mcpHttp.ts) retains the legacy-client HTTP adapter created for `0.4.1`: it combines `createServer` with the SDK JSON transport and delegates modern requests to the library handler. Updating the version therefore did not eliminate this second negotiation/cancellation implementation. It was not removed in this audit.

### Relevant external dependencies

| Component | Relevant requirements / resolved versions |
| --- | --- |
| TypeScript library | Node `>=24`; TypeScript `5.9.3`; server/client SDK `2.3.1`, Node adapter `2.1.1`, Zod `4.6.5`, `ws 8.22.0` in the lockfile |
| TypeScript peers | Required Zod `^4.6.0`; Node SDK `^2.0.0`, `ws ^8.19.0` optional in the package but needed for their adapters |
| Go | Library/Backend require Go `1.26.0`; Yard requires `1.26.9`. All three declare Go SDK `1.8.0` and `jsonschema-go 0.4.3`; the library also uses `coder/websocket 1.8.15` and JWT `5.3.1` |
| Rust | Minimum Rust `1.88`, edition 2021; `rmcp = "3.0"` resolves to `3.5.0` in the library lockfile and `3.2.0` in NoteX; library `jsonschema` resolves to `0.58.5` |
| NoteX TypeScript | Lockfile contains server SDK `2.0.0` in backend and `2.3.1` at root; Node adapter `2.0.0`, Zod `4.6.5`, `ws 8.21.3` |
| Bot TypeScript | Node `>=24 <25`; server/client SDK `2.3.1`, Node adapter `2.0.0`, Zod `4.6.0` in the lockfile |

Version sources: manifests and lockfiles of the five repositories. SDKs and validators cross public API boundaries; upgrades may affect types, serialization, and transports without changing NoX function names.

TypeScript is distributed as the `nox-mcp.tgz` GitHub Release asset; the package is marked `private`. Rust has `publish = false`; Go resolves root-module tags. Preserve these paths, compiled contents, and tarball type declarations. Package version, manifest schema version, bridge protocol, and MCP protocol are separate version axes.

## 6. Confirmed differences and issues

1. **Mixed NoteX versioning.** Confirmed by manifests and lockfiles, including Rust `0.1.0` at an older commit. This alone does not mean the product is broken; it means `0.4.3` does not describe every component.
2. **Manifest metadata lacks parity.** TypeScript `ToolDefinition` and Go `Tool.Meta` preserve `_meta` during direct registration; current Rust preserves it in `load_tools`. However, library TypeScript `ToolManifestEntry`/`toolManifestSchema` do not declare `_meta`: an in-memory analysis confirmed the parser strips it. The manifest JSON Schema does not declare it but allows additional properties. In NoteX's pinned Rust commit, `load_tools` also does not copy `_meta` into `Tool`; this difference was confirmed against local Git history. NoteX's own manifest already contains `_meta.cli`.
3. **Manifest scopes do not imply automatic authorization.** The shared schema accepts `scope` and `requiredScopes`; the Rust loader does not transfer them into `ServerOptions.required_scopes`. Remote NoteX enforces scopes in the backend. The same policy cannot be inferred for the local server solely from the manifest.
4. **Uneven manifest validation.** TypeScript accepts any non-empty `protocolVersion` within the limit and does not check duplicate names in the parser; Rust requires `2.0`, uniqueness, and object schemas. The TypeScript type requires all four annotation booleans, but its schema permits omission. JSON schemas allow additional fields; Zod objects may strip them during parsing.
5. **HTTP changes between versions.** Diff `v0.4.1..v0.4.3` confirms the new TypeScript handler with default JSON and optional SSE. Go implementations and Rust code do not change in that range except for the crate version. Clients depending on SSE/intermediate notifications need their own assessment; NoteX backend remains on `0.4.1`, and Bot retains a local adapter.
6. **Outdated documentation.** `nox-backend/docs/mcp.md` and `nox-bot/docs/mcp.md` still mention `0.4.1`; library README/`typescript/HTTP_VALIDATION.md` still describe the next release. Older Yard decisions also describe permanent anonymous access, contradicted by current configuration/authorization code. This baseline uses code, not those historical descriptions.
7. **Observed HTTP test instability.** On the first run, `json legacy disconnect and close cancel once without pending exchanges` received `TypeError` where it expected `AbortError`. All 20 HTTP tests passed on rerun. This is an observed intermittent failure with an unresolved cause; alone, it does not prove a reproducible product failure.

## 7. Tests and validation

### Checks executed during this audit

| Check | Result / limits |
| --- | --- |
| TypeScript `5.9.3`, real configuration, `noEmit` | No diagnostics; additional in-memory emission matches the 17 existing `dist` artifacts |
| TypeScript tool tests | 3/3 passed |
| TypeScript HTTP tests | First run: 19/20; rerun: 20/20. Node `24.21.0` through the available Node runner |
| Versioning/release tests | 11/11 passed using temporary test repositories |
| `go test -mod=readonly ./...` | Passed on Go `1.26.3`, without network access, after moving cache to an accessible temporary directory |
| `go test -mod=readonly -cover ./...` | Passed; **30.0% statement coverage** in the Go package |
| `cargo test --locked --offline --manifest-path rust/Cargo.toml` | 2 unit tests and 3 integration tests passed; build artifacts directed to a temporary directory |
| Contract consistency | Compared six schemas across all three locations; compared JSON defaults semantically |

`npm test` was not run directly because it emits files; existing tests were used and `dist` was validated without rebuilding. The package was not installed/repacked. Full consumer suites, real service calls, Docker/Discord, and external desktop-client tests were not run. Installed Go is below Yard's current requirement. Historical `HTTP_VALIDATION.md` results are prior evidence, not checks repeated in this audit.

### Existing coverage and gaps

| Area | Existing evidence | Relevant gaps |
| --- | --- | --- |
| TypeScript: tools/HTTP | `typescript/test/tools.test.mjs` and `http.test.mjs`: metadata, schemas, scopes, results, JSON/SSE, two MCP generations, negotiation, limits, timeout, cancellation, subscriptions, and shutdown | No configured coverage percentage; disconnect instability unresolved; cross-instance limits and long-running scenarios not demonstrated |
| TypeScript: bridge/authorization | No dedicated tests for these modules in the library repository | Expired/reused tickets, revocation, heartbeat, generations, bridge clients, and the now-retired identity integration depend mainly on product validation |
| Go | `go/nox_test.go`: metadata, in-memory discovery/calls, context, schemas, scopes, and previously cancelled context | 30.0% coverage; missing dedicated HTTP/stdio, `RunBridge`, frame schema, `Protect`/JWT, in-execution timeout, saturation, and invalid/oversized output tests |
| Rust | Two registry/broker tests and three metadata/call tests with in-memory transport | Missing systematic frame parser, invalid manifest, deadline, limit, server timeout/cancellation, generation, and overload tests; current tests demonstrate neither real HTTP nor cross-SDK parity |
| Cross-language contracts | Duplicated schemas currently equal | No shared corpus run in all three languages or automated verification of copies/defaults, unknown fields, scopes, or manifests with `_meta` |
| Release/distribution | Eleven script tests; `check-package.mjs` verifies package and installed HTTP consumer; workflow runs all three suites on `v*` tags | Installation verification not repeated in this audit; no separate PR/branch workflow in the repository; no automatic matrix with all four consumers and older versions |

Consumers have relevant tests that were inspected but not run here:

- Backend, `backend/internal/app/mcp_test.go`: catalog/CLI, authentication, ownership, vault lifecycle, shared HTTP/MCP state, sanitization, and `int64` preservation.
- Yard, `internal/mcpapi/*_test.go` and `internal/httpapi/machine_test.go`: catalog/annotations, permissions and secrets, token rotation, configuration, partial errors, jobs, and timeout with unknown outcome.
- NoteX, `backend/test/`: sessions/tickets, disconnect/reconnect without replay, real WebSocket, Origin, OAuth, and both MCP generations. There are contract, dispatcher/mutation, and Rust credential/frame/local-server tests. These do not replace a matrix against the current library because dependencies are pinned to different versions.
- Bot, `tests/mcp.test.mjs`: JSON in both generations, 14 tools and CLI, guild isolation, revisions, secrets, database failures, message-send cancellation, and shutdown. They also exercise the custom HTTP adapter.

## 8. Potential risks for Gateway, CLI, and Portal

These are evolution risks, not missing features implemented by this audit:

- **Routing and identity:** products do not share authentication mechanisms. Backend has public tools and per-tool errors; Yard has per-request policies; NoteX uses OAuth and desktop sessions; Bot ties authority to the URL's guild. A Gateway API key cannot be treated as already supported by all products.
- **Variable discovery:** Yard's catalog depends on permissions; presence/sessions affect NoteX; guild affects Bot. Caching a catalog without respecting context may reveal tools or route them incorrectly.
- **Names and navigation:** `_meta.cli` is established usage but not a versioned contract. Products share aliases such as `status` and `health` and use different canonical naming conventions. Existing tool schemas also do not guarantee a complete form/workflow UI.
- **Additional metadata:** old parsers may ignore or strip new fields. Adding a JSON property alone does not guarantee that it survives manifests, old libraries, and discovery through to CLI/Portal.
- **Transport and duration:** JSON/SSE, deadlines, disconnects, payload limits, and concurrency scope differ. Chaining requests through another service may exceed deadlines or repeat mutations with unknown outcomes.
- **Independent upgrades:** changing an SDK, runtime requirement, import path, public type, or release artifact may break consumers before any new contract is used. NoteX demonstrates coexistence of old and new versions.
- **Portal modules:** this repository has no page/component loading contract. No consumer Portal was audited; frontend module compatibility cannot be claimed at this stage.

## 9. Readiness for Step 2

The repository is ready to start design with a concrete baseline, but **the safety of a cross-cutting expansion or simultaneous product upgrade has not been demonstrated**. The README's alpha status does not remove existing dependencies.

Before proceeding, discuss:

1. Which library, SDK, and runtime versions will be supported, including NoteX's three version states and continued bridge protocol `1.0` support.
2. Which current behaviors/formats are mandatory across languages and which remain product-specific, including manifests, metadata, scopes, and errors.
3. How future discovery respects identity, permissions, availability, product, and guild without changing existing authorization boundaries.
4. The meaning of published `_meta.cli` and guarantees for preserving unknown fields in current consumers.
5. Expectations for JSON/SSE, notifications, cancellation, unknown outcomes, and limits in a routed operation.
6. Required regression validation for all four consumers, including the intermittent HTTP failure and poorly covered bridge/authorization paths.

This baseline neither defines new contracts nor proposes implementation changes. It records what exists and what must continue working when that design begins.
