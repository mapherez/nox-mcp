# NoX CLI metadata and incremental discovery

An optional extension for CLI metadata and incremental discovery. `tools/list` remains available to conventional MCP clients; the extension reuses existing transports.

## Compatibility and negotiation

`tools/list` continues returning complete MCP tools. `_meta.cli`, schemas, annotations, and custom metadata remain available to conventional clients. Advanced descriptors are separate documents: they are not inserted into `_meta` and do not duplicate schemas.

The extension is identified as `nox/discovery`, following the MCP `prefix/name` format. The server advertises it in `server/discover`:

```json
{
  "extensions": {
    "nox/discovery": { "versions": ["1.0"], "maxBatchSize": 64 }
  }
}
```

The methods are `nox/tools/catalog` and `nox/tools/definitions`, over the MCP transport already in use: stdio or Streamable HTTP. There is no additional REST endpoint.

The client queries `server/discover`, checks the extension, and selects `1.0`. Every extension request includes:

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {
      "extensions": { "nox/discovery": { "version": "1.0" } }
    }
  }
}
```

Capabilities are not inferred from an earlier request. Under MCP `2026-07-28`, both methods require `clientCapabilities.extensions["nox/discovery"].version: "1.0"`. If that capability is missing or advertises an incompatible version, they respond with JSON-RPC `-32021` (`MissingRequiredClientCapability`) and the following data:

```json
{"requiredCapabilities":{"extensions":{"nox/discovery":{"version":"1.0"}}}}
```

An incompatible extension version is not an incompatible protocol version. An unknown protocol produces `-32022`, with `data.requested` and `data.supported`. A missing required `io.modelcontextprotocol/clientCapabilities` field in the modern envelope is a malformed request (`-32602`); a valid capabilities object missing the required extension produces `-32021`.

For earlier protocols, or when the server does not advertise the extension, consumers use `tools/list` and conventional MCP caching. Attempting NoX methods under a legacy protocol retains the previous rejection (`EXTENSION_NOT_NEGOTIATED`); modern negotiation does not apply to legacy clients. Incremental helpers do not silently downgrade: consumers choose the path after discovery.

References: [MCP versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [MCP caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching), [JCS, RFC 8785](https://www.rfc-editor.org/rfc/rfc8785).

## Tools and descriptors

A simple tool only needs the existing contract:

```json
{
  "name": "item_get",
  "title": "Get item",
  "inputSchema": {
    "type": "object",
    "properties": { "id": { "type": "string", "title": "Identifier" } },
    "required": ["id"]
  },
  "annotations": { "readOnlyHint": true },
  "_meta": { "cli": "item show" }
}
```

Segments of `_meta.cli` define the navigation path. A node may have an action and subcommands. Types, titles, descriptions, required fields, enums, and hints come from the schema. `default` does not insert arguments automatically. `navigation` adjusts `label`, `group`, and `order`; shared group/product labels can be published once in the catalog's `presentation`. Presentation neither identifies servers nor grants authorization.

For a deletion operation, the tool schema defines `projectId`, `id`, `fingerprint`, and `confirm`; it may require `confirm: {"const": true}`. Its associated descriptor may be:

```json
{
  "version": "1.0",
  "parameters": {
    "/projectId": {
      "options": { "tool": "project_list", "itemsPointer": "/projects" },
      "order": 10
    },
    "/id": {
      "options": { "tool": "item_list", "input": ["/projectId"] },
      "order": 20
    }
  },
  "preview": {
    "tool": "item_delete_preview",
    "input": ["/projectId", "/id"],
    "bind": { "/fingerprint": "/fingerprint" },
    "reviewPointer": "/summary"
  },
  "confirmation": {
    "mode": "typed",
    "message": "Confirm deletion of the displayed item.",
    "matchPointer": "/id",
    "bindPointer": "/confirm"
  }
}
```

Shared semantics:

- Paths are RFC 6901 JSON Pointers, not executable expressions.
- `options` implies `control: "select"`. By default, the list comes from `structuredContent` at `/items`, with value `/id` and label `/name` relative to each option. Text blocks are not parsed as JSON.
- `input` copies the specified paths from the main arguments to the same paths in the auxiliary tool. An absent value stays absent; there is no type coercion. `input` and `arguments` are alternatives.
- `arguments` maps argument names to explicit bindings: `{"value":42}`, `{"from":"input","pointer":"/id"}`, or `{"from":"step","step":"preview","pointer":"/fingerprint"}`. The last reads `structuredContent` from the specified step.
- Argument references establish dependencies: changing the project invalidates item selection and dependent results.
- In the compact path, `preview.bind` maps destinations in the main arguments to paths in the structured preview result; `reviewPointer` selects information to display.
- `confirmation.mode` is `boolean` or `typed`. In `typed` mode, `matchPointer` is required and reads the main arguments. `bindPointer` permits assigning `true` only after explicit confirmation. Approval is tied to the reviewed arguments and preview; any change invalidates it.
- After confirmation, the client calls the tool itself. Auxiliary tools are resolved by canonical name on the same server under current authorization. Options and previews should be appropriate read tools; the client retains its trust policy.

Longer workflows use `workflow`, a sequential list of steps with unique `id` and `type: "input" | "call" | "confirm"`. `input` steps declare `parameters`; `call` steps declare `tool` and bindings; `confirm` steps declare `confirmation`. Result references may point only to earlier steps. Do not mix `workflow` with the compact `preview`/`confirmation` path.

```json
{
  "version": "1.0",
  "workflow": [
    { "id": "choose", "type": "input", "parameters": ["/id"] },
    {
      "id": "preview", "type": "call", "tool": "item_delete_preview",
      "arguments": { "id": { "from": "input", "pointer": "/id" } }
    },
    {
      "id": "approve", "type": "confirm",
      "confirmation": { "mode": "typed", "matchPointer": "/id", "bindPointer": "/confirm" }
    },
    {
      "id": "execute", "type": "call", "tool": "item_delete",
      "arguments": {
        "id": { "from": "input", "pointer": "/id" },
        "fingerprint": { "from": "step", "step": "preview", "pointer": "/fingerprint" },
        "confirm": { "from": "input", "pointer": "/confirm" }
      }
    }
  ]
}
```

`interpretCli` / `InterpretCLI` / `interpret_cli` validate and expand presentation conventions without changing the original document. They do not conduct interactions or execute steps. Unknown optional fields are preserved. New execution-affecting features must be declared in `requires`; an unknown required feature blocks the advanced path. Version 1 recognizes `dynamic-options`, `preview`, `confirmation`, and `workflow`.

Client confirmation and annotations are hints, not authorization. Products verify permissions, domain revision, and preview validity in the executor, including calls made by generic clients.

## TypeScript integration

Exports use the existing `@nox/mcp` entry point. Simple tools continue using `createServer` without additional options.

```ts
import { createServer, createHttpHandler, interpretCli } from '@nox/mcp';
import { z } from 'zod';

