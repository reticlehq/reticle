import { PredicateKind, REDACTED_VALUE } from '@reticlehq/core';
import type { Predicate } from './predicate-schema.js';

/**
 * What an evaluation ANSWERS, and the small comparisons every oracle answers it with.
 *
 * A leaf. `predicate-console.ts` and `predicate-request-body.ts` are called BY `predicate-eval.ts`
 * and both had to import back out of it — the result type to declare their own signatures, and four
 * comparison helpers to do the comparing. Nothing here reads an event or decides a verdict; it is
 * the vocabulary those decisions are written in, which is why it can sit underneath all of them.
 */

export interface EvalResult {
  pass: boolean;
  /**
   * For a TIME-based failure: how long until this predicate could first become true, if nothing else
   * changes. Purely a scheduling hint for `waitForPredicate` — it replaces a blind poll tick with one
   * timed to the moment that matters, and never decides anything. Absent when the wait is on an
   * external event (a request in flight settles when the server answers, not on a clock).
   */
  retryAfterMs?: number;
  /**
   * Set when the assertion could not be EVALUATED — the call was under-specified or there was
   * nothing instrumented to read — rather than evaluated and found false. Carries the sentence that
   * names what is missing.
   *
   * `pass` stays false because nothing was proven, but a false that nobody could have made true is
   * not a defect in the user's app, and reporting it as one puts agent mistakes into the bug count.
   */
  inconclusive?: string;
  /**
   * No later event in this window can change this answer, so waiting out the rest of the budget
   * buys nothing.
   *
   * Set ONLY where that is provable, which is rarer than it looks. "The toast never appeared" is not
   * decided — it is only knowable when the budget ends, and ending early there would manufacture the
   * false negative the budget exists to prevent. Exact cardinality IS decided once exceeded, because
   * a window only accumulates matches and a count cannot come back down.
   *
   * A scheduling fact, never a verdict: `pass` already says what the answer is, and this only says
   * that it is final.
   */
  decided?: boolean;
  evidence?: unknown;
  failureReason?: string;
  /**
   * The wait ended because the TAB went away, not because the app did anything observable.
   *
   * A sibling of `inconclusive` and for the same reason: `pass` is false because nothing was
   * proven, but nobody could have made it true, so grading it as a defect in the user's app is a
   * false claim. Without this the verdict rule saw only `pass: false` and answered
   * `assertion_failed` — "the declared consequence did not hold" — naming the component the agent
   * had just clicked. See VerifiedReason.OBSERVATION_LOST.
   */
  observationLost?: boolean;
  /**
   * The failure, structured — what was seen, what was required, and which oracle judged it.
   *
   * `failureReason` says the same thing in prose, and prose is the WRONG shape for this: measured on
   * three seeded bugs, an agent handed observed/expected/assertion alongside the source pointer used
   * fewer tool calls than one handed the pointer alone, and the repair literature has structured
   * feedback beating rich natural-language feedback by 10.5pp. The prose stays for humans reading a
   * log; these three fields are for the agent.
   *
   * Optional because they are populated per oracle, not globally — see the note in predicate.ts on
   * which classes carry them today.
   */
  observed?: string;
  expected?: string;
  assertion?: string;
}

export function str(value: unknown): string | undefined {
  return 'string' === typeof value ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return 'number' === typeof value ? value : undefined;
}

/**
 * Match one value against a pattern. Supports `*` (present), strict equality, and operators:
 * `{$gte,$lte,$gt,$lt}` (numbers), `{$contains}` (array membership or substring), `{$length}`.
 */
export function matchValue(got: unknown, want: unknown): boolean {
  if ('*' === want) return got !== undefined;
  // An object is an OPERATOR container only if it actually carries a `$`-prefixed operator. An empty
  // `{}` (or an object with no `$` key) used to enter this branch, iterate zero recognized operators,
  // and `return true` — so `equals: {}` / `dataMatches: {status: {}}` was a green assertion that
  // passed against ANYTHING, undefined included: the exact false green the oracle exists to catch.
  // Without an operator it is a literal to compare, and falls through to strict equality below.
  const ops =
    'object' === typeof want && want !== null && !Array.isArray(want)
      ? Object.entries(want as Record<string, unknown>)
      : undefined;
  if (ops !== undefined && ops.some(([op]) => op.startsWith('$'))) {
    for (const [op, val] of ops) {
      const n = 'number' === typeof got ? got : NaN;
      switch (op) {
        case '$gte':
          if (!(n >= (val as number))) return false;
          break;
        case '$lte':
          if (!(n <= (val as number))) return false;
          break;
        case '$gt':
          if (!(n > (val as number))) return false;
          break;
        case '$lt':
          if (!(n < (val as number))) return false;
          break;
        case '$contains':
          if (Array.isArray(got)) {
            if (!got.includes(val)) return false;
          } else if ('string' === typeof got) {
            if (!got.includes(String(val))) return false;
          } else {
            return false;
          }
          break;
        case '$length':
          if (!((Array.isArray(got) || 'string' === typeof got) && got.length === val)) {
            return false;
          }
          break;
        default:
          return false;
      }
    }
    return true;
  }
  return structurallyEqual(got, want);
}

