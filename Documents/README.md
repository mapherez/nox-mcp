# NoX MCP documentation

Start with the [project README](../README.md) for installation, the main APIs, and the release process.

Repository documentation is maintained in English, including historical documents.

Delivery baseline, updated **October 30, 2026**: [NoX MCP `0.7.0`](https://github.com/mapherez/nox-mcp/releases/tag/v0.7.0) is published and available to consumers; the Suite wire contract remains `1.0`. Next, follow the [Backend work sequence and completion criteria](NOX_SUITE_IMPLEMENTATION_PLAN.md#19-current-delivery-and-next-work-backend). Product migrations and service implementations are still pending.

| Current document | Contents |
| --- | --- |
| [NoX Suite implementation plan](NOX_SUITE_IMPLEMENTATION_PLAN.md) | Approved requirements, responsibilities, delivery status, Backend work sequence and completion criteria, and separate future product work |
| [Product integration design](PRODUCT_INTEGRATION_PROPOSAL.md) | Consolidated product declaration, Backend registration, lifecycle, failure handling, and migration requirements; historical filename retained; shared SDK implementation available |
| [Gateway and shared integration contract](GATEWAY_CONTRACT.md) | Product-independent normative contract for pairing, service credentials, five-minute delegated authorization, events, aggregation, caches, and execution; Gateway/CLI/Portal do not yet exist |
| [Suite SDK integration](INTEGRATION.md) | Consuming SDK `0.7.0`, implemented TypeScript/Go/Rust APIs, native runtime admission, examples, verification, and service responsibilities |
| [Compatibility and support](COMPATIBILITY.md) | Supported matrix, dependencies, errors, validation, and known limitations |
| [CLI metadata and incremental discovery](DISCOVERY.md) | Extension contract, server/client examples, fingerprints, snapshots, and caching |
| [Contract maintenance](../contracts/README.md) | Authoritative schemas, generation, and conformance tests |

The Suite design documents apply to any current or future conforming product. Existing products will need adaptation; their present implementations do not constrain the shared contracts. The integration guide distinguishes implemented SDK mechanisms from the separate Backend/service/product work.

## History

[old/](old/README.md) contains earlier audits, the migration to 0.5.0, and historical HTTP client results. These documents preserve evidence and decision context; they are not guides to the current implementation. Consumer versions and test results recorded there apply only to the identified revisions.
