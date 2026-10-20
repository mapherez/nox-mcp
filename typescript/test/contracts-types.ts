import { z } from 'zod';
import { bridgeReadySchema, bridgeRequestSchema, createResponseSchema, type ToolManifest } from '../src/contract.js';

// Existing callers pass dynamically selected protocol strings; do not narrow this input type.
const version: string = '2.0';
const ready: z.input<typeof bridgeReadySchema> = { type: 'ready', appVersion: '1', protocolVersion: version };
bridgeReadySchema.parse(ready);
const deadlineSchema: z.ZodISODateTime = bridgeRequestSchema.shape.deadlineAt;
deadlineSchema.parse('2026-10-20T10:00:00Z');

const response = createResponseSchema(z.object({ code: z.literal('CONFLICT'), currentVersion: z.number() }));
const conflict: z.output<typeof response> = { type: 'response', requestId: '123e4567-e89b-42d3-a456-426614174000', ok: false, error: { code: 'CONFLICT', currentVersion: 2 } };
response.parse(conflict);

// Keep the pre-existing interface implementable without an index signature.
class ExistingManifest implements ToolManifest {
  schemaVersion = 1 as const;
  protocolVersion = '2.0';
  tools = [];
}
new ExistingManifest();
