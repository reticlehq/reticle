import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  EventType,
  HumanControlKind,
  IRIS_WS_PATH,
  IrisMessageSchema,
  LOOPBACK_HOST,
  MessageKind,
  TRANSPORT_LIMITS,
  isLoopbackHostname,
} from '@syrin/iris-protocol';
import { Session, SessionManager } from './session/session.js';
import { tokensMatch } from './token-auth.js';
import { log } from './log.js';

/** A human clicked ▶ on a saved flow in the panel — replay it with no agent. Wired by the daemon. */
type ReplayRequestHandler = (sessionId: string, flowName: string) => void;
/** Called once a browser session connects, so the daemon can push it the replayable-flow list. */
type SessionReadyHandler = (session: Session) => void;

/** The flow name if this event is a panel ▶ replay request, else undefined. Pure boundary narrowing. */
function replayRequest(event: { type: string; data: Record<string, unknown> }): string | undefined {
  if (event.type !== EventType.HUMAN_CONTROL) return undefined;
  if (event.data['kind'] !== HumanControlKind.REPLAY) return undefined;
  const name = event.data['text'];
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

interface BridgeOptions {
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
  #onReplay: ReplayRequestHandler | undefined;
  #onSessionReady: SessionReadyHandler | undefined;

  constructor(options: BridgeOptions) {
    const host = options.host ?? LOOPBACK_HOST;
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
      // In shared-server mode the daemon owns listen(); but a WebSocketServer bound to a server that
      // fails to listen (EADDRINUSE) surfaces the error on the WS instance too. Without a listener
      // that is an unhandled 'error' that can crash/hang the process — so absorb it here and reject
      // `ready`, mirroring the standalone branch. The daemon's own listen handler reports the failure.
      this.ready = new Promise<number>((resolve, reject) => {
        this.#wss.once('error', reject);
        if (srv.listening) {
          this.#wss.removeListener('error', reject);
          resolve((srv.address() as AddressInfo).port);
        } else {
          srv.once('listening', () => {
            this.#wss.removeListener('error', reject);
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
      // Reject on 'error' as well as resolve on 'listening'. A port collision (EADDRINUSE) emits
      // 'error'; with no listener that becomes an unhandled 'error' (process crash) AND leaves
      // `ready` pending forever. Surfacing it lets the CLI print "port already in use" cleanly.
      this.ready = new Promise<number>((resolve, reject) => {
        this.#wss.once('error', reject);
        this.#wss.on('listening', () => {
          this.#wss.removeListener('error', reject);
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
        this.#onSessionReady?.(session); // daemon pushes the replayable-flow list to the panel
        return;
      }
      if (session === undefined) return;
      session.touch();

      if (parsed.kind === MessageKind.EVENT) {
        // A panel ▶ replay needs the daemon's flow store, which the Session can't reach — route it to
        // the daemon-wired handler instead of the in-session control path. Everything else is normal.
        const replay = replayRequest(parsed.event);
        if (replay !== undefined) this.#onReplay?.(session.id, replay);
        else session.pushEvent(parsed.event);
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

  /** Register the daemon's handler for a panel ▶ replay (it owns the flow store). */
  attachReplay(handler: ReplayRequestHandler): void {
    this.#onReplay = handler;
  }

  /** Register a callback fired when a browser session connects (to push it the replayable flows). */
  attachSessionReady(handler: SessionReadyHandler): void {
    this.#onSessionReady = handler;
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
