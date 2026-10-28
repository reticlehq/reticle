/**
 * One readable sentence when a predicate does not parse — never the zod array.
 *
 * `PredicateSchema.parse()` throws a `ZodError` whose `.message` IS the raw issue array, and three
 * handlers call it directly — `reticle_act_and_wait`, `reticle_wait_for` and `reticle_assert`, which
 * are also the three that produce every action-derived finding. So the least readable error emitted
 * anywhere lands on the highest-value path, and an agent has to `JSON.parse` an error string to learn
 * which field it got wrong.
 *
 * This wraps it once, so every caller gets the same shape rather than each growing its own catch —
 * the pattern #108 asks for: name the parameter, say whether anything ran, show a valid call.
 */

import * as z from 'zod';
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
  [PredicateKind.COMPARE]:
    '{ kind: "compare", left: { from: "text", scope: "#total" }, right: { from: "net", urlContains: "/api/cart", path: "total" }, as: "number" }',
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

/** The one example a refusal ends with: the agent's own predicate corrected, else the kind's sample. */
function exampleSentence(kind: string, corrected: string | undefined): string {
  return corrected === undefined
    ? `A valid ${kind} predicate looks like: ${exampleFor(kind)}`
    : `The corrected ${kind} predicate from your call: ${corrected}`;
}

/**
 * The field that holds the value a kind checks. An unknown field's string value goes here when the
 * agent left it empty. `element` holds it in `query.text`. Kinds not listed get no correction.
 */
const PRIMARY_FIELD: Readonly<Partial<Record<string, string>>> = {
  [PredicateKind.TEXT]: 'contains',
  [PredicateKind.ROUTE]: 'pathname',
  [PredicateKind.NET]: 'urlContains',
  [PredicateKind.SIGNAL]: 'name',
  [PredicateKind.ANIMATION]: 'name',
  [PredicateKind.CONSOLE]: 'contains',
  [PredicateKind.STATE]: 'path',
};

/** `"200"` → 200 and `"true"` → true, the two type mistakes with one reading. */
const NUMERIC = /^-?\d+(\.\d+)?$/;
const BOOLEANS: Readonly<Record<string, boolean>> = { true: true, false: false };

/** A string value as the number or boolean the schema wanted, or undefined when it is not one. */
function readTyped(value: unknown, expected: unknown): unknown {
  if ('string' !== typeof value) {
    return undefined;
  }
  if ('number' === expected && NUMERIC.test(value)) {
    return Number(value);
  }
  if ('boolean' === expected) {
    return BOOLEANS[value];
  }
  return undefined;
}

/** The predicate with the kind's check value set to `text`, or undefined for a kind with none. */
function withPrimary(
  kind: string,
  candidate: Record<string, unknown>,
  text: string,
): Record<string, unknown> | undefined {
  if (PredicateKind.ELEMENT === kind) {
    return candidate['query'] === undefined ? { ...candidate, query: { text } } : undefined;
  }
  const field = PRIMARY_FIELD[kind];
  if (field === undefined || candidate[field] !== undefined) {
    return undefined;
  }
  return { ...candidate, [field]: text };
}

/**
 * One corrected predicate built from the agent's own values, as JSON, or undefined.
 *
 * Unknown fields are removed, and the first one that holds a string becomes the kind's check value.
 * A number or boolean written as a string is read as one. Call arguments (`ref`, `action`) are never
 * used as the check value. When any value the agent wrote would be lost, there is no correction:
 * a predicate that checks less than the agent asked for is not a correction.
 */
