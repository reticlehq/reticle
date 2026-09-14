import {
  PresenterTone,
  SESSION_LEASE,
  SESSION_LIFECYCLE,
  UNDELIVERED_NOTES_LABEL,
} from '@reticlehq/core';
import type { Session, SessionManager } from './session.js';
import { log } from '../log.js';

/**
 * Server-authoritative session liveness. The browser idle timer is throttled in a backgrounded tab
 * and dies with the bridge if the agent (MCP client) is killed — so the Node server, which is immune
 * to throttling, owns the decision. The reaper ends a session whose AGENT has gone quiet past its
 * idle window; the end is pushed to the browser as a PRESENTER command, which a throttled tab still
 * receives. A returning agent revives an auto-ended session (see Session.markAgentActivity).
 */

/**
 * Human-facing summary shown in the HUD when the MCP client (the agent) disconnects. Agent-neutral:
 * Reticle runs under any agent (Codex/OpenCode/Claude/Hermes), so the copy never names one.
 */
export const MCP_DISCONNECT_SUMMARY = 'Session ended — the agent disconnected.';

/** Shown when the agent goes quiet between turns and the session is handed back to the human (WAITING). */
const IDLE_WAITING_SUMMARY = 'Agent idle — your turn. Continue in your terminal.';

/**
 * Fold any unread human notes into the end-of-session notice. Pure. A prompt typed into the panel in
 * the death-race — the agent stops before draining its inbox — would otherwise vanish silently; here
 * it rides the end banner so the human can copy it into their terminal. No notes → the base unchanged.
 */
export function composeEndedNotice(base: string, undelivered: string[]): string {
  if (0 === undelivered.length) return base;
  const notes = undelivered.map((text) => `"${text}"`).join(', ');
  return `${base} · ${UNDELIVERED_NOTES_LABEL} ${notes}`;
}

/**
 * End a session, surfacing any unread human notes in its end notice instead of dropping them. `tone`
 * tells the panel how to present it: WAITING (agent went quiet) vs WARN (agent crashed/disconnected).
 */
function endWithUndelivered(session: Session, base: string, tone: PresenterTone): void {
  const undelivered = session.drainInbox().map((m) => m.text);
  session.autoEnd(composeEndedNotice(base, undelivered), tone);
}

/**
 * Hand back every session whose agent has gone quiet past its window — shown as WAITING (your turn),
 * not a crash, since the agent is still connected and revives on its next action. Returns the ids.
 */
export function reapIdleSessions(sessions: SessionManager): string[] {
  const ended: string[] = [];
  for (const session of sessions.all()) {
    if (session.isEnded()) continue;
    if (session.agentIdleMs() >= session.idleEndMs()) {
      endWithUndelivered(session, IDLE_WAITING_SUMMARY, PresenterTone.WAITING);
      ended.push(session.id);
    }
  }
  if (ended.length > 0) log('session_reaped_idle', { sessions: ended });
  return ended;
}

/**
 * Drop sessions that have ENDED and gone quiet, so a listing stops offering them.
 *
 * `reticle_session { action: "end" }` sets state and nothing else -- it never calls
 * `sessions.remove`. `SessionManager.list()` does not filter by state, and `reapIdleSessions`
 * above skips ended sessions by design. The only code path in the whole server that removes a
 * session is the socket `close` handler in bridge.ts. So an ended session whose socket is already
 * gone has nothing left that can remove it, and the row is listed for the life of the daemon
 * (#938).
 *
 * That is what the field report describes: `{ ended: true }` three times, the row back on the next
 * `reticle_sessions` call each time, still there after every tab on the origin was closed, 17 hours
 * attached. And Reticle's own advice for a stale session is
 * `Call reticle_session{action:"end"} to free this session` -- which is the one thing that does not
 * free it.
 *
 * Deliberately NOT "remove on end". The panel is client-side, so `setState` has already pushed the
 * ended state to the browser and the HUD keeps it; but `end` is documented idempotent, and removing
 * immediately would make a second call fail to resolve. Waiting for the session to go quiet keeps
 * that, keeps a just-ended session inspectable, and still collects the case that actually hurts: a
 * row nobody can get rid of.
 */
export function reapEndedSessions(
  sessions: SessionManager,
  staleAfterMs: number = SESSION_LEASE.STALE_AFTER_MS,
): string[] {
  const dropped: string[] = [];
  // Snapshot first: `remove` mutates the map this iterates.
  for (const session of [...sessions.all()]) {
    if (!session.isEnded()) continue;
    if (session.staleMs() < staleAfterMs) continue;
    if (sessions.remove(session)) dropped.push(session.id);
  }
  if (dropped.length > 0) log('session_reaped_ended', { sessions: dropped });
  return dropped;
}

/** End every active session immediately (the agent / MCP client disconnected → WARN). Returns ended ids. */
export function endAllSessions(sessions: SessionManager, reason: string): string[] {
  const ended: string[] = [];
  for (const session of sessions.all()) {
    if (session.isEnded()) continue;
    endWithUndelivered(session, reason, PresenterTone.WARN);
    ended.push(session.id);
  }
  if (ended.length > 0) log('sessions_ended', { reason, sessions: ended });
  return ended;
}

/**
 * Runs {@link reapIdleSessions} on a Node interval. The timer is `unref`'d so it never keeps the
 * process alive on its own, and `start` is idempotent.
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
      // Second rule, same sweep, kept as its own function: one ends a live session that went
      // quiet, the other collects one that already ended. Merging them would put "end this" and
      // "forget this" behind a single condition.
      reapEndedSessions(this.#sessions);
    }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
