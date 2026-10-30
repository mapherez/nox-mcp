/** Portable Suite documents and pure helpers. No networking, issuance or persistence. */
import { isIP } from 'node:net';
import { Ajv } from 'ajv';
import { canonicalize, fingerprint } from './discovery.js';
import { suiteSchemas, suiteDefaults } from './suite-contracts.generated.js';
import type { SuiteDocumentMap, SuitePolicy } from './suite-types.generated.js';
export * from './suite-types.generated.js';
export { suiteSchemas, suiteDefaults } from './suite-contracts.generated.js';

export type SuiteSchemaName = keyof SuiteDocumentMap;
export type SuiteCapability = 'nox:inspect' | 'nox:write' | 'nox:sensitive-read';
export const SUITE_CAPABILITIES: readonly SuiteCapability[] = Object.freeze(['nox:inspect', 'nox:write', 'nox:sensitive-read']);
export class SuiteError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SuiteError'; }
}
export function suiteFail(code: string): never { throw new SuiteError(code); }
export function suiteProductId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/u.test(value);
}

/** Reject duplicates before JSON.parse can erase their meaning. Bound recursion first. */
export function parseSuiteJson(input: string | Uint8Array, maxBytes: number = suiteDefaults.maxPayloadBytes): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) suiteFail('INVALID_INTEGRATION');
  let source: string;
  try { source = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input); }
  catch { return suiteFail('INVALID_INTEGRATION'); }
  if (Buffer.byteLength(source) > maxBytes) suiteFail('INVALID_INTEGRATION');
  let offset = 0;
  const space = () => { while (/[ \t\n\r]/.test(source[offset] ?? '\0')) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === '\\') offset++;
      else if (char === '"') return JSON.parse(source.slice(start, offset));
    }
    return suiteFail('INVALID_INTEGRATION');
  };
  const value = (depth: number): void => {
    if (depth > suiteDefaults.maxDocumentDepth) suiteFail('INVALID_INTEGRATION');
    space();
    if (source[offset] === '{') {
      offset++; space(); const keys = new Set<string>();
      if (source[offset] === '}') { offset++; return; }
      for (;;) {
        space(); if (source[offset] !== '"') suiteFail('INVALID_INTEGRATION');
        const key = string(); if (keys.has(key)) suiteFail('INVALID_INTEGRATION'); keys.add(key);
        space(); if (source[offset++] !== ':') suiteFail('INVALID_INTEGRATION'); value(depth + 1);
        space(); const delimiter = source[offset++]; if (delimiter === '}') return;
        if (delimiter !== ',') suiteFail('INVALID_INTEGRATION');
      }
    }
    if (source[offset] === '[') {
      offset++; space(); if (source[offset] === ']') { offset++; return; }
      for (;;) { value(depth + 1); space(); const delimiter = source[offset++]; if (delimiter === ']') return; if (delimiter !== ',') suiteFail('INVALID_INTEGRATION'); }
    }
    if (source[offset] === '"') { string(); return; }
    const start = offset;
    while (offset < source.length && !/[,\]} \t\n\r]/.test(source[offset])) offset++;
    if (offset === start) suiteFail('INVALID_INTEGRATION');
  };
  try {
    value(0); space(); if (offset !== source.length) suiteFail('INVALID_INTEGRATION');
    const parsed: unknown = JSON.parse(source); checkJson(parsed, 0); return parsed;
  } catch { return suiteFail('INVALID_INTEGRATION'); }
}

function checkJson(value: unknown, depth: number, seen = new Set<object>()): void {
  if (depth > suiteDefaults.maxDocumentDepth) suiteFail('INVALID_INTEGRATION');
  if (typeof value === 'string') { if (/\p{Surrogate}/u.test(value)) suiteFail('INVALID_INTEGRATION'); return; }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) suiteFail('INVALID_INTEGRATION'); return; }
  if (typeof value !== 'object' || seen.has(value)) suiteFail('INVALID_INTEGRATION');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) suiteFail('INVALID_INTEGRATION');
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string' || (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/.test(key))) suiteFail('INVALID_INTEGRATION');
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!property.enumerable || property.get || property.set) suiteFail('INVALID_INTEGRATION');
    checkJson(key, depth + 1, seen); checkJson(property.value, depth + 1, seen);
  }
  if (Array.isArray(value)) for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) suiteFail('INVALID_INTEGRATION');
  seen.delete(value);
}

