/**
 * iris_state path selection + depth capping. The report flagged 60KB+ store reads with no way to
 * scope them as a real token tax. `selectPath` walks a dot-path (with numeric array indices) into a
 * store value and, on a miss, returns the keys that WERE available at the last good level so a wrong
 * path is diagnosable rather than a bare null. `capDepth` prunes deeply-nested values to a budget.
 */

/** Result of walking a dot-path: the value, or a near-miss with the keys available where it stopped. */
export interface PathSelection {
  found: boolean;
  value: unknown;
  /** On a miss: the keys present at the deepest level reached (so the agent can correct the path). */
  availableKeys?: string[];
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((_, i) => String(i));
  if (typeof value === 'object' && value !== null) return Object.keys(value);
  return [];
}

/** Walk `path` (e.g. "captionCache.v3.0.text") into `root`. Empty path returns root unchanged. */
export function selectPath(root: unknown, path: string): PathSelection {
  const segments = path.split('.').filter((s) => s.length > 0);
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: null, availableKeys: keysOf(current) };
      }
      current = current[index];
      continue;
    }
    if (typeof current === 'object' && current !== null && segment in current) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return { found: false, value: null, availableKeys: keysOf(current) };
  }
  return { found: true, value: current };
}

/**
 * Prune `value` to `maxDepth` levels: objects/arrays deeper than the budget collapse to a compact
 * placeholder string recording their size, so a huge store can be skimmed shape-first. A negative
 * budget means "no cap".
 */
export function capDepth(value: unknown, maxDepth: number): unknown {
  if (maxDepth < 0) return value;
  if (Array.isArray(value)) {
    if (maxDepth === 0) return `[Array(${String(value.length)})]`;
    return value.map((v) => capDepth(v, maxDepth - 1));
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    if (maxDepth === 0) return `{…${String(keys.length)} keys}`;
    const out: Record<string, unknown> = {};
    for (const key of keys)
      out[key] = capDepth((value as Record<string, unknown>)[key], maxDepth - 1);
    return out;
  }
  return value;
}
