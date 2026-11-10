# NoX MCP documentation

NoX MCP `0.7.3` provides the shared contracts and SDKs. Backend, Yard and Gateway consume it; Auth provides shared NoX Login, and CLI consumes Gateway discovery and execution. These are independent products: SDK publication does not install or operate them. Portal remains future work. Auth's login contract is maintained in `nox-auth/NOX_AUTH_CONTRACT.md`.

Start with the [project README](../README.md) for installation, the main APIs, and the release process.

Repository documentation is maintained in English.

The Suite wire contract remains `1.0`. SDK `0.7.1` adds the shared HTTP/HTTPS correction, `0.7.2` publishes the same-host design record, and `0.7.3` separates normal MCP tool publication from human CLI metadata. Product adapters and service operation remain separate from SDK delivery.

| Current document | Contents |
| --- | --- |
| [Same-host presence, communication and registration](SUITE_SAME_HOST_INTEGRATION.md) | Same-machine boundary, local sockets/volume, presence versus membership, automated setup and Yard registration |
| [Product integration design](PRODUCT_INTEGRATION_PROPOSAL.md) | Consolidated product declaration, Backend registration, lifecycle, failure handling, and migration requirements; historical filename retained; shared SDK implementation available |
| [Gateway and shared integration contract](GATEWAY_CONTRACT.md) | Product-independent normative contract for pairing, service credentials, five-minute delegated authorization, events, aggregation, caches, and execution; separate Gateway/CLI/Portal implementation responsibilities |
| [Suite SDK integration](INTEGRATION.md) | Consuming SDK `0.7.3`, implemented TypeScript/Go/Rust APIs, native runtime admission, examples, verification, and service responsibilities |
| [Compatibility and support](COMPATIBILITY.md) | Supported matrix, dependencies, errors, validation, and known limitations |
| [CLI metadata and incremental discovery](DISCOVERY.md) | Extension contract, server/client examples, fingerprints, snapshots, and caching |
| [Contract maintenance](../contracts/README.md) | Authoritative schemas, generation, and conformance tests |

The Suite contracts apply to any current or future conforming product. Each product implements its own adapter without a built-in product list in the SDK, Gateway or CLI. The integration guide distinguishes implemented SDK mechanisms from the separate Backend/service/product work.

## General Suite plan

The [general implementation plan](NOX_SUITE_IMPLEMENTATION_PLAN.md) retains the Suite-wide scope and future work. Start with its [current implementation checkpoint](NOX_SUITE_IMPLEMENTATION_PLAN.md#21-current-implementation-status-and-continuation--november-10-2026) for the implementation state and continuation boundaries. Product installation and operation belong in the maintained guides above.
