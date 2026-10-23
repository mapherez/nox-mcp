# NoX Suite — General implementation plan

Consolidated on **October 23, 2026**.

Status: **reference for approved requirements and architectural decisions**. This document does not imply that planned features are implemented, nor does it independently authorize product changes or release publication.

## 1. Purpose and use of this document

This is the reference for the evolution of NoX Suite. It consolidates decisions about the SDK, Backend, Gateway, CLI, Portal, and product integration without relying on recovering earlier conversations.

Use three distinctions when planning work:

- **Existing:** confirmed in code or explicitly stated by the product author.
- **Decided:** intended and approved behavior, even if not implemented yet.
- **To be defined:** a technical choice requiring an explicit proposal before implementation.

Initial plans and reports in [old/](old/README.md) provide historical context. Where they conflict with the future direction, the decisions consolidated here take precedence. Published contracts and versions are not changed retroactively by this documentation.

When a new decision is made, update this document and the affected technical contracts/documents. Do not silently turn old suggestions or illustrative examples into requirements.

## 2. Objective and initial scope

NoX Suite is a set of autonomous products integrated through common contracts. Each product retains its logic, data, frontend, and independent operation.

The objective is to let users and AI agents discover and execute functionality without product-specific integrations inside the CLI or Gateway.

Approved initial scope:

- One environment administered by one NoX Backend, on the same network.
- One product of each type: one Backend, one Yard, one Gateway, etc.
- Multiple approved Google accounts in that Backend, each with its own API key.
- Initial integration focused on applications installed on the environment's host/network.
- Products remain individually usable without Gateway, CLI, or Portal.
- CLI, Gateway, and Portal are future products; do not treat plans or experiments as implemented products.

Multiple copies of the same product in an environment, federation between Backends, and tunnels to products on other networks are outside the initial scope. Do not build architecture for those scenarios now, or make unnecessary choices that prevent future evolution.

The CLI may access the Gateway remotely when it is published. The network restriction above concerns the products reached by the Gateway.

## 3. Terminology

| Term | Meaning in this plan |
| --- | --- |
| Product/application | An autonomous product such as Backend, Yard, Bot, NoteX, Gateway, CLI, or Portal |
| Registered product | A product associated with the environment and known to the Backend |
| NoX Suite environment | Products and users administered by the same Backend |
| UI contribution | A page/component supplied by a product for presentation in the Portal |
| Direct MCP | A client accessing a product's own MCP server under its local policy |
| NoX Suite MCP | Integrated access through the Gateway under central identity and policy |

There is no additional functional entity called a **module**, or a mandatory application/module/instance hierarchy. Those terms appeared in old plans without an approved definition.

In this work, the old term **Module Contract** refers to the future **product integration and registration contract**. Final schema, API, and extension names remain to be decided. Do not rename existing public APIs because of this terminology.

## 4. Component responsibilities

| Component | Responsibility |
| --- | --- |
| NoX MCP | TypeScript/Go/Rust SDK, contracts, validation, and shared execution, authorization, and discovery mechanisms |
| NoX Backend | Authority for identity, API keys, roles, permissions, and registration; retains existing data and synchronization services |
| NoX Gateway | Consults the registry, discovers MCP servers, aggregates tools, and routes authorized calls |
| NoX Yard | Installs and manages Docker products; triggers authorized integration and reports lifecycle operations |
| NoX CLI | Manual navigation and execution; future AI integration and MCP tool exposure |
| NoX Portal | Aggregates management interfaces supplied by products |
| Each product | Executes functionality, owns its data, and enforces effective operation restrictions |

### NoX MCP

It is a library, not a central service. It does not own an installed-product database, manage accounts, or run a Gateway or terminal UI.

The SDKs must provide equivalent contracts and mechanisms for shared functionality. Internal implementations may differ and remain idiomatic.

### NoX Backend

