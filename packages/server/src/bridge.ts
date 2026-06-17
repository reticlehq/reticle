import { timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  IRIS_WS_PATH,
  IrisMessageSchema,
  MessageKind,
  TRANSPORT_LIMITS,
  isLoopbackHostname,
} from '@syrin/iris-protocol';
import { Session, SessionManager } from './session/session.js';
import { log } from './log.js';

export interface BridgeOptions {
  port: number;
  host?: string;
  token?: string;
  allowedOrigins?: string[];
  maxMessagesPerSecond?: number;
  maxSessions?: number;
  maxPendingConnections?: number;
  helloTimeoutMs?: number;
  clock?: () => number;
  /**
   * When set, the WebSocket server attaches to this HTTP server instead of binding standalone.
   * Used in daemon mode where a single HTTP server handles both WS and SSE MCP traffic.
   * `port` and `host` are ignored for binding when this is provided.
   */
  server?: http.Server;
}

function normalizeOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function tokensMatch(expected: string, received: string | undefined): boolean {
  if (received === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
  );
}

/** Normalize ws RawData (string | Buffer | Buffer[] | ArrayBuffer) into a UTF-8 string. */
function rawToString(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

/**
 * The browser-facing half of the relay: a localhost WebSocket server. Each connection
 * announces itself with HELLO (registering a Session), then streams EVENTs and replies to
 * COMMANDs.
 */
export class Bridge {
  readonly sessions = new SessionManager();
  /** Resolves with the actually-bound port once the server is listening. */
  readonly ready: Promise<number>;
  readonly #wss: WebSocketServer;
  readonly #clock: () => number;
  readonly #token: string | undefined;
  readonly #allowedOrigins: Set<string>;
  readonly #maxMessagesPerSecond: number;
  readonly #maxSessions: number;
  readonly #maxPendingConnections: number;
  readonly #helloTimeoutMs: number;
  #pendingConnections = 0;

  constructor(options: BridgeOptions) {
    const host = options.host ?? '127.0.0.1';
    if ((options.token?.length ?? 0) > TRANSPORT_LIMITS.MAX_TOKEN_LENGTH) {
      throw new Error(
        `Iris pairing token exceeds ${String(TRANSPORT_LIMITS.MAX_TOKEN_LENGTH)} characters`,
      );
    }
    if (!isLoopbackHostname(host) && (options.token === undefined || options.token.length === 0)) {
      throw new Error('a pairing token is required when the Iris bridge binds beyond localhost');
    }
    this.#clock = options.clock ?? (() => Date.now());
    this.#token =
      options.token !== undefined && options.token.length > 0 ? options.token : undefined;
    this.#allowedOrigins = new Set(
      (options.allowedOrigins ?? [])
        .map(normalizeOrigin)
        .filter((origin): origin is string => origin !== null),
    );
    this.#maxMessagesPerSecond =
      options.maxMessagesPerSecond ?? TRANSPORT_LIMITS.MAX_MESSAGES_PER_SECOND;
    this.#maxSessions = options.maxSessions ?? TRANSPORT_LIMITS.MAX_SESSIONS;
    this.#maxPendingConnections =
      options.maxPendingConnections ?? TRANSPORT_LIMITS.MAX_PENDING_CONNECTIONS;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? TRANSPORT_LIMITS.HELLO_TIMEOUT_MS;

    if (options.server !== undefined) {
      const srv = options.server;
      this.#wss = new WebSocketServer({
        server: srv,
        path: IRIS_WS_PATH,
        maxPayload: TRANSPORT_LIMITS.MAX_MESSAGE_BYTES,
        verifyClient: ({ origin }, done) => {
          const allowed = this.#originAllowed(origin);
          if (!allowed) log('origin_rejected', { origin: origin ?? 'missing' });
          done(allowed, 403, 'Forbidden');
        },
      });
      this.ready = new Promise<number>((resolve) => {
        if (srv.listening) {
          resolve((srv.address() as AddressInfo).port);
        } else {
          srv.once('listening', () => {
            resolve((srv.address() as AddressInfo).port);
          });
        }
      });
    } else {
      this.#wss = new WebSocketServer({
        port: options.port,
        host,
        path: IRIS_WS_PATH,
        maxPayload: TRANSPORT_LIMITS.MAX_MESSAGE_BYTES,
        verifyClient: ({ origin }, done) => {
          const allowed = this.#originAllowed(origin);
          if (!allowed) log('origin_rejected', { origin: origin ?? 'missing' });
          done(allowed, 403, 'Forbidden');
        },
      });
      this.ready = new Promise<number>((resolve) => {
        this.#wss.on('listening', () => {
          resolve((this.#wss.address() as AddressInfo).port);
        });
      });
    }

    this.#wss.on('connection', (socket) => {
      this.#onConnection(socket);
    });
  }

  #onConnection(socket: WebSocket): void {
    if (this.#pendingConnections >= this.#maxPendingConnections) {
      socket.close(1013, 'too many pending handshakes');
      return;
    }
    this.#pendingConnections += 1;
    let awaitingHello = true;
    let session: Session | undefined;
    let messageWindowStartedAt = this.#clock();
    let messagesInWindow = 0;
    const releasePending = (): void => {
      if (!awaitingHello) return;
      awaitingHello = false;
      this.#pendingConnections -= 1;
    };
    const helloTimer = setTimeout(() => {
      if (!awaitingHello) return;
      releasePending();
      socket.close(1008, 'hello timeout');
    }, this.#helloTimeoutMs);

    socket.on('message', (raw) => {
      const now = this.#clock();
      if (now - messageWindowStartedAt >= 1000) {
        messageWindowStartedAt = now;
        messagesInWindow = 0;
      }
      messagesInWindow += 1;
      if (messagesInWindow > this.#maxMessagesPerSecond) {
        log('message_rate_exceeded', {});
        socket.close(1008, 'message rate exceeded');
        return;
      }

      const parsed = this.#parse(rawToString(raw));
      if (parsed === null) {
        socket.close(1008, 'invalid message');
        return;
      }

      if (parsed.kind === MessageKind.HELLO) {
        if (session !== undefined) {
          socket.close(1008, 'hello already received');
          return;
        }
        if (this.#token !== undefined && !tokensMatch(this.#token, parsed.token)) {
          log('authentication_failed', {});
          socket.close(1008, 'authentication failed');
          return;
        }
        const existing = this.sessions.get(parsed.sessionId);
        if (existing === undefined && this.sessions.count() >= this.#maxSessions) {
          socket.close(1013, 'session limit reached');
          return;
        }
        clearTimeout(helloTimer);
        releasePending();
        session = new Session(parsed, socket, this.#clock);
        const replaced = this.sessions.add(session);
        replaced?.disconnect('session replaced by a newer connection');
        log('session_connected', { sessionId: session.id, url: session.url });
        return;
      }
      if (session === undefined) return;
      session.touch();

      if (parsed.kind === MessageKind.EVENT) {
        session.pushEvent(parsed.event);
      } else if (parsed.kind === MessageKind.COMMAND_RESULT) {
        session.handleResult(parsed);
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      releasePending();
      if (session !== undefined) {
        if (this.sessions.remove(session)) {
          log('session_disconnected', { sessionId: session.id });
        }
      }
    });

    socket.on('error', (err) => {
      log('socket_error', { error: err.message });
    });
  }

  #originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    const normalized = normalizeOrigin(origin);
    if (normalized === null) return false;
    if (this.#allowedOrigins.has(normalized)) return true;
    return isLoopbackHostname(new URL(normalized).hostname);
  }

  #parse(text: string): ReturnType<typeof IrisMessageSchema.parse> | null {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const result = IrisMessageSchema.safeParse(json);
    if (!result.success) {
      log('bad_message', { issues: result.error.issues.length });
      return null;
    }
    return result.data;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.#wss.clients) client.terminate();
      this.#wss.close(() => {
        resolve();
      });
    });
  }
}
