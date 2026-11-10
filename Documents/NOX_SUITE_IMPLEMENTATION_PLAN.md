# NoX Suite — General implementation plan

Originally consolidated on **October 23, 2026**; delivery status and Backend/frontend work sequence updated on **October 30, 2026**.

**Authorized update, November 3, 2026:** introduce the headless NoX Auth service and shared NoX Login described in [section 20](#20-nox-auth-and-shared-nox-login). This explicitly requested change moves Google login and account admission out of individual applications. Earlier delivery snapshots remain dated history, not claims about today's implementation. The [current implementation checkpoint](#21-current-implementation-status-and-continuation--november-10-2026) records the current implementation and continuation scope.

Status: **reference for approved requirements and architectural decisions**. This document does not imply that planned features are implemented, nor does it independently authorize product changes or release publication.

## 1. Purpose and use of this document

This is the reference for the evolution of NoX Suite. It consolidates decisions about the SDK, Auth, Backend, Gateway, CLI, Portal, and product integration without relying on recovering earlier conversations.

Use three distinctions when planning work:

- **Existing:** confirmed in code or explicitly stated by the product author.
- **Decided:** intended and approved behavior, even if not implemented yet.
- **To be defined:** a technical choice requiring an explicit proposal before implementation.

Superseded reports remain available in Git history. The maintained contracts and the current checkpoint govern ongoing work; published contracts and versions are not changed retroactively by this documentation.

When a new decision is made, update this document and the affected technical contracts/documents. Do not silently turn old suggestions or illustrative examples into requirements.

## 2. Objective and deployment scope

NoX Suite is a set of autonomous products integrated through common contracts. Each product retains its logic, data, frontend, and independent operation.

The contracts and NoX MCP apply to **any present or future Suite product**. Product names in this document identify responsibilities or historical examples, not an exhaustive catalog or a list of allowed implementations. Adding a conforming product must not require product-specific code in the SDK, Gateway, CLI, or Portal.

The target is a complete contract for the agreed scope, not a temporary first version or a pilot tied to existing products. All existing integrations must be adapted as necessary to the resulting contracts. Gateway, CLI, and Portal were unimplemented at the October baseline; subsequent delivery is tracked in the correction record, rather than inferred from this historical statement.

The objective is to let users and AI agents discover and execute functionality without product-specific integrations inside the CLI or Gateway.

Approved deployment scope:

- One environment administered by one NoX Backend; participating Suite services run on the **same host**, as clarified in [same-host integration](SUITE_SAME_HOST_INTEGRATION.md).
- One product of each type: one Backend, one Yard, one Gateway, etc.
- Google accounts admitted centrally by NoX Auth; Backend retains personal API-key management for those identities.
- Integration targets applications installed on that same host; a shared LAN alone does not establish membership.
- Products remain individually usable without Gateway, CLI, or Portal.
- NoX Auth is a separate headless service; CLI and Portal remain separate product work. Do not treat planned authentication changes as implemented in existing releases.

Multiple copies of the same product in an environment, federation between Backends, and tunnels to products on other networks are outside this deployment scope. This does not limit the number or business domains of distinct products. Do not build architecture for excluded deployments, or make unnecessary choices that prevent future evolution.

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

In this work, the old term **Module Contract** refers to the **product integration and registration contract**. Its design is recorded in [product integration](PRODUCT_INTEGRATION_PROPOSAL.md), with shared trust and communication rules in the [Gateway Contract](GATEWAY_CONTRACT.md). Do not rename existing public APIs because of this terminology.

## 4. Component responsibilities

| Component | Responsibility |
| --- | --- |
| NoX MCP | TypeScript/Go/Rust SDK, contracts, validation, and shared execution, authorization, and discovery mechanisms |
| NoX Auth | Google authentication, central account admission and shared human login/session authority; no management frontend |
| NoX Backend | API keys, capability/delegation policy, service trust and registration using the Auth identity; retains existing data and synchronization services |
| NoX Gateway | Consults the registry, discovers MCP servers, aggregates tools, and routes authorized calls |
| NoX Yard | Installs and manages Docker products; triggers authorized integration and reports lifecycle operations |
| NoX CLI | Manual navigation and execution; future AI integration and MCP tool exposure |
| NoX Portal | Aggregates management interfaces supplied by products |
| Each product | Executes functionality, owns its data, and enforces effective operation restrictions |

### NoX MCP

It is a library, not a central service. It does not own an installed-product database, manage accounts, or run a Gateway or terminal UI.

The SDKs must provide equivalent contracts and mechanisms for shared functionality. Internal implementations may differ and remain idiomatic.

### NoX Backend

Preserve SQLite, `/data`, blobs, vaults, synchronization, and existing APIs. The separately authorized NoX Login adaptation changes dashboard authentication while preserving existing account/data relationships and client/API-key operation. Evolution does not rebuild these services without a demonstrated need.

Retain a native administrative UI and independent APIs. Administrators configure essential Yard and Gateway connections in that UI without depending on the Portal.

Separate frontend and backend delivery during the Backend implementation. Keep both components in the same `nox-backend` repository/project, with separate builds, images, and containers, so a frontend change can be delivered without rebuilding the backend image. The native frontend remains part of the product, retaining all current management functionality and the planned initial Yard/Gateway connection configuration. Preserve the existing frontend integration used by another product. Isolate business operations from presentation and expose complete authenticated administration APIs; frontend separation does not transfer this interface to the Portal. See [the concrete work sequence](#19-current-delivery-and-next-work-backend).

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

The versions and product integrations above are historical observations, not a statement of the current SDK release. [NoX MCP `0.7.0`](https://github.com/mapherez/nox-mcp/releases/tag/v0.7.0) is now published. It provides the Core/CLI foundation, incremental discovery, fingerprints, snapshots, caching, and the shared Suite schemas, native DTOs/loaders, trust and authorization helpers, aggregation/state helpers, and protected runtime admission described in [SDK integration](INTEGRATION.md). Backend management services and Gateway/CLI/Portal are not implemented here. Publishing the SDK does not adapt those consumers.

The retained NoteX remote code imports `@nox/mcp/better-auth`, which is incompatible with the entry points available in the installed SDK 0.6.1. Resolution returned `ERR_PACKAGE_PATH_NOT_EXPORTED`. This is a confirmed incompatibility in that remote path, not evidence that local MCP is broken. Do not reintroduce that adapter into the SDK to work around it.

Current SDK references: [compatibility](COMPATIBILITY.md), [discovery and CLI](DISCOVERY.md), and [contract maintenance](../contracts/README.md).

## 6. Identity and authorization

### Shared human login

NoX Auth owns Google credentials and the account allowlist. Each application's **NoX Login** button redirects through Auth and returns to that application's registered callback and original page. Auth has no frontend. Approved identities use the same central account authority across applications, including administrative access; applications do not maintain a second admission list. Existing product/domain checks remain required. Session, logout, private-origin compatibility and adaptation requirements are in [section 20](#20-nox-auth-and-shared-nox-login).

### Central access through the Gateway

- The user authenticates with a Google account approved by NoX Auth.
- The Backend issues and manages the API key associated with that account.
- The CLI uses the API key to access the Gateway.
- The Backend determines the account's current role; the Gateway applies policy and forwards the authorized context.
- Products validate integrated communication and retain domain restrictions during execution.

Google remains the upstream identity provider; the authorized NoX Auth service centralizes its integration. Do not introduce a separate NoX username/password account system. The Auth repository records its Go/OIDC implementation choices and exact API profile; the earlier exclusion of Better Auth remains unchanged.

The approved central rule is:

| Role | Normal inspection | Writes | Sensitive reads |
| --- | --- | --- | --- |
| Admin | Allowed | Allowed | Allowed |
| Non-admin | Allowed | Denied | Denied |

Concrete capability/role mappings must follow the Backend contract and consume Auth's central human authority when adapted. The requirement is the distinction above, not an unnecessary new enum named `guest`. This update adds no per-app account-approval list or new role-management UI.

Each product classifies its tools during implementation. The Backend maps roles to shared capabilities; no individually configured per-user/per-tool matrix is required.

Restrictions are checked during execution as well as presentation and catalog filtering. Admin access does not remove domain requirements for validity, revision checks, confirmation, availability, or conflict handling.

Classification distinguishes normal reads, writes, and sensitive reads using the shared capabilities and execution rules in the Gateway Contract. Argument-dependent requirements are calculated by trusted product code and can add restrictions. `destructiveHint` does not replace authorization.

### Direct product access

The product manages direct **MCP** authentication and permissions independently of integrated MCP policy. Yard is the reference model: its own token, separate inspection/write/sensitive-read permissions, and explicit access-mode configuration. This is distinct from dashboard login, which moves to NoX Login; replacing dashboard login does not remove direct MCP or existing client APIs.

An optional token does not mean NoX authentication protects an anonymous endpoint: when the application explicitly allows that mode, the selected local permissions apply. Default and configuration consistency will be addressed during product adaptation.

### Consolidated trust and authorization decisions

The Backend manages dedicated, scoped, revocable service credentials. Authorized pairing uses a temporary, single-use secret. Suite server-to-server communication uses the approved [same-host local channel](SUITE_SAME_HOST_INTEGRATION.md); native application origins may use HTTP or HTTPS. Auth's Google-facing callback uses HTTPS, without imposing certificates on every internal app. The Gateway validates the personal API key with the Backend and receives a Backend-signed, product-specific delegation; the personal key is not forwarded to products. Products verify the delegation and enforce current domain rules at execution.

Delegations may be reused for up to **five minutes**, never beyond the underlying credential validity. The Gateway validates requests locally while the authorization remains valid, invalidates cached authorizations on Backend events, and renews on demand. Missed revocation events can leave an already issued delegation usable until its original expiry, at most five minutes. During Backend unavailability, valid delegations remain usable until expiry; no fresh authorization or lifetime extension is permitted. A 1–3 hour CLI session does not expire on this schedule and does not repeat Google login.

This supersedes the earlier discussion suggestion of a separate 30-second, argument-bound authorization for every request and a live Backend authorization call for every operation. Complete wire rules, cache partitions, and failure behavior are in the Gateway Contract.

## 7. Two MCP access paths without a mandatory third port

Approved exposure model, using illustrative values only:

| Endpoint | Purpose |
| --- | --- |
| `https://192.168.10.10:8095/` | Product's native web application |
| `https://192.168.10.10:8095/mcp` | MCP integrated with NoX Suite |
| `https://192.168.10.10:8096/mcp` | Direct MCP for independent clients under product policy |

Do not hardcode these IPs, ports, bind addresses, Docker publication settings, or access URLs. A registered base address is an origin: IP/hostname with an optional port, or a dedicated domain/subdomain. Application prefixes such as `/apps/example` are **not supported**. `/nox/integration` is the bootstrap path; the protected Suite MCP path is declared by the product. HTTPS can use a trusted deployment certificate or an explicitly provisioned certificate pin, as defined in the Gateway Contract.

- The application's MCP switch controls only **direct MCP**.
- NoX Suite MCP remains accessible to the authorized Gateway when that switch is off.
- Both reuse tools and business logic; do not create two business implementations.
- Sharing the main port is not proof of authorization. The integrated endpoint must validate incoming communication.
- Tools cannot execute if the application or host is stopped; "always available" does not mean executing a stopped process.

Existing clients and their URLs must not silently change destination. The Backend's current `/mcp` and the Gateway's future publication require explicit compatibility handling.

## 8. Installation, initial configuration, and registration

### Environment foundation

Backend, Yard, and Gateway are installed and connected through administrative configuration in the Backend's native web application. No mandatory first-run wizard or prior Portal installation is required. When NoX Login is implemented, Auth is also installed/configured as their shared login service before adapting their dashboard entry points; it does not replace this foundation configuration or Yard's deployment responsibilities.

These operations must also be available through the appropriate APIs. The Backend remains useful and administrable without Gateway or Portal.

### Subsequent products

1. An administrator installs the product/project through Yard.
2. Yard completes deployment and verifies the NoX integration capability announced by the product.
3. Yard requests registration from the Backend through the authorized administrative connection.
4. The Backend maintains the registry and makes the change available to relevant consumers.
5. The Gateway discovers the product's MCP server; the Portal, once available, discovers its UI contribution.

The declaration, registration API, identifiers, revisions, and validation are defined in [product integration](PRODUCT_INTEGRATION_PROPOSAL.md). Pairing and service trust are defined in the [Gateway Contract](GATEWAY_CONTRACT.md). A product does not become trusted merely by claiming to belong to NoX.

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

Delayed, lost, or repeated events are handled by a durable Backend event log, cursor-based long polling, producer sequences, and snapshot reconciliation. Long-poll waits default to 25 seconds; availability checks/reports default to 15 seconds and observations become stale after 45 seconds. These are configurable installation-wide operational intervals, not per-user authentication timers. Do not treat Docker healthchecks as sufficient proof of MCP availability.

## 10. Discovery, aggregation, and caching

Preserve conventional `tools/list` and `tools/call`. The optional `nox/discovery` extension already provides compact catalogs, selective definition retrieval, JCS/SHA-256, snapshots, and caching in all three languages.

The Gateway may keep:

- A copy of registration information needed for communication, obtained from the Backend.
- Tool definitions and fingerprints, obtained from products.
- Mappings between aggregated names and actual destinations.
- Operational state and availability observations.

These copies are reconstructible; they do not form a second autonomous registry. Definition caching and authorization validity are separate concerns. Cache freshness/TTL does not expire a product's membership in the environment.

The Gateway Contract defines:

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

Product boundaries, aliases, auxiliary references, and ambiguous action-path handling follow the Gateway Contract and existing CLI foundation. Terminal interaction is implemented in the CLI without redesigning the shared contract around a product-specific feature.

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

The Backend retains its own frontend as a permanent product component, deployed separately from its backend service within the same project. This separation supports independent frontend image updates and preserves current management and dependent-product integration. The Portal remains a separate application for aggregated Suite management and product contributions. Its future loading, compatibility, and browser integration work does not remove or replace the Backend's native frontend.

The Portal has the lowest priority among future products and does not block MCP contracts, the Backend, or the Gateway. Do not implement its UI loader now.

## 13. Operation without Internet

Environment control is local and must not require external services for every request.

- Previously prepared users and API keys continue to allow internal-network operation, including after restarting services.
- The Backend validates API keys and capabilities locally; adapted applications check current human admission through local Auth under the agreed validity bounds. Google authentication is not repeated for every call.
- New Google login/account verification goes through Auth and requires Internet access; valid existing sessions do not contact Google periodically merely to remain open.
- Cloud AI and cloud synchronization require Internet access.
- Product features that inherently contact external services remain subject to those services' availability.

Initial offline login or another identity provider to bypass Google unavailability is not planned. The LAN/host connection and required local services must remain operational.

## 14. Existing applications and execution models

The author confirmed functional equivalence between NoteX desktop and web, with these differences: the web version does not export the database and has no integrated MCP server. There is no need to reopen a functional parity investigation for this plan.

This historical snapshot is not a contract constraint or a permanent migration exemption. Existing desktop, web, and service products must be adapted wherever required for their intended Suite participation, while retaining their independent functionality and domain rules.

NoteX web MCP does not exist yet. Retained remote bridge code must not be mistaken for its implementation. The shared contract does not prescribe a renderer, browser-storage backend, desktop bridge, or product-specific execution architecture.

Future integration must respect the web version's actual storage and execution model. Google synchronization between desktop and web requires Internet access and is not an offline Suite execution mechanism.

## 15. Implementation order and progression criteria

| Stage | Work | Condition for proceeding |
| --- | --- | --- |
| 1. Consolidate requirements | This document and analysis of existing implementations | Decisions separated from hypotheses; compatibility requirements identified |
| 2. Design integration/registration | Product identity, capabilities, registration, update, removal, and relationship to MCP/UI | Approved proposal, examples, and clear failure cases |
| 3. Define the Gateway Contract | Routing, trust, authorization, catalogs, fingerprints, and availability | [Complete contract](GATEWAY_CONTRACT.md) consistent with stage 2 and existing contracts |
| 4. Implement SDK contracts | Authoritative schemas, TypeScript/Go/Rust APIs/validation, generation, documentation, and conformance | Tested equivalence, working external packages, and regression verification |
| 5. Adapt products incrementally | Backend registry, Yard integration/lifecycle, two MCP access paths, product classification and descriptors | Real integrations validated, including failures and independent operation |
| 6. Build Gateway and CLI | Gateway service; manual CLI and additional modes in increments | Real end-to-end execution and conventional MCP compatibility |
| 7. Build Portal | Shared structure and dynamic loading of contributions | Product integration without rebuilding and consistent authorization |

Contract design precedes service implementation and product adaptation. No pilot using the current Backend/Yard implementations is a prerequisite for completing it. Shared fixtures validate SDK implementation against the contract; end-to-end tests follow once services and products have been implemented/adapted. Integrated CLI AI and the Portal are not prerequisites for validating the SDK.

### Areas affected by repository

| Repository/product | Planned evolution |
| --- | --- |
| `nox-mcp` | Shared contracts, validation and APIs in all three languages, corpus, packages, and CI |
| `nox-auth` | Headless Google-backed NoX Login service, central admission/session authority, reusable client integration, persistent state and deployment documentation; see section 20 |
| `nox-backend` | Persistent registry, administrative configuration, central operation authorization, integration APIs, own Suite adaptation, and separate frontend/backend builds, images, and containers in the same project; subsequently consume NoX Login and expose Suite logout while preserving existing services and frontend integrations |
| `nox-yard` | Authorized post-deployment integration, lifecycle signals, and separation of Suite/direct MCP |
| NoX Bot and other host products | Integration/registration, capabilities, a Suite path independent of direct access, and optional descriptors |
| NoteX and other desktop/web products | Adapt relevant integrations to the shared contracts, respecting each product's storage, execution, and independent-access model |
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

## 17. Decision status and separate product work

The following design areas are specified. Shared SDK mechanisms are published in `0.7.0`; service responsibilities remain to be implemented. See [SDK integration](INTEGRATION.md) for the implemented APIs and exact boundaries:

| Area | Reference |
| --- | --- |
| Product declaration, identity, registration, conditional updates, removal, and durable idempotency | [Product integration](PRODUCT_INTEGRATION_PROPOSAL.md) |
| Pairing, service credentials, same-host transport, signed delegated identity, and capability classification | [Gateway Contract](GATEWAY_CONTRACT.md), sections 3–7, with [authorized transport corrections](SUITE_SAME_HOST_INTEGRATION.md) |
| Shared Google-backed human login and central admission | Section 20, `nox-auth/NOX_AUTH_CONTRACT.md` and its `docs/integration.md`; Auth service/Go client implemented in source; five-minute admission-check interval confirmed; installed product adapters pending |
| Five-minute authorization reuse, event invalidation, on-demand renewal, and Backend outages | Gateway Contract, section 6 |
| Durable events, reconciliation, observation sequences, and availability intervals | Gateway Contract, section 8 |
| Aggregated names, reference rewriting, original/aggregate fingerprints, and private snapshots | Gateway Contract, sections 9–10 |
| Deadlines, cancellation, limits, error propagation, and conventional MCP compatibility | Gateway Contract, sections 11–12 |
| Origin-only deployment addresses and preservation of direct/Suite access during migration | Product integration and Gateway Contract, sections 3 and 13 |

Separate product work still includes the CLI's own MCP-server transport/authentication/process lifecycle and AI integration, the Portal UI contribution/loading contract, and each product's storage/execution adapters. These do not reopen the completed integration/Gateway design or imply that those products already exist. CLI presentation must retain `_meta.cli`; no `_meta.nox` hierarchy is introduced.

The detailed routes, payloads, and validation rules in the Gateway Contract formalize the consolidated choices for implementation. Product-specific business decisions remain with their products. Implementation findings must identify a concrete incompatibility before changing this baseline.

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
- Adapt existing products only in their explicitly scoped implementation work; no existing integration is permanently exempt from the final shared contracts.
- Shared SDK APIs and fixtures do not implement Portal, CLI, Gateway services, Backend persistence/issuance, or consumer changes.

### Explicit corrections to old plans

| Old idea | Current decision |
| --- | --- |
| Autonomous registry in the Gateway | Registry in the Backend; Gateway holds cache and operational state |
| Modules and instances as a formal hierarchy | Registered products; no such hierarchy in the agreed scope |
| Gateway outbound channels to products on other networks | Gateway reaches products on the environment's network |
| CLI connects directly to NoX products | CLI uses Gateway; external MCP connections follow a distinct path |
| Portal must replace all frontends | Products retain frontends; Portal aggregates dedicated contributions |
| Adding any Compose service registers it automatically | Yard initiates authorized integration for prepared products; Compose alone does not register them |
| Disabling MCP in the application also disables Suite access | The switch controls only direct MCP |
| Automatic expiry deletes offline products | Registration persists; removal requires an explicit confirmed action |

## 19. Current delivery and next work: Backend

Delivery baseline as of **October 30, 2026**:

The following tables retain that historical Backend work sequence, including its then-native Google authentication. They are not a new instruction to keep Google credentials/account admission in Backend: the authorized November 3 target in section 20 supersedes that responsibility. Use the correction record for subsequent released work and outstanding tasks.

| Item | State |
| --- | --- |
| Shared integration/Gateway contract | Defined; wire compatibility version `1.0` |
| NoX MCP SDK | `0.7.0` published on GitHub after CI approval; available for explicit consumer migrations |
| Backend authority and own Suite adaptation | Next implementation scope; pending |
| Backend frontend/backend separation | Separate builds, images, and containers within the same `nox-backend` project; native frontend retained; pending |
| Gateway, installer/product adaptations, and CLI | Follow their service dependencies; pending |
| Generic Portal | Separate application and contribution/loading work; pending; does not replace the Backend frontend |

The SDK implementation and release delivery are complete for this scope. This does not certify service implementations, consumer adaptations, or end-to-end Suite operation. Existing products must be adapted to the published contracts; unchanged Backend/Yard deployments are not a prerequisite for starting this work.

### Backend work sequence

The table is an implementation sequence for the complete Backend scope, not a list of temporary product versions. It organizes the approved plan and the clarified frontend/backend deployment separation without changing any other approved decision. Use the linked contracts for exact routes, payloads, limits, and failure behavior; do not redefine those rules in Backend-local documents.

| Work | Required result |
| --- | --- |
| 1. Establish the consumer baseline | Pin SDK `v0.7.0` in the Backend Go module and update its lock data; record existing API, authentication, MCP, dashboard, storage, deployment, and dependent-product frontend integration behavior before changing it. |
| 2. Separate frontend/backend delivery and operations | Keep both components in the same `nox-backend` repository/project with independent builds, images, and containers. Frontend updates must not require rebuilding the backend image. Move business/permission rules into backend operations shared by HTTP APIs, direct MCP, and Suite MCP; the native frontend consumes authenticated backend APIs. Preserve SQLite, `/data`, blobs, vaults, synchronization, and existing client APIs. |
| 3. Complete administration APIs and retain native UI | Expose the operations currently available through the dashboard through authenticated APIs, including account/role administration, personal key management, and relevant vault operations. Retain their frontend functionality and add the initial foundation-service connection configuration required by the plan. Keep Google authentication/session authority in Backend. JSON APIs must return API results/errors rather than depend on HTML or dashboard redirects. Preserve existing browser-facing authentication and dependent-product integration. |
| 4. Implement persistent service trust | Add issuer identity, signing-key storage/rotation and public verification keys, scoped service credentials, pairing/provisioning recovery, credential rotation/revocation, and persistent associations under [Gateway Contract sections 3–6](GATEWAY_CONTRACT.md#3-addresses-and-authenticated-transport). |
| 5. Implement registry and durable events | Add verified declaration retrieval, registration revisions, conditional management operations, durable idempotency, role-filtered snapshots, event delivery/reconciliation, and authorized observations under the [integration design](PRODUCT_INTEGRATION_PROPOSAL.md) and [Gateway Contract section 8](GATEWAY_CONTRACT.md#8-registry-events-lifecycle-and-availability). Commit registration mutations, idempotency outcomes, and their events atomically. |
| 6. Implement authorization issuance | Map existing roles to agreed capabilities and issue signed, product-bound user delegations and distinct service probe tokens. Enforce current key/service/association revisions and emit invalidation events for relevant changes. Use the already agreed five-minute bounds and offline behavior; do not add repeated Google login or per-call remote authorization. |
| 7. Adapt Backend as a Suite product | Serve `/nox/integration`, declare and implement a protected Suite MCP path, classify tools, and enforce verified identity, scopes, ownership, deadlines, and limits. Preserve or explicitly migrate the existing direct `/mcp` policy; both paths share operations and remain independently configurable. |
| 8. Integrate administration and validate delivery | Make foundation-service configuration usable through APIs and the native frontend, with accurate partial-failure states. Update Backend docs, migrations, separate image build/release jobs, Compose deployment, and required CI for the actual implementation. Verify installed/packaged behavior, independent frontend delivery, and the existing dependent-product frontend integration before claiming completion. |

### Backend completion criteria

- Existing supported client APIs, vault ownership, synchronization, storage, direct MCP, and dashboard workflows continue to work under the approved compatibility requirements. The product that depends on the Backend frontend retains a working integration, including its browser-facing routes and authentication flow.
- The native frontend remains part of `nox-backend`, supports all current management functionality and the planned initial service connections, and works without requiring Gateway or Portal. All dashboard operations have corresponding authenticated APIs, and integration logic is independent of page rendering.
- Frontend and backend have separate builds, images, and containers within the same project. A frontend-only change can be built and deployed without rebuilding the backend image. Compose/Yard represents one `nox-backend` project containing its frontend and backend services, plus other services only where required by the approved plan.
- Database migrations preserve installed data. Issuer identity, signing/trust keys, service credentials, associations, pairing recovery, registry state, idempotency outcomes, and events survive restart as specified.
- Real Backend HTTP/persistence tests cover authorized and forbidden operations, wrong/expired/replayed pairing proofs, credential/key rotation and revocation, invalid target/declaration, conditional conflicts, lost responses, repeated/concurrent mutations, restart, event cursor expiry, and observation ordering/freshness. Verify atomic rollback on failed commits and consistent snapshot/cursor state.
- Issued user/probe tokens pass the released SDK verifier under the intended trust configuration; wrong audience, purpose, actor, scope, revision, or association cannot gain access. Backend Suite execution enforces the product rules independently of UI visibility.
- Backend required CI and package/deployment checks pass for the exact implementation being delivered. SDK fixtures are supporting evidence, not a substitute for these service tests.

Gateway/product end-to-end flows are validated when those services have been implemented/adapted. Tests for the Backend may use explicit protocol fixtures or test clients; they do not claim that a Gateway, CLI, Portal, or real adapted product already exists.

### Frontend boundary and subsequent work

Implement the frontend/backend separation in the Backend scope above. Keep the native frontend in the same repository/project, communicating with backend APIs and retaining current management and dependent-product integration. Its separate image/build lifecycle is the purpose of this separation; the frontend is not temporary and is not scheduled for removal when Portal exists.

In Yard, the deployment is one `nox-backend` project containing `frontend` and `backend` containers/services, plus other services only if required by the approved plan. These are deployment components of the same product, not extra Suite registry products or a new module/instance hierarchy. Container separation does not change the approved origin/path, trust, API, or MCP contracts. Deployment routing must preserve the existing browser-facing frontend integration while exposing the approved Backend endpoints.

Portal implementation remains separate work: the shared shell and generic product contribution contract, loading/compatibility, and browser authentication/session integration. It aggregates product interfaces while each product, including Backend, retains its own frontend. This clarification selects no frontend framework, Portal loader technology, or new browser credential scheme and changes no other approved architectural decision.

After the Backend scope, implement Gateway and installer/product adapters against the same contracts, then the dependent CLI flows. Complete the Portal as its own product work.

The [product integration design](PRODUCT_INTEGRATION_PROPOSAL.md) and [Gateway Contract](GATEWAY_CONTRACT.md) together define the integration baseline. A contract version such as `1.0` identifies wire compatibility; it does not describe a provisional product release.

## 20. NoX Auth and shared NoX Login

**Owner-authorized decision, November 3, 2026.** The canonical requirements contract is `NOX_AUTH_CONTRACT.md` in the separate `nox-auth` repository. Its service and reusable Go client were published as Auth `v0.0.1`; the owner subsequently accepted Yard NoX Login with real Google login. `docs/integration.md` records the exact profile. Further product adaptations retain their own acceptance and do not change the released SDK wire version.

### Responsibilities and user journey

- Run one headless Auth service/container for the installation. It owns Google client ID/secret, the allowed-account email list, stable identity bindings and human login sessions. Applications consume the shared contract rather than copying Google integration and account lists.
- A product's **NoX Login** button takes the browser through Auth/Google and back to its approved application callback and original page. A valid Auth session avoids repeated Google account selection when entering another app with the same browser/profile.
- Auth's Google callback has a configurable HTTPS origin, which may use an existing reverse proxy/tunnel. Application callbacks are separate and can be internal addresses. Private HTTP/HTTPS hostnames and IP origins must be addressed explicitly in the protocol specification; do not silently introduce per-app public URLs, manual certificates or disabled validation.
- Auth has no management frontend. Backend retains its native frontend; Portal remains a future separate UI. Yard still installs products and initiates authorized registration; Backend remains registry/service-trust and operation-delegation authority; Gateway routes MCP. No new deployment manager is introduced.

### Sessions, account removal and logout

- **Decided:** human sessions last one year, renewable with use while still admitted. Applications maintain their own cookies and preserve valid sessions across ordinary updates. Another device/browser has its own session.
- **Decided:** **Sair** terminates the current app session. **Sair de todas**, shown in Backend's dashboard now and Portal later, requests Auth revocation of the current Auth session and its derived Suite app sessions. No Auth frontend is required. This does not log out Google or remove a Discord integration.
- **Decided:** after a removed account's updated Auth configuration is applied, new login and existing-session access must be refused. Editing `.env` alone does not update an already running process; applying configuration uses the documented restart/recreate process.
- **Decided, confirmed by the owner November 3:** cache a positive Auth admission/session check for at most five minutes. An active application revalidates with local Auth when necessary, without Google account selection or manual approval. Denial stops access; validation failure cannot extend a cached grant after expiry. This interval also bounds derived-session revocation propagation and is separate from the existing five-minute MCP delegation lifetime. Do not compound stale admission and fresh authorization cache intervals into an unbounded delay.

### Adaptation order and preservation

1. Implement/validate Auth against its requirements and documented protocol profile. Its Go implementation uses the maintained ZITADEL OIDC provider with confidential web clients, Basic client authentication, PKCE S256 and exact private HTTP/HTTPS callbacks with development mode disabled. Confidential exchanges use the same-host runtime socket; client enrollment uses a separate restricted administration socket. The Auth repository records local acceptance and packaging checks; real Google login with operator credentials and installed product adaptation remain separate acceptance work.
2. Integrate and test **Yard first**, as requested by the owner, with real login/logout/session/restart and rollback acceptance. Its dashboard becomes NoX Login only; retain installation data and previous-version database compatibility so reverting its image restores the existing login. No new local-password fallback is requested.
3. After successful Yard acceptance, adapt Backend and the remaining products in their own scoped work. Preserve Backend user/data ownership, personal keys, APIs and native frontend. Voice MLX replaces its separate Google flow. Bot uses NoX Login for dashboard entry and keeps Discord as a persistent settings integration, separate from dashboard session lifetime and from the bot's own Discord token. Future products use the same generic integration.

There is no separate data-import/migration project in this scope. Necessary technical identity/session adaptations must preserve existing data; backups or quick-command exports are not permission to reset databases. Acceptance and rollback must be verified before claiming them.

### Deployment authorization and correction sequence

Backend's administrative installer pairing delegates authority over the installer's own local deployments. Subsequent registration uses the enrolled service credential, canonical local target and exact deployment ownership; it neither forwards personal Auth tokens nor grants account/key administration. The current model is specified in [same-host integration](SUITE_SAME_HOST_INTEGRATION.md).

The numbered references below describe the earlier authentication checkpoint. Current component implementation and the remaining product/CLI scope are recorded in [section 21](#21-current-implementation-status-and-continuation--november-10-2026); they must not be inferred from these dated progress statements.

### Auth adaptation progress — November 3, 2026

The owner confirmed Yard login both with an existing Google session and in an
incognito browser. Backend adaptation follows that acceptance, as authorized.
Backend consumes NoX Login, preserves existing identity/data/key ownership and
local roles, and provides the agreed Suite logout action in its native dashboard.
Google client credentials and account admission belong only to Auth. Backend
adds no parallel account-admission environment list. Private HTTP app origins
remain supported; no per-app certificates or new deployment manager are required.

Independent personal API keys are checked against central account admission
after Backend verifies the key and local account. A private authenticated Auth
`/v1/admission` service capability supports this without making API keys depend
on a browser session. This capability is added after Auth `v0.0.1`: publish/update
Auth before installing the Backend adapter. Positive reuse stays within five
minutes; a new operation delegation cannot restart that interval from a stale
admission result. Browser/Suite logout does not revoke independent API keys.

Backend source/packaging checks and actual installed Google/SSO/global-logout
acceptance are separate evidence. The latter follows publication of compatible
Auth, Backend and frontend images. Yard lifecycle points 7 + 8 retain their
existing names and remain unfinished; this login work does not authorize a Yard
service to grant itself administrative deployment associations.

### Installed login acceptance — November 4, 2026

After updating Auth, Backend and Yard, the owner confirmed Google login in both
Backend and Yard. Invoking **Logout all** in Backend also logged out the Yard
session when switching to its browser tab. Both applications accepted a new
login afterwards. This records owner-reported acceptance of those installed
login, shared-session revocation and re-login flows.

The authentication work that paused the Yard correction sequence now has that
installed acceptance. The next scoped work remains **7. Adaptar o Yard,
reutilizando o seu deployment existente.** and **8. Ligar o lifecycle do Yard ao
registo do Backend.** Neither point is completed by login acceptance, and this
record does not resume implementation or change deployment/service permissions.

## 21. Current implementation status and continuation — November 10, 2026

This checkpoint is the current handoff for continuing Suite work. It supersedes older progress statements and CLI scope descriptions earlier in this document. Those dated sections describe their original checkpoints, not tasks that must be repeated. This section records implementation and known delivery evidence; it does not authorize new work or claim unreported release results.

### Implemented foundation

| Component | Current implementation and evidence |
| --- | --- |
| NoX MCP | SDK 0.7.3 is released. Shared contracts and native TypeScript/Go/Rust helpers are implemented. Conventional MCP tool listing excludes human CLI metadata; NoX discovery retains the canonical definitions. |
| NoX Auth | Service 0.0.2 provides shared Google-backed NoX Login, automatic client-enrollment APIs, private account admission and session revocation. The reusable Go client is consumed at 0.0.1. Installed Backend/Yard login and shared-session logout initiated in Backend were confirmed. |
| NoX Backend | Authority, service pairing, deployment delegation, durable registry/events, authorization issuance and its own MCP publication are implemented. Its native frontend is retained in the same project with independent frontend/backend images. Installed Backend 1.2.2 service-status execution through Gateway/CLI was confirmed. |
| NoX Gateway | Same-host enrollment, private discovery/aggregation, authorization, routing, probes and lifecycle observation are implemented. Gateway 0.0.2 was reported by the CLI. It preserves exact structured-result numbers and MCP error semantics. |
| NoX Yard | NoX Login, same-host pairing and registration, participating deployment preparation and job-driven registration/lifecycle recovery are implemented. Installed Yard registration was confirmed; source is tagged 1.4.2. A source tag alone does not establish the installed image. |
| NoX CLI | The six implementation stages have source implementations: foundation, configuration/installation, interactive interface, discovery/execution, real Backend connectivity and update/uninstall. The owner exercised Yard and Backend tools. The release helper, packages and installer-hosting workflow exist; publication and hosted installation have not been reported as completed. |
| NoX Portal | Not implemented. It remains a separate future application and does not replace Backend's native frontend. |

### Position in the existing work sequence

The original twelve task names and numbers are unchanged. The foundation work through points 1–9 has implementation; do not restart Backend, Gateway or Yard foundation development merely because earlier sections call it pending.

- **Point 10 — participating product adaptation:** remains the scope for other products selected by the owner. Each product implements the shared adapter, declaration, trust, discovery and relevant login integration in its own repository. A conforming new product must not require product-specific changes to CLI, Gateway, Backend or Yard.
- **Point 11 — CLI implementation:** source functionality is implemented. The remaining delivery activity is owner-controlled commit/push, existing CI, release publication and installer-endpoint publication. The owner accepted the current CLI behavior for now. Do not introduce another CLI feature stage from the old plan.
- **Point 12 — delivery/validation:** completion remains an owner decision. Existing repository checks and reported installed results are evidence for their actual scopes; no additional mandatory all-products test campaign or new CI gate is authorized by this checkpoint.

The current task is documentation consolidation. Resume product implementation or publication only as directed by the owner. Portal and additional product adaptations must not be presented as already delivered.

### Decisions to preserve when continuing

Suite services run on the same host and communicate through the private local Unix channel. Native application URLs may use HTTP or HTTPS; local Suite integration requires no manually distributed certificates. CLI may run on another computer with private LAN/VPN access to Gateway; public Gateway destinations are outside its supported policy.

Auth owns Google credentials and central account admission. Backend owns personal API keys, membership and delegated authority. Administrative installer pairing delegates management of the installer's own deployments; no personal Auth token or repeated account approval is required per installation. Products retain their native domain and data-ownership checks.

AI MCP clients connect directly to Gateway. CLI is the human client: it has no incoming MCP server, embedded agent/chat or external MCP aggregation in the implemented scope. All product UI text and documentation use EN-US. The project READMEs and project LICENSE files use the Yard attribution/license policy.

### Maintained references

Use the [Gateway contract](GATEWAY_CONTRACT.md), [product integration reference](PRODUCT_INTEGRATION_PROPOSAL.md), [same-host channel](SUITE_SAME_HOST_INTEGRATION.md) and [SDK integration guide](INTEGRATION.md) for the current shared behavior. Product operation belongs in each repository's current guides. CLI's maintained technical reference is `nox-cli/TECHNICAL.md`; Yard's is `nox-yard/Documentation/Developer/Architecture.md`. Superseded implementation logs are not installation instructions or a source of additional requirements.
