/**
 * One readable sentence when a predicate does not parse — never the zod array.
 *
 * In the field a meaningful share of all tool errors were **a serialized zod issue array**, all on
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
import { PredicateKind } from '@reticlehq/core';
import { PredicateSchema, predicateFieldsFor, predicateNestedFieldsFor } from './predicate-eval.js';

/**
 * One valid call PER KIND, because an example of another kind answers a question nobody asked.
 *
 * This was a single `signal` example shown for every rejection. Watched on a real drive: an agent got
 * the `element` shape wrong, was shown a `signal` example, got `element` wrong again, and was shown
 * the same `signal` example. A rejected predicate produces no verdict at all, so each of those was a
 * round trip that ended with nothing — and the one field an agent most needs (`element`'s nested
 * `query`) is exactly what a flat example cannot convey.
 *
 * Short by design: an example that grows past a line stops being read.
 */
const EXAMPLES: Readonly<Partial<Record<string, string>>> = {
  [PredicateKind.ELEMENT]: '{ kind: "element", query: { role: "button", name: "Save" } }',
  [PredicateKind.TEXT]: '{ kind: "text", contains: "Saved" }',
  [PredicateKind.NET]: '{ kind: "net", method: "POST", urlContains: "/api/save", status: 200 }',
  [PredicateKind.ROUTE]: '{ kind: "route", pathname: "/dashboard" }',
  [PredicateKind.CONSOLE]: '{ kind: "console", level: "error", absent: true }',
  [PredicateKind.ANIMATION]: '{ kind: "animation", name: "slide-in", completed: true }',
  [PredicateKind.SIGNAL]: '{ kind: "signal", name: "todos:loaded" }',
  [PredicateKind.STATE]: '{ kind: "state", path: "cart.total", equals: 0 }',
  [PredicateKind.SETTLED]: '{ kind: "settled" }',
  [PredicateKind.ALL_OF]:
    '{ kind: "allOf", predicates: [{ kind: "text", contains: "Saved" }, { kind: "console", level: "error", absent: true }] }',
  [PredicateKind.ANY_OF]:
    '{ kind: "anyOf", predicates: [{ kind: "text", contains: "Saved" }, { kind: "text", contains: "Updated" }] }',
  [PredicateKind.NOT]: '{ kind: "not", predicate: { kind: "text", contains: "Error" } }',
};

/** The fallback, for when the KIND itself is the mistake and there is no shape to demonstrate. */
const GENERIC_EXAMPLE = '{ kind: "text", contains: "Saved" }';

function exampleFor(kind: string): string {
  return EXAMPLES[kind] ?? GENERIC_EXAMPLE;
}

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
/**
 * The placeholder `verify_next` puts in the `until` it suggests, sent back unchanged.
 *
 * The nudge hands the agent a ready-made `act_and_wait` call with `ref` and `action` filled in from
 * the act that dispatched, and leaves the consequence blank on purpose: naming it is the one part
 * only the agent can know, and guessing would be Reticle inventing the assertion.
 *
 * Sent verbatim it parses as a perfectly valid text predicate that simply never matches, so the
 * verdict came back `verified:"no"` / "the declared consequence did not hold" — blaming the app for
 * a placeholder the agent forgot to replace, and sending it to hunt a defect that does not exist.
 * Measured on a live app before this guard: a confident, wrong, actionable-looking answer, which is
 * the exact failure the rest of this file exists to avoid.
 */
const UNFILLED_PLACEHOLDER = /^<name the consequence/i;

function placeholderValue(input: unknown): string | undefined {
  if ('object' !== typeof input || null === input) return undefined;
  const value = (input as Record<string, unknown>)['value'];
  return 'string' === typeof value && UNFILLED_PLACEHOLDER.test(value) ? value : undefined;
}

/**
 * The timeout spellings a predicate may carry harmlessly, and why they are dropped rather than
 * rejected.
 *
 * `reticle_act_and_wait { until: { kind: "element", query: {...}, timeout_ms: 30000 } }` came from
 * the field. The rejection was good -- precise, and it named the accepted fields -- but the agent
 * had to provoke it, and a rejected predicate produces no verdict at all, so the round trip ended
 * with nothing (#877).
 *
 * The enclosing call already carries `timeout_ms` and it means exactly the same thing, so the
 * intent is unambiguous and refusing buys nothing. That equality is the whole licence: this must
 * NOT grow to cover a field that would CHANGE behaviour, because silently dropping one of those is
 * how a step-level timeout went missing and a flow reported a working feature as a regression.
 *
 * Live calls only. Flow files validate through `PredicateSchema` directly (flow-expect-grammar.ts,
 * replay.ts), so #744's rule that a saved contract rejects unknown keys is untouched -- a flow file
 * is a contract, a live call is not.
 */
