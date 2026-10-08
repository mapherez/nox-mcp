# HTTP JSON default validation

Validated on Windows on 2026-10-08, against the implementation for the next
release (package version remains 0.4.1; nothing was published).

Environment: Node 24.21.0, npm 11.19.0, Go 1.26.3, Cargo 1.95.0.
Installed MCP server/client SDK packages: 2.3.1; Node adapter SDK: 2.1.1.

## Automated checks

| Command | Result |
| --- | --- |
| `npm test` | Passed: 34 tests, including 20 HTTP tests |
| `npm run package:check` | Passed: fresh installed tarball consumer, JSON and SSE in both protocol eras, without TypeScript installed |
| `go test -mod=readonly ./...` | Passed |
| `cargo test --locked --manifest-path rust/Cargo.toml` | Passed: 2 unit and 3 integration tests |
| `git diff --check` | Passed |

HTTP tests use real localhost servers through `toNodeHandler`. They exercise
legacy 2025-11-25 and modern 2026-07-28 flows, native JSON versus explicit SSE,
Accept negotiation (including absence, wildcards and specific q=0 exclusions),
notifications, modern SSE subscriptions, stateless methods, protocol/body
errors, authentication/scopes, custom errors, schemas/metadata, input/output
limits, timeouts, overload, cancellation, disconnects and idempotent shutdown.
Both eras are also exercised using the SDK client. Tarball consumers import
only installed public package exports.

## Real clients, direct endpoints

Each validation starts the library's Node HTTP endpoint with only a harmless
`echo` tool. The observer records request methods and response headers on that
endpoint; it does not change requests or response bodies. Neither a proxy nor
an SDK-only client substitutes for the real application's MCP client.

| Client | Version | Result |
| --- | --- | --- |
| Codex app-server, bundled with VS Code extension 26.1002.51308 | `codex-cli 0.162.0-alpha.2` | Connected, listed `echo` with schemas, annotations and `_meta`, then called it once; structured result preserved |
| LM Studio desktop REST API, local `gemma-4-e4b-it` model | `0.4.25+1` | Connected, listed tools and called `echo` once with `lmstudio-direct-json`; returned the tool result and `DONE` |

For both clients, `initialize`, `tools/list` and `tools/call` returned
`200 application/json`. `notifications/initialized` returned an empty `202`.
Their attempted GET event streams received `405`, as required for this
stateless endpoint, without preventing discovery or the tool call.

Codex used an isolated temporary `CODEX_HOME` and app-server RPCs; no model
turn or user configuration change was required. Reproduce after building:

```powershell
node scripts/validate-codex-http.mjs <path-to-codex.exe>
```

LM Studio rejects dynamic remote MCP integrations pointing at localhost.
The successful test therefore used a temporary preconfigured HTTP entry
`mcp/nox-json-validation` in its native `mcp.json`. Its server initially denied
calls to preconfigured MCPs (`403`). With explicit user approval, the test
temporarily enabled that permission, required authentication with a temporary
token, and restarted LM Studio to reload the settings. Only the echo tool was
allowed by the chat integration. After stopping the test daemon, the original
MCP configuration was restored and the initially absent permissions file was
removed in `finally`. Stopping first prevents cached settings from being
persisted again during exit. A repeated successful run verified cleanup.
Tokens are not logged.

```powershell
# Permission changes and restarting an existing desktop process require approval.
# The optional final PID identifies the desktop process approved for restarting.
node scripts/validate-lmstudio-http.mjs http://127.0.0.1:1234 gemma-4-e4b-it <mcp.json> <permissions-store.json> <lms.exe> [approved-desktop-PID]
```

These validations cover the installed client versions and a harmless local
tool, not every client version or application workflow. NoX Bot migration
remains a later change in its repository; NoteX and Yard were not migrated.
This change standardizes transport responses and does not identify the cause
of the earlier transient Codex connection failure.
