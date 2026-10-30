import { type AuthInfo, type McpHttpHandler, readRequestBody } from '@modelcontextprotocol/server';
import { createHttpHandler, type HttpHandlerOptions } from './http.js';
import { McpError, defaults } from './contract.js';
import { fingerprint } from './discovery.js';
import { loadSuiteDocument, parseSuiteJson, requireSuiteScopes, suiteFail, SuiteError } from './suite.js';
import { requireSuiteMethod, verifySuiteToken, type SuiteVerificationOptions, type VerifiedSuiteIdentity } from './suite-auth.js';
import { suiteRequestBudget } from './suite-state.js';
import type { SuitePolicy } from './suite-types.generated.js';
import type { ExecutionContext, ServerOptions } from './index.js';

export interface SuiteHttpHandlerOptions extends Omit<HttpHandlerOptions, 'resolveAuth' | 'resolveTools' | 'resolveDiscovery'> {
  /** Local pinned trust/registry snapshot. No token-controlled key retrieval. */
  verification(): Omit<SuiteVerificationOptions, 'nowMs'>;
  policies: Readonly<Record<string, SuitePolicy>>;
  /** Pure local mapping; Suite capability grants always come from the signed token. */
  localScopes?(identity: VerifiedSuiteIdentity): readonly string[];
  /** Local invalidation state, updated by the host's Backend event consumer. */
  isActive?(identity: VerifiedSuiteIdentity): boolean;
  additionalScopes?(name: string, input: unknown, context: ExecutionContext): readonly string[] | Promise<readonly string[]>;
  clock?(): number;
}
/** A separate Suite endpoint. The application's direct endpoint keeps its own authentication. */
export function createSuiteHttpHandler(options: SuiteHttpHandlerOptions): McpHttpHandler {
  const clock = options.clock ?? Date.now;
  const policies = new Map(Object.entries(options.policies).map(([name, policy]) => [name, loadSuiteDocument('policy', policy)]));
  for (const policy of policies.values()) if (policy.argumentDependent && !options.additionalScopes) throw new TypeError('Argument-dependent policy requires additionalScopes.');
  const admitted = new WeakMap<AuthInfo, { identity: VerifiedSuiteIdentity; auth: NonNullable<ServerOptions['auth']> }>();
  const session = (info?: AuthInfo) => { const value = info && admitted.get(info); if (!value) suiteFail('INVALID_DELEGATION'); return value; };
  const classified = options.tools.filter(tool => policies.has(tool.name)).map(tool => {
    const policy = policies.get(tool.name)!;
    return { ...tool, _meta: { ...tool._meta, 'nox/authorization': policy }, requiredScopes: [...new Set([...(tool.requiredScopes ?? []), ...policy.requiredScopes])],
      async execute(input: unknown, context: ExecutionContext) {
        try { requireSuiteScopes(context.scopes, policy, await options.additionalScopes?.(tool.name, input, context) ?? []); }
        catch { throw new McpError('FORBIDDEN', 'The requested operation is not allowed'); }
        context.signal.throwIfAborted();
        return tool.execute(input, context);
      },
    };
  });
  const handler = createHttpHandler({ ...options, tools: classified,
    resolveAuth: info => session(info).auth,
    resolveTools: info => { const { identity, auth } = session(info); return identity.kind === 'probe' ? [] : classified.filter(tool => tool.requiredScopes.every(scope => auth.scopes.includes(scope))); },
    ...(options.discovery && { resolveDiscovery: (info?: AuthInfo) => {
      const identity = session(info).identity;
      return { ...options.discovery!, async resolveView(context, tools) {
        const view = await options.discovery!.resolveView(context, tools);
        return { ...view, viewId: fingerprint([view.viewId, identity.claims().iss, identity.context()]) };
      } };
    } }),
  });
  return { ...handler, async fetch(request, requestOptions) {
    let identity: VerifiedSuiteIdentity;
    try {
      const bearer = request.headers.get('authorization');
      const match = bearer && /^Bearer[ \t]+([A-Za-z0-9_.-]+)$/i.exec(bearer.trim());
      if (!match) suiteFail('INVALID_DELEGATION');
      identity = verifySuiteToken(match[1], { ...options.verification(), nowMs: clock() });
      if (options.isActive && !options.isActive(identity)) suiteFail('INVALID_DELEGATION');
    } catch { return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'www-authenticate': 'Bearer', 'cache-control': 'no-store' } }); }
    try {
      const body = await readRequestBody(request.clone(), 4 * 1024 * 1024);
      if (body.tooLarge) return Response.json({ error: 'payload_limit' }, { status: 413 });
      const parsed = parseSuiteJson(body.text, 4 * 1024 * 1024);
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      for (const message of messages) {
        if (!message || typeof message !== 'object' || !('method' in message) || typeof message.method !== 'string') suiteFail('INVALID_INTEGRATION');
        requireSuiteMethod(identity, message.method, clock());
      }
      const signed = identity.context();
      const local = options.localScopes?.(identity) ?? [];
      if (local.some(scope => typeof scope !== 'string' || !scope || scope.startsWith('nox:'))) suiteFail('INVALID_INTEGRATION');
      const scopes = identity.kind === 'user' ? [...new Set([...(signed as { scopes: string[] }).scopes, ...local])] : [];
      let controls: { requestId?: string; deadlineAt?: string } = {};
      if (messages.some(message => (message as {method:string}).method === 'tools/call')) {
        const rawTimeout = request.headers.get('nox-timeout-ms') ?? '';
        if (!/^[1-9][0-9]*$/.test(rawTimeout)) suiteFail('INVALID_REQUEST_CONTROLS');
        controls = suiteRequestBudget({ requestId: request.headers.get('nox-request-id') ?? '', deadlineAt: request.headers.get('nox-deadline-at') ?? '', timeoutMs: Number(rawTimeout) }, Date.now(), options.timeoutMs ?? defaults.requestTimeoutMs);
      }
      const info: AuthInfo = { token: identity.accessToken(), clientId: String(identity.claims().iss), scopes };
      if (options.isActive && !options.isActive(identity)) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'cache-control': 'no-store' } });
      admitted.set(info, { identity, auth: { scopes, ...(identity.kind === 'user' && { userId: String(signed.userId) }), ...controls } });
      return await handler.fetch(request, { ...requestOptions, authInfo: info, parsedBody: parsed });
    } catch (error) {
      const code = error instanceof SuiteError ? error.code : 'INVALID_INTEGRATION';
      return Response.json({ error: code }, { status: code === 'FORBIDDEN' ? 403 : code === 'TIMEOUT' ? 408 : 400, headers: { 'cache-control': 'no-store' } });
    }
  } };
}
