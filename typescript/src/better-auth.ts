import { requireMcpAuth } from '@better-auth/mcp';

export interface Auth { options: object; $context: Promise<{ baseURL: string; internalAdapter: unknown }> }
type Claims = Parameters<Parameters<typeof requireMcpAuth>[1]>[1];
/** Verify cryptographic validity AND live authorization. Never cache an active grant here. */
export function protectWithBetterAuth(auth: Auth, handler: (request: Request, claims: Claims) => Promise<Response>, options: NonNullable<Parameters<typeof requireMcpAuth>[2]> & { isActive(request: Request, claims: Claims): Promise<boolean> }) {
  return requireMcpAuth(auth as Parameters<typeof requireMcpAuth>[0], async (request, claims) => {
    if (!(await options.isActive(request, claims))) {
      const resource = options.resource ?? (await auth.$context).baseURL;
      return Response.json({ error: 'invalid_token' }, { status: 401, headers: { 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${new URL('/.well-known/oauth-protected-resource' + new URL(resource).pathname, resource).toString()}"`, 'cache-control': 'no-store' } });
    }
    return handler(request, claims);
  }, options);
}
