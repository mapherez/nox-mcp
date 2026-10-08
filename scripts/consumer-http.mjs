import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { createHttpHandler } from '@nox/mcp';
import { toNodeHandler } from '@nox/mcp/node';

for (const responseMode of [undefined, 'sse']) {
  const handler = createHttpHandler({
    appId: 'consumer', name: 'consumer', version: '1', ...(responseMode && { responseMode }),
    tools: [{ name: 'echo', description: 'Harmless package check', _meta: { package: true },
      inputSchema: z.object({ value: z.string() }), outputSchema: z.object({ value: z.string() }), execute: async input => input }],
  });
  const node = toNodeHandler(handler);
  const server = createServer((req, res) => { void node(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  try {
    for (const modern of [false, true]) {
      for (const [method, params] of [
        [modern ? 'server/discover' : 'initialize', modern ? {} : { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'consumer', version: '1' } }],
        ['tools/list', {}], ['tools/call', { name: 'echo', arguments: { value: 'installed tarball' } }],
      ]) {
        const body = { jsonrpc: '2.0', id: 1, method, params: modern ? { ...params, _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'consumer', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        } } : params };
        const response = await fetch(url, { method: 'POST', headers: {
          'content-type': 'application/json', accept: responseMode ? 'application/json, text/event-stream' : 'application/json',
          ...(modern && { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' && { 'mcp-name': 'echo' }) }),
        }, body: JSON.stringify(body) });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), responseMode ? /^text\/event-stream/ : /^application\/json/);
        const text = await response.text();
        const reply = responseMode ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(message => message.id === 1) : JSON.parse(text);
        if (method === 'tools/list') assert.deepEqual(reply.result.tools[0]._meta, { package: true });
        if (method === 'tools/call') assert.deepEqual(reply.result.structuredContent, { value: 'installed tarball' });
      }
    }
  } finally {
    await handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
console.log('Installed tarball: legacy/modern initialization/discovery, metadata and calls passed in JSON and SSE.');
