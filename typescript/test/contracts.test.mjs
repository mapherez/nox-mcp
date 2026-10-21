import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { z } from 'zod';
import { Ajv } from 'ajv';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import * as contract from '../dist/contract.js';
import { validateDiscovery } from '../dist/discovery.js';
const corpus = JSON.parse(await readFile(new URL('../../contracts/conformance.json', import.meta.url), 'utf8'));
const schemas = { manifest: contract.toolManifestSchema, error: contract.bridgeErrorSchema, request: contract.bridgeRequestSchema, response: contract.bridgeResponseSchema, desktop: contract.desktopBridgeMessageSchema, server: contract.serverBridgeMessageSchema };
const canonical = Object.fromEntries(await Promise.all(Object.keys(schemas).map(async (name) => [name, new Ajv({ strict: false, validateFormats: false }).compile(JSON.parse(await readFile(new URL(`../../contracts/${name}.schema.json`, import.meta.url), 'utf8')))])));
test('shared corpus exercises every official contract', async () => {
    assert.equal(corpus.version, 1);
    const additional=JSON.parse(await readFile(new URL('../../contracts/discovery-conformance.json',import.meta.url),'utf8'));
    for(const example of additional.schemaCases){let valid=true;try{validateDiscovery(example.schema,example.data)}catch{valid=false};assert.equal(valid,example.valid);}
    const official = (await readdir(new URL('../../contracts/', import.meta.url))).filter(name => name.endsWith('.schema.json')).map(name => name.replace('.schema.json', '')).sort();
    assert.deepEqual([...new Set([...corpus.cases,...additional.schemaCases].map(c => c.schema))].sort(), official);
    assert.equal(new Set(corpus.cases.map(c => c.id)).size, corpus.cases.length);
});
for (const example of corpus.cases)
    test(`contract: ${example.id}`, () => {
        assert.equal(canonical[example.schema](example.data), example.valid, 'canonical JSON Schema validation');
        const parsed = schemas[example.schema].safeParse(example.data);
        assert.equal(parsed.success, example.valid, parsed.error?.message);
        if (parsed.success) {
            assert.deepEqual(parsed.data, example.data, 'validation must not transform the document');
            const supplied = (actual, expected) => {
                if (expected && typeof expected === 'object')
                    for (const key of Object.keys(expected)) {
                        assert.ok(Object.hasOwn(actual, key), `lost property ${key}`);
                        supplied(actual[key], expected[key]);
                    }
                else
                    assert.deepEqual(actual, expected);
            };
            supplied(parsed.data, example.data);
            if (example.schema !== 'manifest')
                assert.deepEqual(contract.parseFrame(schemas[example.schema], JSON.stringify(example.data)), parsed.data);
        }
        if (example.schema === 'manifest') {
            if (example.executable)
                assert.deepEqual(contract.loadToolManifest(example.data), example.data);
            else
                assert.throws(() => contract.loadToolManifest(example.data));
        }
    });
for (const example of corpus.schemaCases)
    test(`tool schema: ${example.id}`, () => {
        const schemaBefore = structuredClone(example.schema);
        if (example.schemaValid)
            assert.equal(typeof contract.compileToolSchema(example.schema), 'function');
        else
            assert.throws(() => contract.compileToolSchema(example.schema));
        const before = structuredClone(example.data);
        assert.equal(contract.validateToolValue(example.schema, example.data), example.valid);
        assert.deepEqual(example.data, before);
        assert.deepEqual(example.schema, schemaBefore, 'schema compilation must not mutate its source');
    });
test('custom response schemas and legacy error extensions remain supported', () => {
    const custom = contract.createResponseSchema(z.object({ code: z.literal('CONFLICT'), currentVersion: z.number() }));
    const response = { type: 'response', requestId: '123e4567-e89b-42d3-a456-426614174000', ok: false, error: { code: 'CONFLICT', currentVersion: 7 } };
    assert.deepEqual(custom.parse(response), response);
    assert.equal(contract.bridgeErrorSchema.parse({ code: 'CUSTOM', message: 'Error' }).retryable, undefined);
});
test('existing public contract usage patterns still typecheck', () => {
    const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const options = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, fileURLToPath(new URL('../', import.meta.url))).options;
    const program = ts.createProgram([fileURLToPath(new URL('./contracts-types.ts', import.meta.url))], { ...options, rootDir: undefined, noEmit: true });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
});

test('manifest preparation bounds both JSON and object inputs', () => {
    const manifest = { schemaVersion: 1, protocolVersion: '2.0', tools: [], custom: 'x'.repeat(contract.defaults.maxPayloadBytes) };
    assert.throws(() => contract.loadToolManifest(manifest), /payload limit/);
    assert.throws(() => contract.loadToolManifest(JSON.stringify(manifest)), /payload limit/);
});
