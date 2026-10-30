import { performance } from 'node:perf_hooks';
import { fingerprint, canonicalize } from './discovery.js';
import { loadSuiteDocument, normalizeSuiteResource, suiteDefaults, suiteFail, suiteProductId } from './suite.js';
import { suiteIdentityState, type VerifiedSuiteIdentity } from './suite-auth.js';

export interface SuiteAuthorizationPartition {
  credentialPartition: string;
  issuer: string;
  audience: string;
  gatewayServiceId: string;
  serviceCredentialRevision: string;
  productId: string;
  associationId: string;
  registrationRevision: string;
  kind?: 'user' | 'probe';
}
export interface SuiteInvalidation {
  all?: true;
  userId?: string;
  keyId?: string;
  serviceId?: string;
  credentialRevision?: string;
  productId?: string;
  associationId?: string;
}
export function suiteAuthorizationPartitionKey(partition: SuiteAuthorizationPartition): string {
  const fields = [partition.credentialPartition, partition.issuer, partition.audience, partition.gatewayServiceId, partition.serviceCredentialRevision, partition.productId, partition.associationId, partition.registrationRevision, partition.kind ?? 'user'];
  if (fields.some(field => typeof field !== 'string' || !field) || !/^[A-Za-z0-9_-]{43}$/.test(partition.credentialPartition) || !suiteProductId(partition.productId) || !['user', 'probe'].includes(partition.kind ?? 'user') || normalizeSuiteResource(partition.audience) !== partition.audience) suiteFail('INVALID_INTEGRATION');
  return fingerprint(fields);
}
function matches(identity: VerifiedSuiteIdentity, selector: SuiteInvalidation): boolean {
  if (selector.all) return true;
  const context: any = suiteIdentityState(identity).context;
  const fields: Record<string, unknown> = { ...context, serviceId: context.gatewayServiceId ?? context.serviceId, credentialRevision: context.serviceCredentialRevision };
  return Object.entries(selector).every(([key, value]) => value === undefined || fields[key] === value);
}
export function validateSuiteAuthorizationPartition(partition: SuiteAuthorizationPartition, identity: VerifiedSuiteIdentity, nowMs: number): void {
  suiteAuthorizationPartitionKey(partition);
  const value = suiteIdentityState(identity); const context: any = value.context; const claims = identity.claims();
  if (value.kind !== (partition.kind ?? 'user') || claims.iss !== partition.issuer || claims.aud !== partition.audience || context.productId !== partition.productId || context.associationId !== partition.associationId || context.registrationRevision !== partition.registrationRevision || context.serviceCredentialRevision !== partition.serviceCredentialRevision || (context.gatewayServiceId ?? context.serviceId) !== partition.gatewayServiceId || nowMs >= value.expiresAtMs || nowMs < value.admittedAtMs - suiteDefaults.clockSafetyMs) suiteFail('INVALID_DELEGATION');
}

