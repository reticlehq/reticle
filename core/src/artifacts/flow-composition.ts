import type { FlowFile } from './flow-types.js';
import type { Predicate } from '@/verdict/predicate.js';

/**
 * Whether one flow may be replayed straight after another.
 *
 * Replaying journeys back to back only works when the state one leaves is the state the next
 * expects. Two flows that each pass alone can fail composed, and the reverse, and the red looks
 * like a regression — the most expensive kind, because it sends somebody to read product code that
 * is fine.
 *
 * It answers over DECLARATIONS, not over a running app: a pure comparison of what B says it needs
 * against what A says it leaves, so it can be asked before either flow runs.
 *
 * SILENCE IS PERMISSIVE. A flow that declares neither `requires` nor `ensures` says nothing, and
 * unknown means unchecked rather than unsafe; `unmet` names the claims that could not be
 * discharged, so the answer is never a bare boolean.
 *
 * NOT ENFORCED AT REPLAY TIME. An unmet precondition reported as a step result would read as a
 * FAILURE — `FlowStepResult` has `ok: boolean` and no third state — and honestly it is `unknown`:
 * nothing ran, so nothing was proved.
 */
export interface CompositionCheck {
  /** True when nothing B requires is left undischarged by A. Vacuously true when either is silent. */
  readonly ok: boolean;
  /** The claims B requires that A does not ensure. Empty when `ok`. */
  readonly unmet: readonly Predicate[];
  /** True when neither flow declared anything, so the answer is "unchecked" rather than "safe". */
  readonly unchecked: boolean;
}

/**
 * Compared by VALUE, because a precondition is a claim and two claims are the same claim when they
 * say the same thing. Deep equality over a small JSON-shaped object, which is what these are: no
 * functions, no cycles, no class instances. A structural compare here would need a schema-aware
 * walk to be any better and would be wrong in ways that are hard to see.
 */
function sameClaim(a: Predicate, b: Predicate): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Can `next` be replayed immediately after `previous`? */
export function canFollow(previous: FlowFile, next: FlowFile): CompositionCheck {
  const required = next.requires ?? [];
  const ensured = previous.ensures ?? [];
  if (0 === required.length) {
    return { ok: true, unmet: [], unchecked: 0 === ensured.length };
  }
  const unmet = required.filter((claim) => !ensured.some((have) => sameClaim(have, claim)));
  return { ok: 0 === unmet.length, unmet, unchecked: false };
}
