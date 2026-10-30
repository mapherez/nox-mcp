import { canonicalize, fingerprint, interpretCli } from './discovery.js';
import { loadSuiteDocument, resolveSuiteEndpoint, suiteDefaults, suiteFail, suiteToolAlias } from './suite.js';
import type { SuiteGatewaySnapshot, SuiteGatewaySource, SuiteGatewayRoute } from './suite-types.generated.js';
import { suiteIdentityState, type VerifiedSuiteIdentity } from './suite-auth.js';

export function suiteAuthorizationViewKey(identity: VerifiedSuiteIdentity, credentialPartition: string, policyRevision = '1.0'): string {
  const value = suiteIdentityState(identity); const context: any = value.context;
  if (!/^[A-Za-z0-9_-]{43}$/.test(credentialPartition) || !policyRevision) suiteFail('INVALID_INTEGRATION');
  return fingerprint([credentialPartition, identity.claims().iss, context.userId ?? context.serviceId, context.keyId ?? null, context.authRevision ?? context.serviceCredentialRevision, [...(context.scopes ?? [])].sort(), policyRevision]);
}
export interface SuiteGatewayOptions {
  serverId: string;
  /** Opaque private partition, derived from verified authority, never a role label. */
  authorizationViewId: string;
  registryRevision: string;
  sources: readonly SuiteGatewaySource[];
  nowMs: number;
  authorizationExpiresAtMs: number;
  policyRevision?: string;
  maxBytes?: number;
}
function rewriteCli(input: any, names: ReadonlyMap<string, string>): any {
  interpretCli(input); const result = structuredClone(input);
  const source = (value: any) => {
    if (!value) return;
    const alias = names.get(value.tool); if (!alias) suiteFail('INVALID_CLI'); value.tool = alias;
  };
  for (const parameter of Object.values(result.parameters ?? {}) as any[]) if (parameter.options) source(parameter.options);
  if (result.preview) source(result.preview);
  for (const step of result.workflow ?? []) if (step.type === 'call') source(step);
  return result;
}
/** Compose data only. The host supplies verified authorized source views and owns I/O. */
export function composeSuiteGateway(options: SuiteGatewayOptions): SuiteGatewaySnapshot {
  const maxBytes = options.maxBytes ?? suiteDefaults.maxGatewaySnapshotBytes;
  if (!options.serverId || !options.registryRevision || !/^[A-Za-z0-9_-]{43}$/.test(options.authorizationViewId) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(options.nowMs) || !Number.isSafeInteger(options.authorizationExpiresAtMs)) suiteFail('INVALID_GATEWAY');
  if (options.authorizationExpiresAtMs <= options.nowMs) suiteFail('INVALID_DELEGATION');
  const sources = options.sources.map(input => loadSuiteDocument('gateway-source', input)).sort((a, b) => a.registration.productId < b.registration.productId ? -1 : 1);
  if (new Set(sources.map(source => source.registration.productId)).size !== sources.length) suiteFail('INVALID_GATEWAY');
  let totalBytes = 0;
  const definitions: any[] = [], routes: SuiteGatewayRoute[] = [], diagnostics: any[] = [], components: any[] = [], products: any[] = [];
  const aliases = new Set<string>();
  const authViews: unknown[] = [];
  let ttlMs = Math.min(30000, options.authorizationExpiresAtMs - options.nowMs);
  for (const source of sources) {
    totalBytes += Buffer.byteLength(canonicalize(source)); if (totalBytes > maxBytes) suiteFail('PAYLOAD_LIMIT');
    const product = source.registration; const productId = product.productId;
    const path = product.declaration.capabilities.suiteMcp?.path; if (!path) suiteFail('INVALID_GATEWAY');
    const endpoint = resolveSuiteEndpoint(product.connection.baseUrl, path);
    const originals = new Map<string, { definition: any; hash: string; alias: string }>(); const catalogEntries: any[] = [];
    const diagnose = (toolName: string, code: string) => diagnostics.push({ productId, toolName, code });
    for (const definition of source.definitions) {
      const name = definition.tool.name;
      if (originals.has(name)) suiteFail('INVALID_GATEWAY');
      const bundle = { tool: definition.tool, ...(definition.cli !== undefined && { cli: definition.cli }) };
      const hash = fingerprint(bundle); if (definition.fingerprint !== undefined && definition.fingerprint !== hash) suiteFail('STALE_DEFINITION');
      const alias = suiteToolAlias(productId, name);
      originals.set(name, { definition, hash, alias });
      catalogEntries.push({ name, fingerprint: hash, ...(definition.availability !== undefined && { availability: definition.availability }) });
    }
    catalogEntries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const sourceCatalog = fingerprint({ serverId: source.serverId, viewId: source.viewId, tools: catalogEntries, ...(source.presentation !== undefined && { presentation: source.presentation }) });
    if (source.catalog !== undefined && source.catalog !== sourceCatalog) suiteFail('STALE_CATALOG');
    const names = new Map<string, string>();
    for (const [name, value] of originals) {
      const meta = value.definition.tool._meta;
      if (meta && Object.hasOwn(meta, 'nox/gateway')) { diagnose(name, 'RESERVED_METADATA'); continue; }
      if (!meta || !Object.hasOwn(meta, 'nox/authorization')) { diagnose(name, 'UNCLASSIFIED_TOOL'); continue; }
      try { loadSuiteDocument('policy', meta['nox/authorization']); } catch { diagnose(name, 'INVALID_POLICY'); continue; }
      if (aliases.has(value.alias)) suiteFail('INVALID_GATEWAY'); aliases.add(value.alias); names.set(name, value.alias);
    }
    for (const [name, alias] of names) {
      const original = originals.get(name)!; const definition = original.definition;
      const tool = structuredClone(definition.tool); tool.name = alias;
      tool._meta = { ...tool._meta, 'nox/gateway': { version: '1.0', productId, toolName: name, serverId: source.serverId, registrationRevision: product.revision, sourceFingerprint: original.hash } };
      let cli: any;
      if (definition.cli !== undefined) { try { cli = rewriteCli(definition.cli, names); } catch { diagnose(name, 'INVALID_CLI'); } }
      const bundle = { tool, ...(cli !== undefined && { cli }) }; const hash = fingerprint(bundle);
      definitions.push({ ...bundle, fingerprint: hash, ...(definition.availability !== undefined && { availability: definition.availability }) });
      routes.push({ alias, productId, registrationRevision: product.revision, associationId: product.associationId, serverId: source.serverId, viewId: source.viewId, toolName: name, endpoint, sourceFingerprint: original.hash, fingerprint: hash, availability: definition.availability ?? 'available' });
    }
    components.push({ productId, registrationRevision: product.revision, serverId: source.serverId, viewId: source.viewId, catalog: sourceCatalog });
    products.push({ productId, displayName: product.declaration.displayName, ...(source.presentation !== undefined && { presentation: source.presentation }) });
    authViews.push([productId, product.associationId, product.revision, source.serverId, source.viewId]);
    if (source.ttlMs !== undefined) ttlMs = Math.min(ttlMs, source.ttlMs);
  }
  definitions.sort((a, b) => a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0);
  routes.sort((a, b) => a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0);
  diagnostics.sort((a, b) => canonicalize([a.productId, a.toolName, a.code]) < canonicalize([b.productId, b.toolName, b.code]) ? -1 : 1);
  const viewId = 'view-' + fingerprint({ authorizationViewId: options.authorizationViewId, policyRevision: options.policyRevision ?? '1.0', products: authViews });
  const presentation = { gateway: { version: '1.0', registryRevision: options.registryRevision, products: components }, products };
  const tools = definitions.map(definition => ({ name: definition.tool.name, fingerprint: definition.fingerprint, ...(definition.availability !== undefined && { availability: definition.availability }) }));
  const catalog = { resultType: 'complete', serverId: options.serverId, viewId, tools, presentation, cacheScope: 'private', ttlMs, catalog: fingerprint({ serverId: options.serverId, viewId, tools, presentation }) };
  const result = { contractVersion: '1.0', serverId: options.serverId, viewId, registryRevision: options.registryRevision, catalog, definitions, routes, diagnostics };
  return loadSuiteDocument('gateway-snapshot', result, maxBytes);
}
/** Routing data is not authority. Admission must also enforce a valid delegation. */
export function selectSuiteRoute(snapshot: SuiteGatewaySnapshot, alias: string, expectedFingerprint?: string): SuiteGatewayRoute {
  const route = snapshot.routes.find(route => route.alias === alias); if (!route) suiteFail('FORBIDDEN');
  if (expectedFingerprint !== undefined && route.fingerprint !== expectedFingerprint) suiteFail('STALE_DEFINITION');
  if (route.availability !== 'available') suiteFail('UNAVAILABLE');
  return structuredClone(route);
}
