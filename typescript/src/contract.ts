import { z } from 'zod';
import defaultsJson from './defaults.json' with { type: 'json' };
import type { ContractDefaults } from './defaults.generated.js';
import { bridgeResponseSchema, bridgeRequestSchema, bridgeErrorSchema } from './contracts.generated.js';
export { bridgeErrorSchema, bridgeTicketSchema, bridgeAuthenticateSchema, bridgeReadySchema, bridgeRequestSchema, bridgeCancelSchema, bridgeResponseSchema, serverBridgeMessageSchema, desktopBridgeMessageSchema, toolManifestSchema } from './contracts.generated.js';

export const defaults: ContractDefaults = defaultsJson;
export const BRIDGE_PROTOCOL_VERSION = defaults.bridgeProtocolVersion;
export const LEGACY_BRIDGE_PROTOCOL_VERSION = defaults.legacyBridgeProtocolVersion;
export const BRIDGE_REQUEST_TIMEOUT_MS = defaults.requestTimeoutMs;
export const BRIDGE_HEARTBEAT_INTERVAL_MS = defaults.heartbeatIntervalMs;
export const BRIDGE_OFFLINE_AFTER_MS = defaults.offlineAfterMs;
export const BRIDGE_TICKET_TTL_SECONDS = defaults.ticketTtlSeconds;
export const MAX_BRIDGE_FRAME_BYTES = defaults.maxPayloadBytes;
export const MAX_IN_FLIGHT_REQUESTS = defaults.maxInFlightRequests;
export const bridgeDeliveryPolicy = { queue: 'none', replay: 'never', disconnect: 'fail-in-flight', ticketUse: 'single-use' } as const;
export type McpErrorBody = z.infer<typeof bridgeErrorSchema>;
export class McpError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly details?: Record<string, unknown>) { super(message); this.name = 'McpError'; }
  toJSON(): McpErrorBody { return { code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) }; }
}
export function createResponseSchema<E extends z.ZodType>(errorSchema: E) {
  return z.discriminatedUnion('ok', [
    bridgeResponseSchema.options[0],
    bridgeResponseSchema.options[1].extend({ error: errorSchema }),
  ]);
}
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
  _meta?: Record<string, unknown>;
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}
export interface ToolManifest { schemaVersion: 1; protocolVersion: string; tools: ToolManifestEntry[] }
export { compileToolSchema, validateToolValue, loadToolManifest } from './manifest.js';
