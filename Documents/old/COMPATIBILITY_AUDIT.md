> **Archived historical document.** The versions, results, and status statements below apply to the revisions described. See the [current documentation](../README.md).

# Compatibility, robustness, and quality audit

Date: October 21, 2026. Scope: `nox-mcp` only, current published version **0.6.0**. No release was published, tag replaced, or consumer application changed. Consumers mentioned below are temporary applications created by tests outside the checkout.

**Historical record:** the 17/17 jobs in section B belong to the earlier revision `9b45842`. They are not results for the current revision. The post-v0.6.0 update simplifies publication, removes the unintended identity integration, and makes Go SSE diagnostics manual-only. Results for this revision are recorded at the end.

## A. Identified and corrected issues

### 1. Rust requirements below the APIs in use

`rust/Cargo.toml` allowed rmcp 3.0–3.2, but the code used the modern API validated with 3.5: `ServerConfig`, `ServerHandler`, `CallToolResponse`, custom requests, extension capabilities, per-request metadata, and typed `-32021`/`-32022` errors. The lockfile selected 3.5.0 and hid the incompatible declared requirement.

The supported minimum is now **`rmcp = "3.5.0"`** in normal and development dependencies. This is a compatible Cargo range (`^3.5.0`), not an exact `=3.5.0` pin. Tests compile every public API and execute contracts with 3.5.0 and recent resolution 3.6.0. `ServerConfig` was not replaced with older types. Version 3.5.0 is the proven support baseline; this does not claim that each method first appeared in that exact release.

Testing the other minimums revealed additional issues:

| Dependency | Demonstrated issue | Minimum declared in this revision |
| --- | --- | --- |
| chrono | 0.4.0 lacks the `std` feature; the rmcp/schemars graph already requires a much higher version. | 0.4.39, compiled/tested |
| serde_json | 1.0.127/1.0.140 do not implement `Default` for `CompactFormatter`, used by jsonschema 0.58.0. | 1.0.145, compiled/tested |
| serde | serde_json 1.0.145 requires at least 1.0.220. | 1.0.220, compiled/tested |
| tokio-util | 0.7.0 does not re-export `bytes`, and its cancellation wait does not satisfy the rmcp transport's `Sync` requirements. | 0.7.16, compiled/tested |
| tokio | Joint selection with tokio-stream requires a recent Tokio; `1` did not describe a tested minimum baseline. | 1.43.0, compiled/tested |

There was no general upgrade of the locked graph. jsonschema, sha2, base64, and ryu-js retain their previous ranges. The selected minimums form a tested support combination without attempting to reconstruct the first historical release of every API.

### 2. MSRV not validated by the lockfile

The SDK declares Rust 1.88. `cargo +1.88.0 check --locked --all-targets` revealed that locked `uuid 1.27.0` requires Rust 1.89. The lockfile correction was limited to `uuid 1.26.0`. All other locked versions were preserved.

`.cargo/config.toml` configures `rust-version`-compatible resolution. This configuration **is not inherited by consumer applications**. External tests explicitly set the same policy and application MSRV. For a consumer using Rust 1.88, configure:

```toml
# Application .cargo/config.toml
[resolver]
incompatible-rust-versions = "fallback"
```

The SDK cannot stop an application from selecting future transitive dependencies requiring another toolchain when its resolver ignores MSRV. The recent profile is also tested with the current toolchain, allowing that newer graph.

### 3. Apparently external consumers reused internal resolution

`scripts/check-native-packages.mjs` copied `Cargo.lock` and the Go graph into consumers. This checked included files and imports, but not independent application resolution.

Consumers now create their own lockfiles/sums. The new `scripts/check-consumers.mjs` tests:

- Rust through local Git with an immutable working-tree revision and through `path`, without copying `Cargo.lock`;
- a Rust application declaring `rmcp = "3.0"`, resolving a version allowed by the SDK;
- mandatory rejection of an application attempting to pin `rmcp = "=3.2.0"`;
- minimums of every direct dependency and recent compatible resolution;
- production application compilation without the `client` feature, followed by `cargo check --all-targets`, real runtime/contract tests, and stdio/HTTP/SSE binaries;
- an independent Go module, `go mod tidy`, execution, `go vet`, and the same transport tests;
- an installed TypeScript tarball with strictly valid peers, every public export, compilation and execution of a TypeScript application, and HTTP JSON/SSE discovery and calls.