Preserve SQLite, `/data`, blobs, vaults, synchronization, authentication, and existing APIs. Evolution adds integration; it does not rebuild these services without a demonstrated need.

Retain a native administrative UI and independent APIs. Administrators configure essential Yard and Gateway connections in that UI without depending on the Portal.

### NoX Gateway

It is an independent service. It does not issue API keys, manage accounts, maintain a second autonomous registry, or implement product business logic.

It holds only the operational state required for communication and reconstructible copies of information. The Backend is authoritative for registration and permissions; products define their tools.

## 5. Current reference state

This snapshot reflects the local analysis on October 23, 2026. It does not claim recent execution of test suites or validation of production installations.

| Product | Reviewed revision | Observed MCP integration |
| --- | --- | --- |
| NoX Backend | `a2382ec` | Go, SDK 0.6.1, HTTP JSON, 10 tools; per-user API key and vault ownership |
| NoX Yard | `376e528` | Go, SDK 0.6.1, HTTP JSON, 35 tools in the full catalog; local token, permissions, and operation management |
| NoteX | `6bd2005` | SDK 0.6.1 in TypeScript/Rust; 34-tool contract, local desktop server, and retained remote code |
| NoX Bot | Earlier local analysis during this preparation | TypeScript, dependency 0.6.1, MCP per Discord server; existing tools and CLI paths |

Updating dependencies to 0.6.1 was not a functional migration to the SDK's new capabilities. All four products still need the planned adaptation. The reviewed integrations did not enable `nox/discovery` or publish advanced CLI descriptors.

The SDK already provides the Core/CLI foundation, incremental discovery, fingerprints, snapshots, and caching. It does not yet provide the product registration or Gateway contracts planned here.

The retained NoteX remote code imports `@nox/mcp/better-auth`, which is incompatible with the entry points available in the installed SDK 0.6.1. Resolution returned `ERR_PACKAGE_PATH_NOT_EXPORTED`. This is a confirmed incompatibility in that remote path, not evidence that local MCP is broken. Do not reintroduce that adapter into the SDK to work around it.

Current SDK references: [compatibility](COMPATIBILITY.md), [discovery and CLI](DISCOVERY.md), and [contract maintenance](../contracts/README.md).

## 6. Identity and authorization

### Central access through the Gateway

- The user authenticates with a Google account approved by the Backend.
- The Backend issues and manages the API key associated with that account.
- The CLI uses the API key to access the Gateway.
- The Backend determines the account's current role; the Gateway applies policy and forwards the authorized context.
- Products validate integrated communication and retain domain restrictions during execution.

Do not introduce another identity provider. A dedicated NoX Account is only a future possibility, not a requirement for this phase. Do not use Better Auth in the NoX Suite design.

The approved central rule is:

| Role | Normal inspection | Writes | Sensitive reads |
| --- | --- | --- | --- |
| Admin | Allowed | Allowed | Allowed |
| Non-admin | Allowed | Denied | Denied |

Concrete role names must follow those defined in the Backend. The requirement is the distinction above, not an unnecessary new enum named `guest`.

Each product classifies its tools during implementation. The Backend maps roles to shared capabilities; no individually configured per-user/per-tool matrix is required.

Restrictions are checked during execution as well as presentation and catalog filtering. Admin access does not remove domain requirements for validity, revision checks, confirmation, availability, or conflict handling.

Classification must distinguish normal reads, writes, and sensitive reads. `destructiveHint` does not replace authorization. Reuse existing metadata where appropriate; the sensitivity contract and operations whose access depends on arguments still require design.

### Direct product access

The product manages authentication and permissions for this access independently of central policy. Yard is the reference model: its own token, separate inspection/write/sensitive-read permissions, and explicit access-mode configuration.

An optional token does not mean NoX authentication protects an anonymous endpoint: when the application explicitly allows that mode, the selected local permissions apply. Default and configuration consistency will be addressed during product adaptation.

