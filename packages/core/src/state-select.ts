/**
 * reticle_state output projection — pure, shared by the browser SDK (which applies them
 * BEFORE the transport so a scoped read of a huge store isn't truncated) and the server (back-compat
 * fallback when an older browser returns the whole store). `selectPath` walks a dot-path (with numeric
 * array indices) and, on a miss, returns the keys that WERE available at the last good level so a wrong
 * path is diagnosable rather than a bare null. `capDepth` prunes deeply-nested values to a budget.
 * `projectComponentState` strips React fiber plumbing (effect chains) from a component hook read.
 */

/** Result of walking a dot-path: the value, or a near-miss with the keys available where it stopped. */
export interface PathSelection {
  found: boolean;
  value: unknown;
  /** On a miss: the keys present at the deepest level reached (so the agent can correct the path). */
  availableKeys?: string[];
  /**
   * On a miss where `availableKeys` is a SAMPLE: how many keys were really there.
   *
   * Present only when the list was cut. `availableKeys` is capped, and without this a 10,000-key
   * store answered a wrong path with 50 names and no sign there were more — so an agent reading it
   * concludes the key it wants does not exist, when it is simply key 51. That reads as the strongest
   * possible negative signal and it is a false one, which is the precise failure this near-miss
   * payload was added to prevent.
   */
  totalKeys?: number;
}

/** Cap on how many near-miss keys travel in a failed selection — a 10k-key store must not return a
 *  10k-entry array in the error payload (that was the token blowup the near-miss exists to avoid). */
const MAX_AVAILABLE_KEYS = 50;

/**
 * The ONLY intrinsic (non-own) property a path segment may select, and only on an array or a string.
 * `todos.length` is the tool's own shipped example, so it has to resolve — but a path walks UNTRUSTED
 * app state, so this stays a closed one-name set rather than a general property read: anything wider
 * puts `constructor`/`__proto__`/`toString` (and every array method) back on the path grammar.
 */
const LENGTH_SEGMENT = 'length';

/** True where `LENGTH_SEGMENT` is a real, meaningful count — arrays and strings, nothing else. */
function hasIntrinsicLength(value: unknown): value is unknown[] | string {
  return Array.isArray(value) || 'string' === typeof value;
}

/** The keys at a level, as a bounded sample plus the true count when the sample is short. */
function keysOf(value: unknown): { keys: string[]; total: number } {
  if (Array.isArray(value)) {
    // `length` is listed because it IS selectable here — answering `["First task"]` with just `["0"]`
    // sent someone who mistyped `length` looking for a key that does not exist.
    const indices = value.slice(0, MAX_AVAILABLE_KEYS - 1).map((_, i) => String(i));
    return { keys: [...indices, LENGTH_SEGMENT], total: value.length + 1 };
  }
  if ('string' === typeof value) return { keys: [LENGTH_SEGMENT], total: 1 };
  if (value instanceof Map) {
    const keys: string[] = [];
    let total = 0;
    for (const k of value.keys()) {
      total += 1;
      if ('string' === typeof k && keys.length < MAX_AVAILABLE_KEYS) keys.push(k);
    }
    return { keys, total };
  }
  if ('object' === typeof value && value !== null) {
    const all = Object.keys(value);
    return { keys: all.slice(0, MAX_AVAILABLE_KEYS), total: all.length };
  }
  return { keys: [], total: 0 };
}

/** A miss, with the sample of keys available where it stopped and the count when that sample is cut. */
function miss(value: unknown): PathSelection {
  const { keys, total } = keysOf(value);
  return {
    found: false,
    value: null,
    availableKeys: keys,
    ...(total > keys.length ? { totalKeys: total } : {}),
  };
}

/**
 * Walk `path` (e.g. "captionCache.v3.0.text") into `root`. Empty path returns root unchanged.
 * Segments are own keys, canonical array indices, Map keys, or `length` on an array/string.
 */
