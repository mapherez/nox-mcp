import { randomUUID } from 'node:crypto';
import { McpServer, fromJsonSchema, type StandardSchemaWithJSON, type jsonSchemaValidator, type JsonSchemaValidatorResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { defaults, McpError, bridgeErrorSchema, compileToolSchema, loadToolManifest, type McpErrorBody } from './contract.js';
export * from './contract.js';

export interface ExecutionContext {
  requestId: string; appId: string; userId?: string; scopes: ReadonlySet<string>;
  deadlineAt: string; signal: AbortSignal;
}
export interface ToolDefinition {
  name: string; title?: string; description: string;
  _meta?: Record<string, unknown>;
  inputSchema: z.ZodType; outputSchema: z.ZodType;
  requiredScopes?: readonly string[];
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  execute(input: unknown, context: ExecutionContext): Promise<Record<string, unknown>>;
}
export interface ServerOptions {
  appId: string; name: string; version: string; tools: readonly ToolDefinition[];
  auth?: { userId?: string; scopes: readonly string[] };
  timeoutMs?: number;
  maxPayloadBytes?: number;
  maxInFlightRequests?: number;
  formatError?(error: unknown): McpErrorBody & Record<string, unknown>;
}
export function createServer(options: ServerOptions): McpServer {
  return createRuntimeServer(options);
}
type RuntimeSchema = StandardSchemaWithJSON & { parse(value: unknown): unknown };
type RuntimeTool = Omit<ToolDefinition, 'inputSchema' | 'outputSchema'> & { inputSchema: RuntimeSchema; outputSchema: RuntimeSchema };
function createRuntimeServer(options: Omit<ServerOptions,'tools'> & { tools: readonly RuntimeTool[] }): McpServer {
  if (!options.appId || !options.name || options.tools.some(t => !t.name || [...t.name].length > 64 || t.requiredScopes?.some(s => typeof s !== 'string' || !s)) || new Set(options.tools.map(t => t.name)).size !== options.tools.length) throw new Error('Invalid server identity, tool or scopes.');
  const server = new McpServer({ name: options.name, version: options.version });
  const timeoutMs = options.timeoutMs ?? defaults.requestTimeoutMs;
  const maxBytes = options.maxPayloadBytes ?? defaults.maxPayloadBytes;
  const maxInFlight = options.maxInFlightRequests ?? defaults.maxInFlightRequests;
  if (![timeoutMs, maxBytes, maxInFlight].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid server limits.');
  let inFlight = 0;
  // The SDK advertises the schemas but must not reject outside NoX's structured
  // error boundary. Actual input/output validation remains mandatory below.
  const boundarySchema = (schema: RuntimeSchema): StandardSchemaWithJSON => ({ '~standard': { ...schema['~standard'], validate: value => ({ value }) } });
  for (const tool of options.tools) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: boundarySchema(tool.inputSchema), outputSchema: boundarySchema(tool.outputSchema), annotations: tool.annotations, _meta: tool._meta }, async (input: unknown, extra) => {
      const controller = new AbortController();
      const deadline = Date.now() + timeoutMs;
      const timeoutError = () => new McpError('TIMEOUT','The request timed out',tool.annotations?.readOnlyHint === true,tool.annotations?.readOnlyHint ? undefined : { outcome:'unknown' });
      const checkActive = () => { if (!controller.signal.aborted && Date.now() >= deadline) controller.abort(timeoutError()); controller.signal.throwIfAborted(); };
      const cancel = () => controller.abort(new McpError('CANCELLED', 'The request was cancelled', tool.annotations?.readOnlyHint === true, tool.annotations?.readOnlyHint ? undefined : { outcome: 'unknown' }));
      extra.mcpReq.signal.addEventListener('abort', cancel, { once: true });
      if (extra.mcpReq.signal.aborted) cancel();
      const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
      let acquired = false;
      let onAbort: () => void = () => {};
      try {
        const scopes = new Set(options.auth?.scopes ?? []);
        if (tool.requiredScopes?.some(scope => !scopes.has(scope))) throw new McpError('FORBIDDEN', 'The requested operation is not allowed');
        checkActive();
        if (inFlight >= maxInFlight) throw new McpError('OVERLOADED', 'Too many requests', true);
        if (Buffer.byteLength(JSON.stringify(input)) > maxBytes) throw new McpError('INVALID_INPUT', 'Input exceeds the payload limit');
        let validatedInput: unknown;
        try { validatedInput = tool.inputSchema.parse(input); } catch { throw new McpError('INVALID_INPUT','Invalid input'); }
        inFlight++; acquired = true;
        const work = Promise.resolve().then(() => { checkActive(); return tool.execute(validatedInput, { requestId: randomUUID(), appId: options.appId, userId: options.auth?.userId, scopes, deadlineAt: new Date(deadline).toISOString(), signal: controller.signal }); }).finally(() => { inFlight--; });
        const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort(); });
        const value = await Promise.race([work, aborted]);
        let result: Record<string, unknown>;
        try { result = tool.outputSchema.parse(value) as Record<string,unknown>; } catch { throw new McpError('INTERNAL','Invalid tool result'); }
        checkActive();
        const response = { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
        if (Buffer.byteLength(JSON.stringify(response)) > maxBytes) throw new McpError('INTERNAL', 'Result exceeds the payload limit');
        checkActive();
        return response;
      } catch (error) {
        const normalized = controller.signal.aborted ? controller.signal.reason : error instanceof z.ZodError && !acquired ? new McpError('INVALID_INPUT', 'Invalid input') : error;
        try {
          const formatted = options.formatError?.(normalized) ?? (normalized instanceof McpError ? normalized.toJSON() : new McpError('INTERNAL', 'An internal error occurred').toJSON());
          const body = { ...bridgeErrorSchema.parse(formatted), retryable: formatted.retryable ?? false };
          const response = { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(body) }], structuredContent: body };
          if (Buffer.byteLength(JSON.stringify(response)) <= maxBytes) return response;
        } catch { /* Unserializable or oversized app errors must not escape the boundary. */ }
        const body = new McpError('INTERNAL', 'An internal error occurred').toJSON();
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(body) }], structuredContent: body };
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); extra.mcpReq.signal.removeEventListener('abort', cancel); }
    });
  }
  return server;
}

