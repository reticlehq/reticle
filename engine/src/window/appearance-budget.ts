/**
 * Whether to act on what a name matched, wait for it, or refuse.
 *
 * Batching a whole journey into one round trip is the only way to stop paying a model turn per
 * step, and it needs every step's element named up front. But the element a later step acts on
 * often does not exist when the batch is submitted: the modal step 1 opens, the row step 2 creates.
 * Resolving each name with a single query fails those instantly, which is exactly why an agent
 * falls back to snapshot, act, snapshot, act — and that loop, not the engine, is where the time goes.
 *
 * Waiting fixes it. Only one kind of waiting is safe, and the asymmetry below IS the design:
 *
 *   ONE match   act. Nothing to decide.
 *   ZERO        wait, while budget remains. The element may still be arriving, and there is nothing
 *               else it could be confused with, so waiting cannot act on the wrong thing.
 *   MANY        refuse NOW, and never wait. This is the dangerous case and the reason this is a
 *               function rather than a retry loop: given time, a second element can arrive and make
 *               an ambiguous name resolve to whichever one the race happened to settle on. "It
 *               became unambiguous while I waited" is not the caller's intent — it is a coin toss
 *               the caller never saw, and the caller is the only one who can fix the name.
 *
 * Nothing here decides whether a consequence was PROVED. It decides only when to look again, which
 * is why it can be this aggressive without touching a verdict.
 */

/** How long to pause between looks. Short enough to catch a fast render, long enough not to spin. */
const POLL_MS = 120;

export interface AppearanceInput {
  /** How many elements the name matched on the most recent look. */
  readonly matches: number;
  /** How long this step has already spent looking. */
  readonly elapsedMs: number;
  /** The step's whole budget. Zero means the caller asked never to wait. */
  readonly budgetMs: number;
}

export type AppearanceDecision =
  | { readonly do: 'act' }
  | { readonly do: 'wait'; readonly waitMs: number }
  | { readonly do: 'refuse'; readonly because: string };

export function appearanceDecision(input: AppearanceInput): AppearanceDecision {
  /*
   * Ambiguity first, before any budget arithmetic, so no future edit to the timing can accidentally
   * make a name that matches several things resolve by waiting.
   */
  if (input.matches > 1) {
    return {
      do: 'refuse',
      because: `that name is ambiguous — it matched ${String(input.matches)} elements, and waiting cannot fix that: it would only change which one gets acted on. Name the one you mean.`,
    };
  }
  if (1 === input.matches) return { do: 'act' };
  const remaining = input.budgetMs - input.elapsedMs;
  if (remaining <= 0) {
    return {
      do: 'refuse',
      because: `that name never appeared — nothing matched it within ${String(input.budgetMs)}ms. If it should have been there already, take a snapshot; if an earlier step was supposed to produce it, that step is the one that failed.`,
    };
  }
  return { do: 'wait', waitMs: Math.min(POLL_MS, remaining) };
}
