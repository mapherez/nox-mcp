import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY, SERVER_INFO_META_KEY } from '@modelcontextprotocol/server';
import { createHttpHandler, McpError } from '../dist/index.js';
import { toNodeHandler } from '../dist/node.js';

const both = 'application/json, text/event-stream';
const version = '2026-07-28';
const echo = {
  name: 'echo', description: 'Harmless echo', _meta: { cli: 'echo', custom: [1, null] },
  annotations: { readOnlyHint: true },
  inputSchema: z.object({ value: z.string() }), outputSchema: z.object({ value: z.string() }),
  execute: async input => input,
};
const init = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } };
const call = { name: 'echo', arguments: { value: 'hello' } };

async function endpoint(t, options = {}, adapterOptions = {}) {
  const errors = [];
  const handler = createHttpHandler({ appId: 'test', name: 'test', version: '1', tools: [echo], onerror: error => errors.push(error), ...options });
  const node = toNodeHandler(handler, adapterOptions);
  const server = httpServer((req, res) => {
    if (req.headers.authorization) req.auth = { token: req.headers.authorization, clientId: 'test', scopes: ['echo:read'], extra: { userId: 'user' } };
    void node(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  t.after(async () => { await handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function post(method, params = {}, { modern = false, accept = 'application/json', headers = {}, id = 1, ...rest } = {}) {
    const body = { jsonrpc: '2.0', ...(id !== null && { id }), method, params: modern ? {
      ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: version, [CLIENT_INFO_META_KEY]: { name: 'test', version: '1' }, [CLIENT_CAPABILITIES_META_KEY]: {}, ...params._meta },
    } : params };
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(accept !== null && { accept }), ...(modern && { 'mcp-protocol-version': version, 'mcp-method': method, ...(method === 'tools/call' && { 'mcp-name': params.name }) }), ...headers },
      body: JSON.stringify(body), ...rest,
    });
    return response;
  }
  return { handler, server, url, post, errors };
}

async function result(response, mode = 'json') {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('mcp-session-id'), null);
  assert.match(response.headers.get('content-type'), mode === 'json' ? /^application\/json/ : /^text\/event-stream/);
  if (mode === 'json') return response.json();
  const events = (await response.text()).split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  return events.find(message => message.id === 1);
}

for (const mode of ['json', 'sse']) for (const modern of [false, true]) {
  test(`${mode} ${modern ? 'modern' : 'legacy'}: real HTTP initialize, discovery, calls and notifications`, { timeout: 10000 }, async t => {
    const { post, url } = await endpoint(t, mode === 'sse' ? { responseMode: mode } : {});
    const headers = { modern, accept: mode === 'json' ? 'application/json' : both };
    if (!modern) {
      const initialized = await result(await post('initialize', init, headers), mode);
      assert.equal(initialized.result.serverInfo.name, 'test');
      const actual = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: headers.accept }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
      assert.equal(actual.status, 202); assert.equal(await actual.text(), '');
    } else {
      const discovered = await result(await post('server/discover', {}, headers), mode);
      assert.equal(discovered.result._meta[SERVER_INFO_META_KEY].name, 'test');
    }
    const listed = await result(await post('tools/list', {}, headers), mode);
    assert.deepEqual(listed.result.tools[0]._meta, echo._meta);
    assert.equal(listed.result.tools[0].inputSchema.properties.value.type, 'string');
    assert.equal(listed.result.tools[0].outputSchema.properties.value.type, 'string');
    assert.equal(listed.result.tools[0].annotations.readOnlyHint, true);
    const called = await result(await post('tools/call', call, headers), mode);
    assert.deepEqual(called.result.structuredContent, { value: 'hello' });
    assert.deepEqual(called.result.content, [{ type: 'text', text: '{"value":"hello"}' }]);
    const invalid = await result(await post('tools/call', { name: 'echo', arguments: {} }, headers), mode);
    assert.equal(invalid.result.isError, true);
    for (const method of ['GET', 'DELETE', 'PUT']) {
      assert.equal((await fetch(url, { method, headers: { accept: both } })).status, 405);
    }
  });
}

