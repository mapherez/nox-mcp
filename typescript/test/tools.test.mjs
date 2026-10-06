import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createServer } from '../dist/index.js';

async function connect(t, tools) {
  const server = createServer({ appId: 'test', name: 'test', version: '1.0.0', tools });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(() => server.close());
  await server.connect(serverTransport);
  await clientTransport.start();
  let id = 0;
  async function request(method, params = {}) {
    const requestId = ++id;
    const response = new Promise((resolve, reject) => {
      clientTransport.onmessage = message => {
        if (message.id === requestId) {
          if ('error' in message) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
        }
      };
      clientTransport.onerror = reject;
    });
    await clientTransport.send({ jsonrpc: '2.0', id: requestId, method, params });
    return response;
  }
  await request('initialize', {
    protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return request;
}

function tool(name) {
  return {
    name, description: 'Test tool',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    execute: async input => ({ value: input.value }),
  };
}

test('tools/list preserves custom metadata unchanged', { timeout: 5000 }, async t => {
  const metadata = { cli: 'resource create', custom: { flags: ['one', 'two'], enabled: true, count: 2, value: null } };
  const request = await connect(t, [{ ...tool('create_something'), _meta: metadata }]);
  const { tools } = await request('tools/list');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'create_something');
  assert.equal(tools[0]._meta?.cli, 'resource create');
  assert.deepEqual(tools[0]._meta, metadata);
});

test('tools without metadata are listed and execute normally', { timeout: 5000 }, async t => {
  const request = await connect(t, [tool('echo')]);
  const { tools } = await request('tools/list');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'echo');
  assert.equal(tools[0]._meta, undefined);
  const result = await request('tools/call', { name: 'echo', arguments: { value: 'hello' } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, { value: 'hello' });
  assert.deepEqual(result.content, [{ type: 'text', text: '{"value":"hello"}' }]);
});
