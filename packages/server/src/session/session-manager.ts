import { NO_SESSION_CONNECTED_ERROR } from '@reticlehq/core';
import {
  declareDrivenRedactionKeys,
  forgetDrivenRedactionKeys,
} from '../input/driven-redaction.js';
import { Session, type SessionInfo } from './session.js';
import { AttachmentHistory } from './attachment-history.js';

/**
 * The agent's active project, used to scope auto-selection. `projectId` is the stable build-stamped
 * identity (authoritative when present); `url` is the app origin, a fallback hint for older SDKs that
 * don't stamp a projectId. Both optional — an empty scope means "no project filter" (legacy behavior).
 */
interface ResolveScope {
  projectId?: string;
  url?: string;
}

/** The scheme://host:port of a URL, or undefined if it can't be parsed. Used to compare origins. */
export function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Narrow a session list to those belonging to the scoped project. With a `projectId` the match is by
 * that stable id (origin ignored — it survives port swaps). With only a `url`, match by origin. With
 * no scope, return the list unchanged (legacy single-/multi-session behavior).
 */
function scopeSessions(sessions: Session[], scope?: ResolveScope): Session[] {
  if (scope === undefined) return sessions;
  if (scope.projectId !== undefined) {
    return sessions.filter((s) => s.projectId === scope.projectId);
  }
  const wantOrigin = originOf(scope.url);
  if (wantOrigin !== undefined) {
    return sessions.filter((s) => originOf(s.url) === wantOrigin);
  }
  return sessions;
}

/**
 * Honest, scoped error when sessions exist but none match the agent's project.
 *
 * The daemon takes its default scope from the `.reticle.json` of whichever directory started it, so
 * attaching from a second project — or another worktree of the SAME project — makes every tool
 * refuse while `reticle_sessions` shows the tab sitting right there. The old message asked "is that
 * app running with @reticlehq/core enabled?", which is the one thing that is definitely true, so the
 * reader goes looking at their app instead of at the scope. Name what IS connected and how to
 * target it: both facts are already in hand here.
 */
function scopeMissError(connected: Session[], scope?: ResolveScope): string {
  const who =
    scope?.projectId !== undefined
      ? `project '${scope.projectId}'`
      : scope?.url !== undefined
        ? `your app at ${scope.url}`
        : 'the active project';
  const listed = connected
    .map((s) => `'${s.projectId ?? 'untagged'}' (${s.url}, sessionId '${s.id}')`)
    .join(', ');
  return (
    `no browser session for ${who}, but ${String(connected.length)} session(s) ARE connected under a ` +
    `different project: ${listed}. The daemon scopes to the .reticle.json of the directory it was ` +
    `started in, so this is a scope mismatch, not a dead app. Pass the sessionId above to target one, ` +
    `or restart the daemon from that app's directory.`
  );
}

/**
 * Owns the set of connected browser sessions and the smart auto-selection that resolves which one a
 * tool targets when the agent omits an explicit sessionId. Extracted from session.ts so each file
 * stays one cohesive unit (Session = one tab; SessionManager = the registry over all tabs).
 */
