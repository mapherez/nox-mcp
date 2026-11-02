# NoX MCP documentation

**Current work, November 2, 2026:** SDK `0.7.1` is released. [Suite correction scope and migration](SUITE_CORRECTION_STATUS.md) records its corrections, the fixed work sequence and remaining consumer work. [Same-host presence, communication and registration](SUITE_SAME_HOST_INTEGRATION.md) records the owner's deployment clarification and proposed local-channel implementation. That service behavior is not yet implemented; it is not supplied by the SDK release.

Start with the [project README](../README.md) for installation, the main APIs, and the release process.

Repository documentation is maintained in English, including historical documents.

The Suite wire contract remains `1.0`. The October 30 delivery baseline was SDK `0.7.0`; `0.7.1` adds the shared HTTP/HTTPS correction. Follow the [current correction sequence](SUITE_CORRECTION_STATUS.md#fixed-correction-sequence) for ongoing work. Product adaptations and service implementation are separate from SDK delivery.

| Current document | Contents |
| --- | --- |
| [NoX Suite implementation plan](NOX_SUITE_IMPLEMENTATION_PLAN.md) | Historical plan with later additions; the correction record identifies the original revision and subsequent owner clarifications |
| [Same-host presence, communication and registration](SUITE_SAME_HOST_INTEGRATION.md) | Same-machine boundary, proposed local sockets/volume, presence versus membership, automated setup, Yard registration, migration and acceptance |
| [Suite correction scope and progress](SUITE_CORRECTION_STATUS.md) | Original-plan reference, released SDK correction, fixed 12-point sequence and remaining consumer work |
| [Product integration design](PRODUCT_INTEGRATION_PROPOSAL.md) | Consolidated product declaration, Backend registration, lifecycle, failure handling, and migration requirements; historical filename retained; shared SDK implementation available |
| [Gateway and shared integration contract](GATEWAY_CONTRACT.md) | Product-independent normative contract for pairing, service credentials, five-minute delegated authorization, events, aggregation, caches, and execution; Gateway/CLI/Portal do not yet exist |
| [Suite SDK integration](INTEGRATION.md) | Consuming SDK `0.7.1`, implemented TypeScript/Go/Rust APIs, native runtime admission, examples, verification, and service responsibilities |
| [Compatibility and support](COMPATIBILITY.md) | Supported matrix, dependencies, errors, validation, and known limitations |
| [CLI metadata and incremental discovery](DISCOVERY.md) | Extension contract, server/client examples, fingerprints, snapshots, and caching |
| [Contract maintenance](../contracts/README.md) | Authoritative schemas, generation, and conformance tests |

The Suite design documents apply to any current or future conforming product. Existing products will need adaptation; their present implementations do not constrain the shared contracts. The integration guide distinguishes implemented SDK mechanisms from the separate Backend/service/product work.

## History

[old/](old/README.md) contains earlier audits, the migration to 0.5.0, and historical HTTP client results. These documents preserve evidence and decision context; they are not guides to the current implementation. Consumer versions and test results recorded there apply only to the identified revisions.
