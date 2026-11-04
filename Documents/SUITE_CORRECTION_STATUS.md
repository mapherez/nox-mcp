# Suite correction scope and consumer migration

This records the correction authorized on **November 2, 2026**. It is an implementation record, not a replacement for the owner's original plan. Changes here do not authorize unrelated functionality, consumer edits or publication.

**Current progress, November 4, 2026:** participating Suite products run on the **same host**, through the [shared local channel](SUITE_SAME_HOST_INTEGRATION.md). SDK `0.7.2`, Backend `v1.2.0`, Auth `v0.0.2` and Yard `v1.4.0` form the published baseline; the owner accepted installed Backend/Yard Google login and global logout. Gateway points **6 + 9** were implemented and the owner reported Gateway `v0.0.1` registered in Backend. Yard points **7 + 8** are now implemented in source with corresponding scoped Backend deployment management and local real-service verification. Those new changes are not published or accepted on the installed host yet. Product adaptation, CLI and complete installed Suite acceptance remain subsequent work.

**Authorized authentication change, November 3:** [implementation-plan section 20](NOX_SUITE_IMPLEMENTATION_PLAN.md#20-nox-auth-and-shared-nox-login) records the new headless Auth service, central Google admission and the order Auth → Yard acceptance → Backend/other apps. The canonical requirements contract is `nox-auth/NOX_AUTH_CONTRACT.md`; the owner has confirmed the five-minute admission-check interval. Auth `v0.0.1` is published/running and the owner accepted Yard NoX Login with real Google login. Backend adaptation is now in source; its published/installed acceptance remains separate. Backend requires the subsequent private admission capability in Auth, so Auth must be updated first.

**Installed login acceptance, November 4:** after updating Auth, Backend and Yard, the owner confirmed Google login in Backend and Yard, Backend's **Logout all** revoking the Yard session in another tab, and successful subsequent login in both applications. These installed flows are accepted. Yard correction points **7 + 8** remain incomplete and retain their existing scope; no deployment self-authorization or further implementation is introduced by this record.

## Reference and boundaries

The earliest available original plan is [NOX_SUITE_IMPLEMENTATION_PLAN.md at 3e19feb](https://github.com/mapherez/nox-mcp/blob/3e19febe933ce5d0dccec44012cc3e496976d738/Documents/NOX_SUITE_IMPLEMENTATION_PLAN.md). Its SHA-256 is `5097f7ab165d4160f0e9af445c3ec9e902dbf703a08267ee1fe0fef851c11532`. It defines HTTP examples, Backend-native foundation configuration, Yard installation and registration initiation, and Gateway discovery/routing. A later document is not evidence that every added requirement was approved.

`NOX_SUITE_IMPLEMENTATION_PLAN.md` was left unchanged during the November 2 correction. Its SHA-256 before that correction was `30f1aa3c92c5f44e6b9ed14d9e157da9d695476ad0075dd956f732a313b4dde8`. On November 3 the owner explicitly requested an update for NoX Auth; that dated update also makes the previously authorized same-host/transport clarifications explicit in the plan. The historical hash is not a claim that the newly updated file is identical. Use the original reference and explicit subsequent owner decisions, including separate Backend/frontend delivery with the native frontend retained. The later HTTPS-only restriction is superseded by the authorized same-host correction.

Products remain autonomous. Backend preserves users, API keys, vaults, blobs, synchronization and existing client/frontend integrations. Yard retains Docker/Compose management, configuration editing, previews, workers and recovery. Gateway remains a headless router/aggregator. SDK remains a library; it neither runs a certificate authority nor implements a deployment manager or setup UI. Contracts apply to any conforming present or future product.

## SDK correction released in 0.7.1

- Origins accept HTTP and HTTPS, preserving the scheme and distinguishing default ports 80/443. Paths, credentials in URLs, ambiguous addresses, redirects and authorization remain separate validation/policy concerns.
- Resources, provisioning key URLs, registration/snapshot documents, Gateway composition and signed audiences use the same rules. HTTP does not become an alias for HTTPS.
- Pairing keeps HMAC-SHA-256 over the complete product/origin/declaration/nonce/pairing binding. HTTPS requires its TLS public-key fingerprint; HTTP omits it. No dummy certificate/fingerprint is introduced.
- Signed ES256 delegations, five-minute reuse bounds, scoped service credentials, role capabilities, invalidation and domain authorization are retained. A local IP or an accepted URL alone grants no authority.
- Schemas, generated native copies/DTOs and shared conformance cases are synchronized for TypeScript, Go and Rust. Existing required CI already runs the shared Suite, runtime, packaging and consumer checks.

HTTP/HTTPS syntax support in the SDK does not authorize LAN communication or establish host locality. Consumer adapters must enforce the same-host boundary described in the linked local-channel design. Native web/client transport remains separate; where HTTPS is used, its validation must not be disabled or downgraded after a failure.

## Published-version and API migration

Published **0.7.1** contains the SDK correction; historical **0.7.0 is unchanged** and still has the HTTPS-only restrictions. Consumers must upgrade explicitly. Wire documents retain `contractVersion: "1.0"`; updated readers accept the existing HTTPS documents, while old readers do not support the new HTTP documents. Do not send HTTP documents to an unadapted 0.7.0 host or silently convert stored HTTPS associations. This documentation update creates no release, tag, commit or remote publication.

The generated TLS fingerprint field becomes optional: TypeScript `tlsPublicKeyFingerprint?: string`, Go `TlsPublicKeyFingerprint *string`, Rust `tls_public_key_fingerprint: Option<String>`. Update native constructors and transport-dependent checks. HTTPS constructors still supply their real fingerprint. HTTP constructors omit it. Both complete loaders and cryptographic helpers enforce the selected scheme's binding rules.

## Consumer work still required

| Component | Required correction | Current scope |
| --- | --- | --- |
| Backend | Consume SDK 0.7.2; enforce the same-host channel; finish association initiated in the existing dashboard/APIs, including service execution and recovery. Avoid manual protocol JSON/certificate transfer and preserve native/OAuth/client behavior. | Published baseline v1.2.0 includes owner-accepted NoX Login/global logout. New scoped installer deployment management is implemented and locally tested in source; publish/update Backend before the corresponding Yard release. |
| Gateway | Consume the corrected SDK and adapt local transport and pairing persistence to the Backend flow. Continue registry, authorization, discovery and dispatch work without adding deployment/certificate management. | Points 6 + 9 implemented: local automatic setup, registry/events, private authorization/discovery, generic dispatch/probes, Docker/Compose, checks and release automation. Local source/image and real Backend acceptance passed; the owner subsequently reported v0.0.1 registered in Backend. This is not full Yard/product/CLI acceptance. |
| Yard | Reuse existing deployment/jobs/configuration/recovery to prepare local channels, associate and request registration, then report lifecycle/removal. Do not replace its existing product behavior. | Points 7 + 8 implemented in source: local automatic pairing; existing-job-driven registration, lifecycle/removal and recovery; safe status/retry in Settings. Real isolated Backend/Auth/worker acceptance passed. Publication, installed rollout and point-12 full-product acceptance remain separate. |
| Other products and CLI | Implement declaration/admission and generic metadata consumption against the same contracts. No product-specific branches in Gateway/CLI. | Subsequent work; not certified by SDK tests. |

Foundation URLs and confirmation in Backend administration must lead to service-executed association with accurate state. These are adapter responsibilities, not implemented by changing a URL validator. This correction defines no new standalone installer or mandatory first-run wizard.

## Fixed correction sequence

These are the original task labels from the correction discussion, retained verbatim to avoid renaming or renumbering work:

1. **Fixar a referência e delimitar as alterações.**
2. **Corrigir o transporte e a configuração dos endereços.**
3. **Adaptar os contratos e os três SDKs a esse funcionamento.**
4. **Completar a configuração inicial no Backend.**
5. **Preservar os usos existentes do Backend.**
6. **Adaptar o Gateway ao mesmo processo de configuração.**
7. **Adaptar o Yard, reutilizando o seu deployment existente.**
8. **Ligar o lifecycle do Yard ao registo do Backend.**
9. **Retomar os restantes pontos do Gateway.**
10. **Adaptar os produtos participantes.**
11. **Implementar a CLI sobre esse percurso.**
12. **Validar o percurso completo e a entrega.**

Point 3 delivered the HTTP/HTTPS SDK correction in `0.7.1`; `0.7.2` published the shared local-channel design. Point 4 and its Backend transport prerequisite in point 2 are implemented. Point 5, **Preservar os usos existentes do Backend**, completed the native route/authentication/storage/deployment review, removed an accidental Suite field from the native user-status request, and verified migration 7→8 preserving native data and existing trust. The owner subsequently reported successful Backend builds and browser validation.

The owner authorized **6. Adaptar o Gateway ao mesmo processo de configuração.** and **9. Retomar os restantes pontos do Gateway.** together, before returning to Yard. Both are implemented in Gateway source with local verification recorded below. The correction order remains **6 + 9 → 7 + 8 → 10 → 11 → 12**, preserving the original names and numbers. Auth implementation and installed Yard/Backend login acceptance preceded resumption of points 7 + 8. Those points now have a source implementation and isolated lifecycle acceptance; this does not renumber them or complete points 10–12. Gateway publication/registration was subsequently reported by the owner. Success against Backend and generic protocol fixtures is not completion of the full Suite journey.

## Authentication decision and withdrawn authorization change

The owner requested the NoX Auth requirements contract in its newly initialized repository and an explicit implementation-plan update, then approved the five-minute admission/revocation-check interval and service implementation. Auth remains headless; Google credentials and account admission move there. Human sessions are one year, renewable; local logout affects the current app. Auth implements Suite-session revocation; its control belongs in Backend's native dashboard and later Portal when those adapters are implemented. Auth source uses persistent SQLite, maintained OIDC libraries, private runtime exchanges and separate restricted local client administration; it includes a Go consumer helper, minimal environment example, Docker/Compose, CI/release tooling and security/session tests. The owner subsequently accepted real Google/Yard login. Adapt Backend next, then the other apps; no separate data-import project or database reset is authorized.

An unapproved local Backend change would have let an installer service grant itself deployment associations. It was **reverted**, restoring `SuiteSetDeployment` to the existing `suiteAdmin` authorization and leaving that source file identical to its committed baseline. The existing `TestSuiteInstallerMayPairOnlyAuthorizedDeployment` passed after the rollback: service self-grant remains forbidden; an administrative grant remains accepted. No security test was weakened. No additional Backend implementation or Yard fixes were performed in this documentation/rollback task.

The subsequent owner clarification supersedes the pending per-action identity proposal: the normal application login already identifies the admitted user, and administrative installer pairing delegates management of its own local deployments. No personal Auth token is forwarded and no second account approval is requested per installation. Backend checks the enrolled service, private channel, canonical local target and exact deployment ownership. It does not grant global administration to that service. The earlier unapproved broad change remains a withdrawn historical attempt; the implemented policy is the bounded delegation documented in [Installer deployment authority](SUITE_SAME_HOST_INTEGRATION.md#installer-deployment-authority--clarified-model-november-4-2026). This dated clarification also supersedes the pending per-human-deployment-proof language added in implementation-plan section 20, without rewriting the owner's original plan. Tool metadata and `_meta.cli` menu work remain deferred to point 10.

## Gateway points 6 + 9: local verification

Gateway consumes the published SDK `v0.7.2`. Backend-native configuration automatically delivers pairing over the shared same-host Unix channel, with durable provisioning before ACK and resumable recovery. Native client URLs accept HTTP or HTTPS independently; no certificate, pairing file, CIDR or deployment-specific IP is required for service setup. Gateway retains no deployment manager or product allowlist.

The following checks passed locally on November 2, 2026:

- Full Gateway source/process check: dependency lock/module verification, vet, Go race tests, five release-tooling tests, twelve optional certificate-helper tests, binary smoke/signals/crash recovery and sanitized logs.
- Minimum Go `1.26.0` validation and Linux `amd64`/`arm64` cross-compilation; current installed Go validation used `1.27.3`.
- Actual independent Backend `v1.1.1` and Gateway binaries with disposable state: dashboard-API save/verify/confirm, automatic local pairing, authenticated empty catalog, private discovery, real Backend tools, administrator/member and vault isolation, service-only readiness observations, restart identity, bounded outage reuse, account invalidation, registration removal and secret-free Gateway state/logs.
- Generic conforming SDK test participants: alias collisions, private user views, delegation reuse, source failure isolation, cancellation, uncertain writes without retries, stale-definition rejection, cursor expiry/reconciliation, failed persistence, request limits and denial/outage behavior. These are protocol fixtures, not proposed Suite products.
- Built Gateway Docker image: version, non-root startup, shared local socket, private state preserved across container recreation, healthcheck and rejected anonymous MCP/TCP pairing. Production/development Compose configuration and workflows (`actionlint 1.7.7`) also passed local checks.

Gateway CI requires actual Backend acceptance against commit `4a4b72b4c3a1cfb85c581f42bb3351d8a4880cea` (`v1.1.1`), platform checks and the packaged image. Its release workflow depends on that validation. Remote CI, multiarchitecture image publication and the installed complete Suite flow were not inferred from these local results. The original implementation-plan file was unchanged during that verification; the separately authorized November 3 Auth update is recorded above.

## Acceptance and recorded verification

Shared tests cover HTTP/HTTPS IPs and hostnames, scheme-specific ports, IPv6 and malformed origins; complete HTTP registration/provisioning/snapshot documents; HTTP and HTTPS pairing; rejection of TLS fingerprint omissions for HTTPS and fake TLS fields for HTTP; HMAC binding substitutions; and signed user/probe grants with cross-scheme audience rejection. Existing permissions, deadlines, cache, cancellation, runtime and packaging tests remain required.

SDK verification does not certify installed Backend/Gateway/Yard integration. The eventual acceptance must demonstrate foundation setup in the Backend, Yard deployment and registration, Gateway discovery and CLI execution on an isolated installation with different addresses, plus failures/restart/removal and existing-product regression checks.

Local verification on November 2, 2026 passed:

- `npm test`: 212 tests; existing SDK/runtime/release-tooling regressions retained.
- `go test -race -mod=readonly ./...`: passed on installed Go and on Go 1.26.0.
- `cargo test --locked --manifest-path rust/Cargo.toml`: all Rust suites passed.
- `npm run test:suite`: identical normalized observations in all three languages, including 312 document cases and 55 signed-token cases, plus HTTP/HTTPS pairing proofs.
- `npm run test:conformance`: identical existing runtime behavior in 18 shared scenarios.
- `npm run test:native-packages`: standalone Go module and actual packaged Rust crate/independent consumer passed.
- `npm run package:check` and `npm run package:check -- --minimum`: installed TypeScript tarball, public exports, strict consuming build, Suite tests and JSON/SSE transports passed with latest compatible and minimum dependencies.
- `npm run test:discovery`: existing three-language discovery and supported real transport fixtures passed.
- Generated-output drift, local documentation links, unchanged implementation-plan hash and clean Backend/Gateway/Yard working trees were verified.

Existing required CI jobs already include these test categories and the independent dependency/platform matrix; no workflow weakening or new publication trigger was introduced. These are local results, not a claim that GitHub CI or an installed Suite flow has run.

## Backend NoX Login adaptation — November 3, 2026

After owner-reported Yard acceptance, the authorized Backend work replaces native
Google login with the shared Auth client, preserves user/data/key ownership and
local role restrictions, and adds local/Suite logout. Operational details and
release order are in `nox-backend/docs/nox-login.md`. A new private Auth account
admission endpoint is required for existing independent API keys; it grants no
service permission or login and keeps browser logout separate from key lifetime.
Auth `v0.0.1` must be updated to the service release with this capability before
Backend rollout. The owner subsequently confirmed installed Google login, cross-app
global logout and successful re-login on November 4, as recorded above. No SDK
wire change or completion of Yard lifecycle points 7 + 8 is claimed.

## Yard points 7 + 8 — implementation and verification, November 4

The existing manager/worker is retained. Marked participating services receive the
shared local channel automatically through the existing preview/source path;
ordinary companion containers remain unchanged. A transactional outbox records
job outcomes and binding candidates. The local controller pairs/registers actual
products, reports stopped/running and operation states, refreshes changed
registrations, and retires its own registration/grant on removal. Retries use
private durable journals and never rerun Docker installation jobs. Active
replacement/recovery jobs protect temporary container absence from deregistration.

Backend accepts only a current enrolled installer's own deployment path and
canonical same-host product. Concurrent/foreign claims, target substitutions,
foundation/standalone takeovers and native account/key administration remain
forbidden. Product proof, acknowledgement, revisions, conditional/idempotent
mutations and exact managedBy remain required. SDK and Auth need no code/release
change for this work; Backend must be published/updated before Yard rollout.

Local real-service acceptance covers automatic foundation pairing, actual
Yard-managed deployment and volume isolation, registration/observations,
stop/start, declaration refresh, controller restart, removal/reinstall, and
Backend outage with registration recovery without replaying Docker jobs. Separate
source tests cover transaction persistence, companion-removal scope, competing
installers, private HTTP routes and active-replacement protection. Yard Settings
shows safe integration state and revision/session/CSRF-protected retry.

The real Google login/global logout acceptance remains the owner's prior installed
verification. The full lifecycle test uses an updated Backend candidate image;
the default shared CI runtime fixture tests foundation pairing with published
Backend v1.2.0/Auth v0.0.2. Neither is a claim of remote CI, publication, installed
product adaptation, CLI behavior, or final point-12 acceptance. See
`nox-yard/Documentation/Developer/Suite-Integration.md` for commands and boundaries.

## Point 10 — SDK publication boundary, November 4, 2026

Before continuing Backend menu descriptors, the owner explicitly requested that
human menu information stay out of normal MCP catalogs. Source after SDK 0.7.2
now projects `_meta.cli` out of standard `tools/list` in TypeScript, Go and Rust,
including runtimes without discovery. Unrelated metadata, schemas, annotations,
operations, authentication and results retain their existing behavior.

NoX `nox/tools/definitions` retains the complete canonical tool, its CLI path and
optional separate interactive descriptor. Manifests/loaders remain lossless;
canonical fingerprint algorithms and stale-definition guards are unchanged.
This keeps menus available to the interactive NoX CLI without relying on an AI
client to discard fields it received. The future CLI's AI-facing MCP surface must
publish the normal projection rather than its human navigation interface.

This correction is confined to this repository. Existing released consumers,
including Backend and Gateway, change only after an explicit SDK/publication
adapter update. Backend menu implementation remains the next separate step of
point 10; no product, CLI, release or deployed installation is changed here.
The original implementation-plan file is unchanged.

Local verification of this SDK correction passed: 212 TypeScript tests, complete
Go race tests and vet, the Rust suite, identical runtime observations in 18 shared
scenarios, Suite conformance (312 document and 55 signed-token cases), and real
supported discovery transports (stdio/HTTP JSON in all three languages, SSE in
TypeScript/Rust). The standalone Go module and packaged Rust crate/independent
consumer passed. The installed TypeScript tarball passed consumer build and real
legacy/modern HTTP JSON/SSE with both minimum and latest compatible dependencies.
Shared publication cases cover absent/empty metadata, CLI-only and mixed metadata,
null/object CLI values, unrelated nested fields and authorization metadata. Tests
also verify source immutability, CLI-only fingerprint changes and unchanged normal
catalogs/calls. Existing required CI/release jobs already run these test categories;
no workflow was weakened or publication triggered. Remote CI and consumer rollout
remain separate from these local results. Work stops here before Backend menus.
