import { isReticleUi } from './dom-ignore.js';

/**
 * Where to look. The centre, plus four points inset from the corners.
 *
 * Inset rather than ON the corners because a border, a focus ring or a rounded edge sits exactly
 * there and belongs to neither element cleanly — sampling the literal corner asks a question the
 * geometry cannot answer. A quarter in is inside the control by any reading.
 */
const SAMPLE_POINTS: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
];

/**
 * A majority of samples must be blocked before this is called an occlusion.
 *
 * MEASURED, in both directions. Asking about the CENTRE ALONE missed two bugs in this repo's own
 * detection suite (`occluded`, `cmdk-occluded`): an overlay covering a control but not its exact
 * centre pixel was invisible, and "covers it except for one pixel" is not something a user clicks
 * through. Asking about ANY point would be worse the other way — a tooltip clipping one corner, a
 * focus ring, a sticky header grazing an edge all leave a perfectly usable control, and this repo's
 * cardinal metric is ZERO false positives. A finding that cries wolf gets muted, and a muted
 * detector catches nothing.
 */
const BLOCKED_MAJORITY = 3;

/**
 * Multi-point hit-test, shared by click-geometry (actions) and occlusion detection (commands) so the
 * two can't drift. Returns the NON-Reticle element covering most of `el`, or null when nothing
 * foreign is on top — i.e. `el` itself, an ancestor wrapping it, or a descendant is on top (all "not
 * occluded"). A zero-area or unlayouted box (jsdom / detached node) returns null: we cannot tell, so
 * we never false-positive an occlusion. Reticle's own HUD is never treated as an occluder.
 */
export function hitTestOccluder(el: Element, rect: DOMRect): Element | null {
  if (0 === rect.width || 0 === rect.height) return null;
  const doc = el.ownerDocument;
  if (typeof doc.elementFromPoint !== 'function') return null;

  /*
   * `elementsFromPoint` when the browser has it, so our own chrome cannot hide what is under it.
   *
   * The singular form returns only the TOPMOST element, so anything sitting above the occluder —
   * including Reticle's own presenter — would be skipped as "ours" and the real blocker never seen.
   * Kept deliberately small: this ships in the SDK, and every developer downloads it on every page
   * load whether or not an agent ever connects.
   */
  const withStack = doc as Document & {
    elementsFromPoint?: (this: Document, x: number, y: number) => Element[];
  };
  const topAt = (x: number, y: number): Element | null => {
    const found = withStack.elementsFromPoint?.(x, y) ?? [doc.elementFromPoint(x, y)];
    return found.find((c): c is Element => null !== c && !isReticleUi(c)) ?? null;
  };

  // Counted by element, so the answer names the thing actually covering the control rather than
  // whichever blocked point happened to be sampled first. Two different overlays each covering two
  // points is not an occlusion by either of them, and this counts it as neither.
  const blockers = new Map<Element, number>();
  for (const [fx, fy] of SAMPLE_POINTS) {
    const top = topAt(rect.left + rect.width * fx, rect.top + rect.height * fy);
    if (null === top) continue;
    if (top === el || el.contains(top) || top.contains(el)) continue;
    blockers.set(top, (blockers.get(top) ?? 0) + 1);
  }

  let worst: Element | null = null;
  let worstCount = 0;
  for (const [element, count] of blockers) {
    if (count > worstCount) {
      worst = element;
      worstCount = count;
    }
  }
  return worstCount >= BLOCKED_MAJORITY ? worst : null;
}
