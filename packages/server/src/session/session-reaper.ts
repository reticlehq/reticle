import { SESSION_LIFECYCLE } from '@syrin/iris-protocol';
import type { SessionManager } from './session.js';
import { log } from '../log.js';

/**
 * Server-authoritative session liveness. The browser idle timer is throttled in a backgrounded tab
 * and dies with the bridge if the agent (MCP client) is killed — so the Node server, which is immune
 * to throttling, owns the decision. The reaper ends a session whose AGENT has gone quiet past its
 * idle window; the end is pushed to the browser as a PRESENTER command, which a throttled tab still
 * receives. A returning agent revives an auto-ended session (see Session.markAgentActivity).
 */

/** Human-facing summary shown in the HUD when the MCP client (the agent) disconnects. */
export const MCP_DISCONNECT_SUMMARY = 'Session ended — the Iris agent (Claude) disconnected.';

/** Human-facing summary shown in the HUD when the reaper ends a session. */
function idleEndSummary(idleMs: number): string {
  const mins = Math.round(idleMs / 60_000);
  const window = mins >= 1 ? `${String(mins)} min` : `${String(Math.round(idleMs / 1000))}s`;
  return `Session ended automatically — no agent activity for ${window}.`;
}

/** End every active session whose agent has been idle past its window. Returns the ended ids. */
export function reapIdleSessions(sessions: SessionManager): string[] {
  const ended: string[] = [];
  for (const session of sessions.all()) {
    if (session.isEnded()) continue;
    const idle = session.agentIdleMs();
    if (idle >= session.idleEndMs()) {
      session.autoEnd(idleEndSummary(idle));
      ended.push(session.id);
    }
  }
  if (ended.length > 0) log('session_reaped_idle', { sessions: ended });
  return ended;
}

/** End every active session immediately (the agent / MCP client disconnected). Returns ended ids. */
export function endAllSessions(sessions: SessionManager, reason: string): string[] {
  const ended: string[] = [];
  for (const session of sessions.all()) {
    if (session.isEnded()) continue;
    session.autoEnd(reason);
    ended.push(session.id);
  }
  if (ended.length > 0) log('sessions_ended', { reason, sessions: ended });
  return ended;
}

/**
 * Runs {@link reapIdleSessions} on a Node interval. The timer is `unref`'d so it never keeps the
 * process alive on its own, and `start()` is idempotent.
 */
export class SessionReaper {
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #sessions: SessionManager;
  readonly #intervalMs: number;

  constructor(sessions: SessionManager, intervalMs: number = SESSION_LIFECYCLE.REAP_INTERVAL_MS) {
    this.#sessions = sessions;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      reapIdleSessions(this.#sessions);
    }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
