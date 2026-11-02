import { asString, EventType, type ReticleEvent } from '@reticlehq/core';
import type { ContradictionOptions } from './contradiction-types.js';

/** Reticle's own instrumentation's signals (core's `RETICLE_HYDRATION_SIGNAL`); not imported: coupling only shrinks. */
export const RETICLE_SIGNAL_NAMESPACE = 'reticle:';

const STATE_KEY_PREFIX = 'state:';
const SIGNAL_KEY_PREFIX = 'signal:';

/** Which store path or signal an event moved, keyed the same way in the window and in `prior`. */
function appReactionKey(e: ReticleEvent): string | undefined {
  if (e.type === EventType.STATE_CHANGE) {
    return `${STATE_KEY_PREFIX}${asString(e.data['name']) ?? ''}:${asString(e.data['path']) ?? ''}`;
  }
  if (e.type !== EventType.SIGNAL) {
    return undefined;
  }
  const name = asString(e.data['name']) ?? '';
  // Reticle's own instrumentation is not the app reacting.
  return name.startsWith(RETICLE_SIGNAL_NAMESPACE) ? undefined : `${SIGNAL_KEY_PREFIX}${name}`;
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
export function tiedAppReaction(options: ContradictionOptions): (e: ReticleEvent) => boolean {
  const named = new Set(options.namedStatePaths ?? []);
  const namedSignals = new Set(options.namedSignals ?? []);
  const prior = options.prior ?? [];
  const movedBefore = new Set<string>();
  for (const e of prior) {
    const key = appReactionKey(e);
    if (key !== undefined) {
      movedBefore.add(key);
    }
  }
  return (e) => {
    const key = appReactionKey(e);
    if (key === undefined) {
      return false;
    }
    if (e.type === EventType.STATE_CHANGE && named.has(asString(e.data['path']) ?? '')) {
      return true;
    }
    if (e.type === EventType.SIGNAL && namedSignals.has(asString(e.data['name']) ?? '')) {
      return true;
    }
    return prior.length > 0 && !movedBefore.has(key);
  };
}