function correctedFromCall(input: unknown, issues: readonly z.ZodIssue[]): string | undefined {
  if ('object' !== typeof input || null === input || Array.isArray(input)) {
    return undefined;
  }
  const kind = kindAsWritten(input);
  if ('string' !== typeof kind || 0 === predicateFieldsFor(kind).length) {
    return undefined;
  }
  // On `element` a `ref` is the target. Removed, the check would find any element, not that one.
  if (PredicateKind.ELEMENT === kind && (input as Record<string, unknown>)['ref'] !== undefined) {
    return undefined;
  }
  let candidate: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  delete candidate[KIND_ALIAS];
  candidate['kind'] = kind;
  const donors: string[] = [];
  for (const issue of issues) {
    const field = issue.path[0];
    if (z.ZodIssueCode.unrecognized_keys === issue.code && 0 === issue.path.length) {
      for (const key of issue.keys) {
        const value = candidate[key];
        delete candidate[key];
        if (CALL_LEVEL_FIELDS.includes(key)) {
          continue;
        }
        if ('string' !== typeof value) {
          return undefined;
        }
        donors.push(value);
      }
      continue;
    }
    // A refinement on the whole predicate, or a missing field: the parse at the end decides.
    if (0 === issue.path.length || ('string' === typeof field && candidate[field] === undefined)) {
      continue;
    }
    if (1 !== issue.path.length || 'string' !== typeof field) {
      return undefined;
    }
    const typed = readTyped(candidate[field], 'expected' in issue ? issue.expected : undefined);
    if (typed === undefined) {
      return undefined;
    }
    candidate[field] = typed;
  }
  for (const field of CALL_LEVEL_FIELDS) {
    delete candidate[field];
  }
  if (1 < donors.length) {
    return undefined;
  }
  const [donor] = donors;
  if (donor !== undefined) {
    const filled = withPrimary(kind, candidate, donor);
    if (filled === undefined) {
      return undefined;
    }
    candidate = filled;
  }
  const parsed = PredicateSchema.safeParse(candidate);
  return parsed.success ? JSON.stringify(parsed.data) : undefined;
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
 * The one member of an `allOf`/`anyOf`/`not` every issue points into, when there is exactly one.
 *
 * Read at the outer level, a member's mistake was reported as the combinator's: "allOf accepts:
 * predicates … unknown field satisfies" for a `satisfies` on a nested `element`, which sends the
 * agent to fix the wrong level. Re-parsing that member names its own kind, fields and example.
 */
function onlyChildBlamed(
  input: unknown,
  issues: readonly z.ZodIssue[],
): { path: string; value: unknown } | undefined {
  if ('object' !== typeof input || null === input) return undefined;
  const heads = new Set(
    issues.map((issue) =>
      'predicates' === issue.path[0] && 'number' === typeof issue.path[1]
        ? `predicates.${issue.path[1]}`
        : 'predicate' === issue.path[0] && 1 < issue.path.length
          ? 'predicate'
          : '',
    ),
  );
  const [head] = heads;
  if (1 !== heads.size || undefined === head || '' === head) return undefined;
  const [field, index] = head.split('.');
  const record = input as Record<string, unknown>;
  const container = record[field ?? ''];
  const value =
    undefined === index ? container : (container as unknown[] | undefined)?.[Number(index)];
  return undefined === value ? undefined : { path: head, value };
}

const NOTHING_RAN = 'Nothing ran — the predicate was not evaluated, so no verdict was produced.';

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
  const parsed = PredicateSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const child = onlyChildBlamed(input, parsed.error.issues);
  if (child !== undefined) {
    try {
      parsePredicate(child.value);
    } catch (error) {
      if (error instanceof Error) throw new Error(`${child.path}: ${error.message}`);
    }
  }
  // A refused bare string carries its own readings, so nothing about kinds is added to it.
  if ('string' === typeof input) {
    const said = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`that predicate did not parse: ${said}. ${NOTHING_RAN}`);
  }
  const asWritten = kindAsWritten(input);
  const kind = 'string' === typeof asWritten ? asWritten : 'unknown';
  // Bounded on purpose: a union rejection can produce one issue per member, and pasting all of them
  // back is how the zod array became unreadable in the first place.
  const issues = parsed.error.issues.slice(0, 3).map(describeIssue).join('; ');
  throw new Error(
    `that predicate did not parse (kind "${kind}"): ${issues}. ${NOTHING_RAN} ` +
      `${accepted(kind, parsed.error.issues)}` +
      `${misplacedCallFields(input)} ` +
      exampleSentence(kind, correctedFromCall(input, parsed.error.issues)),
  );
}

