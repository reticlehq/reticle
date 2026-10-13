/**
 * Every Web Storage key the SDK and its HUD write, in one place.
 *
 * One list rather than a constant per file, because the storage observer has to know them ALL: a
 * key the HUD writes and the observer does not skip is reported as the app's own change, which is
 * how `reticle-presenter-log` appeared in a verdict's `storageKeysChanged`.
 *
 * Exact keys, not a `reticle` prefix: apps (our own bench among them) keep keys of their own under
 * `reticle.`, and hiding those would hide the app's real writes.
 *
 * Kept free of imports, so the observer can read it without pulling the HUD into the first load.
 */
export const ReticleStorageKey = {
  SESSION: '__reticle_session',
  REF_BASE: '__reticle_ref_base',
  PRESENTER_LOG: 'reticle-presenter-log',
  PRESENTER_LOG_OWNER: 'reticle-presenter-log-owner',
  PRESENTER_SETTINGS: 'reticle-presenter-settings',
  PRESENTER_MINIMISED: 'reticle-presenter-minimised',
  /** The HUD page that was open, and whether Run/Stop had focus, across a drive's reloads. */
  PRESENTER_VIEW: 'reticle-presenter-view',
  CAROUSEL_DISMISSED: 'reticle.carousel.dismissed',
  ANNOTATION_HISTORY: 'reticle.annotations.history.v1',
} as const;

/** The tour's per-project "seen" flags: one key per project, so a prefix. */
export const TOUR_SEEN_KEY_PREFIX = 'reticle.tour.seen.';
/** The Harness persona last picked, per project. */
export const PERSONA_KEY_PREFIX = 'reticle.harness.persona.';
/** The Impact verdict count when Impact was last opened, per project: the tab's "new" dot. */
export const IMPACT_SEEN_KEY_PREFIX = 'reticle.impact.seen.';

const OWN_KEYS: ReadonlySet<string> = new Set(Object.values(ReticleStorageKey));

/** Whether Reticle wrote this key, rather than the app under test. */
export function isReticleStorageKey(key: string): boolean {
  return (
    OWN_KEYS.has(key) ||
    key.startsWith(TOUR_SEEN_KEY_PREFIX) ||
    key.startsWith(PERSONA_KEY_PREFIX) ||
    key.startsWith(IMPACT_SEEN_KEY_PREFIX)
  );
}
