import { createHmac, createPublicKey, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';
import { canonicalize } from './discovery.js';
import { loadSuiteDocument, normalizeSuiteResource, parseSuiteJson, parseSuiteTimestamp, suiteDefaults, suiteFail } from './suite.js';
import type { SuiteAuthorizationContext, SuitePairingBinding, SuiteProbeContext } from './suite-types.generated.js';

export interface SuiteVerificationOptions {
  issuer: string;
  audience: string;
  productId: string;
  associationId: string;
  gatewayServiceId: string;
  registrationRevision?: string;
  serviceCredentialRevision?: string;
  /** Trusted local key set. Refresh it out of band, never from JWT key URLs. */
  keys: ReadonlyMap<string, JsonWebKey>;
  nowMs?: number;
  kind?: 'user' | 'probe';
}
interface VerifiedState {
  token: string;
  kind: 'user' | 'probe';
  claims: Record<string, any>;
  context: SuiteAuthorizationContext | SuiteProbeContext;
  admittedAt: number;
  expiresAt: number;
}
const verified = new WeakMap<object, VerifiedState>();
/** Only the cryptographic verifier can create a value recognized by the SDK. */
export interface VerifiedSuiteIdentity {
  readonly kind: 'user' | 'probe';
  readonly expiresAtMs: number;
  context(): SuiteAuthorizationContext | SuiteProbeContext;
  claims(): Readonly<Record<string, unknown>>;
  /** Secret: use only to forward to the bound resource; never log or persist. */
  accessToken(): string;
}
function state(identity: VerifiedSuiteIdentity): VerifiedState {
  const value = verified.get(identity); if (!value) suiteFail('INVALID_DELEGATION'); return value;
}
export function suiteIdentityState(identity: VerifiedSuiteIdentity): { kind: 'user' | 'probe'; context: SuiteAuthorizationContext | SuiteProbeContext; expiresAtMs: number; admittedAtMs: number } {
  const value = state(identity); return { kind: value.kind, context: structuredClone(value.context), expiresAtMs: value.expiresAt, admittedAtMs: value.admittedAt };
}
function base64(input: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(input) || input.length > Math.ceil(maxBytes * 4 / 3)) suiteFail('INVALID_DELEGATION');
  const bytes = Buffer.from(input, 'base64url');
  if (bytes.length > maxBytes || bytes.toString('base64url') !== input) suiteFail('INVALID_DELEGATION');
  return bytes;
}
export function verifySuiteToken(token: string, options: SuiteVerificationOptions): VerifiedSuiteIdentity {
  try {
    const now = options.nowMs ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || typeof token !== 'string' || Buffer.byteLength(token) > suiteDefaults.maxTokenBytes || !options.issuer || !options.productId || !options.associationId || !options.gatewayServiceId || normalizeSuiteResource(options.audience) !== options.audience) suiteFail('INVALID_DELEGATION');
    const parts = token.split('.'); if (parts.length !== 3) suiteFail('INVALID_DELEGATION');
    const header: any = parseSuiteJson(base64(parts[0], suiteDefaults.maxTokenBytes));
    if (!header || Array.isArray(header) || header.alg !== 'ES256' || !['nox-delegation+jwt', 'nox-service+jwt'].includes(header.typ) || typeof header.kid !== 'string' || !header.kid || [...header.kid].length > 256) suiteFail('INVALID_DELEGATION');
    if (['crit', 'b64', 'jku', 'x5u', 'jwk', 'x5c'].some(key => Object.hasOwn(header, key))) suiteFail('INVALID_DELEGATION');
    const kind = header.typ === 'nox-delegation+jwt' ? 'user' : 'probe';
    if (options.kind && kind !== options.kind) suiteFail('INVALID_DELEGATION');
    const key = options.keys.get(header.kid);
    if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string' || Object.hasOwn(key, 'd') || key.alg !== undefined && key.alg !== 'ES256' || key.use !== undefined && key.use !== 'sig' || key.kid !== undefined && key.kid !== header.kid) suiteFail('INVALID_DELEGATION');
    if (base64(key.x, 32).length !== 32 || base64(key.y, 32).length !== 32) suiteFail('INVALID_DELEGATION');
    const signature = base64(parts[2], 64); if (signature.length !== 64) suiteFail('INVALID_DELEGATION');
    const publicKey = createPublicKey({ key, format: 'jwk' });
    if (!verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)) suiteFail('INVALID_DELEGATION');
    const claims: any = loadSuiteDocument(kind === 'user' ? 'delegation-claims' : 'probe-claims', base64(parts[1], suiteDefaults.maxTokenBytes));
    const bound = claims.nox;
    if (claims.iss !== options.issuer || claims.aud !== options.audience || bound.productId !== options.productId || bound.associationId !== options.associationId || (kind === 'user' ? claims.act.sub : claims.sub) !== options.gatewayServiceId) suiteFail('INVALID_DELEGATION');
    if (options.registrationRevision !== undefined && bound.registrationRevision !== options.registrationRevision || options.serviceCredentialRevision !== undefined && bound.serviceCredentialRevision !== options.serviceCredentialRevision) suiteFail('INVALID_DELEGATION');
    const expiry = claims.exp * 1000 - suiteDefaults.clockSafetyMs;
    if (!Number.isSafeInteger(expiry) || now >= expiry || claims.iat * 1000 > now + suiteDefaults.clockSafetyMs || claims.nbf * 1000 > now + suiteDefaults.clockSafetyMs) suiteFail('INVALID_DELEGATION');
    const common = { contractVersion: '1.0', productId: bound.productId, registrationRevision: bound.registrationRevision, associationId: bound.associationId, serviceCredentialRevision: bound.serviceCredentialRevision };
    const context = kind === 'user'
      ? loadSuiteDocument('authorization-context', { ...common, userId: claims.sub, keyId: bound.keyId, authRevision: bound.authRevision, gatewayServiceId: claims.act.sub, scopes: claims.scope.split(' ') })
      : loadSuiteDocument('probe-context', { ...common, serviceId: claims.sub, purpose: 'mcp-probe' });
    const identity = Object.freeze({
      kind, expiresAtMs: expiry,
      context: () => structuredClone(context),
      claims: () => structuredClone(claims),
      accessToken: () => token,
      toJSON: () => ({ kind, expiresAtMs: expiry }),
    });
    verified.set(identity, { token, kind, claims, context, admittedAt: now, expiresAt: expiry });
    return identity;
  } catch { return suiteFail('INVALID_DELEGATION'); }
}

