import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { z } from 'zod';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import * as contract from '../dist/contract.js';

const corpus = JSON.parse(await readFile(new URL('../../contracts/conformance.json', import.meta.url), 'utf8'));
const schemas = { manifest: contract.toolManifestSchema, error: contract.bridgeErrorSchema, request: contract.bridgeRequestSchema, response: contract.bridgeResponseSchema, desktop: contract.desktopBridgeMessageSchema, server: contract.serverBridgeMessageSchema };
const canonical = Object.fromEntries(await Promise.all(Object.keys(schemas).map(async name => [name, z.fromJSONSchema(JSON.parse(await readFile(new URL(`../../contracts/${name}.schema.json`, import.meta.url), 'utf8')))])));

test('shared corpus exercises every official contract', async () => {
  assert.equal(corpus.version, 1);
  const official = (await readdir(new URL('../../contracts/', import.meta.url))).filter(name => name.endsWith('.schema.json')).map(name => name.replace('.schema.json', '')).sort();
  assert.deepEqual([...new Set(corpus.cases.map(c => c.schema))].sort(), official);
  assert.equal(new Set(corpus.cases.map(c => c.id)).size, corpus.cases.length);
});

for (const example of corpus.cases) test(`contract: ${example.id}`, () => {
  assert.equal(canonical[example.schema].safeParse(example.data).success, example.valid, 'canonical JSON Schema validation');
  if (example.typescriptValid !== undefined) assert.ok(example.compatibilityReason, 'legacy exceptions require a reason');
  if (example.loadTools !== undefined && example.loadTools !== example.valid) assert.ok(example.loaderReason, 'loader exceptions require a reason');
  const parsed = schemas[example.schema].safeParse(example.data);
  assert.equal(parsed.success, example.typescriptValid ?? example.valid, parsed.error?.message);
  if (parsed.success) {
    // Parsing may materialize retryable=false, but must not discard any supplied value.
    const supplied = (actual, expected) => {
      if (expected && typeof expected === 'object') for (const key of Object.keys(expected)) {
        assert.ok(Object.hasOwn(actual, key), `lost property ${key}`);
        supplied(actual[key], expected[key]);
      } else assert.deepEqual(actual, expected);
    };
    supplied(parsed.data, example.data);
    if (example.schema !== 'manifest') assert.deepEqual(contract.parseFrame(schemas[example.schema], JSON.stringify(example.data)), parsed.data);
  }
});

// These exercise equivalent tool-schema assertions using the existing Zod dev dependency.
// fromJSONSchema is used only in tests, never by the shipped runtime or generator.
for (const example of corpus.schemaCases) test(`tool schema: ${example.id}`, () => {
  assert.equal(z.fromJSONSchema(example.schema, { defaultTarget: 'draft-7' }).safeParse(example.data).success, example.valid);
});

test('custom response schemas and legacy error extensions remain supported', () => {
  const custom = contract.createResponseSchema(z.object({ code: z.literal('CONFLICT'), currentVersion: z.number() }));
  const response = { type: 'response', requestId: '123e4567-e89b-42d3-a456-426614174000', ok: false, error: { code: 'CONFLICT', currentVersion: 7 } };
  assert.deepEqual(custom.parse(response), response);
  assert.equal(contract.bridgeErrorSchema.parse({ code: 'CUSTOM', message: 'Error' }).retryable, false);
});

test('public contract types remain source compatible', () => {
  const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const options = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, fileURLToPath(new URL('../', import.meta.url))).options;
  const program = ts.createProgram([fileURLToPath(new URL('./contracts-types.ts', import.meta.url))], { ...options, rootDir: undefined, noEmit: true });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
});