test('JSON negotiation accepts missing header, compatible wildcards and both types in both eras', async t => {
  const { post, url } = await endpoint(t);
  for (const modern of [false, true]) for (const accept of ['application/json', both, '*/*', 'application/*', 'text/event-stream, application/*;q=0.5', 'APPLICATION/JSON;Q=1', 'application/json;q=0.2, */*;q=0']) {
    for (const [method, params] of [[modern ? 'server/discover' : 'initialize', modern ? {} : init], ['tools/list', {}], ['tools/call', call]]) {
      await result(await post(method, params, { modern, accept }));
    }
    if (!modern) {
      const notification = await post('notifications/initialized', {}, { accept, id: null });
      assert.equal(notification.status, 202); assert.equal(await notification.text(), '');
    }
  }
  // node:http sends no implicit */* unlike fetch.
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', part => body += part); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: call }));
  });
  assert.equal(response.status, 200); assert.match(response.type, /^application\/json/);
  assert.deepEqual(JSON.parse(response.body).result.structuredContent, { value: 'hello' });
});

test('incompatible headers and specific q=0 exclusions are rejected before execution', async t => {
  let executed = 0;
  for (const mode of ['json', 'sse']) {
    const { post, errors } = await endpoint(t, { responseMode: mode, tools: [{ ...echo, execute: async input => { executed++; return input; } }] });
    const rejected = ['text/plain', 'application/json;q=0', '*/*;q=0', 'application/json;q=0, */*;q=1', 'application/*;q=0, */*;q=1', 'application/json;q=0, text/event-stream'];
    if (mode === 'sse') rejected.push('application/json', 'text/event-stream', 'application/json, text/event-stream;q=0, */*', '');
    for (const modern of [false, true]) for (const accept of rejected) {
      for (const [method, params] of [[modern ? 'server/discover' : 'initialize', modern ? {} : init], ['tools/list', {}], ['tools/call', call]]) {
        assert.equal((await post(method, params, { modern, accept })).status, 406, `${mode} ${modern} ${method} ${accept}`);
      }
      if (!modern) assert.equal((await post('notifications/initialized', {}, { accept, id: null })).status, 406);
    }
    assert.ok(errors.length);
  }
  assert.equal(executed, 0);
});

test('SDK protocol validation, malformed JSON, media types and HTTP body limits stay enforced', async t => {
  const { post, url, errors } = await endpoint(t);
  assert.equal((await post('tools/list', {}, { headers: { 'mcp-protocol-version': 'bogus' } })).status, 400);
  assert.equal((await post('tools/list', {}, { modern: true, headers: { 'mcp-method': 'tools/call' } })).status, 400);
  assert.equal((await post('subscriptions/listen', { notifications: {} }, { modern: true, headers: { 'mcp-method': 'tools/call' } })).status, 400);
  assert.equal((await post('tools/list', {}, { modern: true, headers: { 'mcp-protocol-version': '' } })).status, 400);
  assert.equal((await post('tools/list', {}, { modern: true, headers: { 'content-type': 'text/plain' } })).status, 415);
  for (const body of ['{', '', JSON.stringify({ jsonrpc: 'no', id: 1, method: 'tools/list' })]) {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body })).status, 400);
  }
  const unknown = await result(await post('unknown'));
  assert.equal(unknown.error.code, -32601);
  // Raise the adapter bound to exercise the library's actual byte-count limit.
  const largerAdapter = await endpoint(t, {}, { maxRequestBodySize: 8 * 1024 * 1024 });
  const huge = await fetch(largerAdapter.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: ' '.repeat(4 * 1024 * 1024 + 1) });
  assert.equal(huge.status, 413);
  // Also enforce the web handler's bound without the Node adapter.
  const { handler } = await endpoint(t);
  assert.equal((await handler.fetch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: both }, body: ' '.repeat(4 * 1024 * 1024 + 1) }))).status, 413);
  assert.ok(errors.length);
});