/** Memory only. Hosts supply renewal I/O; the SDK neither polls nor issues tokens. */
export class SuiteAuthorizationCache {
  private entries = new Map<string, { identity: VerifiedSuiteIdentity; deadline: number; bytes: number }>();
  private pending = new Map<string, { generation: number; promise: Promise<VerifiedSuiteIdentity> }>();
  private pendingCount = 0;
  private generation = 0;
  private bytes = 0;
  private lastWall = -1;
  private lastMonotonic = -1;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  constructor(options: { maxEntries?: number; maxBytes?: number; now?: () => number; monotonic?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? suiteDefaults.maxAuthorizationEntries;
    this.maxBytes = options.maxBytes ?? suiteDefaults.maxAuthorizationBytes;
    this.now = options.now ?? Date.now; this.monotonic = options.monotonic ?? (() => performance.now());
    if (![this.maxEntries, this.maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) suiteFail('INVALID_INTEGRATION');
  }
  private clock(): { wall: number; monotonic: number } {
    const wall = this.now(), monotonic = this.monotonic();
    if (!Number.isSafeInteger(wall) || wall < 0 || !Number.isFinite(monotonic) || monotonic < 0) suiteFail('INVALID_INTEGRATION');
    if (wall < this.lastWall - suiteDefaults.clockSafetyMs || monotonic < this.lastMonotonic) { this.invalidate(); this.lastWall = wall; this.lastMonotonic = monotonic; suiteFail('AUTHORIZATION_INVALIDATED'); }
    this.lastWall = Math.max(this.lastWall, wall); this.lastMonotonic = Math.max(this.lastMonotonic, monotonic);
    return { wall, monotonic };
  }
  get stats(): { entries: number; bytes: number; pending: number } { return { entries: this.entries.size, bytes: this.bytes, pending: this.pendingCount }; }
  get(partition: SuiteAuthorizationPartition): VerifiedSuiteIdentity | undefined {
    const key = suiteAuthorizationPartitionKey(partition), time = this.clock(), entry = this.entries.get(key);
    if (!entry) return undefined;
    if (time.wall >= entry.identity.expiresAtMs || time.monotonic >= entry.deadline) { this.entries.delete(key); this.bytes -= entry.bytes; return undefined; }
    validateSuiteAuthorizationPartition(partition, entry.identity, time.wall);
    this.entries.delete(key); this.entries.set(key, entry); return entry.identity;
  }
  refresh(partition: SuiteAuthorizationPartition, load: () => Promise<VerifiedSuiteIdentity>): Promise<VerifiedSuiteIdentity> {
    // Do not retain a mutable caller-owned partition across asynchronous work.
    const bound = { ...partition }; const key = suiteAuthorizationPartitionKey(bound);
    const cached = this.get(bound); if (cached) return Promise.resolve(cached);
    const existing = this.pending.get(key); if (existing?.generation === this.generation) return existing.promise;
    if (this.pendingCount >= this.maxEntries) suiteFail('CACHE_LIMIT');
    const generation = this.generation;
    this.pendingCount++;
    const promise = Promise.resolve().then(load).then(identity => {
      if (generation !== this.generation) suiteFail('AUTHORIZATION_INVALIDATED');
      const time = this.clock(); validateSuiteAuthorizationPartition(bound, identity, time.wall);
      const bytes = Buffer.byteLength(identity.accessToken()) + Buffer.byteLength(canonicalize(identity.claims())) + Buffer.byteLength(canonicalize(identity.context()));
      if (bytes > this.maxBytes) suiteFail('CACHE_LIMIT');
      while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
        const oldest = this.entries.keys().next().value!; const entry = this.entries.get(oldest)!;
        this.entries.delete(oldest); this.bytes -= entry.bytes;
      }
      this.entries.set(key, { identity, bytes, deadline: time.monotonic + Math.min(identity.expiresAtMs - time.wall, suiteDefaults.authorizationLifetimeMs) }); this.bytes += bytes;
      return identity;
    }).finally(() => { this.pendingCount--; if (this.pending.get(key)?.promise === promise) this.pending.delete(key); });
    this.pending.set(key, { generation, promise }); return promise;
  }
  invalidate(selector: SuiteInvalidation = { all: true }): void {
    const active = Object.entries(selector).filter(([, value]) => value !== undefined);
    if (!active.length || active.some(([key, value]) => !['all', 'userId', 'keyId', 'serviceId', 'credentialRevision', 'productId', 'associationId'].includes(key) || (key === 'all' ? value !== true : typeof value !== 'string' || !value))) suiteFail('INVALID_INTEGRATION');
    this.generation++;
    for (const [key, entry] of this.entries) if (matches(entry.identity, selector)) { this.entries.delete(key); this.bytes -= entry.bytes; }
    // Old requests may still settle, but cannot repopulate this generation.
  }
  applyEvent(input: unknown): void {
    const event = loadSuiteDocument('event', input) as any;
    switch (event.type) {
      case 'authorization.invalidated': this.invalidate(Object.fromEntries(Object.entries(event.data).filter(([key]) => ['all', 'userId', 'keyId', 'serviceId', 'productId', 'associationId'].includes(key)))); break;
      case 'service.invalidated': this.invalidate({ serviceId: event.data.serviceId, credentialRevision: event.data.credentialRevision }); break;
      case 'signing-keys.changed': this.invalidate(); break;
      case 'product.upserted': this.invalidate({ productId: event.data.record.productId }); break;
      case 'product.removed': this.invalidate({ productId: event.data.productId, associationId: event.data.associationId }); break;
    }
  }
}
