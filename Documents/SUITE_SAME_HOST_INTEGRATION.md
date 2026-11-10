# NoX Suite — same-host presence, communication and registration

This reference applies to every present or future Suite product, independently of its business domain or implementation language. Backend, Yard and Gateway implement this local-channel model; SDK `0.7.3` supplies shared contracts and helpers. The SDK does not create sockets or deploy services.

## Local channel and logical origins

Participating services run on one host. Container deployments share the named local volume `nox-suite-local`, optionally selected through `NOX_SUITE_LOCAL_VOLUME_NAME`, at `/run/nox-suite`. Each product owns its `<productId>.sock` Unix listener. Native frontend containers and unrelated companion services do not receive this mount.

A canonical logical origin such as `http://nox-backend` identifies the local product; the adapter maps it to that product's socket. It is not a DNS destination or the address a user opens. The HTTP protocol is carried over the Unix socket, with scoped credentials and signed delegations. There is no service TCP fallback, LAN-wide discovery, certificate-copying requirement or public service enrollment.

Native browser URLs are configured separately and may use HTTP or HTTPS. CLI clients connect to Gateway over the installation's private LAN/VPN access path. Native HTTPS certificate validation remains required when that scheme is used. A hostname, local socket or Compose label alone does not establish membership.

## Setup and registration

Backend's native dashboard verifies and connects foundation services through the local channel, delivering pairing credentials automatically. Products persist provisioning before acknowledgement. Backend owns membership and permissions; Gateway consumes the registry and discovers authorized tools.

For subsequent participating deployments, Yard prepares the shared mount through its existing deployment path and initiates enrollment/registration after the actual product is available. The product image must implement the local adapter and declare its integration capability. Installing an arbitrary image or adding a label does not implement that adapter.

## Installer deployment authority — clarified model, November 4, 2026

Pairing the installer is the administrative act that delegates management of its own deployments. The existing NoX Login session identifies the admitted user; installing a product does not require another account approval or forwarding a personal Auth token. There is no `X-Nox-User-Authorization` protocol.

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
