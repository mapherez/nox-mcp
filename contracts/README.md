# Shared contracts

`contracts/` is the authoritative source for the six protocol schemas, defaults, tool schema profile, and conformance corpus. The supported scope is described in [compatibility and support](../Documents/COMPATIBILITY.md). Earlier audits and migration notes are in the [historical archive](../Documents/old/README.md).

## Responsibilities

Step 2B adds separate optional contracts for CLI descriptors and incremental discovery without changing earlier contracts. See [incremental discovery](../Documents/DISCOVERY.md) for negotiation, examples in all three languages, fingerprints, snapshots, and caching. `cli.schema.json` and `discovery-*.schema.json` are validated by native JSON Schema validators; the additional corpus is `discovery-conformance.json`. `npm run contracts:sync` generates the copies and TypeScript schemas, and `npm run test:discovery` compares implementations and real transports.

A structurally valid manifest does not grant authorization or guarantee that it can be executed.

| Operation | TypeScript | Go | Rust | Guarantee |
| --- | --- | --- | --- | --- |
| Structural validation | `toolManifestSchema` | `ValidateFrame("manifest", ...)` | `validate_schema` with the authoritative schema | Document conforms to `manifest.schema.json`; tool schemas are not compiled. |
| Execution preparation | `loadToolManifest` | `LoadToolManifest` | `load_manifest` | Structural validation, protocol `2.0`, unique names, object input/output roots, and compilation under the shared profile. Returns the complete document. |
| Binding and execution | `createServerFromManifest` | `NewFromManifest` | `McpServer::from_manifest` | Binds application-supplied implementations, validates input/output, and enforces authorization requirements. |

During structural validation, `schemaVersion` remains `1`, `protocolVersion` is a non-empty string of at most 32 characters, and tool schemas are opaque JSON objects. Duplicate tools or non-executable schemas may be valid for this operation. Annotations are a required object with optional booleans. Tests distinguish these results from execution requirements.

In manifest-based discovery, an absent hint retains its MCP meaning: `readOnlyHint` and `idempotentHint` have an effective value of `false`; `destructiveHint` and `openWorldHint` have an effective value of `true`. Some SDKs materialize booleans whose effective value is `false`. The complete document preserves original field presence.

Document loaders preserve `_meta.cli`, custom metadata, extensions, unknown properties, and the distinction between absence and a present value. `_meta` is optional and must be an object when present; `{}` is valid, while `null`, arrays, and scalars are invalid. We do not reinterpret `_meta.cli` as a new command convention.

Validation does not transform data: it does not insert defaults, coerce types, or remove properties. `default` is an annotation. An omitted field remains omitted, including `retryable` in an error document. Unknown properties are accepted in open contract objects; tools follow their schema's `additionalProperties` setting.

## Scopes and trust

- `scope` is a legacy description. It grants no access and is not equivalent to `requiredScopes`.
- `requiredScopes` declares execution requirements; each element must be a non-empty string. Absence or an empty list means the manifest adds no requirements.
- Loading assigns neither identity nor permissions. The application must approve the manifest and bind trusted executors.
- Manifest constructors combine declared requirements with application-configured requirements. A manifest cannot remove a local restriction.
- Granted scopes come exclusively from identity/authentication: `auth.scopes` in TypeScript, `auth.TokenInfo` in Go, and `ServerOptions.scopes` in Rust. All requirements must be present; otherwise, the library returns `FORBIDDEN` before execution.

TypeScript requires an implementation in `bindings` for each name; Go requires one in `Options.Tools`. Rust receives a trusted `Executor` responsible for dispatching approved names. This architectural difference does not change policy. Each product remains responsible for its authentication mechanisms.

The older Rust `load_tools` returns only `Vec<rmcp::Tool>`, which carries no scope policy. It now rejects manifests with non-empty requirements instead of silently discarding them. Use `load_manifest` for inspection or `McpServer::from_manifest` to execute those manifests.

## Tool schemas

`compileToolSchema` / `CompileToolSchema` / `compile_tool_schema` compile the same explicit, offline JSON Schema draft-07 profile. `validateToolValue` / `ValidateToolValue` / `validate_tool_value` return false for invalid schemas or invalid values. Manifest constructors use this profile to perform actual call validation.

The profile is defined in `tool-schema-policy.json`. It includes types and unions, objects and properties, homogeneous arrays, bounds, `enum`, `const`, `allOf`, `anyOf`, `oneOf`, `not`, local references, and annotations. Boolean subschemas are supported; executable input/output roots declare `type: "object"` because these are MCP tools.

Portability rules:

- Only the draft-07 dialect specified in the policy is supported; unknown keywords are rejected. `x-*` extensions are preserved in the document and introduce no validation.
- Only local `$ref` JSON Pointers `#/...`, with `~0`/`~1` escapes and valid array indices. Remote references, cycles, and depth greater than 64 are rejected. Compilation does not access the network.
- A reference cannot have sibling assertions: draft-07 ignores them while other dialects may apply them. Annotations, definitions, and extensions without validation semantics are allowed.
- `uuid` and `date-time` are the only assertion formats, using the authoritative envelope patterns: UUID with a recognized variant/version and date/time with seconds and an explicit timezone. Other formats are rejected. Semantics follow the versioned patterns, not every RFC variant.
- Regex supports simple or `(?:...)` groups, classes, quantifiers, and common escapes. `\d`, `\w`, and `\s` use ASCII classes; their uppercase negated variants are allowed outside classes. `.` excludes LF, CR, U+2028, and U+2029; `$` requires the actual end of the string. Two-digit hexadecimal escapes are supported. Lookaround, backreferences, Unicode/property escapes, nested/intersected classes, and engine-specific constructs are rejected. Property patterns that collide after normalization are rejected to avoid losing assertions.
- `multipleOf` requires a positive integer up to `2^53−1`. An engine divergence was confirmed for `0.3 / 0.1`; the shared profile explicitly rejects fractional divisors. Native APIs remain available for broader schemas, without an equivalence guarantee in those cases.
- For interoperable numbers, use finite values and integers within JavaScript's exact range (`±(2^53−1)`). Native Go/Rust types can represent more precision; this profile does not add arbitrary decimal arithmetic to JavaScript.

`tool-schema.meta.json` is a versioned copy of the draft-07 meta-schema distributed with Ajv; it also allows Go to check schema validity before resolution. Ajv is the only new TypeScript runtime dependency: it provides draft-07 compilation without the experimental JSON Schema → Zod conversion. Existing dependencies were not upgraded. The three engines retain independent implementations; the corpus verifies common rules.

Native APIs remain available: `createServer` with Zod, `New` with Go schemas, and `McpServer::new` with Rust SDK tools. Zod refinements/transforms, native dialects, and SDK rich content belong to those APIs. Shared manifests use the constructors and profile above.

## Results, errors, and execution

For ordinary calls, success contains a `structuredContent` object validated against the output schema and the same JSON in text content. Invalid input produces `INVALID_INPUT`; invalid output produces `INTERNAL`. Unexpected exceptions/panics are converted to `INTERNAL` without exposing the internal error to the client.

A tool error has `isError: true` and a body conforming to `error.schema.json`. Domain codes and additional properties remain allowed, including `details` and `currentVersion`. At the execution boundary, an omitted `retryable` is materialized as `false`; malformed errors and oversized envelopes produce a minimal `INTERNAL` error. That minimal error may exceed a configured limit too small to hold any valid error.

