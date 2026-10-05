import WebSocket from 'ws';
import { defaults, BRIDGE_PROTOCOL_VERSION, parseFrame, serverBridgeMessageSchema, McpError } from './contract.js';
import type { ExecutionContext } from './index.js';

export interface BridgeClientOptions {
  url: string; ticket: string; appId: string; appVersion: string;
  userId?: string; scopes?: readonly string[];
  execute(command: string, input: unknown, context: ExecutionContext): Promise<unknown>;
  limits?: { maxPayloadBytes?: number; maxInFlightRequests?: number; requestTimeoutMs?: number };
}
/** One connection, no queue or replay. Reconnect only with a freshly issued ticket. */
export async function connectBridge(options: BridgeClientOptions, signal?: AbortSignal): Promise<{ close(): Promise<void> }> {
  const endpoint = new URL(options.url);
  if (endpoint.protocol !== 'wss:' && !(endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) throw new Error('Secure bridge URL required.');
  const limits = { ...defaults, ...options.limits };
  if (Object.values(options.limits ?? {}).some(n => !Number.isSafeInteger(n) || n! < 1)) throw new Error('Invalid bridge limits.');
  const active = new Map<string, AbortController>(), seen = new Map<string, number>();
  const socket = new WebSocket(options.url, { maxPayload: limits.maxPayloadBytes });
  let connected = true;
  let inFlight = 0;
  const stop = () => { connected = false; for (const controller of active.values()) controller.abort(); active.clear(); socket.close(); };
  const send = (value: unknown) => { const data = JSON.stringify(value); if (Buffer.byteLength(data) > limits.maxPayloadBytes) throw new Error('Bridge payload limit.'); socket.send(data); };
  signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
  socket.once('close', () => { stop(); signal?.removeEventListener('abort', stop); });
  socket.on('error', stop);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error('Bridge authentication timed out.')); }, 8000);
    const fail = () => { clearTimeout(timeout); reject(new Error('Bridge authentication failed.')); };
    socket.once('close', fail);
    socket.once('open', () => send({ type: 'authenticate', ticket: options.ticket }));
    socket.once('message', data => {
      try { const frame = parseFrame(serverBridgeMessageSchema, new Uint8Array(data as Buffer), limits.maxPayloadBytes); if (frame.type !== 'authenticated') throw new Error(); send({ type: 'ready', protocolVersion: BRIDGE_PROTOCOL_VERSION, appVersion: options.appVersion }); clearTimeout(timeout); socket.removeListener('close', fail); resolve(); }
      catch { stop(); fail(); }
    });
  });
  socket.on('message', data => {
    try {
      const frame = parseFrame(serverBridgeMessageSchema, new Uint8Array(data as Buffer), limits.maxPayloadBytes);
      if (frame.type === 'session_revoked') { stop(); return; }
      if (frame.type === 'cancel') { active.get(frame.requestId)?.abort(); active.delete(frame.requestId); return; }
      if (frame.type !== 'request') throw new Error('Unexpected frame.');
      for (const [id, end] of seen) if (end <= Date.now()) seen.delete(id);
      const deadline = Math.min(Date.parse(frame.deadlineAt), Date.now() + limits.requestTimeoutMs);
      if (deadline <= Date.now() || seen.has(frame.requestId) || inFlight >= limits.maxInFlightRequests || seen.size >= 4096) throw new Error('Invalid or excessive request.');
      const controller = new AbortController(); active.set(frame.requestId, controller); seen.set(frame.requestId, Date.parse(frame.deadlineAt));
      const timer = setTimeout(() => { controller.abort(); active.delete(frame.requestId); }, deadline - Date.now());
      const context: ExecutionContext = { requestId: frame.requestId, appId: options.appId, userId: options.userId, scopes: new Set(options.scopes ?? []), deadlineAt: new Date(deadline).toISOString(), signal: controller.signal };
      inFlight++;
      void Promise.resolve().then(() => { controller.signal.throwIfAborted(); return options.execute(frame.command, frame.input, context); }).then(result => {
        if (connected && !controller.signal.aborted && active.get(frame.requestId) === controller) send({ type: 'response', requestId: frame.requestId, ok: true, result });
      }, error => {
        if (connected && !controller.signal.aborted && active.get(frame.requestId) === controller) send({ type: 'response', requestId: frame.requestId, ok: false, error: error instanceof McpError ? error.toJSON() : new McpError('INTERNAL', 'An internal error occurred').toJSON() });
      }).catch(stop).finally(() => { inFlight--; clearTimeout(timer); if (active.get(frame.requestId) === controller) active.delete(frame.requestId); });
    } catch { stop(); }
  });
  return { async close() { if (socket.readyState === socket.CLOSED) return; const closed = new Promise<void>(resolve => socket.once('close', () => resolve())); stop(); await closed; } };
}
