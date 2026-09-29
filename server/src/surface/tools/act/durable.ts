/**
 * `act_and_wait { durable: true }` — after a yes, reload and ask again.
 *
 * Every verdict is scoped to one action's window, so "saved" was proved by the toast that said so,
 * and nothing ever asked whether the thing was still there once the page came back. That is the
 * difference between a UI that advanced and a change that persisted, and it was reachable only by
 * hand: navigate, then a separate assert that nothing tied to the action that caused it.
 *
 * Only the part of `until` that describes the page as it IS can be asked of a fresh document. A
 * request or a signal happened once, in a window that died with the old document; a route is read
 * from route events a reload does not replay. So those clauses are dropped, never re-asserted.
 */

import { z } from 'zod';
import {
  PredicateKind,
  ReticleCommand,
  Verified,
  VerifiedReason,
  type Predicate,
} from '@reticlehq/core';
import type { decideVerified } from '@reticlehq/engine/evidence/verified.js';

type VerifiedVerdict = ReturnType<typeof decideVerified>;
import {
  evaluatePredicate,
  waitForPredicate,
} from '@reticlehq/engine/question/predicate/predicate.js';
import {
  RELOAD_RECONNECT_TIMEOUT_MS,
  waitForReconnect,
} from '@/portal/session/session-reconnect.js';
import type { Session } from '@/portal/session/session.js';

export const durableArg = z
  .boolean()
  .optional()
  .describe(
    'After a yes, reload and require the element/text/state part of `until` to hold again.',
  );

// Loose and undescribed on purpose: the output surface is re-sent every turn. `because` carries
// the answer; this is the detail — { held?, observed?, skipped? }.
export const durableOutput = z.record(z.unknown()).optional();

const RE_READABLE: ReadonlySet<string> = new Set([
  PredicateKind.ELEMENT,
  PredicateKind.TEXT,
  PredicateKind.STATE,
]);

/** The part of a predicate a fresh document can answer, or undefined when there is none. */
export function durablePart(p: Predicate): Predicate | undefined {
  if (PredicateKind.ALL_OF === p.kind) {
    const kept = p.predicates.map(durablePart).filter((c): c is Predicate => c !== undefined);
    if (0 === kept.length) return undefined;
    return 1 === kept.length ? kept[0] : { kind: PredicateKind.ALL_OF, predicates: kept };
  }
  // Narrowing an OR to the branches that survive would change the claim, not re-check it.
  if (PredicateKind.ANY_OF === p.kind)
    return p.predicates.every((c) => durablePart(c) === c) ? p : undefined;
  if (PredicateKind.NOT === p.kind) return durablePart(p.predicate) === p.predicate ? p : undefined;
  return RE_READABLE.has(p.kind) ? p : undefined;
}

/** What the re-check found. `held` absent means the page never came back to be asked. */
export interface Durability {
  held?: boolean;
  observed?: string;
  skipped?: string;
}

/**
 * Apply `durable` to a decided verdict. Pure over `recheck`, which the caller supplies — see
 * reloadAndRecheck for the one that reloads a real page.
 */
export async function withDurability(
  asked: unknown,
  until: Predicate,
  decision: VerifiedVerdict,
  recheck: (part: Predicate) => Promise<Durability>,
): Promise<{ decision: VerifiedVerdict; durable?: Durability }> {
  if (true !== asked || Verified.YES !== decision.verified) return { decision };
  const part = durablePart(until);
  if (part === undefined) {
    const skipped =
      'nothing declared describes the page itself — a request or a signal happens once and cannot be seen again after a reload; add an element, text or state clause';
    return { decision, durable: { skipped } };
  }
  const durable = await recheck(part);
  if (true === durable.held) return { decision, durable };
  if (durable.held === undefined) {
    return {
      durable,
      decision: {
        verified: Verified.UNKNOWN,
        verifiedReason: VerifiedReason.OBSERVATION_LOST,
        because: `the consequence held, but the page did not come back after the reload to be asked again${durable.observed === undefined ? '' : ` (${durable.observed})`}`,
      },
    };
  }
  return {
    durable,
    decision: {
      verified: Verified.NO,
      verifiedReason: VerifiedReason.ASSERTION_FAILED,
      because: `the consequence held, then was gone after a reload — it did not persist${durable.observed === undefined ? '' : ` (observed ${durable.observed})`}`,
    },
  };
}

/** Reload the page, wait for it to re-announce itself, and ask `part` of the fresh document. */
export async function reloadAndRecheck(
  deps: { sessions: { get(id: string): Session | undefined }; now: () => number },
  session: Session,
  part: Predicate,
  timeoutMs: number,
): Promise<Durability> {
  // Same floor navigate { reload } sets: nothing from the old document may answer for the new one.
  session.lastAct.markNavigated(session.elapsed());
  const sent = await session.command(ReticleCommand.REFRESH, { hard: false });
  if (!sent.ok) return { observed: sent.error ?? 'the reload was refused' };
  const back = await waitForReconnect({
    current: () => deps.sessions.get(session.id),
    previous: session,
    timeoutMs: Math.max(timeoutMs, RELOAD_RECONNECT_TIMEOUT_MS),
    now: deps.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const fresh = back ? deps.sessions.get(session.id) : undefined;
  if (fresh === undefined) return {};
  const verdict = await waitForPredicate(fresh, part, timeoutMs, 0);
  return {
    held: true === verdict.pass,
    ...(verdict.observed === undefined ? {} : { observed: verdict.observed }),
  };
}

/**
 * Whether the page-state part of a consequence that held has since gone — an optimistic UI that
 * rolled back. Returns the sentence to fail with, or undefined when it still holds.
 *
 * The wait resolves the instant a predicate holds, and the in-flight wait after it only follows a
 * request to its response. A row that appeared and was removed a tick later, with no failing
 * request to contradict it, was a yes. Only element/text/state clauses are re-read: a request or a
 * signal does not un-happen, and re-reading `settled` on a page that polls would accuse it falsely.
 */
export async function revertedAfterMatch(
  session: Parameters<typeof evaluatePredicate>[0],
  until: Predicate,
  since: number,
  baselines: Parameters<typeof evaluatePredicate>[4],
): Promise<string | undefined> {
  const part = durablePart(until);
  if (part === undefined) return undefined;
  const now = await evaluatePredicate(session, part, since, true, baselines);
  if (true === now.pass || now.inconclusive !== undefined) return undefined;
  return `held, then reverted before the action finished${now.observed === undefined ? '' : ` — now ${now.observed}`}`;
}