export function selectPath(root: unknown, path: string): PathSelection {
  const segments = path.split('.').filter((s) => s.length > 0);
  let current: unknown = root;
  for (const segment of segments) {
    if (LENGTH_SEGMENT === segment && hasIntrinsicLength(current)) {
      current = current.length;
      continue;
    }
    if (Array.isArray(current)) {
      // Require a CANONICAL index string. `Number('01')`/`Number('1e0')`/`Number(' 1')` all coerce to 1,
      // so `items.01` silently read index 1 — an assertion on a path that doesn't exist quietly passed.
      // `String(index) === segment` accepts only "0","1","2",… and rejects the coercion aliases.
      const index = Number(segment);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        String(index) !== segment ||
        index >= current.length
      ) {
        return miss(current);
      }
      current = current[index];
      continue;
    }
    if (current instanceof Map) {
      if (current.has(segment)) {
        current = current.get(segment);
        continue;
      }
      return miss(current);
    }
    // `hasOwnProperty`, not `in`: `in` walks the prototype, so a path segment of `constructor`,
    // `__proto__`, or `toString` reported found:true and returned a function from Object.prototype —
    // a state assertion on a typo'd path silently passed against a builtin instead of failing with
    // availableKeys. Only an OWN key is a real state path. `Object.hasOwn` (ES2022) would ship
    // verbatim in the ES2017 dist and throw on browsers that predate it (issue #680's target); the
    // `Object.prototype` form is the same check, callable on any ES5+ engine.
    if (
      'object' === typeof current &&
      current !== null &&
      Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return miss(current);
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
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Set) {
    if (0 === maxDepth) return `[Set(${String(value.size)})]`;
    return [...value].map((v) => capDepth(v, maxDepth - 1));
  }
  if (value instanceof Map) {
    if (0 === maxDepth) return `{Map(${String(value.size)})}`;
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of value) out[String(k)] = capDepth(v, maxDepth - 1);
    return out;
  }
  if (Array.isArray(value)) {
    if (0 === maxDepth) return `[Array(${String(value.length)})]`;
    return value.map((v) => capDepth(v, maxDepth - 1));
  }
  if ('object' === typeof value && value !== null) {
    const keys = Object.keys(value);
    if (0 === maxDepth) return `{…${String(keys.length)} keys}`;
    // Null-proto target: a wire object can carry an own `__proto__` key (via JSON.parse), and
    // `out['__proto__'] = …` on a normal object writes the prototype slot instead of a key, losing
    // that key from the projection. A prototype-less target makes every key an ordinary assignment.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys)
      out[key] = capDepth((value as Record<string, unknown>)[key], maxDepth - 1);
    return out;
  }
  return value;
}

/**
 * Keys a React effect hook's `memoizedState` can carry once sanitized: `create`/`destroy` are
 * functions (already nulled), `deps` re-states values the value-hooks above it already carry, and
 * `next` chains the WHOLE effect list into every effect entry — so N effects cost O(N^2) of nulls.
 * React 18 uses `destroy`, React 19 wraps it in `inst`; both are listed so either version matches.
 */
const EFFECT_HOOK_KEYS = new Set(['tag', 'create', 'destroy', 'deps', 'inst', 'next']);

/** Disclosure text for a projected hook list — a trim is never silent. */
const HOOKS_PROJECTED_NOTE =
  'projected — effect hook(s) dropped (create/destroy are functions, deps duplicate the state values, and each entry re-chains the whole effect list). Every state/memo/ref hook value is unchanged.';

/** True for a sanitized React effect object — internals with no value an agent can act on. */
function isEffectHook(value: unknown): boolean {
  if ('object' !== typeof value || null === value || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.includes('tag') || !keys.includes('deps') || !keys.includes('next')) return false;
  if ('number' !== typeof (value as { tag: unknown }).tag) return false;
  return keys.every((k) => EFFECT_HOOK_KEYS.has(k));
}

/**
 * Project a component-state read down to what an agent can act on: the hook VALUES. Effect entries
 * are dropped (see `EFFECT_HOOK_KEYS`); everything else — useState values, useRef, and the
 * `[value, deps]` tuple of useMemo/useCallback — is passed through untouched, because React exposes
 * no hook KINDS here and a two-element state value is indistinguishable from a memo tuple.
 * A non-conforming value (no `hooks` array) is returned unchanged.
 */
export function projectComponentState(result: unknown): unknown {
  if ('object' !== typeof result || null === result) return result;
  const hooks = (result as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return result;
  const kept = hooks.filter((h) => !isEffectHook(h));
  if (kept.length === hooks.length) return result;
  return {
    ...(result as Record<string, unknown>),
    hooks: kept,
    truncation: { droppedItems: hooks.length - kept.length, note: HOOKS_PROJECTED_NOTE },
  };
}
