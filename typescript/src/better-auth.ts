import { requireMcpAuth } from '@better-auth/mcp';

export interface Auth { options: object; $context: Promise<{ baseURL: string; internalAdapter: unknown }> }
// Keep the Node-facing declaration independent of Better Auth's database/Bun/
// Cloudflare declaration graph. These are structural projections, not a second
// implementation of authentication; parity with the upstream types is checked.
type Claims = { iss?: string; sub?: string; aud?: string | string[]; jti?: string; nbf?: number; exp?: number; iat?: number; [claim: string]: unknown };
type GuardOptions = {
  resource?: string; issuer?: string; jwksUrl?: string;
  challengeScopes?: readonly string[]; requiredScopes?: readonly string[];
  isScopeSatisfied?: (requiredScope: string, grantedScopes: ReadonlySet<string>) => boolean;
  dpop?: { proofMaxAgeSeconds?: number; signingAlgorithms?: readonly string[]; replayStore?: { reserve: (reservation: { key: string; expiresAt: Date; now: Date }) => Promise<boolean> | boolean } };
};
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true> = T;
type _ClaimsParity = Assert<Equal<Claims,Parameters<Parameters<typeof requireMcpAuth>[1]>[1]>>;
type _OptionsParity = Assert<Equal<GuardOptions,NonNullable<Parameters<typeof requireMcpAuth>[2]>>>;
/** Verify cryptographic validity AND live authorization. Never cache an active grant here. */
export function protectWithBetterAuth(auth: Auth, handler: (request: Request, claims: Claims) => Promise<Response>, options: GuardOptions & { isActive(request: Request, claims: Claims): Promise<boolean> }) {
  return requireMcpAuth(auth as Parameters<typeof requireMcpAuth>[0], async (request, claims) => {
    if (!(await options.isActive(request, claims))) {
      const resource = options.resource ?? (await auth.$context).baseURL;
      return Response.json({ error: 'invalid_token' }, { status: 401, headers: { 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${new URL('/.well-known/oauth-protected-resource' + new URL(resource).pathname, resource).toString()}"`, 'cache-control': 'no-store' } });
    }
    return handler(request, claims);
  }, options);
}
