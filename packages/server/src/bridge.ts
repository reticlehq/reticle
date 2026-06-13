import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { IRIS_WS_PATH, IrisMessageSchema, MessageKind } from '@iris/protocol';
import { Session, SessionManager } from './session.js';
import { log } from './log.js';

export interface BridgeOptions {
  port: number;
  host?: string;
  clock?: () => number;
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
 * COMMANDs. See plan/02-architecture.md.
 */
export class Bridge {
  readonly sessions = new SessionManager();
  /** Resolves with the actually-bound port once the server is listening. */
  readonly ready: Promise<number>;
  readonly #wss: WebSocketServer;
  readonly #clock: () => number;

  constructor(options: BridgeOptions) {
    this.#clock = options.clock ?? (() => Date.now());
    this.#wss = new WebSocketServer({
      port: options.port,
      host: options.host ?? '127.0.0.1',
      path: IRIS_WS_PATH,
    });
    this.ready = new Promise<number>((resolve) => {
      this.#wss.on('listening', () => {
        resolve((this.#wss.address() as AddressInfo).port);
      });
    });
    this.#wss.on('connection', (socket) => {
      this.#onConnection(socket);
    });
  }

  #onConnection(socket: WebSocket): void {
    let session: Session | undefined;

    socket.on('message', (raw) => {
      const parsed = this.#parse(rawToString(raw));
      if (parsed === null) return;

      if (parsed.kind === MessageKind.HELLO) {
        session = new Session(parsed, socket, this.#clock);
        this.sessions.add(session);
        log('session_connected', { sessionId: session.id, url: session.url });
        return;
      }
      if (session === undefined) return; // ignore anything before HELLO

      if (parsed.kind === MessageKind.EVENT) {
        session.pushEvent(parsed.event);
      } else if (parsed.kind === MessageKind.COMMAND_RESULT) {
        session.handleResult(parsed);
      }
    });

    socket.on('close', () => {
      if (session !== undefined) {
        this.sessions.remove(session.id);
        log('session_disconnected', { sessionId: session.id });
      }
    });

    socket.on('error', (err) => {
      log('socket_error', { error: err.message });
    });
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
      this.#wss.close(() => {
        resolve();
      });
    });
  }
}
