/**
 * Display-only leaning of an act result's `effect` block. The post-action effect carries the
 * consequence signal (domMutatedWithin, a non-null focusMoved, …) plus many fields that are
 * almost always at a non-informative default. We drop a field ONLY when it equals its
 * uninformative default, so absence always means "the boring value" and no real signal is lost:
 *
 *   - success defaults — `dispatched`/`targetMatched`/`visible`/`enabled` are `true` on a clean
 *     action; only their `false` (action missed, hit a hidden/disabled element) carries signal;
 *   - `false` defaults — `occluded`/`scrolledIntoView`/`defaultPrevented`/`valueChanged`;
 *   - `null` defaults — `occludedBy`/`focusMoved` (no overlay / no focus change).
 *
 * A clean click therefore collapses to its consequence alone (e.g. `{ domMutatedWithin: 8 }`),
 * matching the leanness of a bare browser-driver click. This runs at the serialization boundary;
 * internal settle/predicate logic has already consumed the full effect, so trimming the returned
 * copy is safe.
 */

/** Effect keys whose `true` value is the uninformative success default (a `false` carries signal). */
const TRUE_NOISE = new Set(['dispatched', 'targetMatched', 'visible', 'enabled']);
/** Effect keys whose `false` value carries no signal (a `true` does, so it is kept). */
const FALSE_NOISE = new Set(['occluded', 'scrolledIntoView', 'defaultPrevented', 'valueChanged']);
/** Effect keys whose `null` value carries no signal (a non-null does, so it is kept). */
const NULL_NOISE = new Set(['occludedBy', 'focusMoved']);

function leanEffect(effect: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(effect)) {
    if (TRUE_NOISE.has(k) && v === true) continue;
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
