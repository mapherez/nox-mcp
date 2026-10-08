// Real LM Studio's REST API drives its own MCP client directly at the library.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createHttpHandler } from '../typescript/dist/index.js';
import { toNodeHandler } from '../typescript/dist/node.js';

const base = process.argv[2] ?? 'http://127.0.0.1:1234';
const model = process.argv[3] ?? 'gemma-4-e4b-it';
// Localhost is prohibited for dynamic remote MCPs in LM Studio. An optional
// config path uses its supported preconfigured local-server route instead.
const configPath = process.argv[4];
let originalConfig; let temporaryConfig;
const label = 'nox-json-validation';
// Only pass this after approving the temporary server permission change.
const permissionsPath = process.argv[5];
const lmsPath = process.argv[6];
let ownedDaemonPid = process.argv[7] ? Number(process.argv[7]) : undefined;
const cli = async (...args) => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(lmsPath, args, { env, windowsHide: true, timeout: 60000 });
  console.log(result.stdout.trim());
};
const stopTestDaemon = async () => {
  try { await cli('daemon', 'down'); }
  catch (error) {
    if (error.stderr?.includes('Daemon is not running')) { ownedDaemonPid = undefined; return; }
    if (!ownedDaemonPid || !error.stderr?.includes('running as part of LM Studio')) throw error;
    process.kill(ownedDaemonPid);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(ownedDaemonPid, 0); }
      catch (error) { if (error.code === 'ESRCH') break; throw error; }
      assert.ok(attempt < 99, 'Test desktop process did not exit');
      await delay(100);
    }
  }
  ownedDaemonPid = undefined;
};
let originalPermissions; let token;
const observed = []; let executions = 0;
const handler = createHttpHandler({ appId: 'test', name: 'nox-json-test', version: '1', tools: [{
  name: 'echo', description: 'Echo the supplied value exactly. Harmless local transport validation.', annotations: { readOnlyHint: true }, _meta: { cli: 'echo' },
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
try {
  if (permissionsPath) {
    originalPermissions = await readFile(permissionsPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    const store = originalPermissions === null ? { json: { tokenMode: 'disabled', tokens: [], serverPermissions: { dynamicRemoteMcpServer: 'allowAll', pluginUse: 'deny' } } } : JSON.parse(originalPermissions);
    const clientIdentifier = randomBytes(4).toString('hex');
    const passkey = randomBytes(10).toString('hex');
    token = `sk-lm-${clientIdentifier}:${passkey}`;
    store.json.tokenMode = 'required';
    store.json.serverPermissions.pluginUse = 'allowAll';
    store.json.tokens.push({ clientIdentifier, clientPasskeySHA512Base64: createHash('sha512').update(passkey).digest('base64'), label: 'Temporary NoX transport validation', createdAt: Date.now(), lastUsedAt: null, permissions: { dynamicRemoteMcpServer: 'deny', pluginUse: 'allowAll' } });
    await writeFile(permissionsPath, JSON.stringify(store));
    await delay(1500);
  }
  if (configPath) {
    originalConfig = await readFile(configPath, 'utf8');
    const config = JSON.parse(originalConfig);
    assert.ok(!config.mcpServers?.[label], 'Test server name already exists');
    config.mcpServers = { ...config.mcpServers, [label]: { url } };
    temporaryConfig = JSON.stringify(config, null, 2) + '\n';
    await writeFile(configPath, temporaryConfig);
    await delay(1500);
  }
  // The desktop daemon caches server permissions. Optional CLI control reloads
  // the approved temporary settings and stops the test daemon after restoration.
  if (lmsPath) {
    await stopTestDaemon(); await cli('daemon', 'up');
    ownedDaemonPid = JSON.parse(await readFile(join(dirname(permissionsPath), 'http-server.json'), 'utf8')).pid;
    await cli('server', 'start');
  }
  console.log(`LM Studio ${base}, model ${model}, direct endpoint ${url}`);
  const response = await fetch(`${base}/api/v1/chat`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify({
    model, input: 'Call the echo tool exactly once with value "lmstudio-direct-json". Then reply DONE. You must call the tool; do not merely describe it.',
    integrations: configPath ? [{ type: 'plugin', id: `mcp/${label}`, allowed_tools: ['echo'] }]
      : [{ type: 'ephemeral_mcp', server_label: label, server_url: url, allowed_tools: ['echo'] }],
    temperature: 0, max_output_tokens: 128, context_length: 4096, reasoning: 'off', store: false,
  }), signal: AbortSignal.timeout(180000) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.ok(result.output.some(item => item.type === 'tool_call' && item.arguments?.value === 'lmstudio-direct-json'), JSON.stringify(result));
  assert.equal(executions, 1);
  assert.ok(['initialize', 'tools/list', 'tools/call'].every(method => observed.some(request => request.method === method && request.status === 200 && request.contentType?.startsWith('application/json'))));
  console.log(JSON.stringify({ url, model, result, executions, observed }, null, 2));
} catch (error) { console.error(JSON.stringify({ error: error.message, executions, observed }, null, 2)); process.exitCode = 1; }
finally {
  // Stop before restoring: the desktop can persist its cached permissions while
  // exiting and otherwise recreate the temporary store after its removal.
  let cleanupError;
  try { if (lmsPath) await stopTestDaemon(); } catch (error) { cleanupError = error; }
  if (permissionsPath && originalPermissions !== undefined) {
    if (originalPermissions === null) await unlink(permissionsPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    else await writeFile(permissionsPath, originalPermissions);
  }
  if (temporaryConfig) {
    const current = await readFile(configPath, 'utf8');
    if (current === temporaryConfig) await writeFile(configPath, originalConfig);
    else {
      const config = JSON.parse(current);
      if (config.mcpServers?.[label]?.url === url) { delete config.mcpServers[label]; await writeFile(configPath, JSON.stringify(config, null, 2) + '\n'); }
    }
  }
  await handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (cleanupError) throw cleanupError;
  console.log('Temporary client configuration restored.');
}
