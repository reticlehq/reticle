/**
 * Where a Back or Forward move arrived (#1844).
 *
 * `awaitArrival` waits for a session at a known target. A history move has no target the caller
 * can name: the entry it lands on belongs to the browser. So this waits for the navigated tab to be
 * SOMEWHERE ELSE, and reports where that is. There are two ways a tab shows it moved:
 *
 * - The same document moved. An SPA's popstate fires `route.change`, and the session updates its
 *   `url` from it. The session is the same object and its document id does not change.
 * - A new document connected for the same tab: under the same id with a different document id, or
 *   under a new id after the old document left the registry.
 *
 * A newcomer is never named while the navigated document is still connected and has not moved. A
 * second tab can connect during the wait, and nothing ties it to this move. On the URL path the
 * target is that tie; here there is none, so the old document leaving is the tie instead.
 */

import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { claimedSessionOf } from '../../../../portal/session/session-successor.js';
import {
  ARRIVAL_POLL_MS,
  REAL_ARRIVAL_CLOCK,
  type ArrivalClock,
  type ArrivalScope,
} from './navigate-arrival.js';

/** What a history move knew at dispatch. The same facts a URL navigation samples. */
export type HistoryScope = ArrivalScope;

/** The tab after the move: the session that reports for it now, and the URL it is on. */
export interface HistoryArrival {
  sessionId: string;
  url: string;
  /**
   * True when two looks in a row saw the tab at the same place. False when the budget ended while
   * it was still moving: `url` is then where it was last seen, which is not proof it stopped there.
   */
  settled: boolean;
}

/** One look at where the tab is. The document id is part of "the same place". */
interface Seen {
  sessionId: string;
  url: string;
  documentId: string | undefined;
}

function samePlace(a: Seen, b: Seen): boolean {
  return a.sessionId === b.sessionId && a.url === b.url && a.documentId === b.documentId;
}

function seen(s: Session): Seen {
  return { sessionId: s.id, url: s.url, documentId: s.currentDocumentId };
}

/**
 * Whether `current` reports a different document from the one the move was dispatched on. Either
 * side without a document id is "cannot tell", which is never read as a move.
 */
function documentChanged(scope: HistoryScope, current: Session): boolean {
  const before = scope.navigatedFromDocumentId;
  const after = current.currentDocumentId;
  return before !== undefined && after !== undefined && before !== after;
}

function lookForMove(snapshot: readonly Session[], scope: HistoryScope): Seen | null {
  const navigated = snapshot.find((s) => s.id === scope.navigatedSession.id);
  if (navigated !== undefined) {
    if (documentChanged(scope, navigated) || navigated.url !== scope.navigatedFrom) {
      return seen(navigated);
    }
    // Still connected and still where it was: the move has not shown yet.
    return null;
  }
  const identity = claimedSessionOf(scope.navigatedFrom);
  for (const s of snapshot) {
    // Connected at dispatch: another tab, not this tab's new document.
    if (scope.priorIds.has(s.id)) {
      continue;
    }
    // A tab that claims another identity (a lease) is another tab.
    if (claimedSessionOf(s.url) !== identity) {
      continue;
    }
    return seen(s);
  }
  return null;
}

function arrival(at: Seen, settled: boolean): HistoryArrival {
  return { sessionId: at.sessionId, url: at.url, settled };
}

/**
 * Poll until the navigated tab is somewhere else AND has stopped there, or the budget runs out.
 *
 * The first move seen is not the answer. Back to a guarded route reports the route, then the
 * guard's `replaceState` to the sign-in page: answering on the first look reported a page the tab
 * only passed through, as confirmed. So a place counts once two looks in a row agree on it.
 *
 * Returns `null` when the tab never moved, and never throws: a move nobody saw is an answer, not
 * an error. A tab still moving when the budget ends is reported where it was last seen, with
 * `settled:false`.
 */
export async function awaitHistoryArrival(
  sessions: SessionManager,
  scope: HistoryScope,
  timeoutMs: number,
  clock: ArrivalClock = REAL_ARRIVAL_CLOCK,
): Promise<HistoryArrival | null> {
  const deadline = clock.now() + timeoutMs;
  let previous: Seen | null = null;
  for (;;) {
    const found = lookForMove(sessions.all(), scope);
    if (found !== null && previous !== null && samePlace(found, previous)) {
      return arrival(found, true);
    }
    previous = found;
    if (clock.now() >= deadline) {
      return null === previous ? null : arrival(previous, false);
    }
    await clock.sleep(ARRIVAL_POLL_MS);
  }
}
