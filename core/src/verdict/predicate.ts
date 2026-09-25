/**
 * The predicate: what a caller can declare, as a shape that crosses the wire.
 *
 * This is the CONTRACT half of the predicate language, and it is here for the reason everything
 * else in this package is: a message that crosses browser ↔ bridge ↔ agent is defined in core, and
 * a predicate is now one. `FlowStep.expect` is a `Predicate`, which means a saved flow file carries
 * one, which means core has to be able to parse what it reads off disk.
 *
 * It was in `@reticlehq/engine` and it was already half here: `PredicateKind` has always lived in
 * `verdict/consequence.ts`, so the engine's schema imported its own vocabulary back from its parent.
 * This finishes that migration rather than starting one.
 *
 * WHAT DID NOT COME WITH IT, and the line is deliberate. Evaluation stays in the engine:
 * `satisfiesProperty`, the residual-query checks, the grammar and nested-key introspection. Core is
 * the contract, not the reasoning. A reader looking for "what may I write" is in the right file; a
 * reader looking for "what does it decide" is one package out.
 */
import { z } from 'zod';
import { ElementQuerySchema, type ElementQuery } from '@/wire/types.js';
import { ElementState } from '@/wire/constants/constants.js';
import { PredicateKind } from '@/verdict/consequence.js';
import { propertyAssertionSchema, type PropertyAssertion } from './property-assertion.js';

export type Predicate =
  | {
      kind: typeof PredicateKind.ELEMENT;
      query: ElementQuery;
      state?: ElementState;
      absent?: boolean;
    }
  | {
      kind: typeof PredicateKind.TEXT;
      contains?: string;
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
      /** Match the scope root itself and check its combined subtree text. Requires `scope`. */
      self?: boolean;
      /**
       * Assert a PROPERTY of the rendered text rather than its exact bytes.
       *
       * The same reasoning `state` carries, applied where the user actually reads the value: an
       * app whose output IS a model's output is different on every run and correct on every one of
       * them, so `contains` is the one assertion it cannot satisfy twice. Both may be supplied and
       * then both must hold — `satisfies` narrows, it never excuses.
       */
      satisfies?: PropertyAssertion;
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
      /** Shallow JSON match over the RESPONSE body: this FIELD holds this value (#987). */
      bodyMatches?: Record<string, unknown>;
      /** A substring the REQUEST body must contain — what the UI sent, not what came back. */
      requestBodyContains?: string;
      /** Shallow JSON match over the REQUEST body, in the style of `signal.dataMatches`. */
      requestBodyMatches?: Record<string, unknown>;
    }
  | { kind: typeof PredicateKind.ROUTE; pathname?: string; contains?: string; since?: number }
  | {
      kind: typeof PredicateKind.CONSOLE;
      level?: string;
      /**
       * A substring the captured message must contain. With `absent: true` this flips the meaning
       * from "no console entries at all" to "THIS message did not appear" — the assertion people
       * actually write regression checks for (deprecation warnings, no-op handler notices).
       */
      contains?: string;
      absent?: boolean;
      since?: number;
    }
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
      /**
       * Exact number of matching signals in the window — the same cardinality assertion `net`
       * carries, on the channel the app itself speaks. Omit for presence (≥1).
       */
      count?: number;
      since?: number;
    }
  | {
      kind: typeof PredicateKind.STATE;
      store?: string;
      path: string;
      equals?: unknown;
      satisfies?: PropertyAssertion;
    }
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
  // `text`/`value`/`query` on a `text` predicate: the kind is called "text", so `text:` is the first
  // thing anyone writes for it, `value` follows from the element query's own `value` field, and
  // `query` from `element`'s nested locator, the spelling agents reach for after `reticle_query`.
  // All were hard rejections, and a rejected predicate produces NO verdict at all — the drive ends
  // with nothing rather than with a failure, which is the worst outcome of the three.
  [PredicateKind.TEXT]: { text: 'contains', value: 'contains', query: 'contains' },
  // `urlContains`/`url` reported from the field: an agent that had just written
  // `net { urlContains }` applied the same word to `route`, which spells it `contains`, and got
  // `unrecognized_keys` with no list of what would have worked. The parallel it assumed is a fair
  // one — route's `contains` matches the WHOLE route (path + query + fragment), so "the URL
  // contains this" is precisely what it does — and asserting a redirect after login is the single
  // most common thing an agent reaches for here.
  [PredicateKind.ROUTE]: { path: 'pathname', urlContains: 'contains', url: 'contains' },
  [PredicateKind.NET]: { url: 'urlContains', responseBodyMatches: 'bodyMatches' },
  // `textContains` on a `console` predicate: the reporter who hit the missing matcher reached for
  // it first, by analogy with `net { urlContains }` — and that parallel is exactly right, since
  // both mean "this entry must contain this substring". Accepted as an alias for `contains`.
  [PredicateKind.CONSOLE]: { textContains: 'contains' },
  [PredicateKind.SIGNAL]: { data: 'dataMatches' },
  // `of` on a composite: it reads naturally, several assertion libraries spell it that way, and it has
  // no other meaning here. Observed twice in one drive on a real app, and each rejection cost a round
  // trip AND produced no verdict — a composite is what an agent reaches for precisely when it has two
  // things to prove at once, so failing it is expensive at the worst moment.
  [PredicateKind.ALL_OF]: { of: 'predicates' },
  [PredicateKind.ANY_OF]: { of: 'predicates' },
  // `of` on `not` for the same reason it is accepted on the composites above — an agent that learned
  // the spelling one line earlier applies it to the third composite, and `not` was the one that
  // rejected it. The refusal did name `predicate`, but naming a field still costs the round trip
  // that produced no verdict, and the guess is unambiguous: `not` has exactly one child.
  [PredicateKind.NOT]: { of: 'predicate' },
};

