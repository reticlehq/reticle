/**
 * What the predicate engine adds to the CONTRACT: the fields a browser locator drops, and the
 * introspection the tool surface builds its descriptions from.
 *
 * The shape itself — `Predicate`, `PredicateSchema`, the aliases and the union — moved to
 * `@reticlehq/core`, because a saved flow now carries one and core has to be able to parse what it
 * reads off disk. Core is the contract; this is the reasoning over it. Both halves are re-exported
 * from here, so every existing importer of this module keeps working unchanged.
 */
import { z } from 'zod';
import {
  PredicateKind,
  PredicateSchema,
  QueryBy,
  predicateShapeFor,
  type ElementDescriptor,
  type ElementQuery,
} from '@reticlehq/core';

// One public surface, two packages. A caller asking this module for the shape is asking the right
// module; it simply no longer OWNS it.
export { PredicateSchema } from '@reticlehq/core';
export type { Predicate, PropertyAssertion } from '@reticlehq/core';

/*
 * This file used to keep its own list of element-query fields, and issue #1375 is what that cost:
 *
 * core's copy had fallen four fields behind `ElementQuerySchema` (`scope`, `self`,
 * `attrs`, `source`) while this one had not, so the two disagreed about what a flat element
 * predicate may say. The list is gone: `residualQueryChecks` walks the query's OWN keys instead —
 * the fields the caller actually wrote — which cannot fall behind a schema the query was parsed
 * against, and costs no new core import (the engine's borrow count is a ceiling, not a budget).
 */

/**
 * The locator fields the browser actually CONSUMES for a given query — mirrors the precedence in
 * `findIn` (adapters/realm/browser/src/dom/query.ts).
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
  // `scope`, `attrs` and `self` are not locator fields, so no branch below consumes them and none is
  // dropped: `scope` narrows WHERE the search runs (resolved before any locator branch runs),
  // `attrs` projects the match, and `self` selects the scope root. Claiming these here — whatever
  // their value — is what keeps them from being refused for merely existing.
  //
  // `source` is deliberately NOT one of them. It IS a locator — the anchor `component` is, consumed
  // on exactly the same two branches — and it is claimed there and only there. Claiming it here too
  // is what let a `by`+`value` query, or a `self: true` one, report the locator as having used a
  // `source` it never read: the browser resolves those by `by`+`value` (or the scope root) and
  // returns before `findBySource` is reached, so the predicate could pass for an element other than
  // the one the caller's source location identified. Unclaimed, it falls through to the residual
  // walk and is refused — exactly as `component` already is in the same position.
  if (query.scope !== undefined) used.add('scope');
  if (query.attrs !== undefined) used.add('attrs');
  if (query.self !== undefined) used.add('self');
  // The browser's `self` branch checks subtree text when supplied, but skips every other locator.
  // Mark only text as consumed so role/name/etc. remain residual checks on the returned descriptor.
  if (true === query.self) return query.text === undefined ? used : used.add('text');
  if (query.by !== undefined && query.value !== undefined) {
    used.add('by').add('value');
    if (QueryBy.ROLE === query.by) used.add('name');
    // `by: "component"` resolves through `findByComponent`, which tries the source stamp first and
    // falls back to the component name — so a `source` written here IS consumed.
    if (QueryBy.COMPONENT === query.by) {
      used.add('component');
      if (query.source !== undefined) used.add('source');
    }
    return used;
  }
  // The auto-anchor branch, reached only without `by`+`value`: `source` (precise) then `component`.
  if (query.component !== undefined || query.source !== undefined) {
    used.add('component');
    if (query.source !== undefined) used.add('source');
    return used;
  }
  if (query.role !== undefined) return used.add('role').add('name');
  for (const field of ['text', 'label', 'placeholder', 'testid', 'alt'] as const) {
    if (query[field] !== undefined) return used.add(field);
  }
  return used;
}

/**
 * The role the browser reports for an `<img>`. It stands in for "an image" because the descriptor
 * carries no tag name, so anything else with this role — an `<svg role="img">` — counts as one too.
 */
const IMAGE_ROLE = 'img';
const ALT_FIELD = 'alt';
/** How a failure reports an image that carries no `alt` attribute at all. */
const NO_ALT_ATTRIBUTE = '(no alt attribute)';

/** What the refusal says about `alt` on something that is not an image, and what to assert instead. */
const ALT_IMAGE_ONLY = '`alt` can only be checked on an image';
const ALT_USE_NAME =
  'For an element that is not an image, assert its accessible name with `name` instead.';

