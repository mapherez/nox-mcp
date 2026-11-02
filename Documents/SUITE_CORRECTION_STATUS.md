# Suite correction scope and consumer migration

This records the correction authorized on **November 2, 2026**. It is an implementation record, not a replacement for the owner's original plan. Changes here do not authorize unrelated functionality, consumer edits or publication.

**Current deployment clarification:** participating Suite products must run on the **same host**, not merely on the same LAN. [Same-host presence, communication and registration](SUITE_SAME_HOST_INTEGRATION.md) records that requirement, the proposed Unix-socket channel, automation responsibilities and acceptance criteria. The channel and automated association are not yet implemented. SDK `0.7.1` has been released; the new same-host record is subsequent documentation, not functionality delivered by that release.

## Reference and boundaries

The earliest available original plan is [NOX_SUITE_IMPLEMENTATION_PLAN.md at 3e19feb](https://github.com/mapherez/nox-mcp/blob/3e19febe933ce5d0dccec44012cc3e496976d738/Documents/NOX_SUITE_IMPLEMENTATION_PLAN.md). Its SHA-256 is `5097f7ab165d4160f0e9af445c3ec9e902dbf703a08267ee1fe0fef851c11532`. It defines HTTP examples, Backend-native foundation configuration, Yard installation and registration initiation, and Gateway discovery/routing. A later document is not evidence that every added requirement was approved.

The current `NOX_SUITE_IMPLEMENTATION_PLAN.md` is left unchanged. Its SHA-256 before this correction is `30f1aa3c92c5f44e6b9ed14d9e157da9d695476ad0075dd956f732a313b4dde8`. Use the original reference and the owner's explicit subsequent clarifications, including separate Backend/frontend delivery in the same project with its native frontend retained. The later HTTPS-only restriction is superseded by the present authorized correction, not used to justify the existing code.

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
| Backend | Consume SDK 0.7.1; enforce the same-host channel; finish association initiated in the existing dashboard/APIs, including service execution and recovery. Avoid manual protocol JSON/certificate transfer and preserve native/OAuth/client behavior. | Adaptation in progress; local transport and automated association not applied. |
| Gateway | Consume the corrected SDK and adapt local transport and pairing persistence to the Backend flow. Continue registry, authorization, discovery and dispatch work without adding deployment/certificate management. | Subsequent point; same-host adaptation not implemented. |
| Yard | Reuse existing deployment/jobs/configuration/recovery to prepare local channels, associate and request registration, then report lifecycle/removal. Do not replace its existing product behavior. | Separate adaptation; same-host flow not implemented. |
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

Point 3 delivered the HTTP/HTTPS SDK correction in `0.7.1`; it did not implement the subsequently clarified local channel. Point 4 is in progress and depends on the remaining consumer transport work in point 2. Preserve existing Backend behavior throughout, and verify it under point 5. Later points and end-to-end acceptance remain outstanding. Documentation of a design must not be reported as implementation completion.

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