/**
 * The word half the assertion world spells `kind`.
 *
 * A discriminated union rejects `{ type: "text", ... }` with "Invalid discriminator value" on a field
 * the caller never wrote, so the reply reads as being about `kind` — which is absent — and never
 * says the word `type`. Observed on a live drive as the first rung of a ladder: one field name
 * learned per rejected call, each costing a verdict. No predicate kind declares a `type` field, so
 * lifting it is unambiguous, and an explicit `kind` still wins.
 */
const KIND_SPELLING = 'type';

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

/** `type` read as the discriminator when — and only when — `kind` is absent. */
function renameKindSpelling(obj: Record<string, unknown>): Record<string, unknown> {
  if (obj['kind'] !== undefined || 'string' !== typeof obj[KIND_SPELLING]) return obj;
  const out: Record<string, unknown> = { ...obj, kind: obj[KIND_SPELLING] };
  delete out[KIND_SPELLING];
  return out;
}

/** Rename known aliases before parse; an explicit canonical key always wins. */
function applyPredicateAliases(input: unknown): unknown {
  if (typeof input !== 'object' || null === input || Array.isArray(input)) return input;
  const given = input as Record<string, unknown>;
  const obj = renameKindSpelling(given);
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
        /**
         * Optional ONLY because `satisfies` can carry the claim instead — see the refinement below,
         * which refuses a text predicate that names neither. A `text` predicate with nothing to
         * assert resolves to "some element, some text" and passes on every page that has one.
         */
        contains: z.string().optional(),
        visible: z.boolean().optional(),
        absent: z.boolean().optional(),
        scope: z.string().optional(),
        self: z.boolean().optional(),
        satisfies: propertyAssertionSchema.optional(),
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
        /**
         * Shallow JSON match over the RESPONSE body, keyed like `signal.dataMatches` and sharing its
         * `matchValue` operators (`*`, `$gte`, `$contains`, …) — the field-level half of
         * `bodyContains` (#987).
         *
         * `bodyContains` is a substring test, and the comment above says why that shape was chosen.
         * It leaves one assertion unsayable: "this FIELD holds this value". Reported from the field
         * as the only false green in that export — `bodyContains: "completed"` returned
         * `verified: "yes"` for a job whose status was `queued`, because the body carried
         * `"completedAt": null` and the needle matched the KEY. An enum state in a JSON response is
         * the natural reach for a substring and the one thing a substring cannot decide:
         * `completed`/`completedAt`, `success`/`successRate`, `sent`/`unsent`.
         *
         * `{ bodyMatches: { status: "completed" } }` cannot be satisfied by a key name, by a longer
         * sibling value, or by key order, whitespace and serialisation — all of which a substring
         * answers to. Use `bodyContains` for a non-JSON body, or when the substring IS the claim.
         *
         * A field whose captured value was REDACTED cannot be matched, and the verdict says so
         * instead of reporting a mismatch: a redacted field is unknown, not different.
         */
        bodyMatches: z.record(z.string(), z.unknown()).optional(),
        /**
         * A substring the REQUEST body must contain — the other half of `bodyContains`.
         *
         * `bodyContains` deliberately searches only the response, and the comment above says why:
         * searching the request too would let it pass on the very defect it exists to catch. That
         * reasoning is sound and it leaves a real gap. For a filter, a search or a form, the thing
         * under test IS the outgoing payload: "applying this filter actually sends it" had no
         * verdict at all, only `reticle_network { bodies: true }` and a human reading `requestBody`
         * by eye (#798).
         *
         * A separate field rather than a mode on `bodyContains`, so neither assertion can ever be
         * satisfied by the wrong half of the exchange.
         *
         * Requires body capture, and says so when the request body was never recorded rather than
         * reporting an ordinary mismatch.
         */
        requestBodyContains: z.string().min(1).optional(),
        /**
         * Shallow JSON match over the REQUEST body, keyed like `signal.dataMatches` and sharing its
         * `matchValue` operators (`*`, `$gte`, `$contains`, …).
         *
         * `{ requestBodyMatches: { filter: "manual_review" } }` is the one-call verdict for "the UI
         * put the selected value into the payload", and it does not care about key order,
         * whitespace or how the client serialised the object — all of which a substring does.
         *
         * A field whose captured value was REDACTED cannot be matched, and the verdict says so
         * instead of reporting a mismatch: a redacted field is unknown, not different.
         */
        requestBodyMatches: z.record(z.string(), z.unknown()).optional(),
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
        contains: z.string().min(1).optional(),
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
        /**
         * Exact number of matching signals since the action — presence becomes cardinality.
         *
         * The double-fire is the defect no state-only oracle can see: a handler wired twice fires
         * the signal twice, the store ends up in the right shape either way, and a presence check
         * is green on both. The wrong-name variant is the same blind spot from the other side — the
         * intended signal fires once while a mistyped sibling fires alongside it, and only a count
         * scoped to the matched name tells the two apart. Omit = presence (≥1); `0` asserts the
         * signal never fired, which is a claim in its own right and NOT the same as omitting it.
         */
        count: z.number().int().nonnegative().optional(),
        since: z.number().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.STATE),
        store: z.string().optional(),
        path: z.string(),
        equals: z.unknown().optional(),
        /*
         * Assert a PROPERTY instead of exact bytes, for output that is right differently every run.
         * `equals` cannot express a generated summary, a classification or a computed total; this
         * can, and stays decidable here with no model and no network. Supplying both is allowed and
         * both must hold.
         */
        satisfies: propertyAssertionSchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.SETTLED),
        quietMs: z.number().positive().optional(),
      })
      .strict(),
    /*
     * `.min(1)` on both combinators, because an EMPTY one is a false green and not an edge case.
     *
     * `allOf` over no members is vacuous truth — every member holds because there are none — so it
     * evaluated `pass: true` and reported `verified: "yes"` for a drive that asserted nothing.
     * Nobody writes that by hand; an agent that builds `predicates` by mapping over a list of
     * channels to check emits it the moment the list comes back empty.
     *
     * `anyOf` over no members is the mirror and is merely a false RED, which is honest-ish and far
     * cheaper. It is refused here anyway: one rule is easier to hold than two, and an empty `anyOf`
     * is a mistake in either direction.
     */
    z
      .object({
        kind: z.literal(PredicateKind.ALL_OF),
        predicates: z.array(PredicateSchema).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal(PredicateKind.ANY_OF),
        predicates: z.array(PredicateSchema).min(1),
      })
      .strict(),
    z.object({ kind: z.literal(PredicateKind.NOT), predicate: PredicateSchema }).strict(),
  ]);
}