test('auth, scopes, custom errors, tool input/output limits and timeouts in both eras', async t => {
  const seen = [];
  const { post } = await endpoint(t, {
    timeoutMs: 25, maxPayloadBytes: 1024,
    resolveAuth: auth => { seen.push(auth); return { userId: auth?.extra?.userId, scopes: auth?.scopes ?? [] }; },
    formatError: error => ({ ...(error instanceof McpError ? error.toJSON() : { code: 'INTERNAL', message: 'custom', retryable: false }), custom: true }),
    tools: [
      { ...echo, requiredScopes: ['echo:read'], execute: async (input, context) => { assert.equal(context.userId, 'user'); return input; } },
      { ...echo, name: 'slow', execute: async (_, context) => { await delay(100, null, { signal: context.signal }); return { value: 'late' }; } },
      { ...echo, name: 'large', execute: async () => ({ value: 'x'.repeat(2000) }) },
      { ...echo, name: 'bad_output', execute: async () => ({ value: 123 }) },
    ],
  });
  for (const modern of [false, true]) {
    const denied = await result(await post('tools/call', call, { modern }));
    assert.equal(denied.result.structuredContent.code, 'FORBIDDEN');
    assert.equal(denied.result.structuredContent.custom, true);
    const allowed = await result(await post('tools/call', call, { modern, headers: { authorization: 'Bearer test' } }));
    assert.deepEqual(allowed.result.structuredContent, { value: 'hello' });
    for (const [name, value, code] of [['slow', 'hello', 'TIMEOUT'], ['large', 'hello', 'INTERNAL'], ['bad_output', 'hello', 'INTERNAL'], ['echo', 'x'.repeat(2000), 'INVALID_INPUT']]) {
      const error = await result(await post('tools/call', { name, arguments: { value } }, { modern, headers: { authorization: 'Bearer test' } }));
      assert.equal(error.result.isError, true); assert.equal(error.result.structuredContent.code, code);
    }
  }
  assert.ok(seen.some(auth => auth?.token === 'Bearer test'));
});

for (const mode of ['json', 'sse']) for (const modern of [false, true]) {
  test(`${mode} ${modern ? 'modern' : 'legacy'} disconnect and close cancel once without pending exchanges`, { timeout: 6000 }, async t => {
    let startedResolve; let abortedResolve; let executions = 0;
    const started = new Promise(resolve => startedResolve = resolve);
    const aborted = new Promise(resolve => abortedResolve = resolve);
    const { post, handler } = await endpoint(t, { responseMode: mode, tools: [{ ...echo, execute: async (_, context) => {
      executions++; startedResolve();
      await new Promise(resolve => { context.signal.addEventListener('abort', () => { abortedResolve(); resolve(); }, { once: true }); });
      return { value: 'cancelled' };
    } }] });
    const controller = new AbortController();
    const exchange = post('tools/call', call, { modern, accept: both, signal: controller.signal }).then(async response => { await response.text(); }, error => { assert.equal(error.name, 'AbortError'); });
    await started; controller.abort(); await aborted; await exchange;
    await handler.close(); await handler.close(); assert.equal(executions, 1);

    let begin; let cancel; let count = 0;
    const began = new Promise(resolve => begin = resolve);
    const cancelled = new Promise(resolve => cancel = resolve);
    const second = await endpoint(t, { responseMode: mode, tools: [{ ...echo, execute: async (_, context) => {
      count++; begin(); await new Promise(resolve => context.signal.addEventListener('abort', () => { cancel(); resolve(); }, { once: true })); return { value: 'done' };
    } }] });
    const pending = second.post('tools/call', call, { modern, accept: both }).then(async response => { await response.text(); });
    await began;
    const firstClose = second.handler.close(); assert.equal(firstClose, second.handler.close());
    await firstClose; await cancelled; await pending; assert.equal(count, 1);
    await assert.rejects(second.handler.fetch(new Request(second.url)), /closed/);
  });
}

