import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defaults, BRIDGE_PROTOCOL_VERSION, LEGACY_BRIDGE_PROTOCOL_VERSION, bridgeResponseSchema, McpError } from './contract.js';

export interface BridgeSocket {
  readonly OPEN: number; readyState: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
}
export interface SessionStore {
  isDesktopSessionActive(userId: string, sessionId: string): boolean;
  hasActiveDesktopSession(userId: string): boolean;
}
interface Pending {
  command: string; readOnly: boolean; resolve(value: unknown): void; reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout>; cleanup(): void;
}
export interface BridgeConnection {
  userId: string; sessionId: string; socket: BridgeSocket; ready: boolean;
  protocolVersion: string; generation: string; appVersion?: string; lastPongAt: number;
  pending: Map<string, Pending>;
}
export interface BridgeOptions {
  appId: string; sessions: SessionStore;
  parseInput(command: string, input: unknown): unknown;
  parseOutput(command: string, output: unknown): unknown;
  isReadOnly(command: string): boolean;
  responseSchema?: z.ZodType;
  error?(code: string, options?: { retryable?: boolean; message?: string; details?: Record<string, unknown>; currentVersion?: number }): Error;
  limits?: Partial<typeof defaults>;
}
export class BridgeRegistry {
  private readonly tickets = new Map<string, { userId: string; sessionId: string; expiresAt: number }>();
  private readonly connections = new Map<string, BridgeConnection>();
  private readonly limits;
  constructor(private readonly options: BridgeOptions) {
    if (!options.appId) throw new Error('Bridge appId is required.');
    this.limits = { ...defaults, ...options.limits };
    for (const key of ['requestTimeoutMs', 'ticketTtlSeconds', 'maxPayloadBytes', 'maxInFlightRequests'] as const) if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] <= 0) throw new Error('Invalid bridge limits.');
  }
  private error(code: string, options: { retryable?: boolean; message?: string; details?: Record<string, unknown>; currentVersion?: number } = {}): Error {
    return this.options.error?.(code, options) ?? new McpError(code, options.message ?? ({ APP_OFFLINE: 'The app is offline', USER_NOT_LOGGED_IN: 'User not logged in', TIMEOUT: 'The request timed out', CANCELLED: 'The request was cancelled', OVERLOADED: 'Too many requests', INVALID_INPUT: 'Invalid input', INTERNAL: 'An internal error occurred' }[code] ?? 'The requested operation is not allowed'), options.retryable, options.details);
  }
  issueTicket(userId: string, sessionId: string) {
    if (!this.options.sessions.isDesktopSessionActive(userId, sessionId)) throw this.error('USER_NOT_LOGGED_IN');
    for (const [ticket, value] of this.tickets) if (value.expiresAt <= Date.now()) this.tickets.delete(ticket);
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { userId, sessionId, expiresAt: Date.now() + this.limits.ticketTtlSeconds * 1000 });
    return { ticket, expiresIn: this.limits.ticketTtlSeconds };
  }
  consumeTicket(ticket: string) {
    const value = this.tickets.get(ticket); this.tickets.delete(ticket);
    return value && value.expiresAt > Date.now() && this.options.sessions.isDesktopSessionActive(value.userId, value.sessionId) ? value : null;
  }
  attach(userId: string, sessionId: string, socket: BridgeSocket): BridgeConnection {
    if (!this.options.sessions.isDesktopSessionActive(userId, sessionId)) throw this.error('USER_NOT_LOGGED_IN');
    const current = this.connections.get(userId);
    if (current) this.closeConnection(current, 'APP_OFFLINE', 'A newer connection replaced this one.');
    const connection: BridgeConnection = { userId, sessionId, socket, ready: false, protocolVersion: LEGACY_BRIDGE_PROTOCOL_VERSION, generation: randomUUID(), lastPongAt: Date.now(), pending: new Map() };
    this.connections.set(userId, connection); return connection;
  }
  markReady(connection: BridgeConnection, appVersion: string, protocolVersion = LEGACY_BRIDGE_PROTOCOL_VERSION) {
    if (this.connections.get(connection.userId) !== connection || !this.options.sessions.isDesktopSessionActive(connection.userId, connection.sessionId)) throw this.error('USER_NOT_LOGGED_IN');
    if (![BRIDGE_PROTOCOL_VERSION, LEGACY_BRIDGE_PROTOCOL_VERSION].includes(protocolVersion)) throw this.error('INVALID_INPUT');
    connection.protocolVersion = protocolVersion; connection.appVersion = appVersion; connection.ready = true;
  }
  markPong(connection: BridgeConnection) { connection.lastPongAt = Date.now(); }
  getPresence(userId: string) {
    const loggedIn = this.options.sessions.hasActiveDesktopSession(userId), connection = this.connections.get(userId);
    return { loggedIn, online: Boolean(loggedIn && connection?.ready && connection.socket.readyState === connection.socket.OPEN && this.options.sessions.isDesktopSessionActive(userId, connection.sessionId)), ...(connection?.appVersion ? { appVersion: connection.appVersion } : {}) };
  }
  async dispatch(userId: string, command: string, rawInput: unknown, options: { signal?: AbortSignal; deadlineAt?: string } = {}): Promise<unknown> {
    let input: unknown;
    try { input = this.options.parseInput(command, rawInput); } catch { throw this.error('INVALID_INPUT'); }
    const presence = this.getPresence(userId);
    if (!presence.loggedIn) throw this.error('USER_NOT_LOGGED_IN');
    const connection = this.connections.get(userId);
    if (!presence.online || !connection) throw this.error('APP_OFFLINE', { retryable: true });
    if (options.signal?.aborted) throw this.error('CANCELLED');
    if (connection.pending.size >= this.limits.maxInFlightRequests) throw this.error('OVERLOADED', { retryable: true });
    const deadline = Math.min(Date.now() + this.limits.requestTimeoutMs, options.deadlineAt ? Date.parse(options.deadlineAt) : Infinity);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw this.error('TIMEOUT');
    const requestId = randomUUID(), readOnly = this.options.isReadOnly(command);
    const frame = JSON.stringify({ type: 'request', requestId, command, input, deadlineAt: new Date(deadline).toISOString() });
    if (Buffer.byteLength(frame) > this.limits.maxPayloadBytes) throw this.error('INVALID_INPUT');
    return new Promise((resolve, reject) => {
      const cancel = (code = 'CANCELLED') => {
        if (!connection.pending.has(requestId)) return;
        this.finish(connection, requestId);
        if (connection.protocolVersion === BRIDGE_PROTOCOL_VERSION && connection.socket.readyState === connection.socket.OPEN) {
          try { connection.socket.send(JSON.stringify({ type: 'cancel', requestId })); } catch { /* Delivery remains best effort; the deadline also invalidates work. */ }
        }
        reject(this.error(code, { retryable: readOnly, details: readOnly ? undefined : { outcome: 'unknown' } }));
      };
      const onAbort = () => cancel();
      const timeout = setTimeout(() => cancel('TIMEOUT'), deadline - Date.now());
      connection.pending.set(requestId, { command, readOnly, resolve, reject, timeout, cleanup: () => options.signal?.removeEventListener('abort', onAbort) });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) { cancel(); return; }
      try { connection.socket.send(frame, error => { if (error && connection.pending.has(requestId)) { this.finish(connection, requestId); reject(this.error('APP_OFFLINE', { retryable: readOnly, details: readOnly ? undefined : { outcome: 'unknown' } })); } }); }
      catch { this.finish(connection, requestId); reject(this.error('APP_OFFLINE', { retryable: readOnly, details: readOnly ? undefined : { outcome: 'unknown' } })); }
    });
  }
  acceptResponse(connection: BridgeConnection, rawResponse: unknown) {
    if (this.connections.get(connection.userId) !== connection) return;
    if (Buffer.byteLength(JSON.stringify(rawResponse)) > this.limits.maxPayloadBytes) throw this.error('INVALID_INPUT');
    const response = (this.options.responseSchema ?? bridgeResponseSchema).parse(rawResponse) as { requestId: string; ok: boolean; result?: unknown; error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown>; currentVersion?: number } };
    const pending = connection.pending.get(response.requestId);
    if (!pending) return;
    this.finish(connection, response.requestId);
    if (!this.options.sessions.isDesktopSessionActive(connection.userId, connection.sessionId)) { pending.reject(this.error('USER_NOT_LOGGED_IN')); return; }
    if (!response.ok && response.error) { pending.reject(this.error(response.error.code, response.error)); return; }
    try { pending.resolve(this.options.parseOutput(pending.command, response.result)); } catch { pending.reject(this.error('INTERNAL')); }
  }
  private finish(connection: BridgeConnection, id: string) {
    const pending = connection.pending.get(id); if (!pending) return;
    clearTimeout(pending.timeout); pending.cleanup(); connection.pending.delete(id);
  }
  detach(connection: BridgeConnection) {
    if (this.connections.get(connection.userId) === connection) this.connections.delete(connection.userId);
    for (const [id, pending] of connection.pending) { this.finish(connection, id); pending.reject(this.error('APP_OFFLINE', { retryable: pending.readOnly, details: pending.readOnly ? undefined : { outcome: 'unknown' } })); }
    connection.ready = false;
  }
  revokeUserConnection(userId: string, reason = 'Session revoked.') {
    const connection = this.connections.get(userId); if (!connection) return;
    try { connection.socket.send(JSON.stringify({ type: 'session_revoked', reason })); } finally { this.closeConnection(connection, 'USER_NOT_LOGGED_IN', reason); }
  }
  private closeConnection(connection: BridgeConnection, code: string, reason: string) {
    for (const [id, pending] of connection.pending) { this.finish(connection, id); pending.reject(this.error(code, { retryable: code === 'APP_OFFLINE' && pending.readOnly, details: pending.readOnly ? undefined : { outcome: 'unknown' } })); }
    if (this.connections.get(connection.userId) === connection) this.connections.delete(connection.userId);
    let closeReason = '';
    for (const char of reason) { if (Buffer.byteLength(closeReason + char) > 120) break; closeReason += char; }
    connection.ready = false; connection.socket.close(4001, closeReason);
  }
  closeStaleConnections(offlineAfterMs: number) { for (const connection of this.connections.values()) if (connection.lastPongAt < Date.now() - offlineAfterMs) this.closeConnection(connection, 'APP_OFFLINE', 'Heartbeat timed out.'); }
  close() { this.tickets.clear(); for (const connection of [...this.connections.values()]) this.closeConnection(connection, 'APP_OFFLINE', 'Server is shutting down.'); }
}
