/**
 * Two-way testing: one goal, judged by the coding agent and by the Harness, compared.
 *
 * The agent pass answers "does it work?"; the Harness, starting with one sentence and no context,
 * answers "can someone who has never seen it find out how?". The comparison is the product: an agent
 * that proved a goal the Harness could not find is a discoverability finding, not noise and not a
 * defect. Carried on a Harness run's artifact and on the explore tool's answer.
 */
import * as z from 'zod';
import { Verified } from './verified-constants.js';

/** How the two verdicts on one goal compare. */
export const DisparityKind = {
  /** Both proved it: it works, and someone new can find it. */
  FINDABLE: 'findable',
  /** The agent proved it; the Harness searched and could not find it. */
  DISCOVERABILITY: 'discoverability',
  /** The Harness proved what the agent saw fail: look at the agent's assumption. */
  AGENT_ASSUMPTION: 'agent_assumption',
  /** The agent saw it fail and the Harness did not prove it: a defect. */
  DEFECT: 'defect',
} as const;
export type DisparityKind = (typeof DisparityKind)[keyof typeof DisparityKind];

/** Where the Harness looked, at most this many places. */
export const MAX_DISPARITY_SEARCHED = 20;

export const RunDisparitySchema = z.object({
  /** The goal's text, as the journey quoted it. */
  goal: z.string().min(1).max(500),
  kind: z.nativeEnum(DisparityKind),
  /** The coding agent's verdict on a claim naming the goal, in the same app. */
  agent: z.object({ verified: z.nativeEnum(Verified), claim: z.string().max(2000) }),
  /** The Harness's verdict, and the hunt behind it. */
  harness: z.object({
    verified: z.nativeEnum(Verified),
    /** Whether its search found the goal on a page at all. */
    found: z.boolean(),
    /** The places it searched, in order: the path a newcomer would take. */
    searched: z.array(z.string().max(500)).max(MAX_DISPARITY_SEARCHED),
    /** The last place it looked before giving up, when it did. */
    gaveUpAt: z.string().max(500).optional(),
  }),
});
export type RunDisparity = z.infer<typeof RunDisparitySchema>;
