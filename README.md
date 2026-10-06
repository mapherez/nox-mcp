# NoX MCP

Multi-language MCP building blocks for the NoX ecosystem.

NoX MCP provides shared contracts and native libraries for building MCP-powered applications across **TypeScript, Rust, and Go**. The project focuses on reusable tool infrastructure, server integration, authorization, and communication between MCP services and desktop applications.

> **Status:** Alpha — APIs and contracts may change as the NoX ecosystem evolves.

## What's included

- Shared MCP contracts and JSON schemas
- Tool and handler infrastructure
- MCP server integration
- Desktop bridge and request handling
- Authorization helpers
- Native implementations for TypeScript, Rust, and Go

The shared contracts are kept consistent across implementations, allowing different NoX applications and services to communicate using the same underlying protocol.

## Languages

| Language | Version | Location |
| --- | --- | --- |
| TypeScript / Node.js | Node 24+ | [`typescript/`](typescript/) |
| Rust | Rust 1.88+ | [`rust/`](rust/) |
| Go | Go 1.26+ | [`go/`](go/) |

Shared schemas and protocol definitions live under [`contracts/`](contracts/).

## TypeScript

The TypeScript library is available as `@nox/mcp`.

```sh
npm install https://github.com/mapherez/nox-mcp/releases/download/v0.4.0/nox-mcp.tgz
```

```ts
import { createServer } from '@nox/mcp';
```

To update an app, change the version in the URL and run `npm install` again. The tarball contains compiled JavaScript and type declarations; installation needs only runtime dependencies and the peers used by your app.

## Rust

The `nox-mcp` crate is located in [`rust/`](rust/) and can be referenced directly as a Git or path dependency.

## Go

The Go module is:

```text
github.com/mapherez/nox-mcp
```

The NoX MCP package is available under:

```text
github.com/mapherez/nox-mcp/go
```

## Release

With a clean working tree, run:

```sh
npm run release -- 0.4.0
```

This synchronizes TypeScript and Rust versions, tests all three SDKs and the npm tarball, creates `chore: release v0.4.0` and an annotated `v0.4.0` tag, then pushes both to `origin`. GitHub Actions creates the GitHub Release with `nox-mcp.tgz`; the install URL works once the workflow finishes. Existing tags and releases are never replaced. No package registry is used.

Go uses the same Git tag. Before releasing major 2 or above, migrate the Go module path and imports to the matching `/vN` suffix ([Go module versioning](https://go.dev/doc/modules/version-numbers)).

## License

Licensed under the [MIT License](LICENSE).
