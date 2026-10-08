# NoX MCP

Multi-language MCP building blocks for applications and services.

NoX MCP provides shared contracts and native libraries for building [Model Context Protocol](https://modelcontextprotocol.io/) integrations across **TypeScript, Rust, and Go**.

The project focuses on the infrastructure commonly needed around MCP: tool registration, schema validation, execution policies, transport integration, authorization, metadata, cancellation, limits, and communication between services and desktop applications.

> **Status:** Alpha — APIs and contracts may evolve as the project matures.

## Features

NoX MCP provides reusable primitives for building MCP servers without requiring each application to implement the same infrastructure independently.

Core capabilities include:

- MCP tool registration and discovery
- Input and output schema validation
- Structured tool results and errors
- MCP tool annotations
- Custom tool metadata through `_meta`
- Request timeouts and cancellation
- Concurrent request limits
- Payload size limits
- Execution context and request identity
- Authorization and scope enforcement
- Streamable HTTP integration
- stdio support where applicable
- Desktop request brokers and bridges
- Shared protocol contracts and JSON schemas
- Native implementations for TypeScript, Rust, and Go

The implementations follow the same core contracts while remaining idiomatic to their respective languages.

## Languages

| Language | Requirements | Location |
| --- | --- | --- |
| TypeScript / Node.js | Node 24+ | [`typescript/`](typescript/) |
| Rust | Rust 1.88+ | [`rust/`](rust/) |
| Go | Go 1.26+ | [`go/`](go/) |

Shared schemas and protocol definitions live under [`contracts/`](contracts/).

## Installation

NoX MCP releases use Git tags in the form:

```text
vX.Y.Z
```

Replace `vX.Y.Z` in the examples below with the release you want to use.

### TypeScript

The TypeScript package is distributed as `@nox/mcp` through the release asset `nox-mcp.tgz`.

Install a specific release:

```sh
npm install https://github.com/mapherez/nox-mcp/releases/download/vX.Y.Z/nox-mcp.tgz
```

Example import:

```ts
import { createServer } from '@nox/mcp';
```

Additional package entry points are available for contracts, bridges, Node integration, and authorization helpers.

To update, install the desired release tag again:

```sh
npm install https://github.com/mapherez/nox-mcp/releases/download/vX.Y.Z/nox-mcp.tgz
```

Using an explicit release tag keeps installations reproducible.

### Go

The Go module is:

```text
github.com/mapherez/nox-mcp
```

Install a specific release:

```sh
go get github.com/mapherez/nox-mcp@vX.Y.Z
go mod tidy
```

Import the Go package with:

```go
import noxmcp "github.com/mapherez/nox-mcp/go"
```

To update:

```sh
go get github.com/mapherez/nox-mcp@vX.Y.Z
go mod tidy
```

Go uses the same Git release tags as the rest of the project.

For major versions `v2` and above, the Go module path must follow Go semantic import versioning and include the matching `/vN` suffix.

### Rust

The Rust crate is located under [`rust/`](rust/) and is not currently published to crates.io.

Use a tagged Git dependency:

```toml
[dependencies]
nox-mcp = {
    git = "https://github.com/mapherez/nox-mcp.git",
    tag = "vX.Y.Z"
}
```

Pinning a release tag is recommended over following the repository branch directly.

To update, change the tag in `Cargo.toml` and refresh the lockfile:

```sh
cargo update -p nox-mcp
```

Path dependencies can also be used during local development:

```toml
[dependencies]
nox-mcp = { path = "../nox-mcp/rust" }
```

## Tool metadata

MCP tools can expose additional metadata through `_meta`.

NoX MCP preserves this metadata across the supported implementations.

Example:

```json
{
  "_meta": {
    "cli": "container logs"
  }
}
```

Custom `_meta` values are application-defined and can be ignored by clients that do not understand them.

This makes it possible to layer additional conventions on top of MCP without changing the canonical MCP tool name or schema.

## Execution model

Tool execution can carry contextual information such as:

- request identity
- application identity
- authenticated user identity
- authorization scopes
- request deadline
- cancellation state

Implementations also provide protection against common runtime problems such as:

- oversized payloads
- invalid input or output
- excessive concurrent requests
- request timeout
- client cancellation
- unauthorized operations
- unexpected internal errors

Mutation handlers can use the provided execution context to verify that a request is still active before committing state changes after asynchronous work.

## Transports

NoX MCP supports MCP server integration through the transports provided by each language implementation.

Depending on the implementation, this includes:

- Streamable HTTP
- stdio
- desktop bridge communication

Applications remain responsible for deciding which transports should be exposed and how they should be authenticated.

### TypeScript HTTP response modes (next release)

Updating from `0.4.1` changes normal HTTP exchanges to **JSON by default**.
Applications pinned to the previous release retain their existing behavior.
Both the legacy `initialize`/`tools/list`/`tools/call` flow and modern
`server/discover`/tool exchanges use the SDK's native `application/json`
responses. There is no SSE-to-JSON conversion in applications.

```ts
import { createHttpHandler, type HttpHandlerOptions } from '@nox/mcp';
import { toNodeHandler } from '@nox/mcp/node';

const options: HttpHandlerOptions = {
  appId: 'example', name: 'example', version: '1.0.0', tools,
  // responseMode: 'json' is the default.
};
const handler = createHttpHandler(options);
const nodeHandler = toNodeHandler(handler);
// Mount nodeHandler in the application's HTTP server.
// await handler.close() when shutting the server down.
```

JSON mode accepts `Accept: application/json`, compatible `application/*` and
`*/*` wildcards, an absent Accept header, and clients advertising both JSON
and SSE. A more specific exclusion such as `application/json;q=0, */*;q=1`
returns `406` before tool execution. Only the library's internal request is
normalized for the installed SDK's dual-Accept requirement.

Apps that rely on progress, intermediate notifications, or clients that
exclusively interpret SSE must opt in:

```ts
const handler = createHttpHandler({ ...options, responseMode: 'sse' });
```

SSE clients must accept both `application/json` (including transport errors)
and `text/event-stream`. JSON mode delivers the terminal result and drops
intermediate notifications. The SDK currently logs this behavior when a JSON
handler is created. Modern `subscriptions/listen` remains a dedicated SSE
stream in either mode and requires an Accept header allowing SSE.

The endpoint remains stateless: it creates no sessions, answers legacy
initialization notifications with an empty `202`, and rejects GET/DELETE
session operations with `405`. Auth information from upstream middleware is
passed to `resolveAuth`; schemas, `_meta`, scopes, execution limits and
`formatError` remain shared through `createServer`. HTTP bodies retain the
SDK's 4 MiB bound; `maxPayloadBytes` separately bounds tool input and output.
Disconnecting or closing the handler cancels active work and settles pending
JSON exchanges. Legacy batch cancellation returns a terminal JSON-RPC
cancellation error because the SDK suppresses the cancelled handler's reply.

The Go transport already configures JSON responses and keeps its current
behavior. This change standardizes HTTP response formats; the cause of the
earlier transient Codex connection failure has not been identified.

See [HTTP validation](typescript/HTTP_VALIDATION.md) for automated checks,
real Codex/LM Studio versions and results, and reproduction scripts.

### Application migration

For NoX Bot, after publishing and pinning the new release in the Bot repository:

1. Update its fixed `@nox/mcp` release dependency and lockfile.
2. Remove the local transport adapter and use `createHttpHandler` directly.
3. Validate initialization, tool discovery, harmless calls and authentication
   with its actual clients; set `responseMode: 'sse'` if intermediate events
   are required.

That migration is a later change in the Bot repository. Before recommending
an update for NoteX or Yard, confirm their current response parsing, progress,
notification and authentication flows. They are not migrated by this library
change.

## Authorization

NoX MCP provides reusable authorization primitives for applications that need protected MCP resources.

Tool definitions can declare required scopes, while execution contexts expose the authenticated identity and granted scopes to application code.

Authorization remains independent from the tool implementation itself, allowing the same tool infrastructure to be used in local, trusted-network, and authenticated remote environments.

## Shared contracts

The [`contracts/`](contracts/) directory contains shared protocol definitions and schemas used across implementations.

These contracts exist to keep behavior consistent between TypeScript, Rust, and Go without forcing the languages to share the same internal architecture.

## Releases

Releases are created from a clean working tree with:

```sh
npm run release -- X.Y.Z
```

The release process:

1. validates the requested semantic version;
2. synchronizes versioned project files;
3. runs the TypeScript, Go, and Rust test suites;
4. verifies the distributable TypeScript package;
5. creates a release commit;
6. creates an annotated `vX.Y.Z` Git tag;
7. pushes the commit and tag;
8. lets GitHub Actions validate the tagged source again;
9. creates the GitHub Release;
10. attaches the packaged TypeScript distribution.

Prerelease versions such as:

```text
X.Y.Z-rc.1
X.Y.Z-beta.1
```

are supported.

Existing release tags and GitHub Releases are never silently replaced.

No package registry is currently required: TypeScript uses the GitHub Release asset, Go resolves the repository tag directly, and Rust can use the corresponding tagged Git dependency.

## Repository structure

```text
contracts/      Shared protocol contracts and schemas
typescript/     TypeScript implementation
go/             Go implementation
rust/           Rust implementation
scripts/        Release, validation, and packaging tooling
```

## License

Licensed under the [MIT License](LICENSE).
