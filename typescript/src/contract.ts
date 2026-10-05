import { z } from 'zod';
import defaults from './defaults.json' with { type: 'json' };

export { defaults };
export const BRIDGE_PROTOCOL_VERSION = defaults.bridgeProtocolVersion;
export const LEGACY_BRIDGE_PROTOCOL_VERSION = defaults.legacyBridgeProtocolVersion;
export const BRIDGE_REQUEST_TIMEOUT_MS = defaults.requestTimeoutMs;
export const BRIDGE_HEARTBEAT_INTERVAL_MS = defaults.heartbeatIntervalMs;
export const BRIDGE_OFFLINE_AFTER_MS = defaults.offlineAfterMs;
export const BRIDGE_TICKET_TTL_SECONDS = defaults.ticketTtlSeconds;
export const MAX_BRIDGE_FRAME_BYTES = defaults.maxPayloadBytes;
export const MAX_IN_FLIGHT_REQUESTS = defaults.maxInFlightRequests;
export const bridgeDeliveryPolicy = { queue: 'none', replay: 'never', disconnect: 'fail-in-flight', ticketUse: 'single-use' } as const;
export const bridgeErrorSchema = z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(500), retryable: z.boolean().default(false), details: z.record(z.string(), z.unknown()).optional() });
export type McpErrorBody = z.infer<typeof bridgeErrorSchema>;
export class McpError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly details?: Record<string, unknown>) { super(message); this.name = 'McpError'; }
  toJSON(): McpErrorBody { return { code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) }; }
}
export const bridgeTicketSchema = z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/);
export const bridgeAuthenticateSchema = z.object({ type: z.literal('authenticate'), ticket: bridgeTicketSchema });
export const bridgeReadySchema = z.object({ type: z.literal('ready'), protocolVersion: z.enum([BRIDGE_PROTOCOL_VERSION, LEGACY_BRIDGE_PROTOCOL_VERSION]), appVersion: z.string().min(1).max(64) });
export const bridgeRequestSchema = z.object({ type: z.literal('request'), requestId: z.string().uuid(), command: z.string().min(1).max(64), input: z.unknown(), deadlineAt: z.iso.datetime({ offset: true }) });
export const bridgeCancelSchema = z.object({ type: z.literal('cancel'), requestId: z.string().uuid() });
export function createResponseSchema<E extends z.ZodType>(errorSchema: E) {
  return z.discriminatedUnion('ok', [
    z.object({ type: z.literal('response'), requestId: z.string().uuid(), ok: z.literal(true), result: z.unknown() }),
    z.object({ type: z.literal('response'), requestId: z.string().uuid(), ok: z.literal(false), error: errorSchema }),
  ]);
}
export const bridgeResponseSchema = createResponseSchema(bridgeErrorSchema);
export const serverBridgeMessageSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('authenticated') }), bridgeRequestSchema, bridgeCancelSchema, z.object({ type: z.literal('session_revoked'), reason: z.string().max(200) })]);
export const desktopBridgeMessageSchema = z.discriminatedUnion('type', [bridgeAuthenticateSchema, bridgeReadySchema, bridgeResponseSchema]);
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;
export type BridgeFrame = string | Uint8Array | ArrayBuffer;
export function parseFrame<T>(schema: z.ZodType<T>, frame: BridgeFrame, maxBytes = MAX_BRIDGE_FRAME_BYTES): T {
  const bytes = typeof frame === 'string' ? new TextEncoder().encode(frame) : frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength > maxBytes) throw new RangeError('Bridge frame exceeds the payload limit.');
  return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
export interface ToolManifestEntry {
  name: string; title: string; description: string; scope?: string; requiredScopes?: readonly string[];
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}
export interface ToolManifest { schemaVersion: 1; protocolVersion: string; tools: ToolManifestEntry[] }
export const toolManifestSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.string().min(1).max(32),
  tools: z.array(z.object({ name: z.string().min(1).max(64), title: z.string(), description: z.string(), scope: z.string().optional(), requiredScopes: z.array(z.string()).optional(), inputSchema: z.record(z.string(), z.unknown()), outputSchema: z.record(z.string(), z.unknown()), annotations: z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional(), idempotentHint: z.boolean().optional(), openWorldHint: z.boolean().optional() }) })),
});