/*
 * Cross-field rules, applied to every predicate INCLUDING the ones nested in a composite.
 *
 * They live on the union rather than on the member because `z.discriminatedUnion` takes plain
 * objects only — wrapping one member in a refinement makes the whole union refuse to build, and
 * `shapeForKind` walks those same options to derive the accepted-field list in a rejection message.
 */
function checkPredicateShape(predicate: unknown, ctx: z.RefinementCtx): void {
  // Structural and narrowed HERE, not in the signature: the refinement runs on the union zod
  // inferred, whose optional fields are spelled `| undefined`, and naming any concrete type in the
  // parameter makes the overload unresolvable. Only the four fields this reads are looked at.
  if ('object' !== typeof predicate || null === predicate) return;
  const p = predicate as {
    kind?: unknown;
    contains?: unknown;
    satisfies?: unknown;
    scope?: unknown;
  };
  if (PredicateKind.TEXT !== p.kind) return;
  if (undefined === p.contains && undefined === p.satisfies) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'a text predicate must say WHAT about the text: `contains` for a substring, `satisfies` ' +
        'for a property of it. With neither it matches any element with any text and cannot fail',
    });
  }
  if (undefined !== p.satisfies && undefined === p.contains && undefined === p.scope) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        '`satisfies` needs a subject: add `scope` (the element whose text is tested, with ' +
        '`self: true` to read the scope root itself) or a `contains` that selects one. Without ' +
        'either, the locator is every element on the page and the property would run against ' +
        'whichever one happened to match first',
    });
  }
}

export const PredicateSchema = z.lazy(() =>
  z.preprocess(applyPredicateAliases, predicateUnion()).superRefine(checkPredicateShape),
) as unknown as z.ZodType<Predicate>;
/**
 * The fields one predicate kind accepts, as the schema itself declares them.
 *
 * Exported because the ENGINE's introspection needs it and the union it reads is built here. A
 * second copy of the union next door is how a rejection message comes to name a stale field set,
 * which is worse than naming none: the agent trusts it and retries into the same wall.
 */
export function predicateShapeFor(kind: string): z.ZodRawShape | null {
  for (const option of predicateUnion().options) {
    const shape = (option as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape;
    const literal = shape?.['kind'];
    const value = (literal as unknown as { _def?: { value?: unknown } } | undefined)?._def?.value;
    if (value === kind) return shape as z.ZodRawShape;
  }
  return null;
}