/**
 * Arguments of the CALL that agents write inside the predicate instead.
 *
 * Reported from the field on `timeout_ms`, nested in `until` on an `act_and_wait` that had already
 * timed out once at the default budget. The rejection said "unknown field", which reads as "there is
 * no such thing" — so the obvious retry is to delete it and silently give up the longer budget that
 * was the point of writing it. It is not an unknown field; it is a real argument one level too deep.
 */
const CALL_LEVEL_FIELDS: readonly string[] = [
  'timeout_ms',
  'sessionId',
  'ref',
  'action',
  'args',
  'target',
  'intent',
];

/** The fields that carry a predicate inside a predicate — `anyOf`/`allOf`, and `not`. */
const NESTED_PREDICATE_FIELDS: readonly string[] = ['predicates', 'predicate'];

/**
 * `type`, read as the discriminator when — and only when — `kind` is absent.
 *
 * Spelled here rather than imported: core keeps this constant private, and `core-coupling-only-
 * shrinks` counts every name the engine borrows — a one-word alias is not worth a permanent one.
 * The two are held together by a test instead, so a change to the alias fails here rather than
 * silently reintroducing the `kind "unknown"` reading this fixes.
 */
const KIND_ALIAS = 'type';

/**
 * How many locator clauses one rejection carries before the rest are counted instead.
 *
 * A rejected `anyOf`/`allOf` produces one clause per invalid member, and unlike the three-issue
 * limit on schema errors these had none — so a single tool error could grow into the same sentence
 * repeated until the advice that was asked for was the hardest thing in it to find.
 */
const MAX_LOCATOR_CLAUSES = 3;

/** The clause for a `ref` beside a `query` that already holds a locator. */
const ELEMENT_REF_DELETE_CLAUSE =
  '`ref` is not a field of an `element` predicate: the locator already sits in `query`, ' +
  'so delete the `ref` rather than moving it up beside `until`.';

/** The clause for a `ref` written where the locator belongs, naming the fields `query` accepts. */
function elementRefMoveClause(queryFields: string): string {
  return (
    '`ref` is not a locator on an `element` predicate: element predicates take `query` ' +
    `(${queryFields}), not \`ref\` — put the locator inside \`query\`; a raw element ref ` +
    'belongs in `query.scope`.'
  );
}

/**
 * Whether a written `query` actually carries a locator.
 *
 * `{}` is accepted by the schema and locates nothing, so presence of the key is not the question.
 * Reading it as "the locator is already there" told the caller to delete the only target it had.
 */
function carriesLocator(query: unknown): boolean {
  return 'object' === typeof query && null !== query && 0 < Object.keys(query).length;
}

/**
 * The kind as written, reading core's `type` spelling when `kind` is absent.
 *
 * `PredicateSchema` accepts `type` as the discriminator whenever `kind` is missing — core normalises
 * it in `applyPredicateAliases` before parsing, and an explicit `kind` still wins. Reading `kind`
 * alone here is how `{ type: 'element', ref: 'e1' }` came back as `kind "unknown"` carrying the very
 * #1374 advice the canonical spelling no longer gets. One reader for the sentence and the clause, so
 * the two cannot disagree about which kind was written.
 */
function kindAsWritten(input: unknown): unknown {
  if ('object' !== typeof input || null === input) return undefined;
  const obj = input as Record<string, unknown>;
  return obj['kind'] !== undefined ? obj['kind'] : obj[KIND_ALIAS];
}

/** The clause naming where a misplaced call argument goes, or '' when nothing was misplaced. */
function misplacedCallFields(input: unknown): string {
  const clauses = [...new Set(misplacedClauses(input))];
  // Bounded like the issue list above, and for the same reason: one rejected `anyOf` can carry an
  // invalid `element` per member, and a clause each turns one tool error into a wall of the same
  // sentence — which buries the advice instead of delivering it. The count is named rather than
  // silently dropped, so a caller with a genuinely long list knows to look at the members.
  const shown = clauses.slice(0, MAX_LOCATOR_CLAUSES);
  const rest = clauses.length - shown.length;
  if (0 < rest) shown.push(`${rest} more predicate${1 === rest ? '' : 's'} need the same fix.`);
  return 0 === shown.length ? '' : ` ${shown.join(' ')}`;
}

