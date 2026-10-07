/**
 * Reticle's own UI in the page, as one selector list both the SDK and the daemon read.
 *
 * The presenter overlay (cursor, HUD, glow), the annotator's marks, the action blocker and the
 * first-run tour. The SDK keeps them out of snapshots and queries; the daemon hides them from every
 * screenshot. They lived in the browser adapter alone, so the daemon's two capture paths each
 * hard-coded their own idea of "our chrome": the driven path hid `[data-reticle-overlay]` only, and
 * the lease path hid nothing, so a lease baseline captured the HUD and its activity log and a HUD
 * change read as an app regression (#1355).
 */
export const RETICLE_OVERLAY_SELECTOR =
  '[data-reticle-overlay],[data-reticle-cursor],[data-reticle-hud],[data-reticle-glow],[data-reticle-mark],[data-reticle-blocker],[data-reticle-tour]';

/**
 * A stylesheet that hides Reticle's own UI for one capture, without touching the page under test.
 *
 * `display:none` rather than `visibility`: an expanded HUD at a mobile viewport covers most of the
 * frame, and a hidden-but-laid-out panel still pushes nothing, but a `display:none` one is what a
 * page without Reticle would have looked like.
 */
export const HIDE_RETICLE_CHROME_CSS = `${RETICLE_OVERLAY_SELECTOR}{display:none !important}`;
