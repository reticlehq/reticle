import type { Predicate } from '@reticlehq/engine/question/predicate/predicate-schema.js';
import { evaluatePredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { readsDomState } from '@reticlehq/engine/evidence/already-true.js';
import { alreadyTrueHiddenMatch as alreadyTrueHiddenMatchOf } from '@reticlehq/engine/evidence/already-true.js';
import type { PredicateSession } from '@reticlehq/engine/question/predicate/predicate-session.js';
import { captureBaselines } from '@reticlehq/engine/evidence/baseline.js';
import type { Baselines } from '@reticlehq/engine/question/predicate/predicate.js';

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
  /**
   * What each comparing leaf was reading BEFORE the action — the predicate language's past tense.
   *
   * Taken here because this is already the one place that looks at the app before it is touched,
   * and a second pre-action pass would be a second round trip for a reading we are standing next
   * to. Empty unless the caller actually asked for a comparison, so nothing pays for it.
   */
  baselines: Baselines;
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
  // Before the pre-check, because the pre-check EVALUATES the predicate and a relative leaf with no
  // baseline yet would report `inconclusive` — reading the app twice to answer a question we had
  // not taken the reading for.
  const baselines = await captureBaselines(session, until);
  const precheck =
    until !== undefined && readsDomState(until)
      ? await evaluatePredicate(session, until, since, false, baselines)
      : undefined;
  const alreadyTrue = precheck?.pass ?? false;
  if (!alreadyTrue || until === undefined) {
    return { alreadyTrue: false, alreadyTrueHiddenMatch: false, baselines };
  }
  return {
    alreadyTrue: true,
    baselines,
    // The pre-check evidence is already in hand, so asking whether the match was against something
    // hidden costs nothing and lets the message name it (#889).
    alreadyTrueHiddenMatch: alreadyTrueHiddenMatchOf(until, precheck?.evidence),
    ...(precheck?.evidence === undefined ? {} : { alreadyTrueEvidence: precheck.evidence }),
  };
}
