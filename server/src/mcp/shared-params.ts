/**
 * Parameters that mean the same thing on every tool, documented ONCE instead of every turn.
 *
 * The advertised surface is re-sent on every turn; the MCP `instructions` block is sent once at
 * initialize. Measured on this server: instructions cost 621 tokens total, the surface costs 5,480
 * PER TURN — 87,672 over a 16-turn run. So a byte of prose moved from a parameter description into
 * instructions is roughly 16x cheaper, and nothing is lost, because the text still reaches the model.
 *
 * `sessionId` is the clearest case: identical boilerplate on 16 tools, 2,076 bytes of the surface,
 * re-explained on every turn to say the same thing it said last turn.
 *
 * This is deliberately NOT the `verify` experiment. That one removed the observation tools and
 * measured what it cost: detection held but false alarms tripled, because evidence got expensive.
 * This removes REPETITION, not evidence — every tool stays advertised and every observation stays
 * one call away. Cost goes down; what the model can see does not change.
 *
 * The trade being made, stated: schema prose is expensive but sits adjacent to the call, while
 * instructions are cheap but distant, and a client that drops `instructions` loses this text
 * entirely. So the short forms below still have to be usable on their own — each one names the
 * parameter's PURPOSE, and only the guidance moves.
 */

/** The short form left in the per-turn schema. Must still make sense with no instructions at all. */
export const SHARED_PARAM_SHORT: Readonly<Record<string, string>> = {
  sessionId: 'Target a specific tab. Omit unless you mean one — see instructions.',
  since: 'Cursor from a prior reticle_act/reticle_observe.',
  limit: 'Cap descriptors to the first N.',
};

/** The full text, sent once at initialize. Everything trimmed above is restated here. */
export const SHARED_PARAM_GUIDANCE =
  'Arguments that mean the same thing on every tool: `sessionId` — omit unless you mean a specific ' +
  'tab; Reticle scopes to your project, prefers the active one, and refuses rather than guesses when ' +
  'ambiguous. `since` — a cursor from a prior act/observe, bounding an observation to what came ' +
  'after it. `limit` — caps returned descriptors, cutting tokens on broad queries.';

/** Is this a parameter whose guidance now lives in the instructions block? */
export function isSharedParam(name: string): boolean {
  return Object.hasOwn(SHARED_PARAM_SHORT, name);
}
