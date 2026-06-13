import type { WebSocket } from 'ws';
import {
  EventType,
  HumanControlDataSchema,
  HumanControlKind,
  IrisCommand,
  MessageKind,
  SESSION_HEALTH,
  SESSION_LIFECYCLE,
  SessionState,
  type CommandResult,
  type HelloMessage,
  type HumanControlData,
  type IrisEvent,
} from '@syrin/iris-protocol';
import { RingBuffer } from '../events/ring-buffer.js';
import { buildSessionRecommendation } from './session-recommendation.js';

export interface SessionInfo {
  sessionId: string;
  url: string;
  title: string;
  adapters: string[];
  hasCapabilities: boolean;
  /** ms since the SDK last reported anything (silence ⇒ likely throttled). */
  lastSeenMs: number;
  hidden: boolean;
  focused: boolean;
  throttled: boolean;
  /** present only when hidden/throttled — points at the `iris drive` escape hatch. */
  recommendation?: string;
}

/** The health block spliced onto act/assert results. */
export interface SessionHealth {
  lastSeenMs: number;
  throttled: boolean;
  focused: boolean;
  /** present only when hidden/throttled — points at the `iris drive` escape hatch. */
  recommendation?: string;
}

type PendingCommand = {
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Clock = () => number;

const DEFAULT_COMMAND_TIMEOUT_MS = 8000;

/** ws readyState for an OPEN socket — guard fire-and-forget pushes against a closing tab. */
const WS_OPEN = 1;

/** Live-control: a human note queued for the agent, stamped with session-relative elapsed time. */
export interface InboxMessage {
  text: string;
  t: number;
}

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
  #lastSeenAt: number;
  #hidden = false;
  #focused = true;
  #state: SessionState = SessionState.ACTIVE;
  #lastActCursor: number | undefined;
  /** Liveness: wall-clock of the last AGENT command (distinct from browser chatter / lastSeen). */
  #lastAgentActivityAt: number;
  /** Server-side mirror of the agent-tuned idle window, so the reaper honors iris_session. */
  #idleEndMs: number = SESSION_LIFECYCLE.IDLE_END_MS;
  /** True when the reaper/disconnect ended this session — such an end is revivable; explicit ends are not. */
  #autoEnded = false;
  readonly #inbox: InboxMessage[] = [];

  constructor(hello: HelloMessage, socket: WebSocket, clock: Clock) {
    this.id = hello.sessionId;
    this.url = hello.url;
    this.title = hello.title;
    this.adapters = hello.adapters;
    this.hasCapabilities = hello.hasCapabilities ?? false;
    this.#socket = socket;
    this.#clock = clock;
    this.#startedAt = clock();
    this.#lastSeenAt = clock();
    this.#lastAgentActivityAt = clock();
  }

  /** Milliseconds since this session connected — the authoritative buffer clock. */
  elapsed(): number {
    return this.#clock() - this.#startedAt;
  }

  /** Mark that the SDK was just heard from. Called on every inbound message. */
  touch(): void {
    this.#lastSeenAt = this.#clock();
  }

  /** ms since the SDK last reported anything (distinct from elapsed-since-connect). */
  lastSeenMs(): number {
    return this.#clock() - this.#lastSeenAt;
  }

  /** Record the latest page visibility/focus state from a PAGE_HEALTH event. */
  applyHealth(hidden: boolean, focused: boolean): void {
    this.#hidden = hidden;
    this.#focused = focused;
  }

  /** Throttled if the tab is hidden OR we have not heard from it recently. */
  throttled(): boolean {
    return this.#hidden || this.lastSeenMs() > SESSION_HEALTH.STALE_THRESHOLD_MS;
  }

  /** The attachable health block — single source of truth for the tools. */
  health(): SessionHealth {
    const base: SessionHealth = {
      lastSeenMs: this.lastSeenMs(),
      throttled: this.throttled(),
      focused: this.#focused,
    };
    // attach the escape-hatch hint only when un-scriptable (keeps field absent otherwise).
    const recommendation = buildSessionRecommendation({
      hidden: this.#hidden,
      throttled: base.throttled,
      focused: base.focused,
    });
    return recommendation === undefined ? base : { ...base, recommendation };
  }

  info(): SessionInfo {
    return {
      sessionId: this.id,
      url: this.url,
      title: this.title,
      adapters: this.adapters,
      hasCapabilities: this.hasCapabilities,
      hidden: this.#hidden,
      ...this.health(),
    };
  }

  /** Re-stamp an incoming event with server-relative time, buffer it, and fan out. */
  pushEvent(event: IrisEvent): void {
    if (event.type === EventType.PAGE_HEALTH) {
      const data = event.data;
      const hidden = typeof data['hidden'] === 'boolean' ? data['hidden'] : this.#hidden;
      const focused = typeof data['focused'] === 'boolean' ? data['focused'] : this.#focused;
      this.applyHealth(hidden, focused);
    }
    if (event.type === EventType.HUMAN_CONTROL) {
      // Narrow unknown at the boundary; an invalid/unknown control is ignored (never thrown).
      const parsed = HumanControlDataSchema.safeParse(event.data);
      if (parsed.success) this.applyHumanControl(parsed.data);
    }
    if (event.type === EventType.ROUTE_CHANGE) {
      // Keep the reported URL live across SPA navigation. The SDK already emits route.change on
      // pushState/replaceState/popstate; without this the URL stays frozen at the hello value, and
      // URL-based CDP correlation (real input) silently breaks after the first client-side nav.
      const to = event.data['to'];
      if (typeof to === 'string' && to.length > 0) this.url = to;
    }
    const t = this.elapsed();
    const stamped: IrisEvent = { ...event, t, sessionId: this.id };
    this.#buffer.push(stamped, t);
    for (const listener of this.#listeners) listener(stamped);
  }

  eventsSince(cursor: number): IrisEvent[] {
    return this.#buffer.since(cursor);
  }

  /**
   * Honesty: remember the event cursor of the most recent act so wait_for/assert can default their
   * evaluation floor to it — a signal buffered before this act can never fake a later pass.
   */
  markActCursor(cursor: number): void {
    this.#lastActCursor = cursor;
  }

  /** The cursor of the last act, or undefined if nothing has acted yet. */
  lastActCursor(): number | undefined {
    return this.#lastActCursor;
  }

  // ── Server-authoritative liveness (immune to browser-tab throttling) ──────────────

  /**
   * Stamp the wall-clock of the latest AGENT command (called whenever a tool resolves this session).
   * If the reaper had auto-ended the session, a fresh command means the agent is alive again, so the
   * session is REVIVED to ACTIVE. An EXPLICIT end (human/agent iris_end_session) is terminal and is
   * never revived here.
   */
  markAgentActivity(): void {
    this.#lastAgentActivityAt = this.#clock();
    if (this.#state === SessionState.ENDED && this.#autoEnded) {
      this.#autoEnded = false;
      this.setState(SessionState.ACTIVE);
    }
  }

  /** ms since the agent last issued a command against this session (the reaper's idle signal). */
  agentIdleMs(): number {
    return this.#clock() - this.#lastAgentActivityAt;
  }

  /** The agent-idle window after which the reaper ends this session. */
  idleEndMs(): number {
    return this.#idleEndMs;
  }

  /** Tune the idle window (iris_session). Floored so an agent can't disable the safety net. */
  setIdleEndMs(ms: number): void {
    this.#idleEndMs = Math.max(SESSION_LIFECYCLE.IDLE_END_MIN_MS, Math.floor(ms));
  }

  /**
   * Reaper/disconnect end: terminal like a normal end (pushes PRESENTER ended to the browser, which a
   * throttled tab still receives) but flagged auto-ended so a returning agent revives it. No-op if
   * already ended.
   */
  autoEnd(text?: string): void {
    if (this.#state === SessionState.ENDED) return;
    this.#autoEnded = true;
    this.setState(SessionState.ENDED, text);
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

  // ── Live-control: state machine + human→agent inbox (server-owned) ───────────────

  getState(): SessionState {
    return this.#state;
  }

  isPaused(): boolean {
    return this.#state === SessionState.PAUSED;
  }

  isEnded(): boolean {
    return this.#state === SessionState.ENDED;
  }

  /**
   * Set the lifecycle state and echo it to the panel in ONE PRESENTER push. The SOLE pusher of
   * PRESENTER for a transition. Optional `text` rides the same push (e.g. an end-of-session
   * summary) so a transition never emits two PRESENTER commands.
   */
  setState(next: SessionState, text?: string): void {
    this.#state = next;
    this.pushPresenter(this.#state, text);
  }

  /** Push a human note onto the inbox; empty/whitespace-only text is ignored. Stamped with elapsed t. */
  pushMessage(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.#inbox.push({ text: trimmed, t: this.elapsed() });
  }

  /** Return the queued human notes AND clear the inbox (delivered-once). */
  drainInbox(): InboxMessage[] {
    return this.#inbox.splice(0, this.#inbox.length);
  }

  /** Diagnostic read of the inbox depth (does not clear). */
  inboxSize(): number {
    return this.#inbox.length;
  }

  /**
   * Apply a narrowed human control. `setState` is called only on a GENUINE change, so each real
   * transition pushes exactly one PRESENTER command; no-ops (e.g. resume on active, pause after
   * end) push nothing. `ended` is terminal — pause/resume after end are no-ops.
   */
  applyHumanControl(data: HumanControlData): void {
    if (this.#state === SessionState.ENDED) {
      // Terminal: end is idempotent; pause/resume are no-ops.
      return;
    }
    switch (data.kind) {
      case HumanControlKind.PAUSE:
        if (this.#state !== SessionState.PAUSED) this.setState(SessionState.PAUSED);
        return;
      case HumanControlKind.RESUME:
        if (this.#state !== SessionState.ACTIVE) this.setState(SessionState.ACTIVE);
        return;
      case HumanControlKind.END:
        this.setState(SessionState.ENDED);
        return;
      case HumanControlKind.MESSAGE:
        if (data.text !== undefined) this.pushMessage(data.text);
        return;
      default:
        return;
    }
  }

  /**
   * Push a lifecycle state to the panel, optionally with human-facing `text` (e.g. an end-of-
   * session summary). Used by the live-control agent tools to sync the presenter on an
   * agent-initiated end/resume. State changes still flow through `setState`; this is the
   * text-carrying push.
   */
  pushPresenter(state: SessionState, text?: string): void {
    this.#post(IrisCommand.PRESENTER, text === undefined ? { state } : { state, text });
  }

  /** Fire-and-forget command send — NOT registered in #pending (no correlated result expected). */
  #post(name: string, args: Record<string, unknown>): void {
    if (this.#socket.readyState !== WS_OPEN) return;
    this.#seq += 1;
    const id = `c${String(this.#seq)}`;
    const payload = JSON.stringify({
      kind: MessageKind.COMMAND,
      id,
      sessionId: this.id,
      name,
      args,
    });
    try {
      this.#socket.send(payload);
    } catch {
      // A closing/closed tab must never break event routing for the session.
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

  /** Every connected session — used by the liveness reaper to sweep for idle/disconnected ones. */
  all(): Session[] {
    return [...this.#sessions.values()];
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
      found.markAgentActivity(); // liveness: any targeted tool keeps the session alive / revives it
      return found;
    }
    if (this.#sessions.size === 0) {
      throw new Error(
        'no browser session connected — is your app running with @syrin/iris-browser enabled?',
      );
    }
    if (this.#sessions.size > 1) {
      const ids = [...this.#sessions.keys()].join(', ');
      throw new Error(`multiple sessions connected (${ids}); pass sessionId to target one`);
    }
    const [only] = this.#sessions.values();
    if (only === undefined) throw new Error('session lookup failed');
    only.markAgentActivity();
    return only;
  }
}