`scripts/discovery-wire.mjs` is the shared verifier for checkout hosts and external binaries. A consumer therefore cannot pass merely because an example compiled.

### 4. Tool errors confused with successful results

TypeScript, Go, and Rust included error bodies in `structuredContent` while advertising a success `outputSchema`. Tests checked the error body but did not subject it to strict client validation. This could hide `FORBIDDEN` or a domain error behind a success-schema failure.

**Envelope change explicitly approved by the user:** `isError: true` results no longer include `structuredContent`. The same JSON body, including `code`, `message`, `retryable`, `details`, and custom fields, remains in `content[].text`. Successes retain both `structuredContent` and text. `error.schema.json`, success schemas, function names, and tool names are unchanged.

Files: `typescript/src/index.ts`, `go/nox.go`, and `rust/src/lib.rs`. Rust still accepts existing executors constructing `CallToolResult::structured_error`; it normalizes them before responding. Go's idiomatic `Runtime.Execute` return is unchanged.

References: [MCP results and schemas](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [TypeScript SDK errors](https://ts.sdk.modelcontextprotocol.io/v2/servers/errors). Consumers reading errors from `structuredContent` must switch to JSON in the text block.

### 5. Modern envelopes without protocolVersion were not covered

The shared corpus now includes a modern request without `io.modelcontextprotocol/protocolVersion`, retaining modern capabilities and, for HTTP, the version header. It produces **`-32602` and HTTP 400**. It is treated neither as an unknown version (`-32022`) nor as a legacy client with a valid handshake.

Reference: [MCP 2026-07-28 envelope and error requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic).

### 6. Validation deliberately accepted invalid SSE

The exception turning the Go SSE defect into a passed test was removed. Following the later decision to defer that transport, the reproducer moved to `scripts/investigate-go-sse.mjs` and a separate workflow. It still fails on raw JSON after progress. The required verifier does not advertise Go SSE support; it retains TypeScript/Rust SSE checks and every stdio/HTTP JSON test. Details and resumption criteria are in section D.

### 7. TypeScript declarations were not checked by a strict consumer

Internal `tsc` used `skipLibCheck`, and installation tests only imported JavaScript. Strict external compilation found `TS1543`: the public `defaults` declaration imported JSON without a NodeNext import attribute. `scripts/sync-contracts.mjs` now generates `defaults.generated.ts` with the structural type derived from authoritative defaults. `contract.ts` uses that type, preserving the same object and values; the published `.d.ts` no longer imports JSON.

The specific identity integration was removed by a later explicit decision. The strict consumer now validates the six current exports without that provider's dependencies or type projections. The build cleans previous output so removed modules/declarations no longer ship. Credential, context, scope, and error callbacks remain intact.

### 8. Actual Windows CI failures

[Run 39652399162](https://github.com/mapherez/nox-mcp/actions/runs/39652399162), at commit `64b580d`, had 17 jobs: 10 passed and 7 failed. Logs for every failed job were inspected. They revealed no error category beyond the two Windows failures below and the now-deferred Go SSE issue.

- **npm/PowerShell arguments:** in the minimum profile, npm interpreted `--language` and `--minimum` as configuration, leaving the script without arguments. The Rust job ran Go (default `all`) with an unselected Go toolchain. The matrix now directly calls `node scripts/check-consumers.mjs` with `NOX_CONSUMER_LANGUAGE` and `NOX_CONSUMER_PROFILE`. The parser requires complete, valid, conflict-free selection and prints the effective language/profile. The TypeScript package uses the same explicit profile without forwarding flags through npm. Tests cover all four native combinations and reject incomplete/invalid/conflicting configuration.
- **Git root:** lexical `resolve(...)` comparison rejected equivalent Windows paths, including short temporary-directory names. `update-version.mjs` now calls `realpath` on both paths and compares canonical roots. It uses no prefix matching and removes no clean-tree, branch, tag, identity, changed-file, or rollback checks; the new flow pushes only the preparation SHA, without tags. A junction/symlink integration test proves acceptance of the same repository; another confirms that a subdirectory containing valid version files remains rejected. Release tests modify only temporary repositories.

## B. Actual compatibility matrix

### Local environment and dependencies

Local platform: **Windows x64**. Toolchains: Node **24.0.0 / 24.22.0**, npm **11.21.1 / 12.2.0**, Go **1.26.0 / 1.26.3**, Rust **1.88.0 / 1.95.0**. Local Linux/macOS execution is not claimed.

| TypeScript: direct/peer dependency | Tested minimum | Tested recent resolution |
| --- | --- | --- |
| @modelcontextprotocol/server | 2.3.1 | 2.3.1 |
| ajv | 8.20.0 | 8.20.0 |
| @modelcontextprotocol/node (optional) | 2.0.0 | 2.1.1 |
| zod | 4.6.0 | 4.6.7 |
| ws (optional) | 8.19.0 | 8.22.0 |

Consumer compilation uses TypeScript 5.9.3, `@types/node` 24.10.13, and `@types/ws` 8.18.1. SDK installation is checked first without TypeScript or build hooks. The internal lockfile retains its existing peers; the recent table describes external installation, not a checkout upgrade.

| Go: direct module | Tested minimum MVS | Recent resolution |
| --- | --- | --- |
| github.com/coder/websocket | 1.8.15 | 1.8.15 |
| github.com/golang-jwt/jwt/v5 | 5.3.1 | 5.3.1 |
| github.com/google/jsonschema-go | 0.4.3 | 0.4.3 |
| github.com/modelcontextprotocol/go-sdk | 1.8.0 | 1.8.0; SSE defect pending |

Go requirements did not change. MVS prevents versions below those in `go.mod`; external modules resolve their own graph. Version 1.8.0 was the latest published MCP Go SDK version at the time of this audit's lookup.

| Rust: direct dependency | Tested minimum | SDK lockfile | Tested recent resolution |
| --- | --- | --- | --- |
| rmcp | 3.5.0 | 3.5.0 | 3.6.0 |
| jsonschema | 0.58.0 | 0.58.5 | 0.58.6 |
| chrono | 0.4.39 | 0.4.45 | 0.4.45 |
| serde | 1.0.220 | 1.0.229 | 1.0.229 |
| serde_json | 1.0.145 | 1.0.151 | 1.0.154 |
| tokio | 1.43.0 | 1.53.2 | 1.54.0 |
| tokio-util | 0.7.16 | 0.7.19 | 0.7.20 |
| sha2 | 0.10.9 | 0.10.9 | 0.10.9 |
| base64 | 0.23.1 | 0.23.1 | 0.23.1 |
| ryu-js | 1.0.0 | 1.0.3 | 1.0.3 |

Production rmcp features: `server`, `transport-streamable-http-server`, and `transport-io`, with defaults disabled. Consumers add `client` for tests; a separate build without that feature verifies production configuration. The minimum profile runs on Rust 1.88; the recent profile uses Rust 1.95 locally and 1.99.1 in CI. Exact pins exist only in the temporary minimum consumer.

### Transports and errors

| Feature / transport | TypeScript | Go | Rust |
| --- | --- | --- | --- |
| stdio and HTTP JSON, legacy clients | Supported / Required | Supported / Required | Supported / Required |
| SSE, including error framing after progress | Supported / Required | Investigating / Future Support | Supported / Required |
| Conventional tools/list; incremental discovery and modern negotiation | Supported / Required | Supported / Required | Supported / Required |
| CLI metadata, JCS/fingerprints, snapshots, caching, and authorization | Supported / Required | Supported / Required | Supported / Required |
| Results/schemas, domain errors, and rejection before execution | Supported / Required | Supported / Required | Supported / Required |
| Package/public API and independently resolved consumer | Supported / Required | Supported / Required | Supported / Required |

This table limits guarantees to tested SDK features and paths; it does not certify every optional MCP feature or product integration not executed in this task.

| Scenario | JSON-RPC | HTTP JSON |
| --- | --- | --- |
| Missing extension or incompatible version | -32021, exact `requiredCapabilities` | 400 |
| Unknown protocol | -32022, `requested` / `supported` | 400 |
| Missing required protocolVersion or clientCapabilities | -32602 | 400 |
| Invalid parameters inside the NoX handler | -32602 | TS and rmcp 3.6: 200; Go and rmcp 3.5: 400 |
| Stale definition/snapshot | -32602 with `STALE_DEFINITION` / `STALE_CATALOG` | SDK mapping |
| Runtime authorization/domain error | MCP `isError: true` result, JSON text | 200 |
| Error after SSE progress | Same JSON-RPC error as terminal event; already-started HTTP remains 200 | Go 1.8.0 non-conformant |

Handler error mapping differs from mandatory envelope errors. The corpus explicitly distinguishes rmcp 3.5 and 3.6; it does not relax mandatory HTTP 400 for negotiation/envelope errors. Legacy clients retain `initialize`, `tools/list`, and `tools/call`; incremental methods preserve their existing legacy rejection.

### Required CI and separate diagnostics

- Contracts, regressions, and transports: Windows and Linux.
- Minimum/recent consumers per language: Windows and Linux; recent Rust also on macOS.
- Minimum Node 24.0.0 with bundled npm; recent Node 24, 26, and current version.
- Minimum Go 1.26.0 and recent 1.26.x patch; minimum Rust 1.88 and recent stable.
- `contracts.yml`: **Supported / Required**, 17 required jobs; publication checks this SHA's approvals through `workflow_run` without repeating the workflow. Any failure blocks release.
- `investigating-go-sse.yml`: **Investigating / Future**, two Windows/Linux diagnostics. The invalid test remains red without `continue-on-error`, in a workflow independent of the release graph. It has only `workflow_dispatch`, no push/PR triggers, and must not be a required branch-protection check.
- Remote execution completed at commit [`9b45842`](https://github.com/mapherez/nox-mcp/commit/9b4584291c866ab7e988809942d3e44dc0aebdbf), branch [`codex/compatibility-finalization`](https://github.com/mapherez/nox-mcp/tree/codex/compatibility-finalization). [Required run 39662771266](https://github.com/mapherez/nox-mcp/actions/runs/39662771266) ended with **success, 17/17 jobs**. [Investigating run 39662771414](https://github.com/mapherez/nox-mcp/actions/runs/39662771414) ended with **failure, 2/2 reproductions of the known defect**. This result record was added to the local report after execution without changing validated code.

| Remote environment actually tested | Observed toolchains |
| --- | --- |
| Linux x64 | Node 24.0.0 / 24.21.0 / 24.22.0 / 26.12.1; Go 1.26.0 / 1.26.9; Rust 1.88.0 / 1.99.1 |
| Windows x64 | Node 24.0.0 / 24.22.0; Go 1.26.0 / 1.26.9; Rust 1.88.0 / 1.99.1 |
| macOS arm64 | Rust 1.99.1, recent Git/path consumer; Node 24.21.0 in the verifier |

Both Node selectors `26` and `node` resolved to **26.12.1** in this run; they are not evidence of another major version. That historical run installed npm 11.21.1; the current revision removed the override and validated Node 24.0.0/npm 11.3.0. Effective direct dependencies match the minimum/recent tables above. The Windows minimum Rust job explicitly confirms `language=rust, profile=minimum`, followed by rmcp 3.5.0, without running Go.

| Required job | Remote result |
| --- | --- |
| conformance / ubuntu-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828419) |
| conformance / windows-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828775) |
| consumer / go / latest / ubuntu-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828942) |
| consumer / go / latest / windows-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439829496) |
| consumer / go / minimum / ubuntu-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439829059) |
| consumer / go / minimum / windows-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828977) |
| consumer / rust / latest / macos-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828453) |
| consumer / rust / latest / ubuntu-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439829005) |
| consumer / rust / latest / windows-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828529) |
| consumer / rust / minimum / ubuntu-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828980) |
| consumer / rust / minimum / windows-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828870) |
| consumer / typescript / latest / ubuntu-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439829380) |
| consumer / typescript / latest / windows-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828426) |
| consumer / typescript / minimum / ubuntu-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828987) |
| consumer / typescript / minimum / windows-latest | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439829150) |
| Node / 26 | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439827925) |
| Node / node | [Passed](https://github.com/mapherez/nox-mcp/actions/runs/39662771266/job/119439828380) |

TypeScript tests recorded **168 passes on Windows** and **167 on Linux**; the difference is an additional Git GNU tar extraction test on Windows. Those suites have no failed, cancelled, or skipped tests. Both conformance jobs passed the 18 shared scenarios, native packaging, installed TypeScript consumer, payload budgets, and supported discovery/transport matrix. Rust consumer jobs ran `check --all-targets`, Git/path integration, and rejection of incompatible rmcp 3.2; Go/TypeScript jobs validated their own minimum/recent graphs.

## C. Regression checks

| Check | Evidence / failure now detected |
| --- | --- |
| `npm test` | 168 tests passed locally; execution, errors, limits, bridges, metadata, CI selection, and Git roots |
| `go test -mod=readonly ./...` | Passed on the declared graph |
| `cargo +1.88.0 test --all-targets --locked --manifest-path rust/Cargo.toml` | Passed locally; confirms the internal graph on MSRV. Minimum CI separately validates consumer resolution |
| `npm run test:conformance` | 18 identical observations across languages; errors without structuredContent, same functional content |
| `npm run test:discovery` | Hashes/JCS/CLI/cache/snapshots and negotiation; mandatory stdio/HTTP JSON in all three languages and TypeScript/Rust SSE |
| `npm run diagnose:go-sse` | **Non-conformant / Investigating**: reproduces all four Go SSE errors and exits with code 1; not a conformance approval |
| `npm run package:check -- --minimum` / `npm run package:check` | External installation, exports, compilation, strict outputSchema, authentication/domain behavior, and HTTP JSON/SSE discovery/cache |
| `npm run test:native-packages` | Passed: an actually packaged crate and independently resolved native consumers |
| `npm run benchmark:discovery` | Passed: budgets preserved, results below |
| `actionlint` | Static workflow validation; not equivalent to remote execution |
| `npm run test:consumers -- --language=rust --minimum` | Git/path, no inherited lockfile, all direct dependency minimums, application rmcp 3.0, rejection of 3.2, runtime, and transports |
| `npm run test:consumers -- --language=rust` | Same checks with recent resolution |
| `npm run test:consumers -- --language=go [--minimum]` | Compilation/execution, stdio/HTTP JSON, modern negotiation, and legacy clients, without advertising Go SSE |

To reproduce minimum Rust, first select the toolchain (`RUSTUP_TOOLCHAIN=1.88.0`); for Go, use `GOTOOLCHAIN=go1.26.0`. These variables apply to the test process. `npm run test:native-packages` retains actual Cargo package and separate module validation, now with independent consumer resolution.

In CI, native invocation is `node scripts/check-consumers.mjs` with both `NOX_CONSUMER_LANGUAGE=rust|go` and `NOX_CONSUMER_PROFILE=minimum|latest`. The tarball uses `npm run package:check` with `NOX_CONSUMER_PROFILE`. Each job therefore proves only its configured selection, independently of npm argument forwarding on Windows.

Shared tests verify changes, removals, and availability; authorization partitions; complete catalogs before accepting removals; retention of previous cache on failures/partial responses/tampering; invalidation during synchronization; unknown metadata and `_meta.cli`. The same network verifier runs against checkout hosts and consumers. No new descriptors, hash algorithms, CLI contracts, or authorization mechanisms were introduced.

Network hosts use public NoX runtimes in all three languages. The old Go fixture directly built `mcp.Server.AddTool`, bypassing NoX runtime error normalization; it now uses `NewFromManifestWithDiscovery`. Real execution counters prove that `STALE_DEFINITION`, unavailability, and revocation are rejected before execution; subsequent synchronization removes revoked tools from cache. A real domain error is verified over the same transport.

The benchmark retains its budgets: with 100 tools, conventional discovery transfers 175 929 bytes versus 11 863 bytes for one changed tool (93.3% reduction); an unchanged catalog transfers 526 bytes. Cold incremental discovery is larger (203 851 bytes), as before. These are uncompressed synthetic JSON-RPC payloads; a still-fresh conventional MCP cache may also avoid transfers.

## D. Remaining open issues

### Investigating / Future Support: Go SSE

Cause: `mcp/streamable.go`, `extractErrorStatus` / `stream.deliverLocked`. Errors `-32021`, `-32022`, `-32602`, and `-32601` enter a path writing JSON with status 400/404 without checking whether an SSE notification has already been sent. After headers/progress, status remains 200, and the error is written outside a `data:` event. A correct SSE client never receives the terminal response.

This affects custom handlers/middleware emitting progress before returning one of those codes, including NoX integrations exposing the server through the official SSE handler. It is not a fingerprint/cache issue. NoX negotiation rejects before emitting progress; Go `Runtime.HTTPHandler()` uses JSON responses and is unaffected by this late SSE error case.

Investigation: the public API allows choosing JSON/SSE, not correcting the internal response-writing path. No version newer than 1.8.0 was published at the time of the lookup. Forcing JSON globally would remove streaming; rewriting the body in a ResponseWriter would be a serialization workaround; vendoring/forking would exceed a small sustainable correction. None of these changes was made.

Approved classification: **Investigating / Future Support**, without blocking current requirements. No identified NoX Suite feature depends on this behavior according to the user's scope decision; products were not accessed to repeat that audit. Go stdio and HTTP JSON remain supported. The transport API was neither removed nor replaced, but SSE use remains outside this revision's support guarantee.

Reproduction: `npm run diagnose:go-sse`, with Go SDK 1.8.0, returns HTTP 200 after progress and finds JSON outside `data:` for all four codes. The command retains exit code 1; the separate workflow identifies failure without turning it into success or mixing it with required jobs. No custom transports, forks, architectural changes, or serialization workarounds were introduced.

Reconsider when an upstream fix is published or a safe solution through official APIs becomes available, accompanied by a concrete product need. Before promoting support, require terminal framing tests for all four codes, calls/results/errors, negotiation, and legacy clients on Windows/Linux, plus explicit approval of the support matrix change. A diagnostic that stops failing does not automatically promote support.

### Other platform results and the already published tag

Complete remote results for the current revision are in section B: all 17 required jobs passed, including Windows/Linux, recent Rust on macOS, and current Node. No blockers remained in tested supported requirements; Go SSE retains its separate classification.

Published Git tag `v0.5.0` still refers to the old code: this working-tree revision does not retroactively repair installations of that tag. Future publication and any application migration remain outside this task.

## E. Review after v0.6.0: single release pipeline and identity integration removal

### Changes and files

| Area | Files |
| --- | --- |
| Triggers and publication | `.github/workflows/contracts.yml`, `.github/workflows/release.yml`, `.github/workflows/investigating-go-sse.yml` |
| Release preparation and gate | `scripts/release.mjs`, `scripts/update-version.mjs`, `scripts/release-policy.mjs`, `scripts/publish-release.mjs` |
| Build and installation | `scripts/build.mjs`, `scripts/check-package.mjs`, `package.json`, `package-lock.json` |
| Regressions | `scripts/build.test.mjs`, `scripts/update-version.test.mjs`, `scripts/publish-release.test.mjs` |
| Removed integration | Identity adapter source deleted; export, peers, development dependencies, projected types, parity test, and component pins removed |
| Documentation | `README.md`, `COMPATIBILITY_AUDIT.md`, `COMPATIBILITY_BASELINE.md`, `DISCOVERY.md`, `MIGRATION_0_5.md`, `contracts/README.md` |

The lockfile gained no dependencies and lost 23 entries. The package has six entry points: root, contract, bridge, bridge/client, bridge/server, and node. The build cleans `typescript/dist` before compiling; an isolated test without checkout mutation demonstrates removal of obsolete JS and declarations. Strict installation/compilation verifies all six actual tarball exports. Minimum npm is no longer globally upgraded: Node 24.0.0/npm 11.3.0 passed without that workaround.

The removed provider was not replaced. Credentials, context, scopes, permissions, pre-executor rejection, and error contracts remain in existing mechanisms. API keys belong to NoX Backend; Google Account and future NoX Account remain product responsibilities. No identity flows were implemented. Go/Rust, schemas, and protocols were unchanged in this revision.

### Final flow

1. `npm run release` requires clean master, checks versions/Go major/tags, and prepares a commit with `NoX-Release: X.Y.Z`. Only that SHA is pushed to master with `--no-follow-tags`.
2. The push runs the required 17-job matrix once. There is no `workflow_call` or duplicated local testing; PRs to master also use the matrix without another source-branch push CI run.
3. `workflow_run` accepts only successful completion of a master push from this repository with explicit intent. The publisher verifies workflow identity/path, run, SHA, current branch, and all 17 approvals; later attempts replace only rerun jobs for the same SHA.
4. The package is rebuilt with the approved commit's lockfile: installation without hooks, build, and `npm pack --ignore-scripts`. Suites and `contracts:check`/prepack are not repeated. Package version and tree integrity are verified before any remote write.
5. The annotated tag points to the approved SHA. The release remains a draft until upload completes and asset size is confirmed. Making it public is the final API operation. Global concurrency serializes publishers; existing objects are never replaced.

A prepared version without intent still requires an authorization commit, possibly empty. Retrying unchanged intent reuses the SHA. Failure after tag creation can leave an unpublished tag/draft; recovery requires explicit review without automatically deleting or replacing versions. Before first use, install these workflows on master in an ordinary commit without release intent. The `workflow_run` listener must exist on the default branch, as described in [GitHub documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).

The Go SSE diagnostic retains scripts and tests but has only `workflow_dispatch`. It was neither run nor investigated in this task. The intermittent Rust failure was not investigated and prompted no changes.

### Tests actually executed in this revision

Platform: Windows x64. The new publication flow was exercised against a local HTTP API and temporary Git repositories without any write to real GitHub.

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts` and `npm test` | Passed; 198 tests, zero failures/skips/cancellations |
| Gate/publisher | Real simulated HTTP; 17 jobs, SHA, version, forks/PRs, missing/duplicate/failed/skipped jobs, attempts, concurrent master, existing tags/releases, build/upload failures; no premature publication |
| Git preparation | Master, clean tree, Windows aliases, version/Go major, rollback, cancellation, tag-free push even with followTags, non-fast-forward rejection, and same-SHA retry |
| `go test -mod=readonly ./...` and `cargo test --locked --manifest-path rust/Cargo.toml` | Passed without modifying native suites |
| `npm run test:conformance` | 18 identical observations in all three languages, including authorization and errors |
| `npm run test:discovery` | Passed within supported scope: stdio/HTTP JSON in all three languages and TypeScript/Rust SSE |
| `npm run package:check`, minimum/recent profiles | Passed; real consumers, legacy/modern HTTP JSON/SSE, six exports, and strict TypeScript |
| Minimum Node consumer | Node 24.0.0/npm 11.3.0; installation and compilation passed without npm override |
| Minimum/recent Go consumers | Go 1.26.0/1.26.3; independent resolution, execution, and transports passed |
| Minimum/recent Rust consumers | Rust 1.88/1.95, rmcp 3.5/3.6; Git/path, production without client feature, integration, and transports passed |
| `npm run test:native-packages` | Native packages installed and executed outside the checkout |
| `npm run benchmark:discovery` | Budgets preserved; 93.3% reduction for one change among 100 tools |
| `actionlint`, `git diff --check` | Passed |

The 17 remote jobs in section B are historical evidence, not execution of the new revision. No real release was launched and no consumer applications changed. Tag `v0.6.0` remains at commit `726c53f77608d33bf59849d7b851b7ed36a5900b`; public manifest versions remain 0.6.0. No regressions were observed in executed tests; actual GitHub listener/publisher integration still depends on normal workflow installation on master, without publishing in this task.

## F. October 24, 2026 — HTTP profile and intermittent runtime regressions

These findings extend the historical report; they do not revise the results or public versions recorded above. The SDK's public version in this work is **0.6.1**, unchanged.

### Confirmed failures and corrections

- [Run 40046289985](https://github.com/mapherez/nox-mcp/actions/runs/40046289985), commit `46ef090`: 14/17 jobs passed. All three recent Rust consumer jobs resolved rmcp 3.7.0 and failed handler validation with `200 !== 400`. The earlier correction at `64b580d` selected an exact `rust@3.6` override; any other minor silently inherited the old HTTP 400 expectation. This was reproduced locally before editing the selector. The packaged official 3.5/3.6/3.7 transport implementations confirm the behavior boundary at 3.6.
- [Run 39667704875](https://github.com/mapherez/nox-mcp/actions/runs/39667704875), commit `726c53f`: 16/17 jobs passed. Rust minimum/Windows, using Rust 1.88/rmcp 3.5, returned `TIMEOUT` where `unexpected-error-sanitized` expected `INTERNAL`. The universal 30 ms test budget competed with scheduling/panic handling and the runtime's required final deadline check. A controlled 60 ms delayed error reproduced that exact mismatch under the old budget. Section E had explicitly left this intermittent failure uninvestigated.

The HTTP corpus now defines non-overlapping profiles: rmcp >=3.5,<3.6 expects 400 for invalid handler parameters; >=3.6,<4 expects 200. A shared selector validates full resolved versions and rejects unsupported/missing/ambiguous profiles. Both checkout and independent consumers read Cargo metadata. Tests cover boundaries, later compatible minors, invalid policies, and mandatory envelope/negotiation statuses. Actual responses still have exactly one expected status; future dependency regressions are not automatically accepted.

The runtime corpus now supplies test-only budgets of 5 seconds for ordinary/error/cancellation cases and 1 second for deliberate timeouts, consumed by all three harnesses. The delayed-error regression still requires `INTERNAL`, sanitization, and no successful structured output. Timeout/cancellation assertions, write unknown-outcome semantics, production defaults, runtime source, and authorization are unchanged.

### Validation of the correction

Local platform: Windows x64; Node 24.22.0, Go 1.26.0/1.26.3, Rust 1.88.0/1.95.0 as applicable.

| Check | Actual local result |
| --- | --- |
| `npm test` | 202 passed; no failures, skips, or cancellations; includes four new HTTP-policy tests |
| Complete Go and Rust suites | Passed; Go graph read-only, Rust all targets with locked SDK graph |
| Runtime conformance | 18 matching scenarios across TypeScript, Go, and Rust |
| Minimum Rust runtime repetition | 20/20 independent process runs passed; 360 scenario observations, without retrying failures |
| Discovery conformance | Matching JCS/fingerprints/CLI/cache; real stdio/HTTP JSON and legacy clients in all languages; SSE in TypeScript/Rust |
| Rust independent Git/path consumers | Minimum Rust 1.88/rmcp 3.5 and recent Rust 1.95/rmcp 3.7 passed, including production compilation, runtime, transports, and rejection of incompatible rmcp 3.2 |
| Additional rmcp 3.6 transport fixture | Supported transports passed; a further 20/20 complete wire repetitions passed |
| Go independent consumers | Minimum/recent dependency profiles passed, including stdio/HTTP JSON and legacy clients |
| Installed TypeScript consumers | Minimum/recent dependency profiles passed, strict compilation and real HTTP JSON/SSE |
| Native distribution | Actual packaged Rust crate and external Go/Rust consumers passed without root contracts or Node compilation hooks |
| Discovery benchmark | Existing budgets passed; one change among 100 tools remains 93.3% smaller than conventional discovery |

The first extra rmcp 3.6 transport run produced a generic `fetch failed` after stdio passed. It did not reproduce on the subsequent single run or 20 full repetitions. Its network cause is **unconfirmed**, and no retry was inserted into required tests. The wire runner now preserves the original error cause and failing method so a recurrence can be diagnosed rather than masked. That initial failure is not counted as a pass.

This table records local validation only. Cross-platform GitHub approval must refer to the exact tested SHA and run; local results do not certify Linux/macOS or a later revision. Go SSE remains Investigating; no custom transport, dependency pin/update, public API/version change, release, or consumer-product modification is part of this correction.
