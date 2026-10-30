# NoX MCP documentation

Start with the [project README](../README.md) for installation, the main APIs, and the release process.

Repository documentation is maintained in English, including historical documents.

| Current document | Contents |
| --- | --- |
| [NoX Suite implementation plan](NOX_SUITE_IMPLEMENTATION_PLAN.md) | Source of truth for approved requirements, responsibilities, implementation order, and pending technical decisions |
| [Product integration design](PRODUCT_INTEGRATION_PROPOSAL.md) | Consolidated product declaration, Backend registration, lifecycle, failure handling, and migration requirements; historical filename retained; shared SDK implementation available |
| [Gateway and shared integration contract](GATEWAY_CONTRACT.md) | Product-independent normative contract for pairing, service credentials, five-minute delegated authorization, events, aggregation, caches, and execution; Gateway/CLI/Portal do not yet exist |
| [Suite SDK integration](INTEGRATION.md) | Implemented TypeScript/Go/Rust APIs, native runtime admission, examples, verification, and service responsibilities |
| [Compatibility and support](COMPATIBILITY.md) | Supported matrix, dependencies, errors, validation, and known limitations |
| [CLI metadata and incremental discovery](DISCOVERY.md) | Extension contract, server/client examples, fingerprints, snapshots, and caching |
| [Contract maintenance](../contracts/README.md) | Authoritative schemas, generation, and conformance tests |

The Suite design documents apply to any current or future conforming product. Existing products will need adaptation; their present implementations do not constrain the shared contracts. The integration guide distinguishes implemented SDK mechanisms from the separate Backend/service/product work.

## History

[old/](old/README.md) contains earlier audits, the migration to 0.5.0, and historical HTTP client results. These documents preserve evidence and decision context; they are not guides to the current implementation. Consumer versions and test results recorded there apply only to the identified revisions.
