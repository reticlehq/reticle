import { NO_SESSION_CONNECTED_ERROR } from '@reticlehq/core';
import { Session, type SessionInfo } from './session.js';

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
function originOf(url: string | undefined): string | undefined {
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

/** Honest, scoped error when sessions exist but none match the agent's project. */
function scopeMissError(scope?: ResolveScope): string {
  const who =
    scope?.projectId !== undefined
      ? `project '${scope.projectId}'`
      : scope?.url !== undefined
        ? `your app at ${scope.url}`
        : 'the active project';
  return `no browser session for ${who} — is that app running with @reticlehq/core enabled? (other apps may be connected, but they won't be driven by mistake)`;
}

/**
 * Owns the set of connected browser sessions and the smart auto-selection that resolves which one a
 * tool targets when the agent omits an explicit sessionId. Extracted from session.ts so each file
 * stays one cohesive unit (Session = one tab; SessionManager = the registry over all tabs).
 */
export class SessionManager {
  readonly #sessions = new Map<string, Session>();
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
    const previous = this.#sessions.get(session.id);
    this.#sessions.set(session.id, session);
    return previous;
  }

  remove(session: Session): boolean {
    if (this.#sessions.get(session.id) !== session) return false;
    session.rejectAll('session disconnected');
    return this.#sessions.delete(session.id);
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
   * one connected, returns that.
   *
   * With none and multiple connected, applies smart auto-selection:
   *   1. Prefer non-throttled sessions (not hidden + recently heard from).
   *   2. Within each tier, prefer lowest lastSeenMs (most recently active SDK heartbeat).
   *   3. If two or more non-throttled sessions are within 1 s of each other, throw —
   *      genuinely ambiguous, agent must specify sessionId.
   *   4. If ALL sessions are throttled (e.g. user is working in their editor on another
   *      desktop), skip the gap check and pick the freshest heartbeat. This lets the agent
   *      keep working in the background without requiring sessionId every time.
   */
  resolve(sessionId?: string, scope?: ResolveScope): Session {
    if (sessionId !== undefined) {
      const found = this.#sessions.get(sessionId);
      if (found === undefined) {
        throw new Error(`no connected session with id '${sessionId}'`);
      }
      found.markAgentActivity(); // liveness — a targeted tool keeps the session alive / revives it
      return found;
    }
    if (this.#sessions.size === 0) {
      throw new Error(NO_SESSION_CONNECTED_ERROR);
    }
    // Scope to the agent's active project FIRST, so a stray tab from another app/origin (e.g. a
    // leftover dashboard on a different port) is structurally unselectable — it never enters the
    // candidate set, no matter how recently it was heard from. This is the anti-cross-talk guard.
    // An explicit per-call scope wins; otherwise the daemon's active-project default applies.
    const effectiveScope = scope ?? this.#defaultScope;
    const all = scopeSessions([...this.#sessions.values()], effectiveScope);
    if (all.length === 0) {
      // Sessions exist, but none belong to the scoped project — never fall back to a foreign tab.
      throw new Error(scopeMissError(effectiveScope));
    }
    if (all.length === 1) {
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
    const allThrottled = bestScore === 1;
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
