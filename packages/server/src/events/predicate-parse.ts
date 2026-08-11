/**
 * One readable sentence when a predicate does not parse — never the zod array.
 *
 * Measured 2026-08-10: **9 of 58 tool errors that day were a serialized zod issue array**, all on
 * `reticle_act_and_wait`, `reticle_wait_for` and `reticle_assert` — the three tools that produced
 * every action-derived finding in the dataset. The least readable error we emit was landing on the
 * highest-value path, and an agent had to `JSON.parse` an error string to learn which field it got
 * wrong.
 *
 * `PredicateSchema.parse()` throws a `ZodError` whose `.message` IS that array, and three handlers
 * call it directly. This wraps it once, so every caller gets the same shape rather than each
 * growing its own catch — the pattern #108 asks for: name the parameter, say whether anything ran,
 * show a valid call.
 */

import { z } from 'zod';
import { PredicateSchema } from './predicate-eval.js';

/** A valid call, short enough to sit inside an error without becoming the error. */
const EXAMPLE = '{ kind: "signal", name: "todos:loaded" }';

/** `path: ["net","urlContains"]` → `net.urlContains`; an empty path means the object itself. */
function pathOf(issue: z.ZodIssue): string {
  return 0 === issue.path.length ? 'the predicate' : issue.path.map(String).join('.');
}

/**
 * One issue, as a clause a human or an agent can act on.
 *
 * `unrecognized_keys` is the common case by far and the one worth spelling out — it is what a
 * plausible-but-wrong field name produces, and the key itself is the whole answer.
 */
function describeIssue(issue: z.ZodIssue): string {
  if (z.ZodIssueCode.unrecognized_keys === issue.code) {
    return `unknown field ${issue.keys.join(', ')}`;
  }
  return `${pathOf(issue)}: ${issue.message}`;
}

/**
 * Parse a predicate, or throw an Error whose message is a sentence.
 *
 * Deliberately still THROWS: every call site already handles a throw, and turning this into a
 * result type would mean touching three handlers to gain nothing the message does not already say.
 */
export function parsePredicate(input: unknown): z.infer<typeof PredicateSchema> {
  const parsed = PredicateSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const kind =
    'object' === typeof input && null !== input && 'kind' in input
      ? String((input as Record<string, unknown>)['kind'])
      : 'unknown';
  // Bounded on purpose: a union rejection can produce one issue per member, and pasting all of them
  // back is how the zod array became unreadable in the first place.
  const issues = parsed.error.issues.slice(0, 3).map(describeIssue).join('; ');
  throw new Error(
    `that predicate did not parse (kind "${kind}"): ${issues}. Nothing ran — the predicate was ` +
      `not evaluated, so no verdict was produced. Call reticle_tools for the fields this kind ` +
      `accepts. A valid call looks like: ${EXAMPLE}`,
  );
}