const tool = {
  name: 'item_get', description: 'Get item', _meta: { cli: 'item show' },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ name: z.string() }),
  execute: async (input: unknown) => ({ name: (input as { id: string }).id }),
};

const options = {
  appId: 'example', name: 'example', version: '1', tools: [tool],
  discovery: {
    serverId: 'example-installation-01',
    descriptors: { item_get: interpretCli({ version: '1.0' }) },
    resolveView: async (context, tools) => {
      const policy = await resolveCurrentPolicy(context); // supplied by the product
      return {
        viewId: policy.opaqueRevision,
        visible: tools.filter(t => policy.canCall(t.name)).map(t => t.name),
        unavailable: policy.unavailableTools,
      };
    },
  },
};
const server = createServer(options); // connect to the existing stdio transport
const http = createHttpHandler(options); // or mount the existing HTTP handler
```

`createServerFromManifest` accepts the same `discovery` option. `installDiscovery(server, options)` integrates an SDK `McpServer` directly; install it **before** registering tools. Handles returned by `registerTool` still support `update`, `remove`, `enable`, and `disable`. Standard listing and the extension use those same handles. `discovery.service` shares a `DiscoveryService` across factories; `createHttpHandler` does this automatically.

For clients, supply an adapter that sends method and parameters over the connected MCP transport, returning the `result` object or rejecting JSON-RPC errors:

```ts
import { DiscoveryCache, discoveryMeta } from '@nox/mcp';

