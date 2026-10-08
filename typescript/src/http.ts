import {
  createMcpHandler, classifyInboundRequest, isLegacyRequest, isJsonContentType, isJSONRPCRequest, isJSONRPCResponse, readRequestBody,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo, type McpHttpHandler, type McpHandlerRequestOptions, type McpServerFactory,
} from '@modelcontextprotocol/server';
import { createServer, type ServerOptions } from './index.js';

export interface HttpHandlerOptions extends Omit<ServerOptions, 'auth'> {
  /** Normal exchanges use JSON by default. SSE preserves intermediate notifications. */
  responseMode?: 'json' | 'sse';
  resolveAuth?(authInfo?: AuthInfo): ServerOptions['auth'];
  onerror?(error: Error): void;
}

// Keep the SDK's HTTP body bound; maxPayloadBytes bounds tool input/output.
const maxRequestBodySize = 4 * 1024 * 1024;

/** Most-specific matching range wins, so an explicit q=0 overrides a wildcard. */
function accepts(header: string | null, mediaType: string): boolean {
  if (header === null) return true;
  const [type] = mediaType.split('/');
  let specificity = -1;
  let quality = 0;
  for (const range of header.split(',')) {
    const [rawType, ...params] = range.trim().toLowerCase().split(';');
    const candidate = rawType.trim();
    const rank = candidate === mediaType ? 2 : candidate === `${type}/*` ? 1 : candidate === '*/*' ? 0 : -1;
    if (rank < 0) continue;
    const qParam = params.map(p => p.trim()).find(p => p.startsWith('q='));
    const rawQ = qParam?.slice(2).trim();
    const q = rawQ === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(rawQ) ? Number(rawQ) : 0;
    if (rank > specificity) { specificity = rank; quality = q; }
    else if (rank === specificity) quality = Math.max(quality, q);
  }
  return quality > 0;
}

function errorResponse(status: number, message: string, id: string | number | null = null): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code: status === 500 ? -32603 : -32000, message } }, { status });
}

