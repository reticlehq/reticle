/**
 * A property assertion: what a caller may claim about a value other than its exact bytes.
 *
 * The contract half only. `satisfiesProperty` — the function that DECIDES whether a reading has a
 * property — stays in the engine, with the baseline plumbing and the `show`/`numberIn` helpers it
 * reasons with. This file is what a flow file on disk can legally contain.
 *
 * Split out of the engine with the rest of the predicate contract, and for the same reason: a saved
 * flow carries one of these now, so core has to be able to parse what it reads.
 */
import { z } from 'zod';
import { MeasureOp } from 'open-verification';

export type PropertyAssertion =
  /** Produced something at all — the honest floor for any generated output. */
  | { readonly property: 'nonEmpty' }
  /** A classification landed inside the allowed set. Exact membership, no coercion. */
  | { readonly property: 'oneOf'; readonly values: readonly unknown[] }
  /** A number near enough to an expected one — inclusive on the bound. */
  | { readonly property: 'withinTolerance'; readonly of: number; readonly tolerance: number }
  /** The shape of the output, as a regular expression over its string form. */
  | { readonly property: 'matchesPattern'; readonly pattern: string }
  /** The right KIND of thing: `array` and `object` are distinguished, which `typeof` cannot do. */
  | {
      readonly property: 'type';
      readonly is: 'string' | 'number' | 'boolean' | 'array' | 'object';
    }
  /*
   * RELATIVE properties — the past tense, decided by two readings and a subtraction.
   *
   * `changed`/`unchanged` are the weakest and the most useful: "unchanged" is the assertion that
   * catches the field a re-render silently cleared, and it needs no number at all.
   *
   * `increased`/`decreased` take an optional delta in the protocol's own `MeasureOp` shape — three
   * operators and a tolerance on all of them, so "exactly 11.87", "11.87 ± 0.01" and "at least 3"
   * are one shape with no conditional requirement anywhere. A second spelling of a comparison the
   * protocol already publishes is exactly the drift this release is ending, so there is no `$gt`.
   */
  | { readonly property: 'changed' }
  | { readonly property: 'unchanged' }
  | { readonly property: 'increased'; readonly by?: Delta }
  | { readonly property: 'decreased'; readonly by?: Delta };

/** How far a reading moved, in the protocol's comparison vocabulary. Tolerance defaults to exact. */
export interface Delta {
  readonly op: MeasureOp;
  readonly value: number;
  readonly tolerance?: number;
}

/**
 * The reading taken BEFORE the action, when one was taken.
 *
 * A wrapper rather than a bare value because `undefined` is a legitimate reading — a store path
 * that held nothing — and "the path was empty" and "nobody looked" must not collapse into the same
 * answer. The first is a comparison; the second is a refusal to pretend one happened.
 */
export interface Baseline {
  readonly taken: true;
  readonly value: unknown;
}

const deltaSchema = z
  .object({
    op: z.nativeEnum(MeasureOp),
    value: z.number().finite(),
    /** Never negative — a negative tolerance NARROWS the band, which is a different claim by accident. */
    tolerance: z.number().finite().nonnegative().optional(),
  })
  .strict();

export const propertyAssertionSchema = z.discriminatedUnion('property', [
  z.object({ property: z.literal('nonEmpty') }).strict(),
  z.object({ property: z.literal('oneOf'), values: z.array(z.unknown()).min(1) }).strict(),
  z
    .object({
      property: z.literal('withinTolerance'),
      of: z.number().finite(),
      tolerance: z.number().finite().nonnegative(),
    })
    .strict(),
  z.object({ property: z.literal('matchesPattern'), pattern: z.string().min(1) }).strict(),
  z
    .object({
      property: z.literal('type'),
      is: z.enum(['string', 'number', 'boolean', 'array', 'object']),
    })
    .strict(),
  z.object({ property: z.literal('changed') }).strict(),
  z.object({ property: z.literal('unchanged') }).strict(),
  z.object({ property: z.literal('increased'), by: deltaSchema.optional() }).strict(),
  z.object({ property: z.literal('decreased'), by: deltaSchema.optional() }).strict(),
]);
