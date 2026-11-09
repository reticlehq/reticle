/**
 * The names a deterministic lease shares with the SDK in its page.
 *
 * A deterministic lease replaces the page's clock and random source before any page script runs.
 * It keeps the page's real timers under this key, so the SDK can still wait, reconnect and send
 * its heartbeat while the page's own time stands still.
 */

/** The `Symbol.for` key of the object that holds the real timers and the step function. */
export const DETERMINISM_GLOBAL_KEY = 'reticle.determinism';
/** The length of one stepped frame, in milliseconds: 60 frames each second. */
export const DETERMINISM_FRAME_MS = 1000 / 60;
/** Where the virtual clock starts: 2026-01-01T00:00:00Z. */
export const DETERMINISM_EPOCH_MS = Date.UTC(2026, 0, 1);
/** The seed for Math.random and crypto.getRandomValues when the caller gives none. */
export const DETERMINISM_DEFAULT_SEED = 1;
/** The most frames one step can run. One minute of frames at 60 each second. */
export const DETERMINISM_MAX_STEP_FRAMES = 3600;
