import { EventType, type ReticleEvent } from '@reticlehq/core';

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
 * Predicates never read this: they evaluate the event window directly, so a `state` assertion on
 * `isStale` still sees every transition. One verdict does: `state-vs-render` ignores a change this
 * classes as bookkeeping, so a cache's own clock cannot stand in for an app change nobody rendered.
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

/** TRUE when this before→after differs only in cache-bookkeeping keys, and differs at all. */
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

/** Whether a state event carries movement that can support state-vs-render. */
export function isMeaningfulStateChange(event: ReticleEvent): boolean {
  if (event.type !== EventType.STATE_CHANGE) return false;
  if (!('old' in event.data)) return true;
  const hasAfter = 'value' in event.data || 'new' in event.data;
  if (!hasAfter) return true;
  const after = 'value' in event.data ? event.data['value'] : event.data['new'];
  return !isCacheBookkeepingDiff(event.data['old'], after);
}

/** The name prefixes of Reticle's own signals and stores (`reticle:busy`, `__reticle…`). */
const RETICLE_VOICE = /^(?:reticle:|__reticle)/;

/** True for a signal or store that Reticle sends about itself. It says nothing about the app. */
export const isReticleVoice = (name: string): boolean => RETICLE_VOICE.test(name);

/** What the rule needs to know about an event. The caller supplies it, so this file reads no wire shape. */
interface AppReaction<E> {
  /** Which store path or signal the event moved, or undefined when it moved neither. */
  keyOf: (event: E) => string | undefined;
  /** Whether the caller's predicate named this change. */
  isNamed: (event: E) => boolean;
}

/**
 * A store change or an app signal that can be TIED to the action (#1531).
 *
 * The app's own state moving is a reaction, the same as a request, even when the DOM update it
 * drives lands after the window was read: a Pause button whose store changes on the media `pause`
 * event. But being in the window is not enough. The session stamps the active action's id on every
 * event between dispatch and settle, so a busy page's background store updates look attributed
 * too, and a dead click among them must still be reported ("no-effect under ambient churn").
 *
 * So a change counts only when it is tied to the action in one of two ways:
 *  - the caller's predicate named it (a `state` path or a `signal` name), so it is the consequence
 *    they expected; or
 *  - it was quiet before the action: `prior` holds observations, and none of them moved this path
 *    or fired this signal. Churn that was already moving is the background, not this click.
 */
export function tiedReaction<E>(
  prior: readonly E[],
  { keyOf, isNamed }: AppReaction<E>,
): (event: E) => boolean {
  const movedBefore = new Set<string>();
  for (const event of prior) {
    const key = keyOf(event);
    if (key !== undefined) {
      movedBefore.add(key);
    }
  }
  return (event) => {
    const key = keyOf(event);
    if (key === undefined) {
      return false;
    }
    return isNamed(event) || (prior.length > 0 && !movedBefore.has(key));
  };
}
