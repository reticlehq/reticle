/**
 * The `compare` predicate's contract: where each side's value is read from, and how the two are
 * compared.
 *
 * Every other predicate checks one observation against a value the CALLER supplies. That leaves one
 * claim unsayable: "the page shows what the server answered". The refund case is the one that
 * shipped — the server read `1187.01` as paise and answered `{"refunded":11.87}`, the page displayed
 * the number the user had typed, and every channel was green. `bodyContains` catches it only when
 * the agent already knows the right number, and an agent verifying a fix usually does not.
 *
 * `compare` reads two observed values and relates them, so the claim needs no expected value at all.
 * The sources are the four channels that carry a VALUE (a request or response field, a signal
 * payload field, a store path, an element's text). Route, console and animation carry events, not
 * values, so they are not sources.
 */
import { z } from 'zod';
import { PredicateKind } from './consequence.js';

/** Which half of an exchange a `net` source reads. */
export const NetBodySide = {
  RESPONSE: 'response',
  REQUEST: 'request',
} as const;
export type NetBodySide = (typeof NetBodySide)[keyof typeof NetBodySide];

/**
 * How the two readings are compared.
 *
 * `value` is strict equality of two scalars: `"11.87"` and `11.87` differ, because text and a JSON
 * number are different things and saying they agree would be a guess. `number` reads ONE number out
 * of each side (a JSON number as is, a string by its only numeric token, so `"₹1,187.01"` reads as
 * 1187.01) and compares those, within `tolerance`. A string with no number, or with two, is
 * unreadable rather than unequal: picking one would be a guess about which the caller meant.
 */
export const CompareAs = {
  VALUE: 'value',
  NUMBER: 'number',
} as const;
export type CompareAs = (typeof CompareAs)[keyof typeof CompareAs];

export type CompareSource =
  | {
      from: typeof PredicateKind.NET;
      urlContains: string;
      method?: string;
      /** Which body the path reads. Defaults to the response, the half a UI cannot fake. */
      body?: NetBodySide;
      path: string;
    }
  | { from: typeof PredicateKind.SIGNAL; name: string; path: string }
  | { from: typeof PredicateKind.STATE; store?: string; path: string }
  /** The whole text of the element `scope` names (a CSS selector), itself included. */
  | { from: typeof PredicateKind.TEXT; scope: string };

/** A path into a JSON value: `data.total`, `items.0.id` — the grammar `state.path` speaks. */
const pathField = z.string().min(1);

/**
 * Cast rather than annotated for the reason `PredicateSchema` is: zod infers optional fields as
 * `| undefined`, which `exactOptionalPropertyTypes` will not assign to the hand-written type.
 */
export const CompareSourceSchema = z.discriminatedUnion('from', [
  z
    .object({
      from: z.literal(PredicateKind.NET),
      urlContains: z.string().min(1),
      method: z.string().optional(),
      body: z.enum([NetBodySide.RESPONSE, NetBodySide.REQUEST]).optional(),
      path: pathField,
    })
    .strict(),
  z
    .object({ from: z.literal(PredicateKind.SIGNAL), name: z.string().min(1), path: pathField })
    .strict(),
  z
    .object({ from: z.literal(PredicateKind.STATE), store: z.string().optional(), path: pathField })
    .strict(),
  z.object({ from: z.literal(PredicateKind.TEXT), scope: z.string().min(1) }).strict(),
]) as unknown as z.ZodType<CompareSource>;

/**
 * Does this source read a value the APP produced — a request, a payload, a store — rather than
 * rendered text?
 *
 * Decides how a `compare` grades. With at least one such side, a pass means the page agrees with the
 * app's own record of what happened, which a healed-but-wrong locator cannot fake. Text against text
 * is a presence-grade claim, because both sides are readings of the same DOM.
 */
export function isConsequenceSource(source: CompareSource): boolean {
  return PredicateKind.TEXT !== source.from;
}

/**
 * Do two sources read the same value, for refusing a comparison with itself?
 *
 * Spelled-out defaults are filled in first. Otherwise `{ body: "response" }` against a source that
 * left `body` out would read as two different sources, and a comparison that cannot fail would get
 * past the refusal just by being written two ways.
 */
export function sameCompareSource(a: CompareSource, b: CompareSource): boolean {
  const left = withDefaults(a);
  const right = withDefaults(b);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}

function withDefaults(source: CompareSource): Record<string, unknown> {
  // The network reader matches methods case-blind, so `GET` and `get` pick the same call.
  if (PredicateKind.NET === source.from)
    return {
      ...source,
      body: source.body ?? NetBodySide.RESPONSE,
      method: source.method?.toUpperCase(),
    };
  return { ...source };
}