/**
 * Value equality for the leaf comparison, because `===` could never match a literal.
 *
 * The expected side of a predicate is parsed out of the agent's JSON, so it is a fresh object every
 * time — reference equality made `equals: ["a", "b"]` false against a store holding exactly
 * `["a", "b"]`, and there was no value of the app's state that could have made it true. The mirror of
 * a false green: an assertion nobody could satisfy, on the commonest thing there is to assert about.
 *
 * Deliberately strict about shape. An array is not an object, an extra key is a difference, and order
 * is part of a list's value — `equals` means equals; `dataMatches` is the field-by-field one.
 */
function structurallyEqual(got: unknown, want: unknown): boolean {
  if (got === want) return true;
  if (null === got || null === want) return false;
  if ('object' !== typeof got || 'object' !== typeof want) return false;
  if (Array.isArray(got) !== Array.isArray(want)) return false;
  if (Array.isArray(got) && Array.isArray(want)) {
    return got.length === want.length && got.every((v, i) => structurallyEqual(v, want[i]));
  }
  const a = got as Record<string, unknown>;
  const b = want as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => k in b && structurallyEqual(a[k], b[k]));
}

/** Shallow JSON pattern match: each key in `pattern` must match (see matchValue). */
export function dataMatches(
  actual: Record<string, unknown>,
  pattern: Record<string, unknown>,
): boolean {
  for (const [key, want] of Object.entries(pattern)) {
    if (!matchValue(actual[key], want)) return false;
  }
  return true;
}

/**
 * What a field-level clause over a captured body came to.
 *
 * Three outcomes, not two: a key the SDK redacted before recording cannot be judged at all, and
 * grading that a mismatch blames the application for the observer's own redaction.
 */
export type BodyFieldVerdict = 'match' | 'mismatch' | { redacted: string };

/**
 * Shallow JSON field match over a captured body, for either half of the exchange.
 *
 * One function because both halves ask the identical question, and the request side already had
 * this exact sequence written out — parse, reject a non-object, check the wanted keys for
 * `[REDACTED]`, then `dataMatches`.
 *
 * A body that is not a JSON object counts as a mismatch rather than an error: guessing at form
 * encoding here would answer a different question than the one asked, and the substring clauses
 * exist for those bodies.
 */
export function matchJsonBody(body: string, pattern: Record<string, unknown>): BodyFieldVerdict {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return 'mismatch';
  }
  if (null === payload || 'object' !== typeof payload || Array.isArray(payload)) return 'mismatch';
  const actual = payload as Record<string, unknown>;
  const redacted = Object.keys(pattern).find((key) => REDACTED_VALUE === actual[key]);
  if (redacted !== undefined) return { redacted };
  return dataMatches(actual, pattern) ? 'match' : 'mismatch';
}

/**
 * How much of a response body a failure may quote. Enough to see the value that differed on the
 * bodies this field is used against (a JSON answer), and not a whole payload in every verdict.
 */
const MAX_BODY_IN_FAILURE = 200;

/** Enough of a body to see what differed, without paying for a whole payload in the verdict. */
export function clipBody(body: string): string {
  return body.length <= MAX_BODY_IN_FAILURE ? body : `${body.slice(0, MAX_BODY_IN_FAILURE)}…`;
}

/**
 * The filter as APPLIED, every field of it.
 *
 * The count failure used to print `{method, urlContains, status}` while `ok` and `bodyContains` were
 * applied too, so the caller was shown a predicate it had not written and told nothing matched it.
 * A printed filter that is narrower than the real one is worse than none: it is believed.
 */
export function describeNetFilter(
  p: Extract<Predicate, { kind: typeof PredicateKind.NET }>,
): string {
  const { kind: _kind, count: _count, since: _since, ...filter } = p;
  return JSON.stringify(filter);
}