### Pending technical decisions

The Gateway Contract will define how a product recognizes authorized Gateway communication and receives verified identity/capabilities. Do not assume forwarding of the personal API key, identity taken from arbitrary metadata, or a credential technology that has already been selected.

Permission-cache updates, including role changes and credential revocation, must also be defined.

## 7. Two MCP access paths without a mandatory third port

Approved exposure model, using illustrative values only:

| Endpoint | Purpose |
| --- | --- |
| `http://192.168.10.10:8095/` | Product's native web application |
| `http://192.168.10.10:8095/mcp` | MCP integrated with NoX Suite |
| `http://192.168.10.10:8096/mcp` | Direct MCP for independent clients |

Do not hardcode these IPs, ports, bind addresses, Docker publication settings, or access URLs. Configuration and reverse-proxy details will be defined per product/deployment through a common pattern.

- The application's MCP switch controls only **direct MCP**.
- NoX Suite MCP remains accessible to the authorized Gateway when that switch is off.
- Both reuse tools and business logic; do not create two business implementations.
- Sharing the main port is not proof of authorization. The integrated endpoint must validate incoming communication.
- Tools cannot execute if the application or host is stopped; "always available" does not mean executing a stopped process.

Existing clients and their URLs must not silently change destination. The Backend's current `/mcp` and the Gateway's future publication require explicit compatibility handling.

## 8. Installation, initial configuration, and registration

### Environment foundation

Backend, Yard, and Gateway are installed and connected through administrative configuration in the Backend's native web application. No mandatory first-run wizard or prior Portal installation is required.

These operations must also be available through the appropriate APIs. The Backend remains useful and administrable without Gateway or Portal.

### Subsequent products

1. An administrator installs the product/project through Yard.
2. Yard completes deployment and verifies the NoX integration capability announced by the product.
3. Yard requests registration from the Backend through the authorized administrative connection.
4. The Backend maintains the registry and makes the change available to relevant consumers.
5. The Gateway discovers the product's MCP server; the Portal, once available, discovers its UI contribution.

Capability declaration format, registration API, identifiers, and validation remain to be formalized. A product does not become trusted merely by claiming to belong to NoX.

Manually creating a container on the host still allows normal application use, but does not trigger the automatic integration above. Products outside the Suite retain Yard's normal installation process.

Not every product must be inserted into the Backend's Compose file. Projects may be separate as long as the necessary connectivity exists. Compose manages execution and networking; the NoX contract manages functional integration.

Partial failures across deployment, registration, and discovery must be representable and recoverable. The design must not report integration as complete if one of those stages failed, or assume a single transaction across Docker and the Backend.

## 9. Availability and lifecycle

| Component | Information it owns |
| --- | --- |
| Yard | Known operations: stop, restart, recreate, update, and removal |
| Gateway | Effective communication and MCP server availability |
| Backend | Persistent registry and consolidated state |

Approved rules:

- Periodic checks or heartbeats update availability.
- No response does not automatically expire or remove registration.
- The CLI/Portal must be able to show stops and temporary operations.
- A running container and an MCP server ready for calls are different states.
- Restart and recreate do not mean uninstall.
- Yard-confirmed removal triggers explicit registry removal.
- After registry removal, the product disappears from the integrated catalog and Portal navigation.
- Temporary failure does not delete product configuration or data.
- Already registered products remain usable through the Gateway if Yard is unavailable.

The contract must handle delayed, lost, or repeated events and reconcile state after recovery. Signal mechanisms and frequency have not been decided. Do not treat Docker healthchecks as sufficient proof of MCP availability.

## 10. Discovery, aggregation, and caching

Preserve conventional `tools/list` and `tools/call`. The optional `nox/discovery` extension already provides compact catalogs, selective definition retrieval, JCS/SHA-256, snapshots, and caching in all three languages.

The Gateway may keep:

- A copy of registration information needed for communication, obtained from the Backend.
- Tool definitions and fingerprints, obtained from products.
- Mappings between aggregated names and actual destinations.
- Operational state and availability observations.

These copies are reconstructible; they do not form a second autonomous registry. Definition caching and authorization validity are separate concerns. Cache freshness/TTL does not expire a product's membership in the environment.

The Gateway Contract must define:

- Tool identity and origin; name collision resolution.
- Routing for calls and references to selections, previews, and workflows.
- Relationships between original and aggregated definitions and their fingerprints.
- Catalog and snapshot consistency when a product changes or becomes unavailable.
- Isolation by identity and authorized context.
- Failure, cancellation, and limit propagation.
- Capability negotiation and compatibility with conventional servers/clients.

Do not change canonical product tool names merely to accommodate aggregation. Do not assume the current single-server snapshot defines consistency across several servers.

## 11. NoX CLI

### Manual use: the main priority

The user runs `nox` in a normal terminal and enters a persistent interactive session. They can navigate products, menus, and submenus, execute commands within the session, and fill in arguments.

The CLI interprets published tools and metadata, including schemas, `_meta.cli`, dynamic options, previews, confirmations, and workflows. It does not contain product-specific commands or menus.

Access to **NoX Suite products is exclusively through the Gateway**, using the API key of the account configured in the CLI.

Terminal experience, breadcrumbs, search, keyboard interaction, form state, and interaction execution belong to the CLI. The SDK validates and interprets descriptors; it does not display interfaces or automatically execute workflows on the user's behalf.

Ambiguous navigation composition rules will be settled using the existing foundation, without redesigning the CLI Contract around one product's specific feature.

### AI and the CLI's MCP server

Two additional modes are planned:

1. A local/cloud model integrated into the CLI receives requests and uses available tools.
2. The CLI exposes an MCP server to clients such as Codex Desktop or LM Studio.

Both are objectives, not existing features. Manual use takes priority; model integration may be postponed. Do not assume the second mode is technically trivial or necessarily faster to implement.

The CLI's MCP server may expose both NoX tools obtained through the Gateway and external MCP servers configured in the CLI. NoX calls use that profile's account/API key and retain its restrictions.

Transport, caller authentication for the CLI's MCP server, operation without an interactive session, persistence, and process lifecycle remain to be defined. The CLI does not become a central account or registry authority.

### MCP servers outside the Suite

Conventional servers, such as third-party tool servers, may be configured in the CLI for basic use, primarily by AI. NoX integration, special menus, Portal contributions, or Backend/Yard lifecycle management are not required.

These connections are distinct from NoX products accessed through the Gateway. They use the external server's own configuration and credentials. Agents can also use them directly without the CLI.

Basic manual requests may be available, but they are not the objective of the product-specific NoX interactive experience.

## 12. NoX Portal and product frontends

All applications retain their own frontends. The Portal aggregates management interfaces; it does not mandate replacing those interfaces.

- The Portal provides shared navigation, including vertical tabs.
- The product supplies the page/component shown in its tab.
- A contribution may show only the features needed in that context; it need not reproduce the full web application.
- Presentation distinguishes admin and non-admin and respects authorized capabilities.
- Products and services continue enforcing permissions independently of visible controls.
- After authorized registration and contribution validation, the tab must appear dynamically without rebuilding the Portal.
- Registry removal removes the contribution. Temporary unavailability is represented separately from uninstall.

The future UI contract will define loading, compatibility, communication, permissions, styles, and update behavior. React, Module Federation, iframe, or any other integration technology has not been selected.

The Backend's native administrative interface retains essential connection configuration. The Portal handles aggregated Suite management. Both use service APIs without duplicating business rules.

The Portal has the lowest priority among future products and does not block MCP contracts, the Backend, or the Gateway. Do not implement its UI loader now.

## 13. Operation without Internet

Environment control is local and must not require external services for every request.

