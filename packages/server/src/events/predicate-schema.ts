import {
  ElementQuerySchema,
  ElementState,
  PredicateKind,
  QueryBy,
  type ElementDescriptor,
  type ElementQuery,
} from '@reticlehq/core';
import { z } from 'zod';

export type Predicate =
  | {
      kind: typeof PredicateKind.ELEMENT;
      query: ElementQuery;
      state?: ElementState;
      absent?: boolean;
    }
  | {
      kind: typeof PredicateKind.TEXT;
      contains: string;
      visible?: boolean;
      absent?: boolean;
      /**
       * Restrict the match to a subtree, as a CSS selector or a ref — the same field, and the same
       * meaning, as `scope` on an element query.
       *
       * Without it the match is page-wide, and a word that appears both in a background tab label
       * and in the dialog that just opened satisfies the predicate BEFORE the action runs, so
       * `act_and_wait` reports `already_true` for an action that did exactly the right thing.
       */
      scope?: string;
    }
  | {
      kind: typeof PredicateKind.NET;
      method?: string;
      urlContains?: string;
      status?: number;
      /** Did the call succeed? The honest field for IPC, which has no status code. */
      ok?: boolean;
      since?: number;
      count?: number;
      /** A substring the RESPONSE body must contain — what the server answered, not what was sent. */
      bodyContains?: string;
    }
  | { kind: typeof PredicateKind.ROUTE; pathname?: string; contains?: string; since?: number }
  | { kind: typeof PredicateKind.CONSOLE; level?: string; absent?: boolean; since?: number }
  | {
      kind: typeof PredicateKind.ANIMATION;
      name?: string;
      target?: string;
      completed?: boolean;
      since?: number;
    }
  | {
      kind: typeof PredicateKind.SIGNAL;
      name?: string;
      dataMatches?: Record<string, unknown>;
      since?: number;
    }
  | { kind: typeof PredicateKind.STATE; store?: string; path: string; equals?: unknown }
  | { kind: typeof PredicateKind.SETTLED; quietMs?: number }
  | { kind: typeof PredicateKind.ALL_OF; predicates: Predicate[] }
  | { kind: typeof PredicateKind.ANY_OF; predicates: Predicate[] }
  | { kind: typeof PredicateKind.NOT; predicate: Predicate };

/**
 * Spellings an agent plausibly reaches for, mapped to the real field.
 *
 * `route` spells its field `pathname` while `state`, in the same union, spells its `path`. Every one
 * of these was silently DROPPED before, and because these kinds have all-optional fields, dropping
 * the only key supplied left a predicate that asserts nothing and passes on anything.
 */
const PREDICATE_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // `text`/`value` on a `text` predicate: the kind is called "text", so `text:` is the first thing
  // anyone writes for it, and `value` follows from the element query's own `value` field. Both were
  // hard rejections, and a rejected predicate produces NO verdict at all — the drive ends with
  // nothing rather than with a failure, which is the worst outcome of the three.
  [PredicateKind.TEXT]: { text: 'contains', value: 'contains' },
  // `urlContains`/`url` reported from the field: an agent that had just written
  // `net { urlContains }` applied the same word to `route`, which spells it `contains`, and got
  // `unrecognized_keys` with no list of what would have worked. The parallel it assumed is a fair
  // one — route's `contains` matches the WHOLE route (path + query + fragment), so "the URL
  // contains this" is precisely what it does — and asserting a redirect after login is the single
  // most common thing an agent reaches for here.
  [PredicateKind.ROUTE]: { path: 'pathname', urlContains: 'contains', url: 'contains' },
  [PredicateKind.NET]: { url: 'urlContains' },
  [PredicateKind.SIGNAL]: { data: 'dataMatches' },
  // `of` on a composite: it reads naturally, several assertion libraries spell it that way, and it has
  // no other meaning here. Observed twice in one drive on a real app, and each rejection cost a round
  // trip AND produced no verdict — a composite is what an agent reaches for precisely when it has two
  // things to prove at once, so failing it is expensive at the worst moment.
  [PredicateKind.ALL_OF]: { of: 'predicates' },
  [PredicateKind.ANY_OF]: { of: 'predicates' },
};

/**
 * Element-query fields an agent writes FLAT on an `element` predicate instead of nested under
 * `query`. `reticle_query` takes exactly these at the top level, so an agent that has just located
 * something writes the same words again when it asserts on it — and got `query: Required` plus an
 * `unknown field` list for its trouble. Lifting them is unambiguous: they have no other meaning on
 * this kind.
 */
const ELEMENT_QUERY_FIELDS = [
  'by',
  'value',
  'role',
  'name',
  'text',
  'label',
  'placeholder',
  'testid',
  'alt',
  'component',
] as const;

