import type { SessionManager } from '@/portal/session/session-manager.js';

/**
 * A probe for "is the session these flows drive still there". Followed across reloads: `resolve`
 * answers a departed id with its live successor, so a page that merely reloaded is not "lost".
 */
export function sessionProbe(
  sessions: SessionManager,
  sessionId: string | undefined,
): () => boolean {
  let driven = sessionId;
  return () => {
    try {
      driven = sessions.resolve(driven).id;
      return true;
    } catch {
      return false;
    }
  };
}
