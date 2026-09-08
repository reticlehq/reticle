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

/**
 * Minutes a person spends confirming ONE consequence by hand: open the page, do the thing, look.
 *
 * This is the constant the model was missing, and its absence is why users reported spending more
 * time in Reticle than it claimed to give back. The old reasoning was written down and was wrong -
 * "a pass saves nothing by itself, the run was going to pass either way". The counterfactual is not
 * "it passes anyway"; it is "somebody checks it by hand, or nobody checks it and a false green
 * ships". A PROVEN pass replaces that check, and replacing it is the product.
 *
 * Counting only defects also inverted the incentive: the healthier the app, the less value Reticle
 * appeared to deliver, when a healthy app being verified is the success case.
 *
 * Thirty seconds, and deliberately at the low end of what a manual check costs - a number nobody
 * argues with is worth more than a flattering one. TUNE HERE: this is the single place the claim
 * lives, and one line changes it everywhere.
 */
const MINUTES_PER_MANUAL_CHECK = 0.5;

/** What the two numbers are measured against, shown beside them in the report. */
export const IMPACT_BASIS = {
  TOKENS: 'vs an agent reading the app through screenshots',
  MINUTES: 'vs checking each consequence by hand, plus one re-prompt cycle per defect caught',
} as const;

/**
 * Estimate what the recorded work saved.
 *
 * Tokens: every verdict-bearing call replaced a look the agent would otherwise have taken as a
 * screenshot. The tokens Reticle actually returned are subtracted, so the figure is a NET saving
 * and can never exceed the modelled cost of the runs it replaced.
 *
 * Minutes: two different counterfactuals, summed. EVERY verdict replaces a check somebody would
 * otherwise have made by hand. A verdict that also caught a DEFECT saves the re-prompt round trip on
 * top, because that is what a false green costs when it escapes.
 *
 * Decomposed rather than blended so the basis line can name both, and so changing the value of a
 * pass never silently changes the value of a catch.
 */
export function estimateImpactSavings(counts: ImpactCounts): ImpactSavings {
  const looksReplaced = counts.verdicts;
  const grossTokens = looksReplaced * TOKENS_PER_SCREENSHOT_LOOK;
  const netTokens = Math.max(0, grossTokens - counts.tokensReturned);
  const checksReplaced = counts.verdicts * MINUTES_PER_MANUAL_CHECK;
  const roundTripsAvoided = counts.failed * MINUTES_PER_REPROMPT_CYCLE;
  return {
    tokens: { value: netTokens, basis: IMPACT_BASIS.TOKENS },
    minutes: { value: checksReplaced + roundTripsAvoided, basis: IMPACT_BASIS.MINUTES },
  };
}