function isImage(element: ElementDescriptor): boolean {
  return IMAGE_ROLE === element.role;
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
 *
 * `alt` is read from the image's `alt` ATTRIBUTE, projected onto the match by `withAltProjected` —
 * not from its accessible name. Both a decorative `alt=""` and a missing alt give an empty name, and
 * only the attribute tells them apart: a missing alt is the defect `alt: ""` exists to rule out. On
 * anything but an image it is false, and `describeAltOnNonImage` turns that into a refusal.
 */
/**
 * Does an element whose computed role is `actual` satisfy a query for `queried`?
 *
 * `searchbox` is an ARIA sub-role of `textbox`. A standard search input computes as `searchbox`
 * (per HTML-AAM), which matches `{ role: "searchbox" }`. A `{ role: "textbox" }` query must
 * keep matching it as well, so existing flows and recorded steps using `textbox` continue to match.
 */
function matchesRole(actual: string, queried: string): boolean {
  if (actual === queried) return true;
  if ('textbox' === queried && 'searchbox' === actual) return true;
  return false;
}

const RESIDUAL_CHECKS: Readonly<
  Record<string, (element: ElementDescriptor, want: string) => boolean>
> = {
  value: (element, want) => (element.value ?? '').trim() === want.trim(),
  role: (element, want) => matchesRole(element.role, want),
  name: (element, want) => element.name.trim() === want.trim(),
  text: (element, want) => (element.text ?? element.name).includes(want),
  [ALT_FIELD]: (element, want) => {
    const alt = element.attrs?.[ALT_FIELD];
    return isImage(element) && alt !== undefined && alt.trim() === want.trim();
  },
};

/** The query to send, asking the browser to project `alt` when this side has to check it. */
export function withAltProjected(
  query: ElementQuery,
  checks: readonly [string, string][],
): ElementQuery {
  const attrs = query.attrs ?? [];
  if (!checks.some(([field]) => ALT_FIELD === field) || attrs.includes(ALT_FIELD)) return query;
  return { ...query, attrs: [...attrs, ALT_FIELD] };
}

/**
 * Why `alt` cannot be checked, when none of the matched elements is an image — or `undefined` when
 * it can. A button has no alt, so grading it "no" would read as "the alt is wrong" when the truth is
 * "this is not an image": a refusal that says what to use instead costs one turn.
 *
 * Only the case where NO match is an image is refused. With an image among them, the others simply do
 * not satisfy `alt`, and the verdict is about the images.
 */
export function describeAltOnNonImage(
  checks: readonly [string, string][],
  elements: readonly ElementDescriptor[],
): string | undefined {
  const wantsAlt = checks.some(([field]) => ALT_FIELD === field);
  if (!wantsAlt || 0 === elements.length || elements.some(isImage)) return undefined;
  const roles = [...new Set(elements.map((element) => element.role))].join(', ');
  return `${ALT_IMAGE_ONLY}, and the element matched is ${roles}, not ${IMAGE_ROLE}. ${ALT_USE_NAME}`;
}

interface ResidualQueryChecks {
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
  // The query's own keys, not a list beside the schema. Every field here was written by the caller
  // and survived parsing, so it is one the locator either consumes or drops — which is the whole
  // question. Reading them off the query also means the set cannot drift from `ElementQuerySchema`.
  for (const field of Object.keys(query) as (keyof ElementQuery)[]) {
    const want = query[field];
    if (want === undefined || used.has(field)) continue;
    if ('string' === typeof want && RESIDUAL_CHECKS[field] !== undefined)
      checks.push([field, want]);
    else unusable.push(field);
  }
  return { checks, unusable };
}

/** Explain an element query whose locator drops fields it cannot verify. */
export function describeUnusableElementQuery(
  query: ElementQuery,
  unusable: readonly string[],
): string {
  const preservedChecks = Object.fromEntries(residualQueryChecks(query).checks);
  const roleAlternatives =
    QueryBy.ROLE === query.by && query.value === undefined && query.role !== undefined
      ? ` For this role locator, use ${JSON.stringify({ by: QueryBy.ROLE, value: query.role, ...(query.name === undefined ? {} : { name: query.name }), ...preservedChecks })} or ${JSON.stringify({ role: query.role, ...(query.name === undefined ? {} : { name: query.name }), ...preservedChecks })}.`
      : '';
  return (
    `the element locator ignores ${unusable.map((field) => `\`${field}\``).join(', ')} ` +
    `in ${JSON.stringify(query)} — it resolves by the first of by+value, component/source, role, ` +
    'text, label, placeholder, testid, alt that is present, and nothing here can check the rest.' +
    roleAlternatives +
    ' Assert them one locator at a time, or move the extra field into the locator.'
  );
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
          : ALT_FIELD === field
            ? (element.attrs?.[ALT_FIELD] ?? NO_ALT_ATTRIBUTE)
            : element.name;
  return `${element.role} "${element.name}" ${field}=${JSON.stringify(reading)}`;
}

/**
 * The fields a given predicate kind accepts, read off the schema itself.
 *
 * Derived rather than listed so the two can never disagree: a rejection message that names a stale
 * field set is worse than one that names none, because the agent trusts it and retries into the same
 * wall. Empty for a kind that is not in the union.
 */
export function predicateFieldsFor(kind: string): readonly string[] {
  const shape = shapeForKind(kind);
  if (null === shape) return [];
  return Object.keys(shape).filter((field) => 'kind' !== field);
}

/**
 * The union option for `kind`, or null when the kind is not one.
 *
 * One place that walks the union, so the field list and the nested lookup cannot disagree about
 * which option a kind resolves to. The walk itself is now core's, because the union is: a second
 * copy here would be a second answer to "what fields does this kind take", and the rejection
 * messages built from it would eventually name a field set the schema no longer has.
 */
const shapeForKind = predicateShapeFor;

/**
 * Is this tool parameter ACTUALLY the predicate union?
 *
 * Not a name check. `until` is overloaded on this surface — the act/assert family means a predicate
 * by it, while reticle_observe / _network / _console mean a NUMBER, an upper cursor bound — so any
 * caller keying on the word would treat a numeric parameter as a predicate and describe it to the
 * agent as an object. Keying on the schema cannot make that mistake.
 *
 * Lives beside the schema because two callers now ask the question: the lean tool surface, which
 * compacts these parameters, and `reticle_tools`, which spells their grammar out on request. Two
 * spellings of "is this a predicate" is one chance for the surface and the grammar to disagree.
 */
export function isPredicateParam(schema: z.ZodTypeAny): boolean {
  const inner = schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodTypeAny) : schema;
  return inner === PredicateSchema || inner === (PredicateSchema as z.ZodTypeAny).optional();
}

/**
 * Every kind's fields, in one block an agent can write a predicate from.
 *
 * The tool surface advertises the KIND list and points at `reticle_tools` for the fields, because
 * inlining the 12-variant recursive union in the declared JSON Schema costs thousands of characters
 * per predicate parameter, re-sent every turn, to describe a grammar most calls use one variant of.
 * That trade is right — but the pointer has to land somewhere, and it landed on a parameter
 * description reading "same shape as reticle_assert". So the grammar was reachable from nothing, and
 * an agent that could not find `route`'s fields fell back to a `text` check where a route check was
 * meant: the weaker oracle, which is the expensive half of an undiscoverable grammar.
 *
 * Derived from the schema, like `predicateFieldsFor` and for the same reason: a hand-written grammar
 * that drifts is worse than none, because the agent trusts it and retries into the same wall.
 */
function formatNestedFieldHints(hints: Readonly<Record<string, string>>): string {
  return Object.entries(hints)
    .map(([key, hint]) => `${key}: ${hint}`)
    .join(', ');
}

export function predicateGrammar(): Readonly<Record<string, string>> {
  const grammar: Record<string, string> = {};
  for (const kind of Object.values(PredicateKind)) {
    const nested = predicateNestedFieldHintsFor(kind);
    grammar[kind] = predicateFieldsFor(kind)
      .map((field) => {
        const hints = nested[field];
        return undefined === hints ? field : `${field} { ${formatNestedFieldHints(hints)} }`;
      })
      .join(', ');
  }
  return grammar;
}

/**
 * The keys of a field that is an object, once its wrappers are peeled. Empty for anything else.
 *
 * Exported so the wrapper handling is asserted against THIS function rather than through the
 * rendered sentence. Reached only that way, a wrapper it fails to peel returns `[]`, the old
 * message prints unchanged, and nothing reddens — a regression with no symptom.
 *
 * No top-level predicate field is currently declared behind a wrapper, so the real schema exercises
 * none of these paths; that is exactly why they are worth a case each.
 */
export function nestedKeysOf(schema: z.ZodTypeAny | undefined): readonly string[] {
  if (undefined === schema) return [];
  const inner = unwrapSchema(schema);
  // A union of objects (`compare`'s `left`/`right`) lists every option's keys: which ones apply is
  // decided by the discriminator, and the rejection already names that.
  if (inner instanceof z.ZodDiscriminatedUnion) {
    const options = inner.options as readonly z.ZodTypeAny[];
    return [...new Set(options.flatMap((option) => nestedKeysOf(option)))];
  }
  return Object.keys(nestedFieldHintsOf(schema));
}

/**
 * A one-line type hint for a zod field, derived from the schema rather than hand-written.
 *
 * `predicateGrammar` already named nested field names; without their value domains agents burned
 * round trips learning that `by` has no `css` and `attrs` is an array.
 */
export function fieldHintOf(schema: z.ZodTypeAny | undefined): string {
  if (undefined === schema) return 'unknown';
  const inner = unwrapSchema(schema);
  if (inner instanceof z.ZodString) return 'string';
  if (inner instanceof z.ZodNumber) return 'number';
  if (inner instanceof z.ZodBoolean) return 'boolean';
  if (inner instanceof z.ZodArray) {
    const item = zodTypeOf(inner.element);
    if (undefined === item) return 'unknown[]';
    return `${fieldHintOf(item)}[]`;
  }
  if (inner instanceof z.ZodNativeEnum) {
    const values = inner._def.values as Record<string, string | number>;
    return Object.values(values).join('|');
  }
  if (inner instanceof z.ZodEnum) {
    const values = inner._def.values as readonly string[];
    return values.join('|');
  }
  if (inner instanceof z.ZodRecord) return 'record';
  if (inner instanceof z.ZodObject) {
    const shape = (inner as z.ZodObject<z.ZodRawShape>).shape;
    const parts = Object.entries(shape).flatMap(([key, raw]) => {
      const keySchema = zodTypeOf(raw);
      if (undefined === keySchema) return [];
      return [`${key}: ${fieldHintOf(keySchema)}`];
    });
    return `{ ${parts.join(', ')} }`;
  }
  return 'unknown';
}

/** The value-domain hint for each key of a one-level nested object field. */
export function nestedFieldHintsOf(
  schema: z.ZodTypeAny | undefined,
): Readonly<Record<string, string>> {
  if (undefined === schema) return {};
  const inner = unwrapSchema(schema);
  if (inner instanceof z.ZodDiscriminatedUnion) {
    const merged: Record<string, string> = {};
    const options = inner.options as readonly z.ZodTypeAny[];
    for (const option of options) {
      for (const [key, hint] of Object.entries(nestedFieldHintsOf(option))) {
        if (!(key in merged)) merged[key] = hint;
      }
    }
    return merged;
  }
  if (!(inner instanceof z.ZodObject)) return {};
  const shape = (inner as z.ZodObject<z.ZodRawShape>).shape;
  const hints: Record<string, string> = {};
  for (const [key, raw] of Object.entries(shape)) {
    const keySchema = zodTypeOf(raw);
    if (undefined === keySchema) continue;
    hints[key] = fieldHintOf(keySchema);
  }
  return hints;
}

function zodTypeOf(value: unknown): z.ZodTypeAny | undefined {
  return value instanceof z.ZodType ? value : undefined;
}

/** Peel optional/nullable/default/effects wrappers off a field to reach the schema underneath. */
function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current._def.schema as z.ZodTypeAny;
      continue;
    }
    return current;
  }
}

/**
 * One level into the fields that are themselves objects — `{ query: ['by', 'value', ...] }`.
 *
 * Naming the top-level fields alone leaves `element` unguessable: `query` is an object with its own
 * required shape, and a plain CSS string works in `reticle_snapshot.scope` and `reticle_query.scope`,
 * so assuming it works here is the natural guess. The rejection is the only place that inconsistency
 * can be explained.
 *
 * One level only. Derived from the schema for the same reason `predicateFieldsFor` is: a stale field
 * list is worse than none, because the agent trusts it and retries into the same wall.
 */
export function predicateNestedFieldsFor(
  kind: string,
): Readonly<Record<string, readonly string[]>> {
  const hints = predicateNestedFieldHintsFor(kind);
  const nested: Record<string, readonly string[]> = {};
  for (const [field, fieldHints] of Object.entries(hints)) {
    nested[field] = Object.keys(fieldHints);
  }
  return nested;
}

/** Nested object fields with a value-domain hint beside each key — what `predicateGrammar` prints. */
export function predicateNestedFieldHintsFor(
  kind: string,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const shape = shapeForKind(kind);
  if (null === shape) return {};
  const nested: Record<string, Readonly<Record<string, string>>> = {};
  for (const [field, schema] of Object.entries(shape)) {
    if ('kind' === field) continue;
    const hints = nestedFieldHintsOf(schema);
    if (0 < Object.keys(hints).length) nested[field] = hints;
  }
  return nested;
}
