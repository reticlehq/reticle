import type { ImpactCounts, ImpactSavings } from './impact.js';

/**
 * The savings model: one file, so every claim Reticle makes about its own worth is derivable here
 * and nowhere else.
 *
 * A saving is a counterfactual - a comparison against a run that did not happen - so each constant
 * below carries the run it stands for. Change a number here and the claim changes everywhere; there
 * is deliberately no second place to tune one.
 */

/**
 * Tokens an agent spends to LOOK at an app it cannot see from the inside: a screenshot into
 * context, plus the prose it writes reasoning about the pixels. Screenshots dominate - an image
 * costs on the order of a thousand tokens before anything is understood from it.
 *
 * Reticle's answer to the same question is a semantic snapshot, and what that cost is not modelled:
 * it is COUNTED, per call, and subtracted below.
 */
const TOKENS_PER_SCREENSHOT_LOOK = 1600;

/**
 * Minutes a false green costs when it escapes: the agent reports done, a person tries it, finds it
 * broken, writes the correction, and the agent goes round again. Deliberately conservative - one
 * short cycle, not the afternoon a shipped regression can take.
 */
const MINUTES_PER_REPROMPT_CYCLE = 4;

/** What the two numbers are measured against, shown beside them in the report. */
export const IMPACT_BASIS = {
  TOKENS: 'vs an agent reading the app through screenshots',
  MINUTES: 'vs one re-prompt cycle per defect caught',
} as const;

/**
 * Estimate what the recorded work saved.
 *
 * Tokens: every verdict-bearing call replaced a look the agent would otherwise have taken as a
 * screenshot. The tokens Reticle actually returned are subtracted, so the figure is a NET saving
 * and can never exceed the modelled cost of the runs it replaced.
 *
 * Minutes: only DEFECTS count. A pass saves nothing by itself - the run was going to pass either
 * way; what a false green costs is the round trip, and that is what catching it returns.
 */
export function estimateImpactSavings(counts: ImpactCounts): ImpactSavings {
  const looksReplaced = counts.verdicts;
  const grossTokens = looksReplaced * TOKENS_PER_SCREENSHOT_LOOK;
  const netTokens = Math.max(0, grossTokens - counts.tokensReturned);
  return {
    tokens: { value: netTokens, basis: IMPACT_BASIS.TOKENS },
    minutes: { value: counts.failed * MINUTES_PER_REPROMPT_CYCLE, basis: IMPACT_BASIS.MINUTES },
  };
}