/** Bind an application-approved manifest to a whitelist of trusted implementations.
 * Auth grants come exclusively from options.auth, never from manifest metadata.
 */
export function createServerFromManifest(options: Omit<ServerOptions,'tools'> & {
  manifest: unknown;
  bindings: Record<string, Pick<ToolDefinition,'execute'|'requiredScopes'>>;
}): McpServer {
  const manifest = loadToolManifest(options.manifest);
  const adapter = (schema: Record<string,unknown>): RuntimeSchema => {
    const validate = compileToolSchema(schema);
    const provider: jsonSchemaValidator = { getValidator<T>() {
      return (value: unknown): JsonSchemaValidatorResult<T> => validate(value) ? { valid: true, data: value as T, errorMessage: undefined } : { valid: false, data: undefined, errorMessage: 'Invalid tool value' };
    } };
    const wrapped = fromJsonSchema(schema, provider);
    return Object.assign(wrapped, { parse(value: unknown) { if (!validate(value)) throw new Error('Invalid tool value'); return value; } });
  };
  const tools: RuntimeTool[] = manifest.tools.map(tool => {
    const binding = Object.hasOwn(options.bindings,tool.name) ? options.bindings[tool.name] : undefined;
    if (!binding) throw new Error(`Missing trusted implementation: ${tool.name}`);
    return { ...tool, execute: binding.execute, requiredScopes: [...new Set([...(binding.requiredScopes ?? []),...(tool.requiredScopes ?? [])])], inputSchema: adapter(tool.inputSchema), outputSchema: adapter(tool.outputSchema) };
  });
  return createRuntimeServer({ ...options, tools });
}
export { createHttpHandler, type HttpHandlerOptions } from './http.js';
