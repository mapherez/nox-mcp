import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { createServerFromManifest, McpError } from '../dist/index.js';
const corpus = JSON.parse(await readFile(new URL('../../contracts/conformance.json', import.meta.url), 'utf8'));

async function discover(server) {
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    await client.start();
    let id = 0;
    const request = async (method, params = {}) => {
        const requestId = ++id;
        const response = new Promise((resolve, reject) => {
            client.onmessage = message => {
                if (message.id === requestId) {
                    if (message.error) reject(new Error(JSON.stringify(message.error)));
                    else resolve(message.result);
                }
            };
            client.onerror = reject;
        });
        await client.send({ jsonrpc: '2.0', id: requestId, method, params });
        return response;
    };
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'conformance', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { tool: (await request('tools/list')).tools[0], request };
}
test('shared runtime semantics, including authorization and cancellation', { timeout: 30000 }, async () => {
    const report = [];
    for (const example of corpus.runtimeCases) {
        const manifest = structuredClone(corpus.runtimeManifest), tool = manifest.tools[0];
        tool.requiredScopes = example.requiredScopes ?? [];
        if (example.scope)
            tool.scope = example.scope;
        tool.annotations.readOnlyHint = example.readOnly ?? true;
        let handler;
        const register = McpServer.prototype.registerTool;
        // Capture the real registered NoX callback to control the transport's AbortSignal.
        // SDK cancellation intentionally suppresses replies; wire behavior has separate tests.
        McpServer.prototype.registerTool = function (name, options, callback) { handler = callback; return register.call(this, name, options, callback); };
        let server, startedResolve, executed = false;
        const started = new Promise(r => startedResolve = r);
        try {
            const timeoutMs = corpus.runtimeTestPolicy[example.behavior === 'timeout' ? 'timeoutCaseMs' : 'normalTimeoutMs'];
            server = createServerFromManifest({ appId: 'conformance', name: 'conformance', version: '1', manifest, timeoutMs, maxPayloadBytes: example.maxPayloadBytes, auth: { scopes: example.grants ?? [] }, bindings: { echo: { requiredScopes: example.appRequiredScopes ?? [], execute: async (input, context) => {
                            startedResolve();
                            executed = true;
                            assert.notEqual(example.behavior, 'pre-cancel', 'pre-cancelled request executed');
                            if (example.behavior === 'invalid-error')
                                throw new McpError('', 'Invalid error');
                            if (example.behavior === 'custom-error')
                                throw new McpError('CONFLICT', 'Domain conflict', false, { version: 2 });
                            if (example.behavior === 'panic') {
                                // The old universal 30 ms deadline would mask this error.
                                await new Promise(resolve => setTimeout(resolve, example.delayMs ?? 0));
                                throw new Error('PRIVATE SECRET');
                            }
                            if (['cancel', 'timeout'].includes(example.behavior)) {
                                await new Promise(r => context.signal.addEventListener('abort', r, { once: true }));
                                return { value: 'late' };
                            }
                            assert.deepEqual(input, example.input);
                            return example.result;
                        } } } });
        }
        finally {
            McpServer.prototype.registerTool = register;
        }
        const { tool: listed, request } = await discover(server);
        assert.deepEqual(listed._meta, tool._meta);
        assert.deepEqual(listed.inputSchema, tool.inputSchema);
        assert.deepEqual(listed.outputSchema, tool.outputSchema);
        for (const [hint, fallback] of Object.entries({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true })) {
            assert.equal(listed.annotations?.[hint] ?? fallback, tool.annotations[hint] ?? fallback, `annotation default changed: ${hint}`);
        }
        const controller = new AbortController();
        if (example.behavior === 'pre-cancel')
            controller.abort();
        const pending = ['cancel', 'pre-cancel'].includes(example.behavior)
            ? handler(example.input, { mcpReq: { signal: controller.signal } })
            : request('tools/call', { name: tool.name, arguments: example.input });
        if (example.behavior === 'cancel') {
            await started;
            controller.abort();
        }
        const response = await pending;
        const body = JSON.parse(response.content[0].text);
        if(response.isError)assert.equal(response.structuredContent,undefined);
        else assert.deepEqual(response.structuredContent,body);
        const actual = { id: example.id, isError: response.isError === true, executed };
        if (actual.isError) {
            Object.assign(actual, { code: body.code, retryable: body.retryable });
            if (body.details)
                actual.details = body.details;
            assert.ok(!JSON.stringify(body).includes('PRIVATE SECRET'));
        }
        else
            actual.body = body;
        assert.deepEqual(actual, { id: example.id, ...example.expect });
        report.push(actual);
        await server.close();
    }
    if (process.env.NOX_CONFORMANCE_REPORT)
        await writeFile(process.env.NOX_CONFORMANCE_REPORT, JSON.stringify(report));
});
