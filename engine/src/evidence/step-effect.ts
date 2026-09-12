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
import { buildReactionReport, summarizeReaction } from '../question/reaction.js';
import { findContradictions } from '../disagreement/contradictions.js';

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

export function stepEffect(events: readonly ReticleEvent[], window: StepWindow): StepEffect {
  const effect: StepEffect = {};
  if (window.until > window.since) effect.window = { since: window.since, until: window.until };
  effect.digest = summarizeReaction(buildReactionReport([...events], window.until - window.since));
  // `actionSince` is what tells the detectors which window belongs to THIS action. Without it the
  // headline rule cannot attribute a failed request to the click that moved the screen, and the
  // whole family goes quiet while looking perfectly wired.
  const contradictions = findContradictions(events, { actionSince: window.since });
  if (contradictions.length > 0) effect.contradictions = contradictions;
  return effect;
}
