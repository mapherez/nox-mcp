# NoX MCP

Multi-language MCP building blocks for applications and services.

NoX MCP provides shared contracts and native libraries for building [Model Context Protocol](https://modelcontextprotocol.io/) integrations across **TypeScript, Rust, and Go**.

The project focuses on the infrastructure commonly needed around MCP: tool registration, schema validation, execution policies, transport integration, authorization, metadata, cancellation, limits, and communication between services and desktop applications.

> **Status:** Alpha — APIs and contracts may evolve as the project matures.

Compatibility requirements, tested dependency versions and CI evidence are recorded in [COMPATIBILITY_AUDIT.md](COMPATIBILITY_AUDIT.md). **Supported / Required:** stdio and HTTP JSON in TypeScript, Go and Rust; SSE in TypeScript and Rust. **Investigating / Future Support:** Go SSE, including a known invalid terminal error after progress in the upstream Go SDK. Full Go SSE conformance is not advertised.

## Features

Optional compact CLI descriptors and incremental discovery are documented in [DISCOVERY.md](DISCOVERY.md), including server/client integration for TypeScript, Go and Rust, transport compatibility and measured payload sizes. This work does not change the public SDK version.

NoX MCP provides reusable primitives for building MCP servers without requiring each application to implement the same infrastructure independently.

Core capabilities include:

- MCP tool registration and discovery
- Input and output schema validation
- Structured success results and JSON tool errors in text content
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

Rust requires `rmcp >=3.5.0, <4`; the independently tested MSRV is 1.88 with Rust-aware dependency resolution. Consumers own their resolver/lockfile: see the audit for the minimum graph and resolver configuration. Node 24.0.0 uses its bundled npm; no global npm override is required. `npm run test:consumers -- --language=rust --minimum`, `--language=go --minimum`, and `npm run package:check -- --minimum` exercise actual independent applications; omit `--minimum` to resolve recent compatible dependencies.

Shared schemas and protocol definitions live under [`contracts/`](contracts/).

The shared manifest loaders and execution constructors use the portable schema profile described in [contract management](contracts/README.md). Published releases through `v0.6.0` remain unchanged; the release-tooling changes and removal of the retired identity adapter in this working tree are unreleased. Review the [migration notes](MIGRATION_0_5.md), including the approved tool-error envelope correction. This checkout does not publish a release or migrate consumers.

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

Additional package entry points are available for contracts, bridges, and Node integration.

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

Authorization remains independent from tool execution. The host supplies credential validation and the authorized context through the existing callbacks. NoX Backend exclusively generates and manages NoX API Keys; Google Account and the future NoX Account belong to the product identity layer. This SDK does not implement those identity flows or issue API Keys.

## Shared contracts

The [`contracts/`](contracts/) directory contains shared protocol definitions and schemas used across implementations.

This directory is the only authoritative source. Run `npm run contracts:sync` after
editing a contract or its defaults, and commit the generated Go/Rust copies and
TypeScript validators together. `npm run contracts:check` rejects drift without
changing files; tests, branch/PR CI and releases run this check automatically.
Go and Rust packages contain the generated schemas and build without Node.js or
access to this repository's root contracts directory.

See [contract maintenance and compatibility](contracts/README.md) for the shared
conformance corpus, preserved legacy differences, and the checks required when
adding or changing a contract.

These contracts exist to keep behavior consistent between TypeScript, Rust, and Go without forcing the languages to share the same internal architecture.

## Releases

Version `v0.6.0` is already published and is not modified by this revision.
Commit reviewed changes first. On a clean `master` branch, run:

```sh
npm run release
# or: npm run release -- X.Y.Z
```

The interactive command shows current versions and asks which version to prepare;
Enter cancels. The command validates the version, Go major, clean repository and
absence of local/remote tags, synchronizes the four version files and creates a
commit with an explicit `NoX-Release: X.Y.Z` trailer. It pushes only that SHA to
`origin/master`, without tags or local test suites.

1. `contracts.yml` runs the 17 required jobs once for the master push. Pull
   requests targeting master use the same matrix; feature pushes do not launch
   another duplicate matrix.
2. After success, `release.yml` receives `workflow_run`. It accepts only a
   successful master push from this repository with explicit release intent.
3. The publisher checks workflow identity, all 17 latest job approvals across
   attempts, SHA, current master head, all SDK versions and absence of a tag or
   release. PRs, forks, manual runs, unmarked commits and superseded SHAs cannot
   publish. The checkout is the approved SHA, not the publisher's default SHA.
4. With the committed npm lockfile, it builds and packs the distribution, without
   rerunning tests, contract checks or the normal prepack validation hook. It
   checks source integrity and tag/release absence again before remote writes.
5. It creates an annotated tag at the approved SHA, creates a draft, uploads
   `nox-mcp.tgz`, then publishes as the final API operation. Publication is
   serialized by a repository-wide concurrency group; existing objects are never
   overwritten.

A version prepared earlier still needs an explicit release-intent commit. This
can be empty when the version files already match; it authorizes a new SHA for
CI. Retrying an unchanged intent commit reuses that SHA. `npm run version:update`
prepares only a local version commit, without tag, push or publication intent.

If CI fails, use GitHub's **Re-run failed jobs**: successful jobs from earlier
attempts of the same SHA remain usable. Repeating the local push of an unchanged
SHA does not create a new CI event. If packaging fails, no tag is created. If an
API/upload fails after tag creation, an unpublished draft/tag may remain; inspect
and resolve that incomplete attempt manually. Retries refuse existing tags or
releases, including published versions. No automatic rollback deletes them.

Install these workflow changes on master with an ordinary reviewed commit before
using the new release command. GitHub requires the `workflow_run` listener to be
on the default branch. Publishing uses the native `GITHUB_TOKEN` with
`actions: read` and `contents: write`; repository rules must permit the publisher
to create release tags. No registry credentials or replacement identity system
are introduced. See [GitHub workflow_run documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).

Prereleases such as `X.Y.Z-rc.1` are supported. Go and Rust consume the approved
Git tag; TypeScript uses the release asset. The Go SSE investigation is manual
only (`workflow_dispatch`) and never participates in the release gate.

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
