import { UNSCRIPTABLE_TAB_RECOMMENDATION } from '@reticle/protocol';

/**
 * The session flags the recommendation is derived from. All already exist on every
 * Session (fed by PAGE_HEALTH events) — no new browser API is needed.
 */
export interface RecommendationInputs {
  hidden: boolean;
  throttled: boolean;
  focused: boolean;
}

/**
 * A human-readable escape-hatch hint when a tab is hidden/throttled and may be
 * un-scriptable/un-focusable from here. Returns undefined for a healthy tab so the field stays
 * ABSENT (not empty). Keys on `hidden || throttled` — the same disjunction as Session.throttled() —
 * so it never disagrees with the `throttled` flag the agent already sees. A merely-unfocused but
 * live tab is still scriptable, so blur alone does not trigger it. Pure.
 */
export function buildSessionRecommendation(inputs: RecommendationInputs): string | undefined {
  if (inputs.hidden || inputs.throttled) return UNSCRIPTABLE_TAB_RECOMMENDATION;
  return undefined;
}
