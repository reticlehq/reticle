/**
 * Display-only leaning of an act result's `effect` block. The post-action effect carries the
 * consequence signal (targetMatched, focusMoved, domMutatedWithin, …) plus several fields that
 * are almost always at a non-informative default (occluded:false, occludedBy:null,
 * scrolledIntoView:false, defaultPrevented:false, valueChanged:false). We drop a field ONLY when
 * it equals its uninformative default — a `true`/non-null value still surfaces, so no real signal
 * is lost. This runs at the serialization boundary; internal settle/predicate logic has already
 * consumed the full effect by this point, so trimming the returned copy is safe.
 */

/** Effect keys whose `false` value carries no signal (a `true` does, so it is kept). */
const FALSE_NOISE = new Set(['occluded', 'scrolledIntoView', 'defaultPrevented', 'valueChanged']);
/** Effect keys whose `null` value carries no signal (a non-null does, so it is kept). */
const NULL_NOISE = new Set(['occludedBy']);

function leanEffect(effect: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(effect)) {
    if (FALSE_NOISE.has(k) && v === false) continue;
    if (NULL_NOISE.has(k) && v === null) continue;
    out[k] = v;
  }
  return out;
}

/** Return a copy of an act command result with its `effect` block leaned. Non-objects pass through. */
export function leanActResult(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result;
  const r = result as Record<string, unknown>;
  const effect = r['effect'];
  if (effect === null || typeof effect !== 'object') return result;
  return { ...r, effect: leanEffect(effect as Record<string, unknown>) };
}
