/**
 * The closest surviving control to a role+name anchor that no longer resolves.
 *
 * `runRoleStep` returned `nearest: null` as a literal, so `flow_heal` answered "no nearest match
 * cleared the confidence floor" for every role-anchored drift — which reads as a judgement about
 * candidates when in fact nothing had looked. Reported from a real sweep: a three-step flow failed
 * on `button named 'Menu' did not resolve` and heal called it unhealable, however small the change.
 *
 * What this does NOT do is make role anchors auto-healable, and that restraint is the point. A
 * testid is an identifier a developer put there deliberately; a role name is user-visible text where
 * "Save" and "Save as" are one edit apart. Silently rebinding a step to a similar-looking control is
 * precisely the wrong-element green this product exists to catch. So the bar here is deliberately
 * higher than the testid path's: same role, unambiguous, and genuinely close — otherwise null, and
 * the agent is told to add a testid.
 */
import { editDistance } from './flow-replay.js';

/** Present controls, as role + accessible name. */
export interface RoleCandidate {
  role: string;
  name: string;
}

/**
 * A name must be at least this similar to be worth showing: at most a third of it changed. A looser
 * bar turns "no candidate" into "a confident wrong one", which is worse than saying nothing.
 */
const MAX_CHANGED_FRACTION = 1 / 3;

export function nearestRoleName(
  role: string,
  missing: string,
  present: readonly RoleCandidate[],
): string | null {
  const sameRole = present.filter((candidate) => candidate.role === role);
  if (0 === sameRole.length) return null;
  const budget = Math.floor(missing.length * MAX_CHANGED_FRACTION);
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tied = false;
  for (const candidate of sameRole) {
    const distance = editDistance(missing, candidate.name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate.name;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }
  // A tie is a coin flip between two live controls; naming one would be inventing confidence.
  if (null === best || tied || bestDistance > budget) return null;
  return best;
}
