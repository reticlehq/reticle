import type { WebSocket } from 'ws';
import { MessageKind, type CommandResult, type HelloMessage, type IrisEvent } from '@iris/protocol';
import { RingBuffer } from './ring-buffer.js';

export interface SessionInfo {
  sessionId: string;
  url: string;
  title: string;
  adapters: string[];
  hasCapabilities: boolean;
  lastSeenMs: number;
}

type PendingCommand = {
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Clock = () => number;

const DEFAULT_COMMAND_TIMEOUT_MS = 8000;

/**
 * One connected browser tab. Owns its socket, a ring buffer of observations, and the
 * in-flight command map. `clock` is injected so elapsed-time logic stays testable.
 */
export class Session {
  readonly id: string;
  url: string;
  title: string;
  adapters: string[];
  hasCapabilities: boolean;

  readonly #socket: WebSocket;
  readonly #clock: Clock;
  readonly #startedAt: number;
  readonly #buffer = new RingBuffer();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #listeners = new Set<(event: IrisEvent) => void>();
  #seq = 0;

  constructor(hello: HelloMessage, socket: WebSocket, clock: Clock) {
    this.id = hello.sessionId;
    this.url = hello.url;
    this.title = hello.title;
    this.adapters = hello.adapters;
    this.hasCapabilities = hello.hasCapabilities ?? false;
    this.#socket = socket;
    this.#clock = clock;
    this.#startedAt = clock();
  }

  /** Milliseconds since this session connected — the authoritative buffer clock. */
  elapsed(): number {
    return this.#clock() - this.#startedAt;
  }

  info(): SessionInfo {
    return {
      sessionId: this.id,
      url: this.url,
      title: this.title,
      adapters: this.adapters,
      hasCapabilities: this.hasCapabilities,
      lastSeenMs: this.elapsed(),
    };
  }

  /** Re-stamp an incoming event with server-relative time, buffer it, and fan out. */
  pushEvent(event: IrisEvent): void {
    const t = this.elapsed();
    const stamped: IrisEvent = { ...event, t, sessionId: this.id };
    this.#buffer.push(stamped, t);
    for (const listener of this.#listeners) listener(stamped);
  }

  eventsSince(cursor: number): IrisEvent[] {
    return this.#buffer.since(cursor);
  }

  eventsInWindow(windowMs: number): IrisEvent[] {
    return this.#buffer.window(windowMs, this.elapsed());
  }

  onEvent(listener: (event: IrisEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Send a command to the browser and await its reply (or time out). */
  command(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<CommandResult> {
    this.#seq += 1;
    const id = `c${String(this.#seq)}`;
    const payload = JSON.stringify({
      kind: MessageKind.COMMAND,
      id,
      sessionId: this.id,
      name,
      args,
    });
    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`command '${name}' timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(payload);
    });
  }

  handleResult(result: CommandResult): void {
    const pending = this.#pending.get(result.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(result.id);
    pending.resolve(result);
  }

  /** Reject everything still in flight — used on disconnect. */
  rejectAll(reason: string): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.#pending.delete(id);
    }
  }
}

/** Registry of connected sessions with single-active-session ergonomics. */
export class SessionManager {
  readonly #sessions = new Map<string, Session>();

  add(session: Session): void {
    this.#sessions.set(session.id, session);
  }

  remove(sessionId: string): void {
    this.#sessions.get(sessionId)?.rejectAll('session disconnected');
    this.#sessions.delete(sessionId);
  }

  get(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => s.info());
  }

  count(): number {
    return this.#sessions.size;
  }

  /**
   * Resolve the target session. With an explicit id, returns it. With none and exactly
   * one connected, returns that. Otherwise throws a clear, agent-readable error.
   */
  resolve(sessionId?: string): Session {
    if (sessionId !== undefined) {
      const found = this.#sessions.get(sessionId);
      if (found === undefined) {
        throw new Error(`no connected session with id '${sessionId}'`);
      }
      return found;
    }
    if (this.#sessions.size === 0) {
      throw new Error(
        'no browser session connected — is your app running with @iris/browser enabled?',
      );
    }
    if (this.#sessions.size > 1) {
      const ids = [...this.#sessions.keys()].join(', ');
      throw new Error(`multiple sessions connected (${ids}); pass sessionId to target one`);
    }
    const [only] = this.#sessions.values();
    if (only === undefined) throw new Error('session lookup failed');
    return only;
  }
}
