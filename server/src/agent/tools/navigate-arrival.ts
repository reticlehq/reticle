/**
 * Wait, briefly, for the SDK to reconnect after a navigation — so `confirmed` can mean something.
 *
 * `window.location.assign(url)` destroys the SDK that would report on the new document, so the
 * navigation itself cannot be confirmed from inside the page. But the SDK reconnects TO THE DAEMON,
 * which makes the daemon the only party that can see arrival happen. Before this, it did not look,
 * and told the agent to poll `reticle_sessions` instead — a tool call on every navigation, on the
 * least reliable tool we ship.
 *
 * Bounded and best-effort by construction: a navigation to a page that is not instrumented, or not
 * there at all, must still return promptly with `confirmed:false` rather than hanging. The clock and
 * the sleep are injected so this is testable without waiting on a real one.
 *
 * The bound is the CALLER'S to set. It was a fixed 5s that `reticle_navigate` did not expose, and a
 * Nuxt SPA reattaching under HMR was measured coming back in 30–60s — so every navigation to it
 * answered `confirmed:false` while the app was still on its way, and nothing the agent could pass
 * would make the daemon wait. `assert` / `wait_for` / `act_and_wait` all spend the caller's
 * `timeout_ms` (resolve-within.ts); this is the same budget applied to the same wait.
 */

import type { SessionManager } from '../../connection/session/session-manager.js';
import type { NavigateArrival } from './act/navigate-result.js';

/**
 * The default when the caller gives no `timeout_ms`: long enough for a dev server to serve a page
 * and the SDK to dial back; short enough to not hang. A caller who knows the app is slower says so.
 */
export const ARRIVAL_TIMEOUT_MS = 5_000;
const POLL_MS = 100;

/**
 * Compare only origin + pathname.
 *
 * The app is entitled to add or rewrite the query and hash on arrival — a redirect to
 * `?redirect=%2F`, a router normalising a trailing slash, an auth guard appending a reason. Matching
 * the whole URL string would report `confirmed:false` for a navigation that plainly succeeded, which
 * is the same lie in the opposite direction.
 */
function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}

/**
 * Which session an arrival may be attributed to.
 *
 * Arrival means a session is at the target BECAUSE OF THIS NAVIGATION. The scan had no notion of
 * that: it returned the first session whose page matched, whoever it belonged to. A stale row parked
 * on the origin — in the field report, one belonging to a different app that had previously held the
 * same port — therefore answered for a navigation it had nothing to do with, and `reticle_navigate`
 * reported ITS id as the session the caller had arrived at. Targeting was never wrong; the result
 * was (#785).
 *
 * `sessions.all()` is Map insertion order, so the older stale row is scanned FIRST. That made the
 * wrong id the likely answer rather than a coin flip.
 */
export interface ArrivalScope {
  /**
   * The session the navigation was dispatched to.
   *
   * Exempt from the exclusion below, because it is legitimately at the target both before and after
   * a navigation that keeps the document — a reload, or a same-page route change. Excluding it would
   * report `confirmed: false` for the navigations most likely to have worked.
   */
  navigatedId: string;
  /** Sessions already on the target BEFORE dispatch. They cannot be evidence of this arrival. */
  priorIds: ReadonlySet<string>;
}

/**
 * The sessions already on `target` — the set `ArrivalScope.priorIds` is built from, sampled before
 * the navigation is dispatched.
 *
 * Shares `samePage` with the arrival scan on purpose: "was it already there" and "is it there now"
 * are the same question asked at two moments, and two spellings of it would eventually disagree.
 */
export function idsAtTarget(sessions: SessionManager, target: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const s of sessions.all()) {
    if (samePage(s.url, target)) ids.add(s.id);
  }
  return ids;
}

function findArrival(
  sessions: SessionManager,
  target: string,
  scope: ArrivalScope,
): NavigateArrival | null {
  let arrived: NavigateArrival | null = null;
  for (const s of sessions.all()) {
    if (!samePage(s.url, target)) continue;
    // The tab we drove is the answer whenever it is there, not a tie broken by scan order.
    if (s.id === scope.navigatedId) return { sessionId: s.id };
    if (scope.priorIds.has(s.id)) continue;
    // Keep looking rather than returning: the driven session may still be ahead of us.
    if (null === arrived) arrived = { sessionId: s.id };
  }
  return arrived;
}

export interface ArrivalClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const REAL_CLOCK: ArrivalClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Poll until a session is present at `target`, or the budget runs out. Returns `null` on timeout —
 * never throws, because a failure to confirm is a legitimate answer, not an error.
 */
export async function awaitArrival(
  sessions: SessionManager,
  target: string,
  scope: ArrivalScope,
  timeoutMs: number = ARRIVAL_TIMEOUT_MS,
  clock: ArrivalClock = REAL_CLOCK,
): Promise<NavigateArrival | null> {
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const found = findArrival(sessions, target, scope);
    if (found !== null) return found;
    if (clock.now() >= deadline) return null;
    await clock.sleep(POLL_MS);
  }
}
