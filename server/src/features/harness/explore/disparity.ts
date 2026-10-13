/**
 * Two-way testing: the coding agent's verdict on a goal beside the Harness's, compared.
 *
 * The agent knows where everything is; the Harness starts with one sentence. Agent proved and
 * Harness could not find is a discoverability finding (where a newcomer gives up), not noise. Only
 * a DECIDED agent verdict (yes or no) on a claim naming the goal's text is compared: an undecided one
 * says nothing either way, and a claim about something else is not the same goal.
 */
import {
  DisparityKind,
  JournalVerdictEffectSchema,
  MAX_DISPARITY_SEARCHED,
  Verified,
  VerifiedReason,
  type JournalAction,
  type RunDisparity,
} from '@reticlehq/core';
import type { GoalCheck } from '../goals.js';
import type { GoalSearch } from './goal-search.js';

export interface AgentVerdict {
  claim: string;
  verified: Verified;
}

/** The decided verdicts the connected agent itself made: actions no Harness drove. */
export function agentVerdictsIn(actions: readonly JournalAction[]): AgentVerdict[] {
  return actions.flatMap((action) => {
    if (action.drivenBy !== undefined) return [];
    const parsed = JournalVerdictEffectSchema.safeParse(action.effect);
    if (!parsed.success) return [];
    const { claim, verified } = parsed.data;
    return Verified.YES === verified || Verified.NO === verified ? [{ claim, verified }] : [];
  });
}

/** The comparison for one goal, or undefined when the agent made no decided claim about it. */
export function disparityFor(
  check: GoalCheck,
  agent: readonly AgentVerdict[],
  search: GoalSearch | undefined,
): RunDisparity | undefined {
  if (true === check.absent) return undefined;
  const wanted = comparable(check.text);
  const said = agent.filter((v) => claimed(v.claim).includes(wanted)).at(-1);
  if (said === undefined) return undefined;
  // On the page before the drive began: plainly findable, never "hard to find" (persona 22).
  const alreadyShown = true === check.reason?.startsWith(VerifiedReason.ALREADY_TRUE);
  const harnessYes = Verified.YES === check.verified || alreadyShown;
  const agentYes = Verified.YES === said.verified;
  const kind = agentYes
    ? harnessYes
      ? DisparityKind.FINDABLE
      : DisparityKind.DISCOVERABILITY
    : harnessYes
      ? DisparityKind.AGENT_ASSUMPTION
      : DisparityKind.DEFECT;
  const searched = (search?.searched ?? []).slice(-MAX_DISPARITY_SEARCHED);
  return {
    goal: check.text,
    kind,
    agent: said,
    harness: {
      verified: asVerified(check.verified),
      found: alreadyShown || (search?.found ?? harnessYes),
      searched,
      ...(search?.gaveUpAt === undefined ? {} : { gaveUpAt: search.gaveUpAt }),
    },
  };
}

/**
 * Text as two writers of the same words would both put it: no case, no quote marks of any kind, one
 * space. A claim reads `text containing ‘Free shipping threshold’`; the goal is the bare words.
 */
const comparable = (text: string): string =>
  text
    .toLowerCase()
    .replace(/["'“”‘’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * What a claim says IS there: its "the absence of …" clauses claim the opposite, so they are cut.
 * ponytail: a clause ends at `;` or `)`, as `describeWaitTarget` writes them; a goal text holding
 * either inside an absence would keep its tail.
 */
const ABSENCE = /the absence of [^;)]*/g;
const claimed = (claim: string): string => comparable(claim).replace(ABSENCE, '');

const VERIFIED: ReadonlySet<string> = new Set(Object.values(Verified));
const asVerified = (value: string): Verified =>
  VERIFIED.has(value) ? (value as Verified) : Verified.UNKNOWN;