// One instance per trusted origin and credential partition, without storing the API key.
const cache = new DiscoveryCache('configured-server-01', 'account-a:tenant-01');
await cache.sync(requestMcp); // requestMcp(method, params) -> Promise<result>
await cache.sync(requestMcp); // unchanged definitions are not requested again

const definition = cache.definitions.get('item_get');
await requestMcp('tools/call', {
  name: definition.tool.name, arguments: { id: '42' },
  _meta: {
    ...discoveryMeta(),
    'nox/discovery': { expectedFingerprint: definition.fingerprint },
  },
});
```

`sync` serializes concurrent synchronizations, verifies hashes, and commits only after all pages and batches are valid. `clear()` also prevents an older in-flight synchronization from committing.

## Go integration

Existing `New` and `NewFromManifest` APIs are unchanged. Use `NewWithDiscovery(options, discoveryOptions)` or `NewFromManifestWithDiscovery(options, manifestBytes, discoveryOptions)` to enable the runtime extension.

```go
runtime, err := noxmcp.NewWithDiscovery(options, noxmcp.DiscoveryOptions{
    ServerID: "example-installation-01",
    Descriptors: map[string]noxmcp.JSON{
        "item_get": {"version": "1.0"},
    },
    ResolveView: func(ctx context.Context, extra *mcp.RequestExtra, tools []*mcp.Tool) (
        string, []string, []string, noxmcp.JSON, error,
    ) {
        // Resolve live policy from the trusted context/extra.TokenInfo.
        return policyRevision, visibleNames, unavailableNames, nil, nil
    },
})
// runtime.HTTPHandler() or runtime.ServeStdio(ctx)
```

A nil `visible` list allows all registered tools; an empty list hides all tools. The same resolver applies to standard listing, definitions, and calls. The resolver must include product authorization restrictions; existing runtime scope checks still apply during execution.

For your own `mcp.Server`, advertise `DiscoveryCapability()` in `ServerOptions.Capabilities.Extensions` and call `InstallDiscovery`. Install context-preparing middleware **after** `InstallDiscovery` so it wraps extension middleware, following Go SDK ordering. HTTP authentication middleware remains outside the handler.

```go
caps := &mcp.ClientCapabilities{}
caps.AddExtension(noxmcp.DiscoveryExtension, noxmcp.JSON{"version": noxmcp.DiscoveryVersion})
client := mcp.NewClient(info, &mcp.ClientOptions{Capabilities: caps})
if err := noxmcp.RegisterDiscoveryClient(client); err != nil { /* handle */ }
// session := client.Connect(...) using the existing transport
cache, _ := noxmcp.NewDiscoveryCache("configured-server-01", "account-a:tenant-01")
err = cache.Sync(ctx, noxmcp.DiscoverySessionRequest(session))
definitions := cache.Definitions()
```

`DiscoveryCache.Sync` also accepts a `DiscoveryRequest` callback for other adapters. `Definitions()` returns copies. `Clear()` removes state under the same lock used for synchronization.

## Rust integration

The existing constructor and `ServerOptions` remain unchanged. Add `.with_discovery(...)` to the server:

```rust
use nox_mcp::discovery::{Discovery, ServerDiscovery, View};
use std::sync::Arc;

