/**
 * User-defined verification criteria — with no new mechanism.
 *
 * "Verify my SEO" looks like it wants a plugin API. It does not. A criterion is a document of
 * actions and declared consequences over declared channels, which is exactly what a flow already is,
 * so the extensibility comes from the LANGUAGE being general rather than from a new extension point
 * per use case. A plugin API per use case is how a verification tool acquires an SEO plugin, an a11y
 * plugin and a performance plugin that each invent their own idea of what "passed" means — and then
 * no two of its verdicts are comparable.
 *
 * The consequence worth having is that criteria TYPECHECK like anything else: a rule reading a
 * channel the realm does not observe is refused before it runs, rather than quietly reporting a pass
 * it could never have failed.
 */

import type { ChannelId } from '../vocabulary/channel.js';
import type { ProgramStep } from './typecheck.js';

/** One thing a user wants to be true, in the same terms the protocol already speaks. */
export interface Criterion {
  /** How the result is addressed. Unique within a set. */
  name: string;
  /** What the realm must be able to DO to check it — usually a read. */
  capability: string;
  /** Which channels answering it requires. This is what makes a criterion refusable up front. */
  reads: readonly ChannelId[];
}

/** A criteria set is a program. That is the whole claim of this file. */
export function criteriaToProgram(criteria: readonly Criterion[]): ProgramStep[] {
  return criteria.map((c) => ({ capability: c.capability, reads: c.reads }));
}

export interface CriteriaVerdict {
  verdict: 'yes' | 'no' | 'unknown';
  passed: readonly string[];
  failed: readonly string[];
  /** Named, never subtracted: a criterion nothing answered is the thing a reader most needs. */
  unchecked: readonly string[];
}

/**
 * Fold observed results into one verdict that carries its own coverage.
 *
 * Two rules, and both are the protocol's rather than this file's:
 *
 * SILENCE IS NOT A GREEN. A criterion nothing answered is `unchecked`, and any unchecked criterion
 * makes the whole verdict `unknown`. A set that quietly reports "yes" for the criteria it happened to
 * evaluate is the vacuous pass this project exists to catch, wearing a user's own vocabulary.
 *
 * A FAILURE OUTRANKS A GAP. A known break is worse news than a missing answer, so one `false` makes
 * the verdict `no` even when other criteria went unchecked — there is no need to resolve the gap to
 * know the answer is already not "yes".
 */
export function gradeCriteria(
  criteria: readonly Criterion[],
  observed: Readonly<Record<string, boolean>>,
): CriteriaVerdict {
  const passed: string[] = [];
  const failed: string[] = [];
  const unchecked: string[] = [];
  for (const c of criteria) {
    const result = observed[c.name];
    if (result === undefined) unchecked.push(c.name);
    else if (result) passed.push(c.name);
    else failed.push(c.name);
  }
  const verdict = failed.length > 0 ? 'no' : unchecked.length > 0 ? 'unknown' : 'yes';
  return { verdict, passed, failed, unchecked };
}