/**
 * The locator fields the browser actually CONSUMES for a given query — mirrors the precedence in
 * `findIn` (packages/browser/src/dom/query.ts).
 *
 * An element query is not a conjunction. It is a first-match dispatch: `by`+`value` wins, then the
 * component/source anchor, then `role` (which alone also consumes `name`), then the first of
 * text/label/placeholder/testid/alt that is present. Every OTHER field the caller wrote is dropped on
 * the floor, silently, and the match reported as if the whole query had been honoured.
 *
 * Duplicated here on purpose. The alternative is to send the question to the browser, and the browser
 * cannot answer it: by the time a match comes back, the fields it ignored are indistinguishable from
 * the fields it used.
 */
function usedQueryFields(query: ElementQuery): ReadonlySet<string> {
  const used = new Set<string>();
  if (query.by !== undefined && query.value !== undefined) {
    used.add('by').add('value');
    if (QueryBy.ROLE === query.by) used.add('name');
    if (QueryBy.COMPONENT === query.by) used.add('component');
    return used;
  }
  if (query.component !== undefined || query.source !== undefined) return used.add('component');
  if (query.role !== undefined) return used.add('role').add('name');
  for (const field of ['text', 'label', 'placeholder', 'testid', 'alt'] as const) {
    if (query[field] !== undefined) return used.add(field);
  }
  return used;
}

/**
 * How a dropped field is checked back on the server, against the descriptor the match returned.
 *
 * `value` is the field this exists for: `{ role: "textbox", name: "GST amount", value: "274.58" }`
 * read as a locator has no `by`, so the value half was discarded and the predicate collapsed to "a
 * textbox named GST amount exists" — trivially true against an EMPTY field. Comparison is TRIMMED and
 * exact: an input's value is a value, not prose, and a trailing space in either the app or the
 * predicate is not a finding anybody wants. `""` asserts the field is empty, which describe() reports
 * by omitting the field entirely.
 *
 * `role`/`name`/`value` compare against exactly what `reticle_query` REPORTS, so the words an agent
 * copies out of a query result are the words that match here. `text` is a substring match, matching
 * Testing Library's `exact: false`, and falls back to the name because describe() omits `text` when it
 * equals the accessible name.
 */
const RESIDUAL_CHECKS: Readonly<
  Record<string, (element: ElementDescriptor, want: string) => boolean>
> = {
  value: (element, want) => (element.value ?? '').trim() === want.trim(),
  role: (element, want) => element.role === want,
  name: (element, want) => element.name.trim() === want.trim(),
  text: (element, want) => (element.text ?? element.name).includes(want),
};

export interface ResidualQueryChecks {
  /** Dropped fields this side CAN check, as [field, wanted value] pairs. */
  checks: [string, string][];
  /** Dropped fields with no descriptor to check them against — refuse rather than ignore. */
  unusable: string[];
}

/**
 * Split a query's dropped fields into the ones the server can still enforce and the ones it cannot.
 *
 * The alternative — refuse every dropped field — breaks calls that work today and that our own
 * cheatsheet advertises (`{ role: "button", text: "Save" }`), and breaks them into no verdict at all.
 * Enforcing what we can and refusing only the rest keeps those calls working AS WRITTEN, which is the
 * outcome the caller was already assuming.
 */
export function residualQueryChecks(query: ElementQuery): ResidualQueryChecks {
  const used = usedQueryFields(query);
  const checks: [string, string][] = [];
  const unusable: string[] = [];
  for (const field of ELEMENT_QUERY_FIELDS) {
    const want = query[field];
    if (want === undefined || used.has(field)) continue;
    if ('string' === typeof want && RESIDUAL_CHECKS[field] !== undefined)
      checks.push([field, want]);
    else unusable.push(field);
  }
  return { checks, unusable };
}

/** Does this element satisfy every field the locator dropped? */
export function satisfiesResiduals(
  element: ElementDescriptor,
  checks: readonly [string, string][],
): boolean {
  return checks.every(([field, want]) => true === RESIDUAL_CHECKS[field]?.(element, want));
}

/** How the element's own reading of a dropped field should be REPORTED back on a failure. */
export function describeResidual(element: ElementDescriptor, field: string): string {
  const reading =
    'value' === field
      ? (element.value ?? '')
      : 'text' === field
        ? (element.text ?? element.name)
        : 'role' === field
          ? element.role
          : element.name;
  return `${element.role} "${element.name}" ${field}=${JSON.stringify(reading)}`;
}

