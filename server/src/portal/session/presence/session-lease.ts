import { SESSION_LEASE } from '@reticlehq/core';
/**
 * The one-time session lease block, returned on the very first agent command of a session.
 *
 * It has to be carried in a RESULT rather than in `reticle_session`'s tool description: that tool is
 * not advertised under the default `hybrid` profile, so its description is never in the agent's
 * context, and the lease is the only place these two calls are ever named. Coding agents read tool
 * results, so this is where the reminder actually lands.
 */
export interface SessionLease {
  sessionId: string;
  opened_at: number;
  IMPORTANT: string;
}

/**
 * Kept SHORT on purpose, and this is the reason to read before editing it.
 *
 * This block is a fixed, identical cost paid by EVERY session. The long-form version was 433 bytes
 * on a `reticle_query` whose actual answer was 259 — 57% of the first call of every session spent
 * re-explaining something that never varies. Measured at 815 → 1058 average observation tokens, and
 * the benchmark's fresh-session-per-scenario shape pays it ten times over.
 *
 * Any edit here is a per-session tax on every user: say it in as few words as still work.
 */
const SESSION_LEASE_NOTICE =
  'When you stop driving, call reticle_session {action:"yield", mode:"waiting"|"ask"}. The panel reads "live" until you do. {action:"end"} only when the task is done: it is final.';

export function buildSessionLease(sessionId: string, openedAt: number): SessionLease {
  return { sessionId, opened_at: openedAt, IMPORTANT: SESSION_LEASE_NOTICE };
}

/** The age warning spliced onto session-bound results after SESSION_LEASE.WARN_AFTER_MS, else undefined. */
export function sessionAgeWarning(sessionId: string, ageMs: number): string | undefined {
  if (ageMs < SESSION_LEASE.WARN_AFTER_MS) return undefined;
  const minutes = Math.floor(ageMs / 60_000);
  return `Session ${sessionId} has been open for ${String(minutes)} minutes. If your task is complete, call reticle_session{action:"end"} now.`;
}