let server = server.with_discovery(ServerDiscovery {
    service: Discovery::new("example-installation-01")?,
    resolve_view: Arc::new(move |context, tools| {
        let policy = resolve_current_policy(context)?; // supplied by the product
        let definitions = tools.iter().filter(|t| policy.can_call(&t.name))
            .map(|tool| serde_json::json!({"tool": tool})).collect();
        Ok(View { id: policy.opaque_revision, definitions, presentation: None })
    }),
});
```

Each `definitions` element may add `cli` and `availability`. The resolver may only select real tools and add those fields: replacing an MCP definition is rejected. Do not grant access using client-supplied metadata. The application still supplies authorized context and the executor.

The same server can connect to stdio or `rmcp`'s `StreamableHttpService`. In HTTP factories, cloning shared server/configuration preserves fingerprint memoization.

```rust
use nox_mcp::discovery::Cache;
let mut cache = Cache::new("configured-server-01", "account-a:tenant-01")?;
cache.sync(|method, params| request_mcp(method, params)).await?;
let definitions = cache.definitions();
```

The asynchronous callback returns `result` as `serde_json::Value` or `DiscoveryError`. It may use the `rmcp` client and `ClientRequest::CustomRequest`; parameters already include negotiation metadata. Also configure the extension capability on the client so the SDK publishes it in requests. Query `server/discover` before choosing incremental synchronization.

Test servers in `scripts/fixtures/`, `go/testdata/`, and `rust/examples/discovery_fixture.rs` show complete transport setup. **The `test/policy` policy in these fixtures is a test-only simulation, not a product authentication mechanism.**

## Catalog, snapshots, and fingerprints

`nox/tools/catalog` accepts `ifCatalog` or pagination with `catalog`, `cursor`, and `limit`. The default limit is 1,000 entries; the maximum requested limit is 10,000. Responses contain `serverId`, `viewId`, `catalog`, `ttlMs`, `cacheScope: "private"`, and `{name, fingerprint, availability?}` entries. An unchanged catalog produces `notModified: true` without resending entries.

`nox/tools/definitions` accepts `{catalog, tools: [{name, fingerprint}]}` and returns `{resultType:"complete", catalog, definitions:[{fingerprint,tool,cli?}]}`. A request allows at most 64 definitions, subject to the byte limit (4 MiB by default in the discovery service). An oversized batch produces `PAYLOAD_LIMIT`; consumers may retry with smaller batches. Helpers do not persist partial state.

The snapshot hashes server identity, authorized view, sorted entries, and shared presentation. Every page and definition request must match the current view. A change produces `STALE_CATALOG`: restart synchronization. There is no snapshot history or old definition lookup by hash. An identical snapshot remains valid because it represents the same content and context; TTL indicates freshness, not authorization or token expiry.

Remove absent entries only after receiving the entire catalog. Network failures, incomplete responses, duplicates, snapshot changes, or incorrect hashes leave the previous cache intact. Complete revocation returns an authorized empty catalog; an authentication error requires consumers to stop using the corresponding context/cache.

The fingerprint is `base64url(SHA-256(JCS({tool,cli?})))`, without padding: 43 characters. It includes all published schemas, annotations, and metadata. It excludes `availability`, TTL, shared presentation, envelopes, and the hash itself. Absence differs from `null`; arrays retain order; names and keys use UTF-16 ordering. Unicode is not normalized. JCS rejects non-finite numbers and invalid strings and represents numbers according to binary64/ECMAScript, including rounding JSON integer tokens. Work with JSON values; a parser cannot recover information already lost. Do not use JSON numbers for arbitrary-precision identifiers: use strings. Shared vectors include RFC IEEE 754 extremes and rounding boundaries.

Services memoize hashes by content, with an internal limit of 4,096 entries. Queries still traverse the authorized inventory: the first version does not implement a delta log. Executor code changes absent from the definition do not change the hash.

Clients use one cache per configured trusted origin and local credential partition, further separated by `serverId`, `viewId`, and the fixed protocol/extension profile. Do not use only `serverInfo.name`. Servers supply a stable `serverId` per installation and an opaque `viewId` distinguishing users, tenants, and relevant policy revisions. Do not include tokens or API keys in these fields. `sync` always revalidates the catalog; consumers may avoid the call while their cache is fresh, respecting TTL and applicable MCP notifications.

When supplied in a call's `_meta["nox/discovery"]`, `expectedFingerprint` compares the current definition before executor dispatch. `STALE_DEFINITION` requires refreshing the definition and repeating any review/consent. `FORBIDDEN` hides tools outside the view; `UNAVAILABLE` prevents execution of temporarily unavailable tools. These rejections and parameter validation retain JSON-RPC `-32602` with `data.reason`. A missing required capability uses `-32021`, as described under negotiation. Executor domain errors use `isError: true` and a JSON body in text, without `structuredContent`, to avoid contradicting the success schema. Consumers must treat both as failures without interpreting text as authorization. Clients also verify the complete catalog hash before accepting removals.

### HTTP errors and SSE responses

A JSON response to `-32021` uses HTTP **400**, as does rejection of an unknown protocol version (`-32022`). If the transport already sent SSE headers, status **200** remains: the JSON-RPC error must be the terminal event in the same stream, with the same `id`, before closure. Some transports start SSE before running the handler. Stdio has no HTTP status; the error envelope is the same. See [MCP base protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic) and [TypeScript SDK errors](https://ts.sdk.modelcontextprotocol.io/v2/servers/errors).

Parameter validation inside a handler (`-32602`) retains SDK HTTP mapping: TypeScript 2.3.1 and the rmcp >=3.6, <4 behavior profile return JSON/200; Go 1.8.0 and rmcp 3.5.x return JSON/400. The distinction is confirmed in the packaged official rmcp 3.5.0, 3.6.0, and 3.7.0 `jsonrpc_http_status` implementations. Rejection of required envelope fields before dispatch uses JSON/400 in all three implementations. Tests read the complete resolved rmcp version from Cargo metadata in both checkout and independent consumers; they no longer select an exact-minor exception or silently fall back for an unsupported version. The profile is an expectation checked on the real transport, not permission to accept arbitrary 200/400 responses. See [regression policy](COMPATIBILITY.md#regression-policy-for-sdk-http-mappings-and-test-deadlines).

**Investigating / Future Support — Go SSE, SDK 1.8.0:** if a handler emits SSE progress and then returns `-32021`, `-32022`, `-32602`, or `-32601`, the transport attempts to change status and writes raw JSON without SSE framing. Full Go SSE support was explicitly deferred and is not advertised as conformant. NoX negotiation occurs before progress and correctly returns JSON/400; Go `Runtime.HTTPHandler()` uses JSON responses and remains supported. No current NoX Suite feature was identified in this decision as depending on the late SSE error case.

`npm run diagnose:go-sse` reproduces all four errors and **exits with code 1 while the response remains invalid**. The separate `Investigating / Future Go SSE` workflow runs only through `workflow_dispatch` (no push/PR triggers), preserving visible failure without `continue-on-error`; it is outside the required release graph. Do not configure it as a required branch-protection check. Required tests still enforce stdio/HTTP JSON in all three languages and SSE in TypeScript/Rust. No exceptions accept invalid framing on supported transports. Cause, impact, and resumption criteria are in the [compatibility guide](COMPATIBILITY.md#investigating--future-support-go-sse).

## Contract management and tests

`contracts/` is authoritative. New schemas are separate from the six 0.5.0 contracts. `discovery-conformance.json` covers schemas, descriptors, numbers, and Unicode. The generator publishes TypeScript schemas and copies schemas/corpus into native packages; external Go/Rust compilation requires no Node scripts.

To change a contract:

1. Change the source in `contracts/`, preserving previous APIs and contracts.
2. Add positive/negative cases and shared vectors; new required behavior needs explicit negotiation.
3. Run `npm run contracts:sync`.
4. Run `npm test`, `go test -mod=readonly ./...`, `cargo test --locked --manifest-path rust/Cargo.toml`, `npm run test:conformance`, `npm run test:discovery`, and `npm run test:native-packages`.
5. Run `npm run benchmark:discovery` and review payload changes.

The `Supported / Required compatibility` workflow compares observations across languages and exercises real servers within supported scope: stdio/HTTP JSON in all three languages and SSE in TypeScript/Rust, including already covered legacy paths. Existing 0.5.0 tests remain active. Package tests confirm use outside the checkout. The separate Go SSE diagnostic is not a conformance approval.

## Measurements and limits

`npm run benchmark:discovery` measures minified JSON-RPC requests and responses in UTF-8 bytes, without compression. It uses synthetic catalogs with the same schemas on both paths and optional descriptors on 25% of tools:

| Tools | Full `tools/list` | Initial incremental | Unchanged | One changed | One removed |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 17 799 | 21 173 | 526 | 3 853 | 1 318 |
| 100 | 175 929 | 203 851 | 526 | 11 863 | 9 328 |
| 1 000 | 1 758 129 | 2 033 665 | 526 | 91 963 | 89 428 |

One changed tool reduces transfer by 78.4%, 93.3%, and 94.8%, respectively. The first load costs more because it transfers the catalog and descriptors. A fresh conventional MCP cache can also transfer zero bytes. These figures do not measure latency or production products; compression and schema composition change the results.

This implementation includes no terminal renderer, automatic workflow execution, persistent cache storage, cross-server discovery, or CLI/Gateway products. Selection/preview helpers and their authorization belong to the product server. New Rust production dependencies are `sha2`, `base64`, and `ryu-js`, needed for hashing and JCS representation; `axum` is only a development dependency for real HTTP tests. Existing MCP SDKs were not upgraded.