test('modern subscriptions remain SSE with JSON normal responses and deliver bus notifications', { timeout: 5000 }, async t => {
  const { post, handler } = await endpoint(t);
  const response = await post('subscriptions/listen', { notifications: { toolsListChanged: true } }, { modern: true, accept: both });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /subscriptions\/acknowledged|subscriptionId/);
  await handler.notify.toolsChanged();
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /notifications\/tools\/list_changed/);
  await reader.cancel();
  await handler.close();
  assert.equal(handler.bus.listenerCount, 0);
  const nextEndpoint = await endpoint(t);
  await result(await nextEndpoint.post('tools/call', call, { modern: true }));
  assert.equal((await nextEndpoint.post('subscriptions/listen', {}, { modern: true, accept: 'application/json' })).status, 406);
});

test('legacy batch cancellation and in-flight limit preserve structured errors', { timeout: 5000 }, async t => {
  let executions = 0;
  const { url } = await endpoint(t, { maxInFlightRequests: 1, tools: [{ ...echo, execute: async (input, context) => {
    executions++; await delay(30, null, { signal: context.signal }); return input;
  } }] });
  const postBatch = async body => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^application\/json/); return response.json();
  };
  const requests = [1, 2].map(id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: call }));
  const limited = await postBatch(requests);
  assert.deepEqual(limited.find(message => message.id === 1).result.structuredContent, { value: 'hello' });
  assert.equal(limited.find(message => message.id === 2).result.structuredContent.code, 'OVERLOADED');
  const cancelled = await postBatch([requests[0], { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'test' } }]);
  assert.equal(cancelled.error.message, 'The request was cancelled');
  assert.equal(executions, 1);
});

test('pre-aborted JSON exchange and close during startup never execute a tool', { timeout: 5000 }, async t => {
  let executions = 0;
  const { handler, url } = await endpoint(t, { tools: [{ ...echo, execute: async input => { executions++; return input; } }] });
  const controller = new AbortController(); controller.abort();
  const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: call }), signal: controller.signal });
  assert.equal((await handler.fetch(request)).status, 499);
  const pending = handler.fetch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: call }) }));
  await handler.close();
  assert.equal((await pending).status, 499);
  assert.equal(executions, 0);
});

test('auth failures and throwing onerror remain HTTP errors, and parsed bodies work', async t => {
  const { post, handler, url } = await endpoint(t, { resolveAuth: () => { throw new Error('Auth unavailable'); }, onerror: () => { throw new Error('Observer unavailable'); } });
  for (const modern of [false, true]) assert.equal((await post('tools/call', call, { modern })).status, 500);
  const plain = await endpoint(t);
  const response = await plain.handler.fetch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' } }), { parsedBody: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: call } });
  assert.deepEqual((await response.json()).result.structuredContent, { value: 'hello' });
  await handler.close();
});

for (const mode of ['json', 'sse']) for (const era of ['legacy', 'modern']) {
  test(`SDK client ${era} consumes ${mode} metadata, results and errors`, { timeout: 10000 }, async t => {
    const { url } = await endpoint(t, { responseMode: mode });
    const types = [];
    const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === 'POST' && response.status === 200) types.push(response.headers.get('content-type'));
      return response;
    } });
    const client = new Client({ name: 'sdk-test', version: '1' }, { versionNegotiation: { mode: era === 'modern' ? { pin: version } : 'legacy' } });
    t.after(() => client.close());
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), era);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools[0]._meta, echo._meta);
    const called = await client.callTool(call);
    assert.deepEqual(called.structuredContent, { value: 'hello' });
    const invalid = await client.callTool({ name: 'echo', arguments: {} });
    assert.equal(invalid.isError, true);
    assert.ok(types.length >= 3);
    assert.ok(types.every(type => type.startsWith(mode === 'json' ? 'application/json' : 'text/event-stream')));
  });
}
