import { z } from 'zod';
import { ChannelIdSchema } from './channel.js';
import type { Observation } from './evidence.js';

/**
 * The few predicate shapes this specification evaluates itself.
 *
 * ── WHY THIS EXISTS, GIVEN THAT `Assertion.predicate` IS DELIBERATELY OPAQUE ────────────────────
 * It still is. A general predicate language is a realm's business and the part of a specification
 * that ages worst, and nothing here narrows what an implementation may accept.
 *
 * What the opaque field could not do was let two implementations be COMPARED. The adjudicator's
 * clause 4 -- "the declared consequence did not hold" -- is unreachable unless somebody evaluates
 * the claim, and nobody can evaluate a predicate written in a language they do not speak. So
 * every conformance scenario described its condition in prose, every binding passed
 * `assertionsHeld: undefined`, and a claim that named a count could not be contradicted by two
 * writes. The same shape of defect as `impeaching`: a field defined, deferred to somebody, and
 * evaluated by nobody.
 *
 * These forms are therefore chosen to be the smallest set that makes the clause reachable, not a
 * language:
 *
 *   - they read only what an `Observation` carries in EVERY realm -- its channel, its summary,
 *     and its rendered value -- so a service, a robot and a browser answer them the same way;
 *   - they are about COUNTING and PRESENCE, which is what a claim about a consequence mostly is
 *     ("exactly one charge", "a receipt came back", "nothing was written");
 *   - anything richer stays opaque and evaluates to `undefined`, which means *nobody evaluated
 *     this*, and is honest rather than absent.
 */

/** How a predicate selects the observations it is about. */
export const MatchSchema = z.object({
  /** The channel the observations must have come from. */
  channel: ChannelIdSchema,
  /**
   * The observation's `summary`, exactly.
   *
   * Exact rather than a pattern on purpose: a summary is a short realm-defined label, and a
   * regular expression over it would be a predicate language arriving through the back door.
   */
  summary: z.string().min(1).optional(),
  /**
   * A substring of the observation's rendered value.
   *
   * The weakest thing here, and it says so. Rendering is an implementation's own, so two
   * conformant implementations may disagree about whether this matches. Use it to name an
   * endpoint or an identifier -- something that survives any reasonable rendering -- and never as
   * the whole of a claim.
   */
  valueContains: z.string().min(1).optional(),
});
export type Match = z.infer<typeof MatchSchema>;

/** Comparisons a count may be held to. */
export const CountOp = {
  EXACTLY: 'exactly',
  AT_LEAST: 'at-least',
  AT_MOST: 'at-most',
} as const;
export type CountOp = (typeof CountOp)[keyof typeof CountOp];

export const PredicateKind = {
  /** How many matching observations the window holds. */
  COUNT: 'count',
  /** At least one matching observation. `count at-least 1`, named because claims say it often. */
  PRESENT: 'present',
  /**
   * No matching observation.
   *
   * Weaker than it looks and the specification will not let it be forgotten: this is an ABSENCE
   * inside a window whose end the verifier chose. It can be true because nothing happened or
   * because nothing had happened YET, and an implementation is expected to reflect that in
   * coverage rather than in a confident `yes`.
   */
  ABSENT: 'absent',
} as const;
export type PredicateKind = (typeof PredicateKind)[keyof typeof PredicateKind];

export const PredicateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(PredicateKind.COUNT),
    match: MatchSchema,
    op: z.nativeEnum(CountOp),
    value: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal(PredicateKind.PRESENT), match: MatchSchema }),
  z.object({ kind: z.literal(PredicateKind.ABSENT), match: MatchSchema }),
]);
export type Predicate = z.infer<typeof PredicateSchema>;

/** Does this observation fall inside the predicate's selection? */
export function matches(match: Match, observation: Observation, rendered: string): boolean {
  if (observation.channel !== match.channel) return false;
  if (match.summary !== undefined && observation.summary !== match.summary) return false;
  if (match.valueContains !== undefined && !rendered.includes(match.valueContains)) return false;
  return true;
}

/**
 * How an observation's value is rendered for `valueContains`.
 *
 * Named and exported rather than inlined so that an implementation matching this specification's
 * behaviour has something exact to match, and so a disagreement about a substring has a single
 * place to be resolved.
 */
export function render(value: unknown): string {
  if ('string' === typeof value) return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // A value that will not serialise -- a cycle, a live handle. Unmatched rather than guessed at.
    return '';
  }
}

/**
 * Evaluate a predicate over a window's observations.
 *
 * `undefined` is a real answer and the most important one: it means NOBODY EVALUATED THIS, which
 * the adjudicator must not read as either pass or fail. It is returned for any predicate this
 * specification does not name -- an implementation's own language is not wrong, it is merely not
 * something this function can speak.
 */
export function evaluate(
  predicate: unknown,
  observations: readonly Observation[],
): boolean | undefined {
  const parsed = PredicateSchema.safeParse(predicate);
  if (!parsed.success) return undefined;
  const p = parsed.data;
  const found = observations.filter((o) => matches(p.match, o, render(o.value)));
  switch (p.kind) {
    case PredicateKind.PRESENT:
      return found.length > 0;
    case PredicateKind.ABSENT:
      return 0 === found.length;
    case PredicateKind.COUNT:
      if (CountOp.EXACTLY === p.op) return found.length === p.value;
      if (CountOp.AT_LEAST === p.op) return found.length >= p.value;
      return found.length <= p.value;
  }
}

/**
 * Did a claim's assertions hold?
 *
 * Three-valued, and it must stay that way. `undefined` when NO assertion could be evaluated --
 * "nobody checked" -- and a single evaluable assertion is enough to answer, because an
 * implementation that can check one of three conditions has still learned something about the
 * claim. A false among them is decisive: a claim whose parts are conjunctive fails on any one.
 */
export function assertionsHeld(
  assertions: readonly { readonly predicate?: unknown }[],
  observations: readonly Observation[],
): boolean | undefined {
  const answers = assertions
    .map((a) => evaluate(a.predicate, observations))
    .filter((v): v is boolean => undefined !== v);
  if (0 === answers.length) return undefined;
  return answers.every((v) => v);
}