export function createHttpHandler(options: HttpHandlerOptions): McpHttpHandler {
  const responseMode = options.responseMode ?? 'json';
  if (responseMode !== 'json' && responseMode !== 'sse') throw new TypeError('Invalid HTTP response mode.');
  const report = (error: unknown) => { try { options.onerror?.(error instanceof Error ? error : new Error(String(error))); } catch { /* Reporting cannot change the response. */ } };
  const factory: McpServerFactory = ({ authInfo }) => createServer({ ...options, auth: options.resolveAuth?.(authInfo) });
  const modern = createMcpHandler(factory, { legacy: 'reject', responseMode, onerror: report, maxRequestBodySize });
  const shutdown = new AbortController();
  const active = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;

  async function legacy(request: Request, requestOptions?: McpHandlerRequestOptions): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: responseMode === 'json', maxRequestBodySize });
    const server = await factory({ era: 'legacy', authInfo: requestOptions?.authInfo, requestInfo: request });
    let disposed: Promise<void> | undefined;
    let stopping = false;
    let complete!: () => void;
    const lifetime = new Promise<void>(resolve => { complete = resolve; });
    active.add(lifetime);
    const pending = new Set<string | number>();
    const send = transport.send.bind(transport);
    transport.send = async (message, sendOptions) => {
      // Work may finish after cancellation; its terminal response is already
      // supplied by dispose and must not be sent to a closed exchange again.
      if (stopping) return;
      await send(message, sendOptions);
      if (isJSONRPCResponse(message) && message.id !== undefined) pending.delete(message.id);
    };
    const dispose = (): Promise<void> => {
      if (disposed) return disposed;
      stopping = true;
      request.signal.removeEventListener('abort', abort);
      // SDK 2.3.1 close() clears JSON resolvers without settling them. Deliver a
      // terminal error through send() before closing, using only public APIs.
      disposed = (async () => {
        if (responseMode === 'json') for (const id of pending) {
          await send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'The request was cancelled' } }).catch(report);
        }
        await server.close().catch(report);
        active.delete(lifetime);
        complete();
      })();
      return disposed;
    };
    const abort = () => { void dispose(); };
    try {
      await server.connect(transport);
      const onmessage = transport.onmessage;
      transport.onmessage = (message, extra) => {
        if (isJSONRPCRequest(message)) pending.add(message.id);
        onmessage?.(message, extra);
        // The protocol suppresses a handler response once notifications/cancelled
        // aborts it. A JSON exchange still needs a terminal response to settle.
        if (!('id' in message) && 'method' in message && message.method === 'notifications/cancelled') {
          const params = message.params;
          const id = params?.requestId;
          if ((typeof id === 'string' || typeof id === 'number') && pending.has(id)
            && (params?.reason === undefined || typeof params.reason === 'string')) {
            void transport.send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'The request was cancelled' } }).catch(report);
          }
        }
      };
      // Preserve the protocol's error reporting too (connect installs onerror).
      const onerror = transport.onerror;
      transport.onerror = error => { onerror?.(error); report(error); };
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) { await dispose(); return new Response(null, { status: 499 }); }
      const response = await transport.handleRequest(request, requestOptions);
      pending.clear();
      if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
        await dispose();
        return response;
      }
      const reader = response.body.getReader();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { await dispose(); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) { await dispose(); controller.error(error); }
        },
        async cancel(reason) { await reader.cancel(reason).catch(report); await dispose(); },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { await dispose(); throw error; }
  }

  const fetch: McpHttpHandler['fetch'] = async (request, requestOptions) => {
    if (closing) throw new Error('This MCP handler has been closed');
    if (request.method !== 'POST') return errorResponse(405, 'Method not allowed.');
    const signal = AbortSignal.any([request.signal, shutdown.signal]);
    let internal = new Request(request, { signal });
    try {
      if (!isJsonContentType(request.headers.get('content-type'))) return await modern.fetch(internal, requestOptions);
      let parsedBody = requestOptions?.parsedBody;
      if (parsedBody === undefined) {
        const body = await readRequestBody(internal.clone(), maxRequestBodySize);
        if (body.tooLarge) return await modern.fetch(internal, requestOptions);
        try { parsedBody = JSON.parse(body.text); } catch { /* Let the SDK report malformed JSON. */ }
      }
      const legacyRequest = await isLegacyRequest(internal, parsedBody, { maxRequestBodySize });
      const classification = classifyInboundRequest({
        httpMethod: request.method,
        protocolVersionHeader: request.headers.get('mcp-protocol-version') ?? undefined,
        mcpMethodHeader: request.headers.get('mcp-method') ?? undefined,
        mcpNameHeader: request.headers.get('mcp-name') ?? undefined,
        ...(parsedBody !== undefined && { body: parsedBody }),
      });
      if (classification.kind === 'reject') return await modern.fetch(internal, { ...requestOptions, parsedBody });
      // Only well-classified listen requests get stream negotiation. Malformed
      // modern claims continue through the SDK's validation ladder.
      const listen = classification.kind === 'modern' && classification.messageKind === 'request' && classification.message.method === 'subscriptions/listen';
      const accept = request.headers.get('accept');
      const compatible = responseMode === 'json' && !listen
        ? accepts(accept, 'application/json')
        : listen ? accept !== null && accepts(accept, 'text/event-stream')
        : accept !== null && accepts(accept, 'application/json') && accepts(accept, 'text/event-stream');
      if (!compatible) {
        const message = 'Not Acceptable: Client does not accept the HTTP response mode';
        report(new Error(message));
        return errorResponse(406, message);
      }
      // The legacy SDK requires both literal media types even in native JSON
      // mode. Normalize a private request only after client negotiation passes.
      const headers = new Headers(internal.headers);
      headers.set('accept', 'application/json, text/event-stream');
      internal = new Request(internal, { headers });
      const forwarded = { ...requestOptions, ...(parsedBody !== undefined && { parsedBody }) };
      return await (legacyRequest ? legacy(internal, forwarded) : modern.fetch(internal, forwarded));
    } catch (error) {
      if (signal.aborted) return new Response(null, { status: 499 });
      report(error);
      return errorResponse(500, 'Internal server error');
    }
  };
  return {
    fetch, notify: modern.notify, bus: modern.bus,
    close: () => {
      if (!closing) {
        // Mark closed before abort callbacks run, including during body parsing.
        closing = Promise.resolve().then(async () => {
          shutdown.abort();
          await modern.close();
          await Promise.all([...active]);
        });
      }
      return closing;
    },
  };
}
