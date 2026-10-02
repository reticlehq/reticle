/**
 * The reading taken BEFORE the action, so a predicate can talk about the past.
 *
 * Every leaf in the grammar read the present tense — the DOM now, the store now, the events since a
 * cursor — so the assertions that catch money bugs could not be written: the balance went down by
 * what was charged, the list gained three rows, this field held its value across the re-render.
 *
 * Nothing new is observed to make them writable. `already-true` was already taking a pre-action
 * reading and throwing it away one function short of being this feature; the only change is that a
 * leaf which asked for a comparison gets its own value kept.
 *
 * Deliberately just "before this action" — the window every verdict is already scoped to — and not
 * arbitrary named checkpoints. A `snapshot("cart")` / `compare("cart")` pair is a different feature
 * and has no evidence behind it.
 */
import { PredicateKind, ReticleCommand } from '@reticlehq/core';
import type { Predicate } from '@/question/predicate/predicate.js';
import type { Baseline } from '@/question/predicate/property.js';
import type { PredicateSession } from '@/question/predicate/predicate-session.js';

/** The properties that mean nothing without a before-reading. Mirrors `RELATIVE` in property.ts. */
const NEEDS_BASELINE: ReadonlySet<string> = new Set([
  'changed',
  'unchanged',
  'increased',
  'decreased',
]);

/**
 * Does this leaf's claim compare two readings?
 *
 * Exported because `readsDomState` has to exclude exactly these. A relative property is NEVER
 * answerable before the action — `unchanged` is trivially true against a baseline taken a
 * microsecond earlier — so pre-checking one would report `already_true` for the assertion whose
 * entire purpose is that the value survives what comes next, and turn its verdict into UNKNOWN.
 */
export function asksForComparison(predicate: Predicate): boolean {
  if (PredicateKind.STATE === predicate.kind || PredicateKind.TEXT === predicate.kind) {
    return predicate.satisfies !== undefined && NEEDS_BASELINE.has(predicate.satisfies.property);
  }
  return false;
}

/** Every leaf that asked for a comparison, composites included. */
function leavesNeedingBaseline(predicate: Predicate, into: Predicate[]): void {
  switch (predicate.kind) {
    case PredicateKind.ALL_OF:
    case PredicateKind.ANY_OF:
      for (const part of predicate.predicates) leavesNeedingBaseline(part, into);
      return;
    case PredicateKind.NOT:
      leavesNeedingBaseline(predicate.predicate, into);
      return;
    default:
      if (asksForComparison(predicate)) into.push(predicate);
  }
}

/** Does the whole tree need a pre-action reading at all? One walk, so the caller pays nothing. */
export function needsBaseline(predicate: Predicate | undefined): boolean {
  if (predicate === undefined) return false;
  const found: Predicate[] = [];
  leavesNeedingBaseline(predicate, found);
  return found.length > 0;
}

async function readStateValue(
  session: PredicateSession,
  predicate: Extract<Predicate, { kind: typeof PredicateKind.STATE }>,
): Promise<Baseline | undefined> {
  const args =
    predicate.store === undefined
      ? { path: predicate.path }
      : { store: predicate.store, path: predicate.path };
  const read = await session.command(ReticleCommand.STATE_READ, args);
  if (!read.ok) return undefined;
  const reply = (read.result ?? {}) as { found?: unknown; value?: unknown };
  // `found: false` is a reading — the path held nothing — and it is NOT the same as "nobody
  // looked". Only an unreadable store returns undefined above.
  return 'boolean' === typeof reply.found ? { taken: true, value: reply.value } : undefined;
}

async function readText(
  session: PredicateSession,
  predicate: Extract<Predicate, { kind: typeof PredicateKind.TEXT }>,
): Promise<Baseline | undefined> {
  const query = {
    ...(predicate.contains === undefined ? {} : { text: predicate.contains }),
    ...(predicate.scope === undefined
      ? {}
      : { scope: predicate.scope, ...(true === predicate.self ? { self: true } : {}) }),
  };
  const match = await session.command(ReticleCommand.MATCH, { query });
  if (!match.ok) return undefined;
  const elements = ((match.result ?? {}) as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return undefined;
  const text = elements
    .map((element: unknown) => {
      if ('object' !== typeof element || null === element) return '';
      const value = (element as { text?: unknown }).text;
      return 'string' === typeof value ? value : '';
    })
    .join(' ')
    .trim();
  // An empty page is a reading of "": the element was not there, and that is what a later
  // `changed` is comparing against. Refusing here would turn "it appeared" into "nobody looked".
  return { taken: true, value: text };
}

/**
 * Read what every comparing leaf needs, once, before the action.
 *
 * Keyed by the predicate OBJECT: the same parsed tree is evaluated before and after, so identity
 * is exact and no path or index has to be kept in step with the walk.
 */
export async function captureBaselines(
  session: PredicateSession,
  predicate: Predicate | undefined,
): Promise<ReadonlyMap<Predicate, Baseline>> {
  const captured = new Map<Predicate, Baseline>();
  if (predicate === undefined) return captured;
  const leaves: Predicate[] = [];
  leavesNeedingBaseline(predicate, leaves);
  for (const leaf of leaves) {
    try {
      const reading =
        PredicateKind.STATE === leaf.kind
          ? await readStateValue(session, leaf)
          : PredicateKind.TEXT === leaf.kind
            ? await readText(session, leaf)
            : undefined;
      if (reading !== undefined) captured.set(leaf, reading);
    } catch {
      // A reading that could not be taken leaves the leaf with no baseline, which the evaluator
      // reports as `inconclusive`. Throwing here would lose the whole verdict for one unreadable
      // store — and an unevaluated clause is already the honest answer for exactly this.
    }
  }
  return captured;
}
