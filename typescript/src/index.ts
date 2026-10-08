import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { defaults, McpError, type McpErrorBody } from './contract.js';
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
  if (!options.appId || !options.name || new Set(options.tools.map(t => t.name)).size !== options.tools.length) throw new Error('Invalid server identity or duplicate tools.');
  const server = new McpServer({ name: options.name, version: options.version });
  const timeoutMs = options.timeoutMs ?? defaults.requestTimeoutMs;
  const maxBytes = options.maxPayloadBytes ?? defaults.maxPayloadBytes;
  const maxInFlight = options.maxInFlightRequests ?? defaults.maxInFlightRequests;
  if (![timeoutMs, maxBytes, maxInFlight].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid server limits.');
  let inFlight = 0;
  for (const tool of options.tools) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations, _meta: tool._meta }, async (input: unknown, extra) => {
      const controller = new AbortController();
      const cancel = () => controller.abort(new McpError('CANCELLED', 'The request was cancelled', tool.annotations?.readOnlyHint === true, tool.annotations?.readOnlyHint ? undefined : { outcome: 'unknown' }));
      extra.mcpReq.signal.addEventListener('abort', cancel, { once: true });
      if (extra.mcpReq.signal.aborted) cancel();
      const timer = setTimeout(() => controller.abort(new McpError('TIMEOUT', 'The request timed out', tool.annotations?.readOnlyHint === true, tool.annotations?.readOnlyHint ? undefined : { outcome: 'unknown' })), timeoutMs);
      let acquired = false;
      let onAbort: () => void = () => {};
      try {
        const scopes = new Set(options.auth?.scopes ?? []);
        if (tool.requiredScopes?.some(scope => !scopes.has(scope))) throw new McpError('FORBIDDEN', 'The requested operation is not allowed');
        controller.signal.throwIfAborted();
        if (inFlight >= maxInFlight) throw new McpError('OVERLOADED', 'Too many requests', true);
        if (Buffer.byteLength(JSON.stringify(input)) > maxBytes) throw new McpError('INVALID_INPUT', 'Input exceeds the payload limit');
        const validatedInput = tool.inputSchema.parse(input);
        inFlight++; acquired = true;
        const work = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return tool.execute(validatedInput, { requestId: randomUUID(), appId: options.appId, userId: options.auth?.userId, scopes, deadlineAt: new Date(Date.now() + timeoutMs).toISOString(), signal: controller.signal }); }).finally(() => { inFlight--; });
        const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort(); });
        const result = tool.outputSchema.parse(await Promise.race([work, aborted])) as Record<string, unknown>;
        controller.signal.throwIfAborted();
        const response = { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
        if (Buffer.byteLength(JSON.stringify(response)) > maxBytes) throw new McpError('INTERNAL', 'Result exceeds the payload limit');
        return response;
      } catch (error) {
        const normalized = controller.signal.aborted ? controller.signal.reason : error instanceof z.ZodError && !acquired ? new McpError('INVALID_INPUT', 'Invalid input') : error;
        try {
          const body = options.formatError?.(normalized) ?? (normalized instanceof McpError ? normalized.toJSON() : new McpError('INTERNAL', 'An internal error occurred').toJSON());
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
export { createHttpHandler, type HttpHandlerOptions } from './http.js';
