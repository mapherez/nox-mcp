# NoX Suite — same-host presence, communication and registration

Recorded **November 2, 2026**. This document captures the owner's same-host clarification and the local-channel design discussed afterwards. It applies to every present or future Suite product, independently of its business domain or implementation language.

**Status, updated November 2, 2026:** the same-host requirement and local-channel target are recorded here. SDK `0.7.2` is released. Backend `v1.2.0` and Auth `v0.0.2` form the published login baseline; installed Google login and global logout were owner-accepted. Gateway source adaptation and owner-reported registration precede Yard's current points 7 + 8. Yard's same-host adapter and bounded installer deployment management are now implemented in Yard/Backend source with local verification. New publication/installed rollout and the product/CLI journey remain separate. Use the [current correction status](SUITE_CORRECTION_STATUS.md) for evidence and release boundaries.

## Installer deployment authority — clarified model, November 4, 2026

The owner clarified that the same admitted user operates the applications and
that pairing the installer is the administrative act that delegates management
of its own deployments. Installing a product does not require another account
approval. The proposed forwarding of a personal Auth token was withdrawn and
was not implemented. There is no `X-Nox-User-Authorization` protocol.

The responsibilities are distinct:

- NoX Login handles the existing application login/session. A normal authenticated
  action in Yard uses that session; it does not ask the user to approve the same
  account again for each installation.
- Backend administrative pairing enrolls an installer with associated pairing,
  registry management and lifecycle scopes. Backend authenticates that service
  credential on the private same-host channel for subsequent deployment work.
- The installer may create/read/retire only its own deployment associations.
  The path's service ID must equal its current enrolled service identity. The
  target must use the canonical local product origin and cannot be the installer
  itself, a foundation service, a standalone association, or another installer's
  product. A product identity cannot have two active deployment claims.
- An existing association cannot silently change product/origin. Replacements
  retire the old registration and grant first. Reinstallation uses a fresh
  deployment ID and the current product trust revision; delayed cleanup must not
  remove a replacement association.
- Registration still requires the actual product declaration, pairing proof,
  durable credential acknowledgement, current grant and exact managedBy binding.
  Neither a Compose label nor socket presence establishes membership alone.
- Service authority does not grant account/key administration. The native
  dashboard/API and existing domain authorization keep their protections.

Backend deployment PUT/list responses include the current `trustRevision` so an
installer can conditionally pair an updated or reinstalled product without
blindly overwriting its trust head. This is management response metadata; it does
not change the SDK schemas or require an Auth service change.

Yard uses its existing managed jobs and their transactional outbox. It prepares
the shared channel only for explicitly marked participating services, journals
integration recovery separately, reports actual Docker lifecycle, and removes
its registration/grant after removal. Integration retries do not replay Docker
jobs. Ordinary companion containers receive no Suite channel automatically.

This model applies to any conforming product and scoped installer; it is not a
special account exception for a named product or a homelab address configuration.