The error body is carried as JSON in `content[].text`, **without `structuredContent`**. `structuredContent` is reserved for successful results matching the advertised `outputSchema`. Consumers can validate error bodies with `error.schema.json`. See [compatibility and migration](../Documents/COMPATIBILITY.md#results-and-errors).

The deadline is calculated once at library execution entry; it includes validation and execution and is passed to the executor. An already cancelled call does not start the executor. The library rechecks deadline/cancellation before accepting success so a late result cannot be treated as confirmed. Authentication and transport processing before runtime entry are not included.

Timeout uses `TIMEOUT`; cancellation uses `CANCELLED`. Explicitly marked reads use `retryable: true`; other operations use `retryable: false` and `details.outcome: "unknown"`. Cancellation guarantees neither rollback nor that an external effect did not occur. Executors must cooperate with the supplied context.

These differences remain legitimate:

| API area | Difference and limit |
| --- | --- |
| SDK projections | Rust `load_tools`, `parse_server_frame`, and Go/Rust discovery types represent only SDK fields. Use the complete loader to preserve every extension; do not round-trip a manifest through discovery types. Object `_meta` metadata remains advertised. |
| Go errors | `Runtime.Execute` uses the idiomatic `error` return; MCP envelope normalization occurs in the handler. Tests compare that boundary. |
| Physical cancellation | Go/TypeScript retain capacity while non-cooperating work continues; Rust may abort the future. Universal preemption and effect rollback do not exist. |
| Transport | The SDK may suppress the response when a connection/request is cancelled. The contract defines the internal result when deliverable; it does not require a response on a closed connection. |
| Local details | Human messages, generated IDs, deadline representation, and diagnostics vary. Codes, retryability, unknown-outcome details, and JSON data are comparable. |

MCP protocols, bridge frames `1.0`/`2.0`, tickets, heartbeats, and local brokers have not been redesigned. Prefixed IDs and numeric deadlines in the local Rust broker remain distinct from UUID/RFC3339 WebSocket envelopes.

## Generation and maintenance

```sh
npm run contracts:sync
npm run contracts:check
```

The generator copies schemas, policy, meta-schema, and corpus to `go/contracts` and `rust/contracts`, generates TypeScript Zod validators, copies the TypeScript policy, and generates defaults in all three languages, including the structural `defaults.generated.ts` type for NodeNext-compatible declarations. These outputs are versioned and accompany their sources in the same commit. Do not edit them manually. `contracts:check` is read-only and fails on drift, missing files, or stale copies; only LF/CRLF differences are ignored.

Go uses `go:embed`; Rust uses `include_str!`. Installed packages contain the required copies and compile without Node, symlinks, or build-time generation. The TypeScript tarball includes JavaScript, declarations, and defaults/policy JSON. Consumer installation runs no build hooks.

To change a contract:

1. Review compatibility documentation and, where relevant, the migration archive; identify operations, consumers, and compatibility impact.
2. Change authoritative sources. If adding a new assertion, explicitly support it in the generator or profile rather than ignoring it in one engine.
3. Add valid, invalid, and regression cases to the corpus. `cases` tests documents, `executable` tests preparation, and `loadTools` tests the legacy Rust projection limitation. `schemaCases` separates schema validity from value validity. `runtimeCases` describes calls, authorization, errors, and termination.
4. Synchronize, review the diff, and run the checks below. Include generated files and document any required migration.

```sh
npm run contracts:sync
npm test
go test -mod=readonly ./...
cargo test --locked --manifest-path rust/Cargo.toml
npm run test:conformance
npm run test:native-packages
npm run package:check
```

Suites use the same examples and expectations, without language-specific exceptions in shared validation/preparation. `test:conformance` runs all three runtimes, collects normalized observations, and compares actual JSON output: success/error, body, code, `retryable`, `details`, and whether the executor was invoked. It also checks real discovery of metadata and schemas through the SDKs. Human messages, IDs, and clocks are excluded. Existing transport tests cover HTTP/SDK behavior separately; controlled cancellation avoids depending on transport-level response suppression.

`conformance.json.runtimeTestPolicy` configures tests only: normal/error/cancellation cases receive a separate budget from deliberate timeout cases. The panic example includes a delay longer than the former 30 ms budget, preserving the `INTERNAL`/sanitization assertion under scheduling variance. These values are not public runtime defaults. `discovery-conformance.json` records handler HTTP mappings by compatible SDK version ranges; `scripts/discovery-http-policy.mjs` rejects missing/unsupported/ambiguous selection. Both transport runners use Cargo metadata rather than assuming the checkout's lockfile matches a consumer.

`test:native-packages` compiles an isolated Go consumer and a packaged Rust crate outside the checkout, without the authoritative `contracts/` directory or Node in native builds. `package:check` installs the tarball, tests imports and HTTP JSON/SSE before installing TypeScript, then compiles and runs a strict consumer application. `test:consumers -- --language=rust` and `--language=go` check applications with independent resolution; `--minimum` selects the minimum profile. The toolchain/dependency matrix and blockers are in [compatibility and support](../Documents/COMPATIBILITY.md). Native distribution tests use caches populated by the ordinary suites.

The contracts workflow runs these checks; release publication checks approvals for the same SHA without repeating the matrix or suites. `npm test` and `prepack` reject stale generated files. None of these commands updates Backend, Yard, Bot, or NoteX. Do not edit generated copies directly.

## Suite integration contracts

`suite-*.schema.json`, `suite-defaults.json`, and `suite-conformance.json` define the separate Suite `1.0` protocol. Existing manifests, bridge envelopes, and discovery hashes retain their own versions. `sync-contracts.mjs` also generates complete native Suite DTOs and packaged schemas, and TypeScript types/schema data. `npm run test:suite` compares native validation, cryptography, HMAC, aggregation, observation, and registry outputs; the required CI conformance jobs include it.

Suite runtimes derive grants from a cryptographically verified Backend delegation, independently of constructor scopes used by ordinary direct runtimes. Trusted static/dynamic requirements remain additive. See [SDK integration](../Documents/INTEGRATION.md) for API names, address/JSON/time profiles, host trust and event responsibilities, and native HTTP integration. The SDK does not implement the Backend management routes or issue credentials.
