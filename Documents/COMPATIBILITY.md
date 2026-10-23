# Compatibility and support

This document describes the SDK's supported scope. Manifests and lockfiles are the reference for declared versions; earlier test results are in the [archived report](old/COMPATIBILITY_AUDIT.md). Approval of an earlier SHA does not certify a later revision.

## Supported matrix

| Feature | TypeScript | Go | Rust |
| --- | --- | --- | --- |
| stdio and HTTP JSON, including legacy MCP clients | Supported / Required | Supported / Required | Supported / Required |
| SSE, including terminal errors after progress | Supported / Required | Investigating / Future Support | Supported / Required |
| `tools/list`, incremental discovery, and MCP 2026-07-28 negotiation | Supported / Required | Supported / Required | Supported / Required |
| `_meta.cli`, optional CLI descriptors, JCS/SHA-256, snapshots, and caching | Supported / Required | Supported / Required | Supported / Required |
| Authorization, input/output schemas, errors, and rejection before execution | Supported / Required | Supported / Required | Supported / Required |
| Installable packages, public APIs, and consumers with independent dependency resolution | Supported / Required | Supported / Required | Supported / Required |

Support is limited to the tested features and execution paths. It does not certify every MCP option or NoX product integration, which has its own versions and test suites.

## Dependencies and APIs

- TypeScript: Node 24+, `@modelcontextprotocol/server ^2.3.1`, Ajv `^8.20.0`, and Zod `^4.6.0`. Optional integrations: `@modelcontextprotocol/node ^2.0.0` and `ws ^8.19.0`. The minimum Node version uses its bundled npm, without a global override.
- Go: Go 1.26+, MCP Go SDK 1.8.0, and the remaining requirements in `go.mod`. Consumers resolve their own graph through MVS.
- Rust: Rust 1.88+, `rmcp >=3.5.0, <4`, and the remaining requirements in `rust/Cargo.toml`. Consumers own their resolver/lockfile. For the MSRV, use dependency resolution compatible with the Rust version; minimum-version tests do not inherit the SDK lockfile.
- The TypeScript package exposes six entry points: `@nox/mcp`, `/contract`, `/bridge`, `/bridge/client`, `/bridge/server`, and `/node`. The build removes old output before compiling.
- Authentication is supplied by the application through the existing credential, context, and scope APIs. The SDK does not implement product identity flows or issue API keys.
- `contracts/` is authoritative; generated copies ship with Go/Rust and compile without Node. `_meta.cli`, custom metadata, and existing bridge protocols are preserved.

The portable profile and legitimate differences between native APIs are described in [contract maintenance](../contracts/README.md). When updating older installations, also review the [historical migration notes](old/MIGRATION_0_5.md); publishing a version does not migrate consumers automatically.

## Results and errors

Successes include `structuredContent` matching the `outputSchema`. Tool errors use `isError: true` and a JSON body in `content[].text`, without `structuredContent`. Clients that previously read that field for errors must read the JSON text instead. Domain codes, `retryable`, details, and valid extensions are preserved.

| Modern scenario | JSON-RPC | HTTP JSON |
| --- | --- | --- |
| Required extension missing or incompatible extension version | `-32021`, with `requiredCapabilities` | 400 |
| Unknown protocol version | `-32022`, with `requested` and `supported` | 400 |
| Required `protocolVersion` or `clientCapabilities` missing | `-32602` | 400 |
| Invalid parameters inside the NoX handler | `-32602` | TS/rmcp 3.6: 200; Go/rmcp 3.5: 400 |
| Stale definition or snapshot | `-32602`, `STALE_DEFINITION` or `STALE_CATALOG` | SDK mapping |
| Runtime authorization/domain error | MCP result with `isError: true` | 200 |

On supported SSE transports, an error after streaming starts retains HTTP 200 and arrives as the terminal event for the same request. Stdio uses the same JSON-RPC envelope, without an HTTP status. Legacy clients continue using `initialize`, `tools/list`, and `tools/call`; modern negotiation does not apply to their requests. See [discovery](DISCOVERY.md) for details.

## Required validation and releases

The `Supported / Required compatibility` workflow (`.github/workflows/contracts.yml`) contains 17 blocking jobs: Windows/Linux conformance, minimum/recent consumers for each language on those systems, recent Rust on macOS, and additional Node selectors. Failure of a supported requirement blocks publication.

Main commands, run from the repository root:

```sh
npm test
go test -mod=readonly ./...
cargo test --locked --manifest-path rust/Cargo.toml
npm run test:conformance
npm run test:discovery
npm run test:native-packages
npm run package:check
npm run benchmark:discovery
```

External consumers are tested with independent resolution. In CI, `node scripts/check-consumers.mjs` receives `NOX_CONSUMER_LANGUAGE=go|rust` and `NOX_CONSUMER_PROFILE=minimum|latest`. The TypeScript tarball uses `npm run package:check` with `NOX_CONSUMER_PROFILE`. Also select `GOTOOLCHAIN` or `RUSTUP_TOOLCHAIN` to exercise the minimum toolchain.

`npm run release` prepares and pushes only the release-intent commit to master. After the matrix passes, `workflow_run` verifies the SHA, all 17 approvals, versions, and absence of a tag/release; it packages without repeating the suites and publishes as the final operation. The procedure and failure recovery are in the [README](../README.md#releases).

The [historical report](old/COMPATIBILITY_AUDIT.md#e-review-after-v060-single-release-pipeline-and-identity-integration-removal) distinguishes the 198 local tests for that revision from the 17 remote jobs for an earlier SHA. Do not treat those counts as results for the current revision; consult the logs for the relevant commit.

## Investigating / Future Support: Go SSE

In MCP Go SDK 1.8.0, `extractErrorStatus` / `stream.deliverLocked` can write raw JSON after SSE progress has already been sent. Codes `-32021`, `-32022`, `-32602`, and `-32601` fall outside a `data:` event; HTTP remains 200, and a correct SSE client does not receive a valid terminal response.

The NoX Go HTTP handler uses JSON and is unaffected by this late SSE error case. Go stdio and HTTP JSON remain supported. Full Go SSE conformance is not guaranteed; no custom transport, fork, or serialization workaround was introduced.

`npm run diagnose:go-sse` reproduces the defect and exits with code 1 on invalid framing. The `Investigating / Future Go SSE` workflow has only `workflow_dispatch`, without `continue-on-error`, and is outside the release gate and must not be a required check. Valid TypeScript/Rust SSE tests remain mandatory.

Reconsider support when an upstream fix or a safe solution through official APIs exists and there is a concrete product need. Require framing tests for all four codes, results/errors, negotiation, and legacy clients on Windows/Linux, plus approval of the support matrix. A diagnostic that stops failing does not automatically promote support.
