// Direct real Codex app-server validation; no SDK client, proxy or model turn.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { createHttpHandler } from '../typescript/dist/index.js';
import { toNodeHandler } from '../typescript/dist/node.js';

const executable = process.argv[2] ?? 'codex';
const temporary = await mkdtemp(join(tmpdir(), 'nox-codex-http-'));
const observed = [];
let executions = 0;
const handler = createHttpHandler({ appId: 'test', name: 'nox-json-test', version: '1', tools: [{
  name: 'echo', description: 'Harmless transport validation', _meta: { cli: 'echo' }, annotations: { readOnlyHint: true },
  inputSchema: z.object({ value: z.string() }), outputSchema: z.object({ value: z.string() }),
  execute: async input => { executions++; return input; },
}] });
const adapter = toNodeHandler({ fetch: async (request, options) => {
  const body = request.method === 'POST' ? await request.clone().json().catch(() => null) : null;
  const response = await handler.fetch(request, options);
  observed.push({ method: body?.method ?? request.method, accept: request.headers.get('accept'), status: response.status, contentType: response.headers.get('content-type') });
  return response;
} });
const server = createServer((req, res) => { void adapter(req, res); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/mcp`;
await writeFile(join(temporary, 'config.toml'), `[mcp_servers.nox_json_test]\nurl = "${url}"\nenabled = true\n`);
const child = spawn(executable, ['app-server', '--stdio'], { env: { ...process.env, CODEX_HOME: temporary }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map(); let sequence = 0;
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics += chunk; });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id); clearTimeout(entry.timer);
  message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
try {
  const initialized = await rpc('initialize', { clientInfo: { name: 'nox-transport-test', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  const started = await rpc('thread/start', { cwd: process.cwd(), ephemeral: true, approvalPolicy: 'never' });
  const threadId = started.thread.id;
  const discovered = await rpc('mcpServerStatus/list', { threadId, serverName: 'nox_json_test', detail: 'toolsAndAuthOnly' });
  const inventory = JSON.stringify(discovered);
  assert.ok(inventory.includes('echo'), inventory);
  const called = await rpc('mcpServer/tool/call', { threadId, server: 'nox_json_test', tool: 'echo', arguments: { value: 'codex-direct-json' } });
  assert.deepEqual(called.structuredContent, { value: 'codex-direct-json' });
  assert.equal(executions, 1);
  assert.ok(observed.some(request => request.method === 'initialize'));
  assert.ok(observed.some(request => request.method === 'tools/list'));
  assert.ok(observed.some(request => request.method === 'tools/call'));
  assert.ok(observed.filter(request => ['initialize', 'tools/list', 'tools/call'].includes(request.method)).every(request => request.status === 200 && request.contentType?.startsWith('application/json')));
  console.log(JSON.stringify({ codexVersion: execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), initialized, url, discovered, called, executions, observed }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, observed, diagnostics: diagnostics.slice(-4000) }, null, 2));
  process.exitCode = 1;
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  lines.close(); child.kill();
  await handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
