/**
 * Deciding a presence match that found something -- and saying when what it found is hollow.
 *
 * Extracted from `predicate.ts` so the evaluator's switch stays readable; the reasoning for the two
 * different treatments lives on `presenceVerdict` below.
 */
import type { ElementQuery, ElementState, MatchResult } from '@reticlehq/core';
import type { EvalResult } from './predicate-eval.js';

/**
 * Decide a presence match that found something, and say when what it found is hollow.
 *
 * `element` and `text` are the most idiomatic way to ask "did an error appear", and both are
 * satisfiable without anything appearing (#797):
 *
 *  - A toast library mounts a permanently-present, unnamed `role="alert"` live region. It never
 *    leaves the DOM and it is `visible`, so `{ kind: "element", role: "alert" }` is a permanent
 *    green on any app using one — with zero errors on screen.
 *  - A dialog's content is in the DOM but hidden before the click, so a `text` clause returns
 *    `already_true` and the action it was meant to grade is never actually graded.
 *
 * The two get different treatment on purpose, because the confidence in each differs:
 *
 *  - **Hidden-only matches FAIL.** An appearance check answered entirely by nodes nobody can see
 *    has not observed an appearance. A caller who genuinely means presence-regardless-of-visibility
 *    already has a way to say so — `state: "present"`, or `state: "hidden"` — and this only changes
 *    the DEFAULT, which is what the report asks for.
 *  - **Nameless-only matches PASS, with a caveat.** Plenty of roles are legitimately unnamed
 *    (`progressbar`, a decorative `separator`), so failing here would break correct assertions to
 *    catch an incorrect one. The verdict stands and says what it rested on.
 *
 * Both checks are skipped when the caller passed a `state`: they said what they meant by "there",
 * and second-guessing a stated intent is how a tool earns a reputation for surprises.
 */
export function presenceVerdict(
  match: MatchResult,
  query: ElementQuery,
  subject: string,
  state: ElementState | undefined,
): EvalResult {
  const described = match.elements;
  // `elements` is a described PREFIX of `count` (see the residual note above). With matches the
  // browser never described, "every match is hidden" and "every match is nameless" are claims the
  // evidence does not support -- and a wrong FAILURE here is worse than the false green, because it
  // sends an agent to fix working code. Pass, as before.
  if (state !== undefined || 0 === described.length || match.count > described.length) {
    return { pass: true, evidence: described };
  }

  const visible = described.filter((element) => element.visible);
  if (0 === visible.length) {
    const plural = 1 === described.length ? 'it is' : 'none is';
    return {
      pass: false,
      failureReason:
        `${String(described.length)} element(s) matched ${subject} but ${plural} visible — ` +
        'an appearance check answered by hidden nodes has not seen anything appear. ' +
        'Pass `state: "present"` to accept a match regardless of visibility',
      observed: `${String(described.length)} hidden element(s) matching ${subject}`,
      expected: `a visible element matching ${subject}`,
      assertion: 'element.visible',
      evidence: described,
    };
  }

  // A role-only clause is the hollow shape: the caller named a role and nothing else, and every
  // node that answered it is unnamed. `role="alert"` satisfied only by an empty live-region
  // container is the reported case. When the query itself carries a name or text, a nameless match
  // cannot have answered it, so there is nothing to warn about.
  const discriminating =
    undefined !== query.name || undefined !== query.text || undefined !== query.testid;
  const namedVisible = visible.filter((element) => element.name.trim().length > 0);
  if (!discriminating && 0 === namedVisible.length) {
    return {
      pass: true,
      evidence: described,
      caveat:
        `matched ${String(visible.length)} visible element(s) for ${subject}, all unnamed — ` +
        'a live-region or landmark container that is always present satisfies this clause with ' +
        'nothing on screen. Add `name` (or a `text` clause) to assert what was actually shown',
    };
  }
  return { pass: true, evidence: described };
}
