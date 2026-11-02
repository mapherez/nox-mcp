# NoX Suite — same-host presence, communication and registration

Recorded **November 2, 2026**. This document captures the owner's same-host clarification and the local-channel design discussed afterwards. It applies to every present or future Suite product, independently of its business domain or implementation language.

**Status, updated November 2, 2026:** the same-host requirement and local-channel target are recorded here. SDK `0.7.2` is released; SDK code does not create the channel. The **Backend side is implemented in its working tree, not yet released**: local listener, automatic foundation setup, recovery, Compose and native dashboard/API adaptation passed local validation. Gateway/Yard adapters and actual Suite end-to-end validation remain outstanding. The Backend tests use an explicitly disposable protocol participant, not an adapted Yard release.

## 1. Reference and precedence

Use this record with [correction scope and progress](SUITE_CORRECTION_STATUS.md), the [shared integration contract](GATEWAY_CONTRACT.md), and [SDK integration](INTEGRATION.md). For deployment scope, same-host communication and setup, the owner's clarification recorded here supersedes older descriptions that allow participating products anywhere on a trusted LAN or require manually configured HTTPS.

The [original implementation plan at 3e19feb](https://github.com/mapherez/nox-mcp/blob/3e19febe933ce5d0dccec44012cc3e496976d738/Documents/NOX_SUITE_IMPLEMENTATION_PLAN.md) remains the historical reference. This is an explicit subsequent clarification, not a claim that the original plan specified Unix sockets. The current implementation-plan file is left unchanged.

## 2. Decided requirements

- Backend, Yard, Gateway and every product participating in this Suite installation run on the **same machine/host**. Separate containers on that host are supported.
- A product on another machine cannot join this installation, even on the same LAN, using a private IP, or presenting a valid HTTPS certificate. Internet-originated product connections are also excluded.
- Setup is performed through the Backend's existing dashboard and the Yard's existing deployment workflow. Users must not generate certificates, transfer pairing JSON/credentials, supply private-network CIDRs, or configure proxy trust merely to associate local Suite products.
- Preserve the Backend's existing functionality, data and compatibility with **all existing consumers**. Individual consumers do not define the Suite architecture. Retain the native frontend, with frontend/backend delivered separately in the same Backend project.
- Yard owns deployment and initiates registration for products it installs. Backend owns membership, identities, credentials, permissions and the registry. Gateway owns discovery, aggregation and routing. No additional deployment manager or certificate service is introduced.
- There is no fixed catalog of Suite products. A conforming future product follows the same presence, pairing, registration and authorization rules without product-specific Gateway/CLI branches.

This restriction concerns **participating product services**. It does not, by itself, prohibit an authenticated human from opening an existing dashboard or using the CLI through the product's supported access policy. Browser/client access and inter-product Suite transport are separate boundaries.

## 3. Shared local channel

Use HTTP messages over **Unix-domain sockets**, carried through an ordinary local Docker volume shared by the participating service containers. HTTP here is the protocol framing; the connection is to a local socket, not to a TCP/IP destination. There is no network port or TLS certificate for this inter-product channel.

Deployment conventions:

| Item | Meaning |
| --- | --- |
| `nox-suite-local` | One shared local Docker volume for this installation; deployments must reference the same volume rather than creating project-prefixed independent copies |
| `/run/nox-suite` | Mount point **inside participating containers**, not a user-selected folder on a PC |
| `/run/nox-suite/<productId>.sock` | Socket owned by the product's participating service; for example, `/run/nox-suite/nox-backend.sock` |
| Existing product URL | Native web/dashboard address configured in Backend administration; it does not establish host locality or grant service authority |

Mount the volume only into services that need the Suite channel. A product's frontend or unrelated containers do not need it solely because they share a Compose project. Sharing a pathname without sharing the actual volume is insufficient.

The delivery must prepare the directory, access permissions and mounts in the images/Compose definitions. Services must run with the minimum filesystem access needed; do not solve sharing by making the directory world-writable or by giving Backend/Gateway access to the Docker socket. Yard retains its existing authorized Docker management responsibilities.

Each service creates its socket on startup and owns its cleanup/recovery. Listener ownership must prevent one process from replacing an active listener. Validate product identifiers and paths; reject symlink/path traversal substitutions. Never remove arbitrary files during stale-socket cleanup. Missing or inaccessible sockets produce an explicit local-channel error with no TCP fallback.

This boundary assumes the installation's Docker host and deployment administrator are trusted. Do not expose sockets through TCP relays or mount this volume across machines/NFS. File presence alone is not cryptographic product identity or permission to join.

## 4. Presence announcement is not membership

“Announcing that a container exists” means that the product makes its local channel available and serves its existing public, non-secret **`GET /nox/integration` declaration** through that channel. This design adds no multicast, UDP broadcast, LAN scan or Internet discovery service.

The implementation must keep these states distinct:

| State | Evidence and consequence |
| --- | --- |
| Present | A local socket is available; contact may be attempted |
| Identified | The declaration is valid and matches the intended product; it is still untrusted data |
| Paired | Backend-authorized pairing has completed and the participant has persisted and acknowledged its scoped service credential |
| Registered | Backend has accepted the verified product registration |
| Available for MCP | Gateway has separately verified the registered product's declared Suite MCP capability and current availability |

Creating a socket, returning a declaration or appearing in a directory never automatically enrolls a product. A stale socket does not prove a running product. A valid declaration does not prove readiness for MCP. Loss of connectivity must not silently remove registry membership.

## 5. Foundation setup and future product installation

### Backend, Yard and Gateway

1. Their deployments prepare the same local volume and the services publish their own local channels on startup.
2. The administrator configures the Yard/Gateway native URLs in the Backend dashboard and confirms association there.
3. Backend contacts the intended service through the local channel, validates its declaration and shows an accurate verification result. The entered web URL is not used as proof that a service is on the same host.
4. The services execute the existing intent/proof/provisioning/acknowledgement process, persist credentials privately and complete verified registration. The normal dashboard flow does not expose protocol secrets for copying.
5. Backend shows actual pairing and registration state. Saving a URL alone must not report the service as integrated or available.

### Any product installed through Yard

1. Yard uses its existing deployment/configuration/jobs/recovery flow to install the product on this host and prepare its local Suite channel.
2. The product starts and makes its declaration available locally.
3. Yard initiates the authorized association and registration against Backend, bound to the deployment it manages. Backend verifies and records membership; Yard does not become a second registry.
4. Gateway consumes the authorized registry and contacts the product through its local channel. A product can remain registered without providing MCP tools.
5. Where MCP and CLI metadata are provided, Gateway exposes the authorized tools and the CLI consumes the shared metadata. Neither needs a business-specific integration for the new product.
6. Updates, restart, failure and removal use the existing lifecycle responsibilities: Yard reports deployment changes, Backend maintains registry/trust state, and Gateway reports its observed MCP availability.

### Automatic pairing delivery

The participant's local listener exposes **`POST /nox/integration/pairing`** for Backend-initiated setup. The JSON object contains `contractVersion: "1.0"`, `backendOrigin: "http://nox-backend"`, and `intent`, which is the complete existing SDK `SuitePairingIntent` object. `Idempotency-Key` is the stable setup attempt ID. This envelope is a host-adapter responsibility; the nested intent uses the existing shared loader and proof rules. No personal key or browser cookie is forwarded.

The receiver validates version, intended product/origin and expiry, then resumes the existing completion/provisioning/ACK exchange through `nox-backend.sock`. Persist the received intent/recovery state and provisioning privately before acknowledging with the issued service credential. Repeated delivery must resume that same intent rather than create a second association. Allow concurrent declaration reads while handling delivery: Backend verifies `/nox/integration` during the completion callback.

Accepted delivery may return `200`, `202` or `204`; it does not establish registration. Backend requires actual credential acknowledgement, then verifies and commits registration. A missing receiver (`404`/`405`) reports an explicit adapter-update error. Redirects are refused. A receipt timeout is reconciled against actual pairing state before any retry; background reconciliation does not redeliver intents automatically.

## 6. URLs, identity and existing SDK contracts

Native web addresses remain HTTP/HTTPS origins with an IP/port or dedicated hostname. Application prefixes such as `/apps/product` remain unsupported. Native URLs, OAuth callbacks and existing client APIs must not be silently rewritten when adding the Suite channel.

The local transport needs a stable protocol identity for registry origins and signed audiences. The normal convention is **`http://<productId>`**, such as `http://nox-backend`, routed exclusively to that product's socket by the host adapter. It is a logical origin, not a request to resolve that name using DNS. Preserve canonical origin/path rules and exact audience binding; keep the native web URL separate.

The mapping must cover every SDK-valid product ID. Numeric-only IDs use `http://<id>.nox-suite` so URL parsers cannot reinterpret them as numeric IPs. A 64-character ID is split after its first 32 characters into two DNS labels and suffixed with `.nox-suite`, keeping each label within DNS syntax limits. The socket filename remains the complete original `<productId>.sock`. Accept only this canonical mapping; do not add DNS resolution or alternate network destinations. Ordinary IDs retain the readable origin shown above.

This convention and its mapping into consumer persistence/APIs must be implemented and validated consistently in every adapter before declaring the Suite flow complete. Backend mapping tests cover numeric-only and maximum-length IDs. Existing stored network associations must not be silently reinterpreted as local associations.

SDK `0.7.1` supplies HTTP/HTTPS validation, pairing proofs, scoped credentials, signed delegation verification and the other shared mechanisms. **It does not create sockets, mount volumes, perform announcements or prove host locality.** Host adapters must enforce the local transport. Sharing the volume does not replace authentication, grants, revocation, user capabilities or product domain authorization.

For Backend inter-product endpoints such as `/api/nox/*` and `/mcp/suite`, the adapter accepts service communication only through the local listener. TLS, loopback/private source addresses and forwarded headers must not authorize a TCP service connection. Authenticated human administration remains available through the native dashboard/APIs with its existing session/API-key and CSRF protections; it must not turn into a general network proxy for service credentials.

## 7. Automation and existing deployments

| Responsibility | Required delivery |
| --- | --- |
| Images and Compose | Prepare local directory permissions, shared volume, mounts and listener settings; expose no inter-product Suite TCP port |
| Service startup | Create/recover the service's own socket and serve declaration/protected Suite routes locally |
| Backend dashboard | Configure native foundation URLs, confirm association, show verified state and offer safe retry/recovery |
| Participant adapter | Execute pairing and persist/acknowledge credentials without manual transfers |
| Yard deployment | Prepare the channel for installed conforming products, initiate their registration and report lifecycle through existing jobs |

An existing installation requires an updated deployment definition to add the volume/mounts. Pulling/recreating an image alone cannot add missing mounts. That migration must be delivered ready to use, with existing Backend data preserved. Once Yard is adapted, its supported Suite deployment workflow must prepare these settings itself. This is planned behavior, not a claim that the current Yard already does it.

No additional daemon, certificate authority, manual certificate distribution or user-PC folder is required by this proposal. Other installation methods must provide an equivalent host-local channel; an unsupported environment must fail clearly instead of silently allowing LAN communication.

## 8. Acceptance and current state

Before marking this work complete, demonstrate:

- Foundation setup through Backend administration without certificates, protocol JSON copying or network allowlist configuration; accurate errors for an unadapted/unavailable participant.
- A new conforming product installed through Yard is paired, registered and discoverable; its authorized CLI tools work without Gateway/CLI product-specific code.
- Product service calls over TCP are rejected from another host, the same LAN, the Internet, loopback and a proxy with forged/trusted HTTPS headers. Ordinary native APIs remain compatible.
- Local presence without valid credentials/proofs does not grant membership or execution; invalid declarations, wrong product identity, redirects and filesystem substitutions are rejected.
- Restart, container recreation, interrupted setup, response loss and retries preserve data and recover without duplicate associations or leaked credentials. Removal and credential revocation invalidate access correctly.
- Browser/native URL changes do not silently change service identity or signed audiences. Separate frontend/backend builds remain usable with existing consumers.

SDK `0.7.2` is released and includes the earlier same-host design record. Backend source now implements its side of the channel and automatic setup, with local Go race/vet, frontend unit/type/lint, image/version/healthcheck, native browser regression and local HTTP browser setup/recovery checks passed. That source is not yet a published Backend release. Gateway/Yard/CLI adaptation and the actual installed multi-product journey remain separate work. This status update does not retroactively change published SDK artifacts or claim GitHub CI/production rollout.
