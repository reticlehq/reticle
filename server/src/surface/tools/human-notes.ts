/**
 * The notes a person sent from the HUD, handed to the agent on whatever Reticle call it makes next.
 *
 * Act tools already splice them (`withControl`); every other tool did not, so a note waited until
 * the agent happened to drive the page or poll `messages`. Taken here, once, from the tab the call
 * is about; a call that names no tab and cannot resolve one takes every tab's, since a note held
 * back is a note the person believes was read.
 */
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { SessionState } from '@reticlehq/core';

export interface HumanNotes {
  state: SessionState;
  guidance: string[];
}

export function takeHumanNotes(
  sessions: SessionManager,
  sessionId: string | undefined,
  session: Session | undefined,
): HumanNotes | undefined {
  let target = session;
  if (target === undefined) {
    try {
      target = sessions.resolve(sessionId);
    } catch {
      target = undefined;
    }
  }
  // ponytail: an unresolvable call takes every tab's notes; per-agent routing is the upgrade if two
  // agents ever share one daemon on different apps and a note lands with the wrong one.
  try {
    const holding = (target === undefined ? (sessions.all?.() ?? []) : [target]).filter(
      (tab) => 0 < tab.inboxSize(),
    );
    const first = holding[0];
    if (first === undefined) return undefined;
    return {
      state: first.getState(),
      guidance: holding.flatMap((tab) => tab.drainInbox().map((message) => message.text)),
    };
  } catch {
    // A courtesy on every call is never the reason a call fails; the notes stay queued.
    return undefined;
  }
}
