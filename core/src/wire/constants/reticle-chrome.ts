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

/** Where the pass-through keeps each node's own inline `pointer-events`, on the page's window. */
const POINTER_HELD_KEY = '__reticlePointerHeld';

/**
 * A page script that takes Reticle's own UI out of the hit test for one real pointer gesture.
 *
 * A real click goes to the topmost element that takes pointer events. When a HUD control sat over
 * the app's button, the HUD took the daemon's click, and the verdict said the app did nothing
 * (#992). Each Reticle node gets an inline `pointer-events: none !important`, because a control
 * sets `pointer-events: auto` on itself and a value on the host alone does not reach it. Inline
 * style is not blocked by a page's CSP, and an injected stylesheet can be. Nothing moves or flickers.
 */
export const RETICLE_CHROME_PASS_THROUGH_SCRIPT = `(() => { const held = []; const seen = new Set(); for (const host of document.querySelectorAll(${JSON.stringify(RETICLE_OVERLAY_SELECTOR)})) { for (const el of [host, ...host.querySelectorAll('*')]) { if (seen.has(el) || !el.style) continue; seen.add(el); held.push([el, el.style.getPropertyValue('pointer-events'), el.style.getPropertyPriority('pointer-events')]); el.style.setProperty('pointer-events', 'none', 'important'); } } window.${POINTER_HELD_KEY} = held; })()`;

/** Puts back what `RETICLE_CHROME_PASS_THROUGH_SCRIPT` changed, so a person can click the HUD again. */
export const RETICLE_CHROME_RESTORE_POINTER_SCRIPT = `(() => { for (const [el, value, priority] of window.${POINTER_HELD_KEY} ?? []) { if (value) el.style.setProperty('pointer-events', value, priority); else el.style.removeProperty('pointer-events'); } delete window.${POINTER_HELD_KEY}; })()`;