/** Rename known aliases before parse; an explicit canonical key always wins. */
function applyPredicateAliases(input: unknown): unknown {
  if (typeof input !== 'object' || null === input || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;
  const kind = 'string' === typeof obj['kind'] ? obj['kind'] : '';
  const aliases = PREDICATE_ALIASES[kind];
  let out = obj;
  if (aliases !== undefined) {
    out = { ...obj };
    for (const [from, to] of Object.entries(aliases)) {
      if (out[from] === undefined) continue;
      if (out[to] === undefined) out[to] = out[from];
      delete out[from];
    }
  }
  return PredicateKind.ELEMENT === kind ? liftElementQuery(out) : out;
}

/**
 * Fold flat query fields into `query`. An explicit `query` wins outright — a caller that supplied
 * both told us which one it meant, and merging the two would invent a locator neither side wrote.
 */
function liftElementQuery(obj: Record<string, unknown>): Record<string, unknown> {
  const loose = ELEMENT_QUERY_FIELDS.filter((field) => obj[field] !== undefined);
  if (0 === loose.length) return obj;
  const out = { ...obj };
  const query: Record<string, unknown> = {};
  for (const field of loose) {
    query[field] = out[field];
    delete out[field];
  }
  if (out['query'] === undefined) out['query'] = query;
  return out;
}

/**
 * Strict on every branch. A key that is nobody's spelling is now a schema error naming it, instead of
 * a stripped field and a green — see predicate-strict.test.ts for the MCP session that found this.
 *
 * Built on demand rather than at module scope: the `allOf`/`anyOf`/`not` branches reference
 * `PredicateSchema` itself, which does not exist yet while this module is initialising. Calling it
 * after init is what makes the union introspectable — see `predicateFieldsFor`.
 */
function predicateUnion() {
  return z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal(PredicateKind.ELEMENT),
        query: ElementQuerySchema,
        state: z.nativeEnum(ElementState).optional(),
        absent: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.TEXT),
        contains: z.string(),
        visible: z.boolean().optional(),
        absent: z.boolean().optional(),
        scope: z.string().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.NET),
        method: z.string().optional(),
        urlContains: z.string().optional(),
        status: z.number().optional(),
        ok: z.boolean().optional(),
        since: z.number().optional(),
        count: z.number().int().nonnegative().optional(),
        /**
         * A substring the call's RESPONSE body must contain - what the server answered.
         *
         * The only channel that can catch a UI echoing its own input instead of the server's answer.
         * Reported from a real payments UI: a refund posted `{"amount":"1187.01"}`, the server read it
         * as paise and answered 200 with `{"refunded":11.87}`, and the page displayed the number the
         * user had typed. Request fired, exactly once, status 200, console clean, page settled — every
         * assertable channel green on a hundred-fold wrong refund, so the verdict was `yes`.
         *
         * A substring rather than a JSON path, deliberately: `"refunded":11.87` is the whole assertion
         * for the money case, it needs no schema for the body, and it works the same on JSON, form
         * encoding and plain text. A path-and-equals form can be added later if a real case needs one;
         * this is the shape that turns "a blob I read" into a verdict.
         *
         * Requires body capture (`reticle({ captureNetworkBodies: true })`), and says so when the body
         * was never recorded rather than reporting an ordinary mismatch.
         */
        bodyContains: z.string().min(1).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.ROUTE),
        pathname: z.string().optional(),
        contains: z.string().optional(),
        since: z.number().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.CONSOLE),
        level: z.string().optional(),
        absent: z.boolean().optional(),
        since: z.number().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.ANIMATION),
        name: z.string().optional(),
        target: z.string().optional(),
        completed: z.boolean().optional(),
        since: z.number().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.SIGNAL),
        name: z.string().optional(),
        dataMatches: z.record(z.unknown()).optional(),
        since: z.number().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.STATE),
        store: z.string().optional(),
        path: z.string(),
        equals: z.unknown().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.SETTLED),
        quietMs: z.number().positive().optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal(PredicateKind.ALL_OF), predicates: z.array(PredicateSchema) })
      .strict(),
    z
      .object({ kind: z.literal(PredicateKind.ANY_OF), predicates: z.array(PredicateSchema) })
      .strict(),
    z.object({ kind: z.literal(PredicateKind.NOT), predicate: PredicateSchema }).strict(),
  ]);
}

export const PredicateSchema = z.lazy(() =>
  z.preprocess(applyPredicateAliases, predicateUnion()),
) as unknown as z.ZodType<Predicate>;

/**
 * The fields a given predicate kind accepts, read off the schema itself.
 *
 * Derived rather than listed so the two can never disagree: a rejection message that names a stale
 * field set is worse than one that names none, because the agent trusts it and retries into the same
 * wall. Empty for a kind that is not in the union.
 */
export function predicateFieldsFor(kind: string): readonly string[] {
  for (const option of predicateUnion().options) {
    const literal = option.shape['kind'];
    if (literal instanceof z.ZodLiteral && literal.value === kind) {
      return Object.keys(option.shape).filter((field) => 'kind' !== field);
    }
  }
  return [];
}
