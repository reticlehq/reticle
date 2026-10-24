/**
 * What one action did, from the window it opened — built once, for every path that needs it.
 *
 * A driven step and a replayed step have to describe what happened in the SAME words. They did not:
 * the live act path returned a reaction digest and contradictions, while replay returned a prose
 * sentence, so the same click described twice read as two different events. That makes the
 * before/after comparison this product exists for impossible to do, and it is the shape of drift
 * that this repo keeps finding after it has shipped.
 *
 * Pure: events and a window in, a record out. No session, no clock, no IO — which is what lets the
 * live path and the replay path share it instead of agreeing by coincidence.
 */

import type { Contradiction, ReactionDigest, ReticleEvent } from '@reticlehq/core';
import { buildReactionReport, summarizeReaction } from '@/question/reaction.js';
import { findContradictions } from '@/disagreement/contradictions.js';
import { declaredExpectations } from '@/question/declared.js';
import type { Predicate } from '@/question/predicate/predicate-eval.js';

/** The cursor pair an observer can re-read this step's evidence with. */
export interface StepWindow {
  since: number;
  until: number;
}

export interface StepEffect {
  /**
   * The drill address. `reticle_observe { since, until }` returns exactly this span, so a step that
   * carries it can be asked about later without re-driving anything.
   *
   * Bounded on BOTH ends: a `since` alone returns everything from that point to now, which on a long
   * journey would hand step two the whole tail and invite a reader to blame one click for it.
   *
   * Omitted where the clock never advanced. `{since: 7, until: 7}` reads as "this step caused
   * nothing" when it means "nothing here measures time".
   */
  window?: StepWindow;
  /** What the app did, as counts. The timeline is the expensive half and stays addressable instead. */
  digest?: ReactionDigest;
  /**
   * Channels that disagree about this action — present whether or not the step passed.
   *
   * The detectors run independently of the assertion, so a green step carrying one of these is a
   * finding. Omitted when they agree rather than sent empty: its presence is the signal.
   */
  contradictions?: Contradiction[];
}

/** The page origin and declared background, omitted when the caller cannot say. Absence fails open. */
export function appScope(session: { url?: string; background?: readonly string[] }): {
  appOrigin?: string;
  background?: readonly string[];
} {
  return {
    ...(session.url === undefined ? {} : { appOrigin: session.url }),
    ...(session.background === undefined ? {} : { background: session.background }),
  };
}

export function stepEffect(
  events: readonly ReticleEvent[],
  window: StepWindow,
  /** The page under test, so a third-party write is not graded as the app ignoring a response. */
  scope: {
    appOrigin?: string;
    background?: readonly string[];
    /**
     * What the step said it would cause. A failure it declared is not a contradiction, the same
     * rule `act_and_wait` applies to its `until`. Omitted when the step declared nothing.
     */
    declared?: readonly Predicate[];
  } = {},
): StepEffect {
  const effect: StepEffect = {};
  if (window.until > window.since) effect.window = { since: window.since, until: window.until };
  effect.digest = summarizeReaction(buildReactionReport([...events], window.until - window.since));
  // `actionSince` is what tells the detectors which window belongs to THIS action. Without it the
  // headline rule cannot attribute a failed request to the click that moved the screen, and the
  // whole family goes quiet while looking perfectly wired.
  const contradictions = findContradictions(events, {
    actionSince: window.since,
    ...(scope.appOrigin === undefined ? {} : { appOrigin: scope.appOrigin }),
    ...(scope.background === undefined ? {} : { background: scope.background }),
    ...declaredOptions(scope.declared),
  });
  if (contradictions.length > 0) effect.contradictions = contradictions;
  return effect;
}

/** The contradiction options a step's own expectations give, merged over every one it declared. */
function declaredOptions(declared: readonly Predicate[] | undefined): {
  expectedFailures?: ReturnType<typeof declaredExpectations>['netFailures'];
  namedNetUrls?: readonly string[];
  repeatableNetUrls?: ReturnType<typeof declaredExpectations>['repeatableNetUrls'];
} {
  // Nothing declared names no traffic: an empty `namedNetUrls` would hide every duplicate request.
  if (declared === undefined || 0 === declared.length) {
    return {};
  }
  const each = declared.map(declaredExpectations);
  return {
    expectedFailures: each.flatMap((d) => d.netFailures),
    namedNetUrls: each.flatMap((d) => d.netUrls),
    repeatableNetUrls: each.flatMap((d) => d.repeatableNetUrls),
  };
}
