import type { FlowExpect, FlowFile } from './flow-types.js';

/**
 * Whether one flow may be replayed straight after another.
 *
 * WHY THIS EXISTS AS A CHECK RATHER THAN A HOPE. Replaying journeys back to back only works when the
 * state one leaves is the state the next expects, and until `requires`/`ensures` existed nothing
 * said so. A suite either got lucky or produced a failure that looked like a regression and was a
 * missing precondition — the most expensive kind of red, because it sends somebody to read product
 * code that is fine. Two flows that each pass alone can fail composed, and the reverse, and neither
 * outcome tells you which of the two it was.
 *
 * It answers over DECLARATIONS, not over a running app: a pure comparison of what B says it needs
 * against what A says it leaves. That is the whole point — it can be asked before either flow runs,
 * which is the only moment the answer is cheap.
 *
 * SILENCE IS PERMISSIVE, and deliberately. A flow that declares neither is every flow recorded
 * before this shipped, and treating "did not say" as "does not satisfy" would refuse every existing
 * composition on the day it landed. Unknown means unchecked, not unsafe; the caller decides whether
 * it wants to run unchecked, and `unmet` says which claims could not be discharged so the answer is
 * never a bare boolean.
 *
 * NOT YET ENFORCED AT REPLAY TIME, and said plainly rather than implied. Reporting an unmet
 * precondition as a step result would read as a FAILURE — `FlowStepResult` has `ok: boolean` and no
 * third state — and a missing precondition is honestly `unknown`: nothing ran, so nothing was
 * proved. Giving it a verdict of its own is a change to the suite roll-up, and it belongs with the
 * feature that orders flows into a composition rather than ahead of it.
 */
export interface CompositionCheck {
  /** True when nothing B requires is left undischarged by A. Vacuously true when either is silent. */
  readonly ok: boolean;
  /** The claims B requires that A does not ensure. Empty when `ok`. */
  readonly unmet: readonly FlowExpect[];
  /** True when neither flow declared anything, so the answer is "unchecked" rather than "safe". */
  readonly unchecked: boolean;
}

/**
 * Compared by VALUE, because a precondition is a claim and two claims are the same claim when they
 * say the same thing. Deep equality over a small JSON-shaped object, which is what these are: no
 * functions, no cycles, no class instances. A structural compare here would need a schema-aware
 * walk to be any better and would be wrong in ways that are hard to see.
 */
function sameClaim(a: FlowExpect, b: FlowExpect): boolean {
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
