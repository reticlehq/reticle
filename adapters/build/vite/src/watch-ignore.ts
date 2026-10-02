/**
 * Normalising Vite's watcher `ignored` list, which is not a list.
 *
 * Small but cohesive: one third-party type shape, one runtime hazard it hides, and the guard that
 * makes the plugin's return assignable without a cast.
 */

/**
 * Append Reticle's journal pattern to whatever the app already ignored, without assuming it is an array.
 *
 * Vite's `ignored` is `AnymatchMatcher`, so `watch: { ignored: '**\/fixtures/**' }` is a legal
 * config. Spreading that string would explode it into one pattern PER CHARACTER — every one of
 * which matches nothing, so the app's own exclusion is silently dropped and no error is raised. A
 * function matcher is worse: it is not iterable at all, so the spread throws at config time and
 * takes the dev server down, blaming the last plugin to touch the config.
 */
export function mergeIgnored(existing: unknown, ours: RegExp): WatchPattern[] {
  if (undefined === existing || null === existing) return [ours];
  const listed: unknown[] = Array.isArray(existing) ? existing : [existing];
  // Filtered rather than cast: an entry that is none of the three legal matcher shapes could never
  // have excluded anything, so dropping it loses nothing and keeps the return honest without `any`.
  return [...listed.filter(isWatchPattern), ours];
}

/** Vite's `AnymatchPattern`, restated so the return type needs no cast. */
export type WatchPattern = string | RegExp | ((path: string) => boolean);

function isWatchPattern(value: unknown): value is WatchPattern {
  return 'string' === typeof value || value instanceof RegExp || 'function' === typeof value;
}
