# NoX MCP documentation

**Current status, November 10, 2026:** SDK `0.7.3` is released. Backend, Yard and Gateway source consume it. The owner has confirmed installed Backend/Yard NoX Login, global logout, Yard/Gateway registration, and Backend `v1.2.2` service-status execution through the CLI. Gateway response corrections and Yard menu descriptors have local verification; this does not establish installed acceptance of those changes. The owner deferred Yard menu work after rejecting its current interaction design. See [the correction record](SUITE_CORRECTION_STATUS.md) for current evidence and dated history. [Same-host presence, communication and registration](SUITE_SAME_HOST_INTEGRATION.md) remains the local-channel reference; the SDK itself does not create local channels. Auth requirements remain in `nox-auth/NOX_AUTH_CONTRACT.md`.

Start with the [project README](../README.md) for installation, the main APIs, and the release process.

Repository documentation is maintained in English, including historical documents.

The Suite wire contract remains `1.0`. SDK `0.7.1` adds the shared HTTP/HTTPS correction, `0.7.2` publishes the same-host design record, and `0.7.3` separates normal MCP tool publication from human CLI metadata. The [original correction sequence](SUITE_CORRECTION_STATUS.md#fixed-correction-sequence) retains its names and numbering; subsequent owner instructions determine the active scope. Product adaptations and service implementation are separate from SDK delivery.

| Current document | Contents |
| --- | --- |
| [NoX Suite implementation plan](NOX_SUITE_IMPLEMENTATION_PLAN.md) | Plan with dated additions, including the owner-authorized November 3 NoX Auth decision in section 20; the correction record identifies the original revision and subsequent clarifications |
| [Same-host presence, communication and registration](SUITE_SAME_HOST_INTEGRATION.md) | Same-machine boundary, local sockets/volume, presence versus membership, automated setup and Yard registration |
| [Suite correction scope and progress](SUITE_CORRECTION_STATUS.md) | Original-plan reference, released SDK correction, fixed 12-point sequence and remaining consumer work |
| [Product integration design](PRODUCT_INTEGRATION_PROPOSAL.md) | Consolidated product declaration, Backend registration, lifecycle, failure handling, and migration requirements; historical filename retained; shared SDK implementation available |
| [Gateway and shared integration contract](GATEWAY_CONTRACT.md) | Product-independent normative contract for pairing, service credentials, five-minute delegated authorization, events, aggregation, caches, and execution; separate Gateway/CLI/Portal implementation responsibilities |
| [Suite SDK integration](INTEGRATION.md) | Consuming SDK `0.7.3`, implemented TypeScript/Go/Rust APIs, native runtime admission, examples, verification, and service responsibilities |
| [Compatibility and support](COMPATIBILITY.md) | Supported matrix, dependencies, errors, validation, and known limitations |
| [CLI metadata and incremental discovery](DISCOVERY.md) | Extension contract, server/client examples, fingerprints, snapshots, and caching |
| [Contract maintenance](../contracts/README.md) | Authoritative schemas, generation, and conformance tests |

The Suite design documents apply to any current or future conforming product. Existing products will need adaptation; their present implementations do not constrain the shared contracts. The integration guide distinguishes implemented SDK mechanisms from the separate Backend/service/product work.

## History

[old/](old/README.md) contains earlier audits, the migration to 0.5.0, and historical HTTP client results. These documents preserve evidence and decision context; they are not guides to the current implementation. Consumer versions and test results recorded there apply only to the identified revisions.
