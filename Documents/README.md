# NoX MCP documentation

**Current work, November 3, 2026:** SDK `0.7.2` and Backend `v1.1.1` are released; the owner reported Gateway `v0.0.1` registered in Backend. Yard integration is unfinished. [Implementation-plan section 20](NOX_SUITE_IMPLEMENTATION_PLAN.md#20-nox-auth-and-shared-nox-login) records shared login responsibilities, confirmed five-minute admission checks and the Auth → Yard → other-app adaptation order. Auth service/Go client source and container/check tooling now exist in `nox-auth`; its requirements contract is `NOX_AUTH_CONTRACT.md`, with exact routes in `docs/integration.md`. Product login adapters and real Google/Yard acceptance remain pending. [Suite correction scope and progress](SUITE_CORRECTION_STATUS.md) preserves the fixed work sequence and actual remaining work. [Same-host presence, communication and registration](SUITE_SAME_HOST_INTEGRATION.md) remains the local-channel reference; the SDK release itself does not create local channels.

Start with the [project README](../README.md) for installation, the main APIs, and the release process.

Repository documentation is maintained in English, including historical documents.

The Suite wire contract remains `1.0`. The October 30 delivery baseline was SDK `0.7.0`; `0.7.1` adds the shared HTTP/HTTPS correction and `0.7.2` publishes the same-host design record. Follow the [current correction sequence](SUITE_CORRECTION_STATUS.md#fixed-correction-sequence) for ongoing work. Product adaptations and service implementation are separate from SDK delivery.

| Current document | Contents |
| --- | --- |
| [NoX Suite implementation plan](NOX_SUITE_IMPLEMENTATION_PLAN.md) | Plan with dated additions, including the owner-authorized November 3 NoX Auth decision in section 20; the correction record identifies the original revision and subsequent clarifications |
| [Same-host presence, communication and registration](SUITE_SAME_HOST_INTEGRATION.md) | Same-machine boundary, proposed local sockets/volume, presence versus membership, automated setup, Yard registration, migration and acceptance |
| [Suite correction scope and progress](SUITE_CORRECTION_STATUS.md) | Original-plan reference, released SDK correction, fixed 12-point sequence and remaining consumer work |
| [Product integration design](PRODUCT_INTEGRATION_PROPOSAL.md) | Consolidated product declaration, Backend registration, lifecycle, failure handling, and migration requirements; historical filename retained; shared SDK implementation available |
| [Gateway and shared integration contract](GATEWAY_CONTRACT.md) | Product-independent normative contract for pairing, service credentials, five-minute delegated authorization, events, aggregation, caches, and execution; separate Gateway/CLI/Portal implementation responsibilities |
| [Suite SDK integration](INTEGRATION.md) | Consuming SDK `0.7.2`, implemented TypeScript/Go/Rust APIs, native runtime admission, examples, verification, and service responsibilities |
| [Compatibility and support](COMPATIBILITY.md) | Supported matrix, dependencies, errors, validation, and known limitations |
| [CLI metadata and incremental discovery](DISCOVERY.md) | Extension contract, server/client examples, fingerprints, snapshots, and caching |
| [Contract maintenance](../contracts/README.md) | Authoritative schemas, generation, and conformance tests |

The Suite design documents apply to any current or future conforming product. Existing products will need adaptation; their present implementations do not constrain the shared contracts. The integration guide distinguishes implemented SDK mechanisms from the separate Backend/service/product work.

## History

[old/](old/README.md) contains earlier audits, the migration to 0.5.0, and historical HTTP client results. These documents preserve evidence and decision context; they are not guides to the current implementation. Consumer versions and test results recorded there apply only to the identified revisions.
