import type { z } from 'zod';
import { ReticleTool } from '@reticlehq/core';

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
  since: 'Cursor (a number) from a prior act or observe result.',
  limit: 'Cap descriptors to the first N.',
};

/** The full text, sent once at initialize. Everything trimmed above is restated here. */
export const SHARED_PARAM_GUIDANCE =
  'Arguments that mean the same thing on every tool: `sessionId` — omit unless you mean a specific ' +
  'tab; Reticle scopes to your project, prefers the active one, and refuses rather than guesses when ' +
  'ambiguous. `since` — a cursor from a prior act/observe, bounding an observation to what came ' +
  'after it, or a git ref when verifying a change. `limit` — caps returned descriptors.';

/** A value only a string-typed `since` accepts. */
const GIT_REF_PROBE = 'main';

/**
 * The short form for one parameter, or undefined when it keeps its own text.
 *
 * `since` is a cursor (a number) on every tool but `reticle_verify`, where it is a git ref. That one
 * keeps its own description, so the cursor text never reaches a parameter that takes a ref.
 */
export function sharedParamShort(name: string, schema: z.ZodTypeAny): string | undefined {
  if ('since' === name && schema.safeParse(GIT_REF_PROBE).success) {
    return undefined;
  }
  return SHARED_PARAM_SHORT[name];
}

/** Is this a parameter whose guidance now lives in the instructions block? */
export function isSharedParam(name: string): boolean {
  return Object.hasOwn(SHARED_PARAM_SHORT, name);
}

/**
 * Where to go when a tool refuses a parameter that another tool takes (#1944).
 *
 * An agent proved a click with `reticle_act_and_wait`, saw a request missing from the act's window,
 * and asked for a wider window with `since`. The refusal listed what the tool declares and stopped
 * there, so the agent did not learn that `reticle_assert` reads any window it is given. The refusal
 * now names that tool.
 *
 * A lookup table, keyed by tool and then by the refused parameter. Add a row only where another
 * tool really does what the refused parameter asked for.
 */

const REDIRECTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [ReticleTool.ACT_AND_WAIT]: {
    since:
      `${ReticleTool.ACT_AND_WAIT} always reads the window that its own action opens. To check a ` +
      `window that starts earlier, call ${ReticleTool.ASSERT} { predicate, since } with the cursor ` +
      'from an earlier result.',
  },
};

/** The sentences that name the tool for each refused key, or an empty string. */
export function refusedKeyRedirect(toolName: string, refused: readonly string[]): string {
  const forTool = REDIRECTS[toolName];
  if (forTool === undefined) {
    return '';
  }
  return refused
    .map((key) => (Object.hasOwn(forTool, key) ? forTool[key] : undefined))
    .filter((line): line is string => line !== undefined)
    .map((line) => `${line} `)
    .join('');
}
