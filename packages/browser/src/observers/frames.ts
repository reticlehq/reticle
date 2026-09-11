import type { Teardown } from './types.js';

/**
 * Same-origin `<iframe>` documents, wired into the top document's observation.
 *
 * A `MutationObserver` is scoped to the node it is given, and a frame's document is a DIFFERENT node
 * tree — so a click inside an embedded panel changed its text and `observe` reported an empty window.
 * Measured on a console with an embedded SLA panel: the click landed, the panel updated, and the
 * observe window held zero DOM events. That is the false-green shape exactly — "nothing happened" is
 * what an agent concludes, and it is wrong.
 *
 * A MutationObserver CAN observe a node in another same-origin document, so the fix is to hand it the
 * frame bodies. Cross-origin frames stay unreachable and keep their existing blind-spot declaration.
 *
 * Network is NOT covered here. A frame's `fetch` lives in the frame's own realm and the top realm's
 * patch never sees it, so requests it makes are invisible — declared as a blind spot rather than
 * partially instrumented, because a half-seen request channel is worse than an admitted one.
 */

/** Frames-inside-frames, bounded. Real embeds nest once, occasionally twice. */
const DEPTH_MAX = 3;

function bodyOf(frame: HTMLIFrameElement): HTMLElement | null {
  try {
    return frame.contentDocument?.body ?? null;
  } catch {
    return null; // cross-origin — not ours to read
  }
}

/** Every same-origin frame body at or beneath `root`, in document order. */
export function sameOriginFrameBodies(root: ParentNode): HTMLElement[] {
  const found: HTMLElement[] = [];
  const walk = (node: ParentNode, depth: number): void => {
    if (depth >= DEPTH_MAX) return;
    for (const frame of node.querySelectorAll('iframe')) {
      const body = bodyOf(frame);
      if (null === body) continue;
      found.push(body);
      walk(body, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * Call `attach` for every same-origin frame body now and after each frame load.
 *
 * A frame that navigates gets a BRAND NEW document, so the old observation is dead and re-attaching on
 * `load` is not optional — without it, observation silently stops the first time an embedded panel
 * routes. Attaching twice to the same node is harmless (MutationObserver de-duplicates), so no
 * bookkeeping is kept.
 */
export function observeSameOriginFrames(attach: (body: HTMLElement) => void): Teardown {
  const attachAll = (): void => {
    for (const body of sameOriginFrameBodies(document)) attach(body);
  };
  attachAll();
  // `load` does not bubble, but it DOES reach a capturing listener on the document.
  const onLoad = (event: Event): void => {
    if (event.target instanceof HTMLIFrameElement) attachAll();
  };
  document.addEventListener('load', onLoad, true);
  return () => {
    document.removeEventListener('load', onLoad, true);
  };
}