export function verifySuiteAuthorizationResponse(input: unknown, options: SuiteVerificationOptions): VerifiedSuiteIdentity {
  try {
    const schema = options.kind === 'probe' ? 'probe-response' : 'authorization-response';
    const response = loadSuiteDocument(schema, input);
    const identity = verifySuiteToken(response.accessToken, { ...options, kind: options.kind ?? 'user' });
    const actual: any = identity.context(); const supplied: any = response.context;
    for (const key of Object.keys(actual)) {
      if (key === 'scopes') {
        if (canonicalize([...actual.scopes].sort()) !== canonicalize([...supplied.scopes].sort())) suiteFail('INVALID_DELEGATION');
      } else if (actual[key] !== supplied[key]) suiteFail('INVALID_DELEGATION');
    }
    if (parseSuiteTimestamp(response.expiresAt) !== (state(identity).claims.exp as number) * 1000) suiteFail('INVALID_DELEGATION');
    return identity;
  } catch { return suiteFail('INVALID_DELEGATION'); }
}

/** Enforce probe restrictions per message, including mixed legacy batches. */
export function requireSuiteMethod(identity: VerifiedSuiteIdentity, method: string, nowMs = Date.now()): void {
  const checked = state(identity);
  if (!Number.isSafeInteger(nowMs) || nowMs < checked.admittedAt - suiteDefaults.clockSafetyMs || nowMs >= checked.expiresAt) suiteFail('INVALID_DELEGATION');
  if (checked.kind === 'probe' && !['initialize', 'notifications/initialized', 'ping', 'server/discover'].includes(method)) suiteFail('FORBIDDEN');
}

function secretBytes(secret: string | Uint8Array): Buffer {
  const bytes = typeof secret === 'string' ? base64(secret, 96) : Buffer.from(secret);
  if (bytes.length < 32 || bytes.length > 96) suiteFail('PAIRING_CONFLICT');
  return bytes;
}
export function createSuitePairingProof(secret: string | Uint8Array, binding: SuitePairingBinding): string {
  const checked = loadSuiteDocument('pairing-binding', binding);
  return createHmac('sha256', secretBytes(secret)).update(canonicalize(checked)).digest('base64url');
}
export function verifySuitePairingProof(secret: string | Uint8Array, binding: SuitePairingBinding, proof: string): boolean {
  try { const expected = base64(createSuitePairingProof(secret, binding), 32); const actual = base64(proof, 32); return actual.length === 32 && timingSafeEqual(expected, actual); }
  catch { return false; }
}
export function suiteCredentialPartition(apiKey: string, processSecret: Uint8Array): string {
  if (!apiKey || /\p{Surrogate}/u.test(apiKey) || Buffer.byteLength(apiKey) > 4096 || processSecret.length < 32) suiteFail('INVALID_INTEGRATION');
  return createHmac('sha256', processSecret).update('nox:credential-partition:1.0\0').update(apiKey).digest('base64url');
}
