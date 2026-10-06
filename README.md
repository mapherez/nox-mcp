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
npm install "git+https://github.com/mapherez/nox-mcp.git"
```

```ts
import { createServer } from '@nox/mcp';
```

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

## Distribution

NoX MCP is currently consumed directly from this repository and is not automatically published to npm, crates.io, or other public package registries.

## Updating the project version

Commit your changes first, then run:

```sh
npm run version:update
```

The script shows the current version from `package.json` and the versions in each manifest and lockfile, including any inconsistencies. Enter the new version (for example, `0.4.0` or `0.4.0-beta.1`); press Enter to cancel. You can also pass it directly with `npm run version:update -- 0.4.0`.

It synchronizes `package.json`, both project version fields in `package-lock.json`, the package version in `rust/Cargo.toml`, and the `nox-mcp` entry in `rust/Cargo.lock`. It then creates a release commit and an annotated local tag such as `v0.4.0`, pointing to that commit. Dependencies, language requirements, and protocol versions retain their own versions. Existing tags are never overwritten.

Go uses the Git version tag; `go.mod` does not contain this module's release version. Versions `v2` and above require a matching `/vN` module path before running this script ([Go module versioning](https://go.dev/doc/modules/version-numbers)).

The script does not push. Publish the commit and tag when ready:

```sh
git push --follow-tags
```

## License

Licensed under the [MIT License](LICENSE).