export function normalizeSuiteOrigin(input: string): string {
  if (typeof input !== 'string' || input.length > 2048 || !/^[\x21-\x7e]+$/.test(input)) suiteFail('INVALID_ORIGIN');
  const match = /^https:\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]+))?\/?$/i.exec(input);
  if (!match) suiteFail('INVALID_ORIGIN');
  let host = match[1].toLowerCase();
  const rawPort = match[2];
  if (rawPort !== undefined && (!/^[1-9][0-9]*$/.test(rawPort) || Number(rawPort) > 65535)) suiteFail('INVALID_ORIGIN');
  if (host.startsWith('[')) {
    if (isIP(host.slice(1, -1)) !== 6) suiteFail('INVALID_ORIGIN');
    host = new URL(`https://${host}`).hostname;
  } else if (/^[0-9.]+$/.test(host)) {
    if (isIP(host) !== 4) suiteFail('INVALID_ORIGIN');
  } else {
    const labels = host.split('.');
    if (host.length > 253 || /^[0-9]+$/.test(labels.at(-1)!) || /^0x[0-9a-f]+$/i.test(host) || labels.some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) suiteFail('INVALID_ORIGIN');
  }
  return `https://${host}${rawPort && rawPort !== '443' ? ':' + rawPort : ''}`;
}
export function normalizeSuitePath(input: string): string {
  if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//') || input.length > 2048) suiteFail('INVALID_SUITE_PATH');
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '%') {
      if (!/^[0-9a-f]{2}$/i.test(input.slice(i + 1, i + 3)) || Number.parseInt(input.slice(i + 1, i + 3), 16) < 128) suiteFail('INVALID_SUITE_PATH');
      i += 2;
    } else if (!/^[A-Za-z0-9_~.!$&'()*+,;=:@/\-]$/.test(input[i])) suiteFail('INVALID_SUITE_PATH');
  }
  let decoded: string;
  try { decoded = decodeURIComponent(input); } catch { return suiteFail('INVALID_SUITE_PATH'); }
  if (decoded.split('/').some(segment => segment === '.' || segment === '..') || /[\p{Cc}\s]/u.test(decoded)) suiteFail('INVALID_SUITE_PATH');
  return input.replace(/%[0-9a-f]{2}/gi, escape => escape.toUpperCase());
}
export function resolveSuiteEndpoint(origin: string, path: string): string { return normalizeSuiteOrigin(origin) + normalizeSuitePath(path); }
export function normalizeSuiteResource(resource: string): string {
  const slash = resource.indexOf('/', 'https://'.length);
  if (slash < 0) suiteFail('INVALID_ORIGIN');
  return resolveSuiteEndpoint(resource.slice(0, slash), resource.slice(slash));
}
export function parseSuiteTimestamp(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) suiteFail('INVALID_INTEGRATION');
  const parsed = Date.parse(value);
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => '.' + (fraction ?? '').padEnd(3, '0') + 'Z');
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) suiteFail('INVALID_INTEGRATION');
  return parsed;
}
export function compareSuiteSequences(left: string, right: string): -1 | 0 | 1 {
  const valid = (s: string) => typeof s === 'string' && /^(?:0|[1-9][0-9]*)$(?![\s\S])/.test(s) && s.length <= 20 && (s.length < 20 || s <= '18446744073709551615');
  if (!valid(left) || !valid(right)) suiteFail('INVALID_SEQUENCE');
  return left === right ? 0 : left.length < right.length || left.length === right.length && left < right ? -1 : 1;
}