const REDUNDANT_TIMEOUT_KEYS = ['timeout_ms', 'timeoutMs'] as const;

/**
 * `input` without a redundant timeout at any predicate level, or `input` unchanged.
 *
 * Recursive through the combinators: an agent that writes the field once writes it inside an
 * `allOf` member for the same reason, and the outer call's timeout governs the whole tree either
 * way. Returns the original object when there is nothing to strip, so the ordinary path allocates
 * nothing.
 */
function withoutRedundantTimeout(input: unknown): unknown {
  if ('object' !== typeof input || null === input || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const carries = REDUNDANT_TIMEOUT_KEYS.some((key) => key in record);

  const nestedOne = record['predicate'];
  const strippedOne = withoutRedundantTimeout(nestedOne);
  const nestedMany = record['predicates'];
  const strippedMany = Array.isArray(nestedMany)
    ? nestedMany.map(withoutRedundantTimeout)
    : nestedMany;
  const nestedChanged =
    strippedOne !== nestedOne ||
    (Array.isArray(nestedMany) &&
      (strippedMany as unknown[]).some((value, index) => value !== nestedMany[index]));

  if (!carries && !nestedChanged) return input;

  const out: Record<string, unknown> = { ...record };
  for (const key of REDUNDANT_TIMEOUT_KEYS) delete out[key];
  if (nestedOne !== undefined) out['predicate'] = strippedOne;
  if (Array.isArray(nestedMany)) out['predicates'] = strippedMany;
  return out;
}

export function parsePredicate(input: unknown): z.infer<typeof PredicateSchema> {
  const unfilled = placeholderValue(input);
  if (unfilled !== undefined) {
    throw new Error(
      `that predicate still carries the placeholder from verify_next ("${unfilled}"). Nothing ran, ` +
        'and no verdict was produced — which is deliberate: as written it would have failed and ' +
        'blamed the app for a value you had not filled in yet. Replace it with the consequence ' +
        'this action actually causes, and prefer one the action CHANGES: a signal, a request, a ' +
        'route, or store state. Text on screen that was already there proves nothing.',
    );
  }
  const parsed = PredicateSchema.safeParse(withoutRedundantTimeout(input));
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
      `not evaluated, so no verdict was produced. ${accepted(kind, parsed.error.issues)} ` +
      `A valid ${kind} predicate looks like: ${exampleFor(kind)}`,
  );
}

/**
 * What WOULD have worked, in the same breath as what did not.
 *
 * Telling an agent only which field is wrong leaves it guessing again, and each guess costs another
 * round trip on the one call path that produces verdicts. Naming the accepted fields — or, when the
 * kind itself is the mistake, the accepted kinds — makes the retry informed instead.
 */
function accepted(kind: string, issues: readonly z.ZodIssue[]): string {
  const fields = predicateFieldsFor(kind);
  if (0 < fields.length) {
    // A field whose value is an object is the one an agent cannot guess from its name alone, so
    // expand it in the same breath rather than making the shape a second round trip.
    //
    // Only the field the rejection actually points at, though. Expanding every object-valued field
    // of the kind makes the sentence longer the more the schema grows, and buries the one clause
    // that answers the question asked — the same argument this file already makes for showing one
    // example per kind instead of a generic one. `element` is the only kind with an object-valued
    // field today, so the two agree except when the mistake is somewhere else entirely, which is
    // the case pinned in the tests.
    const all = predicateNestedFieldsFor(kind);
    const blamed = new Set(
      issues
        .map((issue) => issue.path[0])
        .filter((field): field is string => 'string' === typeof field),
    );
    const nested = Object.entries(all)
      .filter(([field]) => blamed.has(field))
      .map(([field, keys]) => ` ${field} accepts: ${keys.join(', ')}.`)
      .join('');
    return `${kind} accepts: ${fields.join(', ')}.${nested}`;
  }
  return `"${kind}" is not a predicate kind — use one of: ${Object.values(PredicateKind).join(', ')}.`;
}
