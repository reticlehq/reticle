import { isReticleUi } from './dom-ignore.js';

/**
 * Center-point hit-test, shared by click-geometry (actions) and occlusion detection (commands) so the
 * two can't drift. Returns the top NON-Reticle element covering `el`'s center, or null when nothing
 * foreign is on top — i.e. `el` itself, an ancestor wrapping it, or a descendant is on top (all "not
 * occluded"). A zero-area or unlayouted box (jsdom / detached node) returns null: we cannot tell, so
 * we never false-positive an occlusion. Reticle's own HUD is never treated as an occluder.
 */
export function hitTestOccluder(el: Element, rect: DOMRect): Element | null {
  if (rect.width === 0 || rect.height === 0) return null;
  const doc = el.ownerDocument;
  if (typeof doc.elementFromPoint !== 'function') return null;
  const top = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (top === null || isReticleUi(top)) return null;
  const lands = top === el || el.contains(top) || top.contains(el);
  return lands ? null : top;
}