const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const validators = Object.fromEntries(Object.entries(suiteSchemas).map(([name, schema]) => [name, ajv.compile(schema)]));
function walk(schema: any, value: any, preflight: boolean): void {
  if (value === null || value === undefined) return;
  if (schema.type === 'array' && Array.isArray(value)) for (const item of value) walk(schema.items, item, preflight);
  if (schema.type === 'object' && typeof value === 'object' && !Array.isArray(value)) {
    if (preflight) {
      for (const name of ['contractVersion', 'version']) if (schema.properties?.[name]?.const === '1.0' && typeof value[name] === 'string' && value[name] !== '1.0') suiteFail('UNSUPPORTED_INTEGRATION');
      if (schema.properties?.requires && Array.isArray(value.requires) && value.requires.length) suiteFail('UNSUPPORTED_INTEGRATION');
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) walk(child, value[key], preflight);
    for (const branch of schema.oneOf ?? []) {
      const literals = Object.entries(branch.properties ?? {}).filter(([, s]) => Object.hasOwn(s as object, 'const')) as [string, { const: unknown }][];
      if (literals.length && literals.every(([key, s]) => value[key] === s.const)) walk(branch, value, preflight);
    }
  }
  if (preflight) return;
  if (schema.properties?.declaration && schema.properties?.productId && value.productId !== value.declaration?.productId) suiteFail('INVALID_INTEGRATION');
  switch (schema['x-nox-kind']) {
    case 'product-id': if (!suiteProductId(value)) suiteFail('INVALID_INTEGRATION'); break;
    case 'origin': normalizeSuiteOrigin(value); break;
    case 'path': normalizeSuitePath(value); break;
    case 'timestamp': parseSuiteTimestamp(value); break;
    case 'sequence': compareSuiteSequences(value, value); break;
  }
}
export function loadSuiteDocument<N extends SuiteSchemaName>(schema: N, input: unknown, maxBytes: number = suiteDefaults.maxPayloadBytes): SuiteDocumentMap[N] {
  if (!Object.hasOwn(validators, schema) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) suiteFail('INVALID_INTEGRATION');
  try {
    const value: any = typeof input === 'string' || input instanceof Uint8Array ? parseSuiteJson(input, maxBytes) : input;
    checkJson(value, 0);
    if (Buffer.byteLength(canonicalize(value)) > maxBytes) suiteFail('INVALID_INTEGRATION');
    walk(suiteSchemas[schema], value, true);
    if (!validators[schema](value)) suiteFail('INVALID_INTEGRATION');
    walk(suiteSchemas[schema], value, false);
    switch (schema) {
      case 'registration-record': if (value.productId !== value.declaration.productId) suiteFail('INVALID_INTEGRATION'); break;
      case 'delegation-claims': case 'probe-claims':
        if (value.exp <= value.iat || value.exp - value.iat > 300 || value.nbf < value.iat || value.nbf >= value.exp || normalizeSuiteResource(value.aud) !== value.aud) suiteFail('INVALID_INTEGRATION');
        if (schema === 'delegation-claims') {
          const caps = value.scope.split(' ');
          if (!caps.includes('nox:inspect') || new Set(caps).size !== caps.length || caps.some((scope: string) => !SUITE_CAPABILITIES.includes(scope as SuiteCapability))) suiteFail('INVALID_INTEGRATION');
        }
        break;
      case 'provisioning':
        if (!value.signingKeysUri.startsWith(normalizeSuiteOrigin(value.backendOrigin) + '/') || normalizeSuiteResource(value.signingKeysUri) !== value.signingKeysUri) suiteFail('INVALID_INTEGRATION');
        break;
      case 'registry-snapshot': case 'gateway-presentation':
        if (new Set(value.products.map((p: any) => p.productId)).size !== value.products.length) suiteFail('INVALID_INTEGRATION');
        if (schema === 'registry-snapshot') for (const product of value.products) if (product.productId !== product.declaration.productId) suiteFail('INVALID_INTEGRATION');
        break;
    }
    return structuredClone(value) as unknown as SuiteDocumentMap[N];
  } catch (error) {
    if (error instanceof SuiteError && error.code === 'UNSUPPORTED_INTEGRATION') throw error;
    return suiteFail('INVALID_INTEGRATION');
  }
}

export function suiteToolAlias(productId: string, canonicalName: string): string {
  if (!suiteProductId(productId) || typeof canonicalName !== 'string' || !canonicalName || [...canonicalName].length > 64 || /\p{Surrogate}/u.test(canonicalName)) suiteFail('INVALID_GATEWAY');
  const readable = productId + '__' + canonicalName;
  return readable.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(readable) ? readable : '_' + fingerprint([productId, canonicalName]);
}
export function suitePolicy(requiredScopes: readonly SuiteCapability[], argumentDependent = false): SuitePolicy {
  return loadSuiteDocument('policy', { version: '1.0', requiredScopes: [...new Set(requiredScopes)], argumentDependent });
}
/** Additional requirements are additive; dynamic input never grants scopes. */
export function requireSuiteScopes(grants: Iterable<string>, policy: SuitePolicy, additional: readonly string[] = []): readonly string[] {
  const checked = loadSuiteDocument('policy', policy);
  if (additional.some(scope => typeof scope !== 'string' || !scope)) suiteFail('FORBIDDEN');
  const required = [...new Set([...checked.requiredScopes, ...additional])];
  const set = new Set(grants); if (required.some(scope => !set.has(scope))) suiteFail('FORBIDDEN');
  return required;
}
