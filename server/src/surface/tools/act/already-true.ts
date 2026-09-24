import type { Predicate } from '@reticlehq/engine/question/predicate/predicate-schema.js';
import { evaluatePredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { readsDomState } from '@reticlehq/engine/evidence/already-true.js';
import { alreadyTrueHiddenMatch as alreadyTrueHiddenMatchOf } from '@reticlehq/engine/evidence/already-true.js';
import type { PredicateSession } from '@reticlehq/engine/question/predicate/predicate-session.js';

/** Everything the pre-action check learned, which is three facts about one reading. */
export interface AlreadyTrueReading {
  /** The consequence held BEFORE the action, so the action proved nothing about it. */
  alreadyTrue: boolean;
  /** That pre-existing match was against something hidden — a stronger reason to doubt the claim. */
  alreadyTrueHiddenMatch: boolean;
  /**
   * WHAT was already true, kept rather than discarded.
   *
   * `already_true` tells an agent its assertion held before it acted; the next question is always
   * "true how?" and it was unanswerable, because the reading decided the bit and was then thrown
   * away. Afterwards the action has run and the state may have moved, so the one moment that
   * mattered is gone. Present only when the answer is yes: a verdict that was genuinely caused
   * carries its own evidence and needs no baseline beside it.
   */
  alreadyTrueEvidence?: unknown;
}

/**
 * Ask whether the declared consequence was already true, once, before the action.
 *
 * Only for predicates that read live DOM state. Event-based ones are floored at this act's cursor
 * and cannot be satisfied by the past, so they need no pre-check and pay nothing. One extra query,
 * on the path where a green is otherwise unfalsifiable.
 *
 * Gathered here rather than as three locals at the call site because they are three readings OF ONE
 * THING, and `act-tools.ts` sits on the 1000-line cohesion cap: the rule says split before adding,
 * and this is the unit that wanted splitting.
 */
export async function readAlreadyTrue(
  session: PredicateSession,
  until: Predicate | undefined,
  since: number,
): Promise<AlreadyTrueReading> {
  const precheck =
    until !== undefined && readsDomState(until)
      ? await evaluatePredicate(session, until, since, false)
      : undefined;
  const alreadyTrue = precheck?.pass ?? false;
  if (!alreadyTrue || until === undefined) {
    return { alreadyTrue: false, alreadyTrueHiddenMatch: false };
  }
  return {
    alreadyTrue: true,
    // The pre-check evidence is already in hand, so asking whether the match was against something
    // hidden costs nothing and lets the message name it (#889).
    alreadyTrueHiddenMatch: alreadyTrueHiddenMatchOf(until, precheck?.evidence),
    ...(precheck?.evidence === undefined ? {} : { alreadyTrueEvidence: precheck.evidence }),
  };
}