/**
 * The clauses for this object, plus the same reading one level down.
 *
 * `anyOf`/`allOf` wrap a predicate, and wrapping the first `element` assertion of a session in one is
 * an ordinary way to write it — so the `ref`-as-locator answer has to reach that level too, or the
 * fix holds only for the spellings that happen to be top-level. The walk is bounded by the number of
 * clauses reported rather than by depth: the schema nests without limit, and a depth cutoff answered
 * `allOf → not → anyOf → element` with the error this change exists to explain.
 */
function misplacedClauses(input: unknown): string[] {
  if ('object' !== typeof input || null === input) return [];
  const obj = input as Record<string, unknown>;
  const written = Object.keys(input);
  const clauses: string[] = [];
  // `element` is the one kind where a `ref` is not a call argument one level too deep but a locator
  // written in the wrong place: the locator nests under `query`, so the retry is to move it inside
  // `query` — not up beside `until`. That advice is misdirection here: on `act_and_wait` moving a
  // `ref` up retargets the ACTION, and `reticle_assert` has no `until` at all, so the caller loses
  // its target and still does not parse. Named as the field to write instead, so the retry keeps it.
  //
  // `ref: undefined` is not a locator written in the wrong place, so the clause keys off a value
  // rather than off the key being present.
  const kind = kindAsWritten(input);
  const refIsLocator =
    'string' === typeof kind && PredicateKind.ELEMENT === kind && obj['ref'] !== undefined;
  if (refIsLocator) {
    // The locator may ALREADY be in `query`, and then the only thing to do is delete the extra
    // `ref`. "Put the locator inside `query`" would send the caller to rewrite a field that is
    // already right — a worse retry than the one it replaces. Derived from the schema rather than
    // listed here: a stale field list is worse than none, because the agent trusts it and retries
    // into the same wall.
    //
    // An EMPTY `query` is not a locator: `{}` parses, and deleting the `ref` as told would leave
    // the predicate with no target at all. So the "already there" reading keys off `query`
    // carrying at least one field, not off the key being present.
    const queryFields = (predicateNestedFieldsFor(PredicateKind.ELEMENT)['query'] ?? []).join('/');
    clauses.push(
      carriesLocator(obj['query']) ? ELEMENT_REF_DELETE_CLAUSE : elementRefMoveClause(queryFields),
    );
  }
  const misplaced = CALL_LEVEL_FIELDS.filter(
    (field) => written.includes(field) && !(refIsLocator && 'ref' === field),
  );
  if (0 < misplaced.length) {
    const list = misplaced.join(', ');
    // Named as a MOVE, not as a removal. Deleting the field is the reading of "unknown field" that
    // costs the caller the thing it asked for.
    clauses.push(
      `${list} ${1 === misplaced.length ? 'is an argument' : 'are arguments'} of the CALL, not of ` +
        `the predicate: ${1 === misplaced.length ? 'move it' : 'move them'} up beside \`until\` rather ` +
        'than dropping it — nesting is why the predicate did not parse.',
    );
  }
  for (const field of NESTED_PREDICATE_FIELDS) {
    const child = obj[field];
    if (child === undefined) continue;
    for (const nested of Array.isArray(child) ? child : [child]) {
      clauses.push(...misplacedClauses(nested));
    }
  }
  return clauses;
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
  const kinds = Object.values(PredicateKind);
  // `absent` is listed beside the kinds in the grammar, but it is a field. Say where it goes.
  const takenBy = kinds.filter((each) => predicateFieldsFor(each).includes(kind));
  const asField =
    0 === takenBy.length
      ? ''
      : ` "${kind}" is a field of ${takenBy.join(', ')}: { kind: "${takenBy[0] ?? ''}", ..., ${kind}: … }.`;
  return `"${kind}" is not a predicate kind — use one of: ${kinds.join(', ')}.${asField}`;
}
