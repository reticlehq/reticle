import type { WebSocket } from 'ws';
import {
  EventType,
  HumanControlDataSchema,
  HumanControlKind,
  HumanMarkDataSchema,
  IrisCommand,
  MessageKind,
  PresenterTone,
  SESSION_HEALTH,
  SESSION_LEASE,
  SESSION_LIFECYCLE,
  SessionState,
  type CommandResult,
  type HelloMessage,
  type HumanControlData,
  type IrisEvent,
} from '@syrin/iris-protocol';
import { RingBuffer } from '../events/ring-buffer.js';
import { ReviewStore, type ReviewMark } from './review-store.js';
import { buildSessionRecommendation } from './session-recommendation.js';
import { buildPresenterArgs } from './presenter-args.js';

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
  stale?: boolean;
  cleanup_suggestion?: string;
  /** present only when the human has flagged bugs on this tab — count of pending review marks. */
  pendingMarks?: number;
  /** present with pendingMarks — nudges the agent to drain them with iris_review. */
  review_suggestion?: string;
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
  /** Human review marks: mistakes the human pinned to elements, for the agent to drain and fix. */
  readonly #review = new ReviewStore();
  /** Whether the session_lease has already been returned (fire-once per session). */
  #firstCommandDone = false;

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
    const base: SessionInfo = {
      sessionId: this.id,
      url: this.url,
      title: this.title,
      adapters: this.adapters,
      hasCapabilities: this.hasCapabilities,
      hidden: this.#hidden,
      ...this.health(),
    };
    if (this.staleMs() > SESSION_LEASE.STALE_AFTER_MS) {
      base.stale = true;
      base.cleanup_suggestion =
        'Call iris_end_session to free this session before starting new work.';
    }
    // Surface human bug reports in iris_sessions (only when > 0, so a clean session adds nothing).
    const marks = this.#review.pendingCount();
    if (marks > 0) {
      base.pendingMarks = marks;
      const s = marks === 1 ? '' : 's';
      base.review_suggestion = `The human flagged ${String(marks)} issue${s} on this tab — call iris_review to see and fix ${marks === 1 ? 'it' : 'them'}.`;
    }
    return base;
  }

  /** Wall-clock age of the session in milliseconds. */
  staleMs(): number {
    return this.#clock() - this.#startedAt;
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
    if (event.type === EventType.HUMAN_MARK) {
      // A human pinned a mistake to an element. Narrow at the boundary; an invalid mark is ignored.
      const parsed = HumanMarkDataSchema.safeParse(event.data);
      if (parsed.success) this.#review.add(parsed.data, this.elapsed());
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
  autoEnd(text?: string, tone: PresenterTone = PresenterTone.WARN): void {
    if (this.#state === SessionState.ENDED) return;
    this.#autoEnded = true;
    this.setState(SessionState.ENDED, text, tone);
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

  /** End this transport without letting a stale socket remove its replacement session. */
  disconnect(reason: string): void {
    this.rejectAll(reason);
    try {
      this.#socket.close(1008, reason);
    } catch {
      // A fake or already-closed socket needs no further cleanup.
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
  setState(next: SessionState, text?: string, tone?: PresenterTone): void {
    this.#state = next;
    this.pushPresenter(this.#state, text, tone);
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

  // ── Human review marks: the "annotate the bug where you see it" inbox (server-owned) ──────────

  /** Human marks still awaiting a fix (oldest first). Reading does not consume — resolveMark() does. */
  pendingMarks(): ReviewMark[] {
    return this.#review.pending();
  }

  /** Full mark history (pending + resolved), oldest first. */
  allMarks(): ReviewMark[] {
    return this.#review.all();
  }

  /** Count of pending marks — surfaced as the panel badge / a session-health hint. */
  pendingMarkCount(): number {
    return this.#review.pendingCount();
  }

  /** Retire a mark the agent fixed. True on a real pending → resolved transition; false otherwise. */
  resolveMark(id: string): boolean {
    return this.#review.resolve(id);
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
   * Push a lifecycle state to the panel with optional human-facing `text`. State changes still flow
   * through `setState`; an auto-ended session rides a `warn` tone so the panel can shout "agent stopped".
   */
  pushPresenter(state: SessionState, text?: string, tone?: PresenterTone): void {
    this.#post(IrisCommand.PRESENTER, buildPresenterArgs(state, text, tone));
  }
  /** Fire-and-forget a narration row to the live panel (so a resolved mark shows "✓ fixed"). */
  pushNarration(text: string): void {
    this.#post(IrisCommand.NARRATE, { text, level: 'info' });
  }

  /**
   * Returns the one-time session lease block on the very first agent command, then undefined
   * forever after. The lease carries an IMPORTANT reminder to call iris_end_session. Coding agents
   * (Claude Code, Codex) read tool results — they will see this and remember to clean up.
   */
  takeSessionLease(): { sessionId: string; opened_at: number; IMPORTANT: string } | undefined {
    if (this.#firstCommandDone) return undefined;
    this.#firstCommandDone = true;
    return {
      sessionId: this.id,
      opened_at: this.#startedAt,
      IMPORTANT:
        'MANDATORY: the moment you stop driving — finishing a reply or waiting on the human — call iris_yield (mode:"waiting", or "ask" with your question) so the panel never falsely reads "live". Call iris_end_session only when the whole task is done. The session revives on your next action.',
    };
  }

  /**
   * Returns a human-readable age warning after SESSION_LEASE.WARN_AFTER_MS (10 min), else undefined.
   * Spliced onto every session-bound tool result so the agent is passively reminded to clean up
   * without needing an explicit polling loop.
   */
  ageWarning(): string | undefined {
    const ageMs = this.#clock() - this.#startedAt;
    if (ageMs < SESSION_LEASE.WARN_AFTER_MS) return undefined;
    const minutes = Math.floor(ageMs / 60_000);
    return `Session ${this.id} has been open for ${String(minutes)} minutes. If your task is complete, call iris_end_session now.`;
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

/**
 * Re-exported from session-manager.ts so the public import path (`./session.js`) is unchanged for
 * the many call sites that resolve a target session. The class lives in its own file to keep both
 * units under the file-size cap.
 */
export { SessionManager } from './session-manager.js';
