> **Archived historical document.** The versions, results, and status statements below apply to the revisions described. See the [current documentation](../README.md).

Status note: this document preserves the historical 0.5.0 migration. Version 0.6.0 has also been published and remains untouched. The subsequent pipeline and public-entry-point review is described in the README and audit section E.

# Migration to 0.5.0

Tag `0.5.0` has already been published. The historical notes below explain migration to that version. The working tree now contains additional corrections under review, **without a new release or version increment**; these corrections do not retroactively change the published tag. Install an explicit version/tag, review the lockfile, and test each product before updating.

## Additional corrections under review

- Rust now requires rmcp 3.5.0 or a compatible higher version and the compiled minimum versions listed in the [audit](COMPATIBILITY_AUDIT.md).
- With explicit user approval, MCP `isError: true` results no longer include `structuredContent`. Read the JSON body from `content[].text`; `code`, `message`, `retryable`, details, and extensions are preserved. Successful results remain in `structuredContent`. This avoids validating an authentication/domain error against the success `outputSchema`.
- Full Go SSE support was explicitly deferred: `Investigating / Future Support`. The diagnostic continues failing on the invalid response after progress; stdio and HTTP JSON remain mandatory. Consult the audit matrix and results before publication.

Bridge protocol versions (`1.0`/`2.0`) and manifest schema version (`1`) do not change: envelopes remain intact, and the changes concern library validation and execution. The MCP protocol was not redesigned. Historical baseline observations remain, except for the later expressly authorized removal of the specific identity integration.

## Confirmed breaking changes

| Before | From 0.5.0 onward | Migration |
| --- | --- | --- |
| The structural schema accepted scalar/array/null `_meta`; the Rust loader interpreted it differently. | When present, `_meta` is an object in all languages. Empty objects, `_meta.cli`, and custom properties are preserved. | Omit absent metadata; carry custom values inside an object. Do not replace `{}` with `null`. |
| TypeScript parsing inserted `retryable: false` into documents lacking the field; Go/Rust did not. | Structural validation does not modify documents. Only the execution boundary materializes `false` in produced errors. | When reading parser output directly, use `error.retryable ?? false` or explicitly distinguish absence. |
| `ToolManifestEntry.annotations` required four booleans in TypeScript even though JSON allowed them to be omitted. | All four members are optional, matching the contract. | Review reads assuming a required `boolean`; use `=== true` to recognize an explicit hint. |
| Rust `load_tools` ignored `requiredScopes`, including malformed values. | It validates the full manifest and rejects non-empty requirements because `Vec<Tool>` cannot carry them. | Use `McpServer::from_manifest` to execute manifests with requirements; use `load_manifest` for lossless inspection. Do not remove requirements to bypass validation. |
| Rust `load_tools` accepted schema objects without checking compilability. Engines applied assertions/formats differently. | Preparation checks the shared profile and fails early on invalid or non-portable schemas. | Validate manifests in CI. Adapt schemas to the documented profile; retain native APIs when a tool deliberately depends on another dialect. |
| Empty requirements could reach execution with different meanings. | `requiredScopes: [""]` and empty requirements in native configurations are invalid. | Remove empty strings; keep an empty list only when there are no requirements. Granted scopes still come from authentication. |
| Lengths could count Go/Rust bytes or TypeScript UTF-16 units. | Contract limits count Unicode code points, including names up to 64 characters. | Do not truncate names by bytes. Existing tool names are unchanged. |
| TypeScript SDK/validation could emit errors outside the NoX boundary; invalid output could be confused with input errors. Rust did not normalize executor errors/panics. | Invalid input → `INVALID_INPUT`; invalid output/malformed error and unexpected failures → `INTERNAL`. Structured errors are validated, sanitized, and bounded. | Review clients/tests relying on SDK errors, internal messages, or errors without a structured body; preserve valid domain codes and details. |
| Some cancellation/deadline paths differed in code, `retryable`, details, and acceptance of late results. | One deadline from runtime entry; `TIMEOUT`/`CANCELLED`, retryability only for explicit reads, unknown outcomes for other operations. | Respect the received signal/context and deadline. Handle `details.outcome: "unknown"` without automatically retrying writes. |
| Rust `McpServer::new` could accept duplicate names, invalid schemas, and policies for nonexistent tools. | These configurations are rejected at startup. | Fix names/policies and schemas before creating the server. |
| Go `Tool` did not represent `openWorldHint`. | Added `OpenWorld *bool`; `nil` means absent. | Use named-field literals. Positional literals must be adapted to the new field. |

New complete loaders and manifest constructors do not replace native APIs. They are the explicit path for sharing the same JSON and validation rules across languages. Binding accepts only application-supplied executors; it does not execute code from metadata. Declared requirements are combined with local policy and never granted to the user.

The shared profile rejects unknown dialects/keywords/formats, remote or recursive references, and non-portable regex. It supports `multipleOf` only with a safe positive integer: Go was confirmed to reject `0.3` with divisor `0.1` while Rust accepted it. The restriction is explicit in all three implementations; arbitrary decimal equivalence is not promised. Native APIs retain their previous scope. See the [full rules](../../contracts/README.md#tool-schemas).

Ajv is added as a TypeScript runtime dependency for draft-07 compilation. Existing dependency versions were not upgraded. Go/Rust continue compiling as external dependencies without Node scripts.

## Expected consumer impact

The references below were inspected read-only. No product code, dependencies, or lockfiles were changed, and product integration suites were not run. Installed versions remain independent of this checkout.

| Product | Observed dependency | Impact of a future update |
| --- | --- | --- |
| NoX Backend | Go `v0.4.3`, tools constructed in code | Existing literals use named fields. Review validation errors, deadlines, cancellation, and scopes; it may continue using `New`. |
| NoX Yard | Go `v0.4.3`, tools and workflows in code | Same checks as Backend, including cancellation of effectful operations. Preserve names, schemas, and `_meta.cli`. |
| NoX Bot | TypeScript `0.4.3`, Zod schemas and `formatError` | Retains `createServer`/Node adapter and native schemas. Test domain errors and `WRITE_UNCONFIRMED`, validation, and cancellation. Formatters must produce a valid error body. |
| NoteX | TypeScript `0.4.3` at root and `0.4.1` in backend/contracts; Rust `0.1.0` pinned to `fd1b688d700b37caf96961c15f6d7022a09ab7a4` | **Untouched.** Do not update in this phase. A future migration must exercise the real manifest, `load_tools`/scopes, error extensions, bridges, tickets, desktop broker, and cross-version integration. |

NoteX does not receive this normalization through `nox-mcp` generation or CI: pinned artifacts and references continue using earlier versions. Automatic compatibility of `0.5.0` with unmigrated/untested code is not claimed.

## Explicit adoption

1. Keep the current reference until an approved release exists. Do not replace an installed version with a moving branch.
2. Review changes and validate real manifests with the new functions. SDK projections do not preserve the complete document.
3. When adopting manifest constructors, separately supply trusted bindings/executor, local policy, and authenticated identity. Test missing permission, explicit authorization, and inability to remove local requirements.
4. Run product suites for errors, limits, cancellation, transports, and, where applicable, desktop/bridge behavior.
5. Deliberately update dependencies and lockfiles only in that product. Publication and those updates are outside this step.

Equivalence is checked for shared contracts and profile, with legitimate SDK/transport differences documented in [contracts/README.md](../../contracts/README.md). New contracts may be designed on this foundation; publication and product migration remain later decisions.