/** How many bridge-initiated closes to remember for diagnosis. */
const MAX_REMEMBERED_CLOSURES = 5;

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  /**
   * Continuity per session, so a listing can answer "was this attached the whole time".
   *
   * Owned here because this is the one place that sees both halves — every add and every remove.
   */
  readonly #attachment = new AttachmentHistory();
  /**
   * The active project's scope, set once from the daemon's .reticle.json. When a tool resolves a session
   * without passing its own scope, this is applied — so auto-selection is project-scoped by default
   * and a stray tab from another app is never picked, even on the no-sessionId path.
   */
  #defaultScope: ResolveScope | undefined;

  /** Set the active project's default resolve scope (called once at daemon wiring). */
  setDefaultScope(scope: ResolveScope | undefined): void {
    this.#defaultScope = scope;
  }

  add(session: Session): Session | undefined {
    this.#everConnected = true;
    const previous = this.#sessions.get(session.id);
    this.#sessions.set(session.id, session);
    // Publish what this app declared sensitive to the driven-path rule. Here rather than in the
    // bridge because EVERY path that registers a session goes through this method, and a declaration
    // that silently fails to register is a leak nothing would report.
    declareDrivenRedactionKeys(session.id, session.redactKeys);
    this.#attachment.attached(session.id);
    return previous;
  }

  remove(session: Session): boolean {
    if (this.#sessions.get(session.id) !== session) return false;
    session.rejectAll('session disconnected');
    forgetDrivenRedactionKeys(session.id);
    // Recorded, not forgotten: a session that comes back needs its gap measured, and a listing after
    // the reconnect is exactly where that matters.
    this.#attachment.detached(session.id);
    return this.#sessions.delete(session.id);
  }

  get(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => {
      const info = s.info();
      const attachment = this.#attachment.of(s.id);
      return attachment === undefined ? info : { ...info, attachment };
    });
  }

  /** Continuity for one session — "has this been attached the whole time I am reasoning about?" */
  attachmentOf(sessionId: string): ReturnType<AttachmentHistory['of']> {
    return this.#attachment.of(sessionId);
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
   * one connected, returns that.
   *
   * With none and multiple connected, applies smart auto-selection:
   * 1. Prefer non-throttled sessions (not hidden + recently heard from).
   * 2. Within each tier, prefer lowest lastSeenMs (most recently active SDK heartbeat).
   * 3. If two or more non-throttled sessions are within 1 s of each other, throw —
   * genuinely ambiguous, agent must specify sessionId.
   * 4. If ALL sessions are throttled (e.g. user is working in their editor on another
   * desktop), skip the gap check and pick the freshest heartbeat. This lets the agent
   * keep working in the background without requiring sessionId every time.
   */
  /**
   * Why a session recently went away, when the bridge closed it rather than the tab.
   *
   * The bridge enforces a message-rate cap and closes the socket on breach with `1008 message rate
   * exceeded` — a policy violation, so the SDK does not retry. The app keeps running and Reticle is
   * blind from that moment. Measured on the bench app: 2600 requests fired in one tick disconnected
   * the session permanently, and the only trace was a line in the PAGE console, which no agent reads.
   *
   * Without this the agent is told "no browser session connected — check your app is running with
   * @reticlehq/browser enabled", which is precisely wrong: the app IS running and instrumented. It
   * was hung up on. Keeping the last few reasons turns an unexplained disappearance into a fact.
   */
  readonly #recentClosures: { at: number; reason: string }[] = [];

  /**
   * What the daemon knows about WHY nothing is connected, refreshed in the background.
   *
   * Measured: of the sessions that call any tool, half make exactly one call — usually
   * reticle_sessions — and stop, because the answer they get names two things they cannot check and
   * nothing they can do. The daemon can tell "no app is running" from "an app is running and never
   * dialled us" from "one was connected and left", and each has a different fix. Optional so a
   * bridge constructed without a daemon (every unit test) keeps the plain message.
   */
  #noSessionHint: (() => string | undefined) | undefined;

  /** Wire the diagnosis provider (daemon boot). Absent ⇒ the plain, static message. */
  setNoSessionHint(hint: (() => string | undefined) | undefined): void {
    this.#noSessionHint = hint;
  }

  /** Whether any session has connected since this daemon booted — half the diagnosis. */
  #everConnected = false;

  everConnected(): boolean {
    return this.#everConnected;
  }

  /** Record a bridge-initiated close so `resolve` can explain a session that vanished. */
  noteClosure(reason: string, at: number): void {
    this.#recentClosures.push({ at, reason });
    if (this.#recentClosures.length > MAX_REMEMBERED_CLOSURES) this.#recentClosures.shift();
  }

  /** The most recent bridge-initiated close, if any. */
  lastClosure(): { at: number; reason: string } | undefined {
    return this.#recentClosures[this.#recentClosures.length - 1];
  }

  /**
   * A dead `sessionId`, answered with what the caller needs to recover — not with an errand.
   *
   * Telemetry, 2026-08-10: one agent called `reticle_navigate` twelve times against an id that was
   * no longer connected. That single loop is **12 of the 58 tool errors recorded all day, 21%**. The
   * refusal said only `no connected session with id 'x'`, and the recovery hint told it to call
   * `reticle_sessions` and retry — two extra round trips to learn something this method already
   * knows at the moment it refuses. An agent charged two calls to recover will often just repeat the
   * one it made.
   *
   * So: name the live ids inline, and when there are none say that instead, because "retry with a
   * valid one" is advice nobody can act on when no valid one exists.
   */
  #unknownSessionError(sessionId: string): string {
    const live = [...this.#sessions.values()];
    if (0 === live.length) {
      return (
        `no connected session with id '${sessionId}', and no sessions are connected at all — so ` +
        'there is no other id to retry with. The app is not dialling this daemon; call ' +
        'reticle_sessions for the diagnosis rather than retrying this call.'
      );
    }
    const named = live.map((s) => `'${s.id}' (${s.url})`).join(', ');
    return (
      `no connected session with id '${sessionId}'. Connected right now: ${named}. ` +
      'Retry with one of those, or omit sessionId entirely and let Reticle scope to your project.'
    );
  }

  resolve(sessionId?: string, scope?: ResolveScope): Session {
    if (sessionId !== undefined) {
      const found = this.#sessions.get(sessionId);
      if (found === undefined) {
        throw new Error(this.#unknownSessionError(sessionId));
      }
      found.markAgentActivity(); // liveness — a targeted tool keeps the session alive / revives it
      return found;
    }
    if (0 === this.#sessions.size) {
      const closure = this.lastClosure();
      // A diagnosis beats a checklist: it names which of the three causes this actually is.
      const hint = this.#noSessionHint?.();
      if (hint !== undefined && closure === undefined) throw new Error(hint);
      throw new Error(
        closure === undefined
          ? NO_SESSION_CONNECTED_ERROR
          : `${NO_SESSION_CONNECTED_ERROR} NOTE: the bridge closed a session recently — "${closure.reason}". The app is probably still running; it was disconnected, and the SDK does not retry after a policy close. Reload the page to reconnect.`,
      );
    }
    // Scope to the agent's active project FIRST, so a stray tab from another app/origin (e.g. a
    // leftover dashboard on a different port) is structurally unselectable — it never enters the
    // candidate set, no matter how recently it was heard from. This is the anti-cross-talk guard.
    // An explicit per-call scope wins; otherwise the daemon's active-project default applies.
    const effectiveScope = scope ?? this.#defaultScope;
    const connected = [...this.#sessions.values()];
    const all = scopeSessions(connected, effectiveScope);
    if (0 === all.length) {
      // Sessions exist, but none belong to the scoped project — never fall back to a foreign tab.
      // ponytail: still a refusal, deliberately. Auto-targeting the only connected tab would be the
      // friendlier 90% case and would also silently defeat the anti-cross-talk guard this scope
      // exists to be. Naming the tab and its sessionId costs the agent one extra argument.
      throw new Error(scopeMissError(connected, effectiveScope));
    }
    if (1 === all.length) {
      const [only] = all;
      if (only === undefined) throw new Error('session lookup failed');
      only.markAgentActivity();
      return only;
    }

    // Multiple sessions: score each (lower = better candidate for auto-selection).
    // 0 = non-throttled (visible + recently-heard), 1 = throttled (hidden or stale heartbeat).
    const scored = all.map((s) => ({ s, score: s.throttled() ? 1 : 0, ms: s.lastSeenMs() }));
    const bestScore = Math.min(...scored.map((x) => x.score));
    const candidates = scored.filter((x) => x.score === bestScore);

    // Sort candidates by recency (ascending lastSeenMs = most recently active first).
    candidates.sort((a, b) => a.ms - b.ms);
    const [best, runnerUp] = candidates;

    if (best === undefined) throw new Error('session lookup failed');

    // Only auto-select if there is a clear winner.
    //
    // When at least one non-throttled (focused/visible) session exists, require a >1 s recency
    // gap before committing — two tabs that both had recent heartbeats are genuinely ambiguous.
    //
    // When ALL candidates are throttled (e.g. the user switched to their editor on another
    // desktop), the gap requirement is dropped: every session is already in "background" mode
    // so we just pick the one with the freshest heartbeat and let the agent proceed. Requiring
    // a gap here only produces spurious "ambiguous" errors while the user works elsewhere.
    const allThrottled = 1 === bestScore;
    const RECENCY_GAP_MS = allThrottled ? 0 : 1_000;
    const clearWinner = runnerUp === undefined || best.ms + RECENCY_GAP_MS < runnerUp.ms;

    if (!clearWinner) {
      // Ambiguous: list sessions with their health so the agent can choose.
      const detail = all
        .map(
          (s) =>
            `${s.id} (${s.throttled() ? 'throttled' : 'active'}, lastSeenMs=${s.lastSeenMs()})`,
        )
        .join(', ');
      throw new Error(`multiple sessions connected — pass sessionId to target one: ${detail}`);
    }

    best.s.markAgentActivity();
    return best.s;
  }
}
