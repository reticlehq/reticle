/**
 * Meaningful state vs cache bookkeeping.
 *
 * A query cache (TanStack Query, SWR-shaped stores) re-emits every entry as it moves through
 * pending → fetching → idle, stamping `fetchStatus`, `isStale` and `dataUpdatedAt` on the way. Those
 * transitions are real, and they are not what an action CHANGED: one click on a cache-backed page
 * reported a dozen `stateDiffs` whose only difference was the cache's own clock, and the one diff
 * that mattered was the thirteenth.
 *
 * This rule classifies ONE before→after pair. It is deliberately narrow: a diff is bookkeeping only
 * when both sides are plain objects AND every key that differs is a bookkeeping key. A change to
 * `data`, `error`, or any key this list does not name is meaningful — so a value nobody anticipated
 * is always reported, never silently classed as noise. `status` is included because on its own
 * (no `data`/`error` move) it is the cache narrating its fetch, not the app changing.
 *
 * Reporting only. Nothing that decides a verdict reads this: predicates evaluate the event window
 * directly, so a `state` assertion on `isStale` still sees every transition.
 */
export const CACHE_BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  'status',
  'fetchStatus',
  'isStale',
  'dataUpdatedAt',
  'errorUpdatedAt',
  'isFetching',
  'isInvalidated',
  'fetchFailureCount',
]);

function plainObject(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && null !== value && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // Not comparable is not "equal": a pair we cannot read is reported, never classed as noise.
    return false;
  }
}

/** TRUE when this before→after differs ONLY in cache-bookkeeping keys (and differs at all). */
export function isCacheBookkeepingDiff(from: unknown, to: unknown): boolean {
  if (!plainObject(from) || !plainObject(to)) return false;
  let differed = false;
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (same(from[key], to[key])) continue;
    if (!CACHE_BOOKKEEPING_KEYS.has(key)) return false;
    differed = true;
  }
  return differed;
}