- Previously prepared users and API keys continue to allow internal-network operation, including after restarting services.
- The Backend validates API keys and roles locally; Google authentication is not repeated for every call.
- New Google login/account verification requires Internet access.
- Cloud AI and cloud synchronization require Internet access.
- Product features that inherently contact external services remain subject to those services' availability.

Initial offline login or another identity provider to bypass Google unavailability is not planned. The LAN/host connection and required local services must remain operational.

## 14. NoteX and desktop applications

The author confirmed functional equivalence between NoteX desktop and web, with these differences: the web version does not export the database and has no integrated MCP server. There is no need to reopen a functional parity investigation for this plan.

Supporting applications on the host takes priority. NoteX desktop retains its current local MCP without changes in this phase.

The future intention is to build MCP for the web version, integrated with the Suite, so desktop changes are not a prerequisite. That feature does not exist yet. Retained remote bridge code must not be mistaken for implementation of this future web MCP.

Future integration must respect the web version's actual storage and execution model. Google synchronization between desktop and web requires Internet access and is not an offline Suite execution mechanism.

## 15. Implementation order and progression criteria

| Stage | Work | Condition for proceeding |
| --- | --- | --- |
| 1. Consolidate requirements | This document and analysis of existing implementations | Decisions separated from hypotheses; compatibility requirements identified |
| 2. Design integration/registration | Product identity, capabilities, registration, update, removal, and relationship to MCP/UI | Approved proposal, examples, and clear failure cases |
| 3. Design the Gateway Contract | Routing, trust, authorization, catalogs, fingerprints, and availability | Complete flows consistent with stage 2 and existing contracts |
| 4. Implement SDK contracts | Authoritative schemas, TypeScript/Go/Rust APIs/validation, generation, documentation, and conformance | Tested equivalence, working external packages, and regression verification |
| 5. Adapt products incrementally | Backend registry, Yard integration/lifecycle, two MCP access paths, product classification and descriptors | Real integrations validated, including failures and independent operation |
| 6. Build Gateway and CLI | Gateway service; manual CLI and additional modes in increments | Real end-to-end execution and conventional MCP compatibility |
| 7. Build Portal | Shared structure and dynamic loading of contributions | Product integration without rebuilding and consistent authorization |

Stages may use fixtures and explicitly authorized minimal adaptations in real products to validate hypotheses. They do not require building final products ahead of time. Integrated CLI AI and the Portal are not prerequisites for validating contracts.

### Areas affected by repository

| Repository/product | Planned evolution |
| --- | --- |
| `nox-mcp` | Shared contracts, validation and APIs in all three languages, corpus, packages, and CI |
| `nox-backend` | Persistent registry, administrative configuration, central authorization, and integration APIs while preserving existing services |
| `nox-yard` | Authorized post-deployment integration, lifecycle signals, and separation of Suite/direct MCP |
| NoX Bot and other host products | Integration/registration, capabilities, a Suite path independent of direct access, and optional descriptors |
| NoteX | Desktop preserved; web MCP and integration handled as separate future work |
| Future Gateway | Aggregation and routing according to approved contracts |
| Future CLI | Generic navigation, manual execution, external connections, and MCP/AI modes |
| Future Portal | Aggregation of UI contributions supplied by products |

Do not update consumers automatically merely because a new SDK version was published. Migrations must be explicit and tested.

## 16. Required validation

Preserve existing SDK conformance and add shared cases for new contracts. The current support matrix is in [COMPATIBILITY.md](COMPATIBILITY.md); Go SSE remains **Investigating / Future Support** and must not be advertised as fully conformant.

Acceptance cases for this evolution:

- Base installation and administrative configuration without Portal.
- Authorized Yard registration; conventional product installation without automatic integration.
- Startup, restart, recreate, update, and removal, including partial failures and repeated/lost events.
- Offline product without registry deletion; recovery without duplication.
- Tool execution in other products while Yard is stopped.
- Admin with full capabilities and non-admin restricted to normal inspection.
- Write/sensitive-read rejection even outside menus and with an earlier cache.
- Working Suite MCP with direct MCP disabled; independent direct-access policies.
- Name collisions, auxiliary tool references, snapshots, and fingerprints remaining consistent through the Gateway.
- Conventional MCP clients and preservation of schemas, `_meta.cli`, results, and errors.
- Local operation without Internet using a previously issued API key, including after restart.
- Portal absence without blocking operation; future tab addition/removal without rebuilding.
- The CLI MCP server preserving NoX authorization and distinguishing external tools.
- Real consumers and packages in all three languages without inheriting SDK dependency resolution.

Tests must not replace authorization checks with hidden UI options. Visual confirmation does not replace product validation.

## 17. Technical decisions still to be formalized

Do not treat these choices as already approved:

1. Identifiers, schemas, versions, and negotiation for the integration/registration contract.
2. APIs and credentials for base configuration, authorized registration, and inter-service communication.
3. A verifiable way to transmit identity and capabilities from Gateway to product.
4. Representation of sensitive reads, argument-dependent policy, and compatibility with legacy tools.
5. Events, notification persistence/retry, reconciliation, periodic checks, and consolidated state calculation.
6. Name/origin mappings, reference transformation, and fingerprint/snapshot composition.
7. Catalog and authorization cache invalidation; behavior during temporary Backend unavailability.
8. Final endpoint names, network configuration, and reverse-proxy publication.
9. Missing CLI composition rules without replacing `_meta.cli` or imposing `_meta.nox`.
10. Transport, protection, process, and lifecycle for the CLI's MCP server; AI model integration.
11. The UI contribution contract and Portal loading technology.
12. NoteX web MCP implementation without mandatory desktop changes.

Design must present alternatives and consequences where relevant. Do not invent new entities, identity providers, or product dependencies to fill these gaps without an explicit decision.

## 18. Compatibility and maintenance boundaries

- Maintain all repository documentation in English, including historical documents.
- Use the CC-BY-NC-SA-4.0 license and attribution/warranty notices adopted by NoX Yard for NoX Suite products. Apply changes to other product repositories only when explicitly requested.
- Do not change the public SDK version without an explicit instruction.
- Do not publish releases or replace existing tags/artifacts on your own initiative.
- Preserve public features and integrations already in use; document and approve breaking migrations where required.
- Keep `/contracts` authoritative and synchronize generated Go/Rust copies; external native builds do not depend on Node.
- Preserve `tools/list`, canonical names, existing metadata, and bridge protocols.
- Do not reopen full Go SSE support or unrelated external issues outside the approved scope.
- Do not modify consumer products in SDK-only tasks; integration changes require their own scope.
- Keep NoteX desktop untouched in this phase.
- Do not build Portal, CLI, or Gateway now to work around undefined contracts.

### Explicit corrections to old plans

| Old idea | Current decision |
| --- | --- |
| Autonomous registry in the Gateway | Registry in the Backend; Gateway holds cache and operational state |
| Modules and instances as a formal hierarchy | Registered products; no such hierarchy in the initial scope |
| Gateway outbound channels to products on other networks | Gateway reaches products on the environment's network |
| CLI connects directly to NoX products | CLI uses Gateway; external MCP connections follow a distinct path |
| Portal must replace all frontends | Products retain frontends; Portal aggregates dedicated contributions |
| Adding any Compose service registers it automatically | Yard initiates authorized integration for prepared products; Compose alone does not register them |
| Disabling MCP in the application also disables Suite access | The switch controls only direct MCP |
| Automatic expiry deletes offline products | Registration persists; removal requires an explicit confirmed action |

**Next work:** design product integration/registration and Gateway contracts from these requirements, preserving the existing Core/CLI foundation and correcting only demonstrated gaps.
