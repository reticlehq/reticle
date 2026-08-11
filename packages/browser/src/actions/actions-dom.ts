import { refs } from '../dom/refs.js';
import { hitTestOccluder } from '../dom/occlusion.js';
import { nativeFrame } from '../timers/native-timers.js';

interface ClickGeometry {
  occluded: boolean;
  occludedBy: string | null;
  scrolledIntoView: boolean;
}
export const NO_GEOMETRY: ClickGeometry = {
  occluded: false,
  occludedBy: null,
  scrolledIntoView: false,
};

/**
 * Full click as a real user produces it: pointerdown -> mousedown -> focus -> pointerup -> mouseup
 * -> click. A bare `click` event skips pointer- and focus-gated handlers. Returns the click event's
 * `defaultPrevented` so the probe is unchanged. Focus only moves for focusable targets (tabIndex>=0),
 * so a plain <div> click still reports focusMoved=null.
 */
export async function fireClickSequence(
  el: HTMLElement,
  hold?: { ms: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<{ prevented: boolean; heldMs: number }> {
  const doc = el.ownerDocument;
  const from: EventTarget = doc.activeElement ?? doc.body;
  firePointer(el, 'pointerdown', from);
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  if (el.tabIndex >= 0 && 'function' === typeof el.focus) el.focus();
  // The gap that makes hold-to-confirm driveable. Everything between down and up used to be
  // synchronous, so a control whose contract is "the button is down for N ms" could not be
  // expressed at all — the reported case cancelled its own confirm on the mouseup that arrived 7ms
  // later. `drag` already splits the pair across a gap; this is that shape with a timer.
  //
  // The ACHIEVED hold is measured and returned rather than echoed back: `holdMs: 1200` against a
  // 1200ms animation is a race by construction, and a caller needs to tell "held 1200" from
  // "held 1204". A backgrounded tab throttles timers, so this can legitimately overshoot by a lot.
  let heldMs = 0;
  if (hold !== undefined && hold.ms > 0) {
    const startedAt = hold.now();
    await hold.sleep(hold.ms);
    heldMs = hold.now() - startedAt;
  }
  firePointer(el, 'pointerup', from);
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  const notPrevented = el.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  return { prevented: !notPrevented, heldMs };
}

/** A box has layout we can reason about (jsdom returns an all-zero box — nothing to hit-test). */
function isMeasurable(rect: DOMRect): boolean {
  return rect.width > 0 || rect.height > 0;
}

/** The center of `rect` falls outside the visible viewport. */
function isOffViewport(el: HTMLElement, rect: DOMRect): boolean {
  const win = el.ownerDocument.defaultView;
  if (null === win) return false;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return cx < 0 || cy < 0 || cx > win.innerWidth || cy > win.innerHeight;
}

/** Hit-test the center: occluded iff the top NON-Reticle element is a foreign subtree (not target/ancestor/descendant). */
function hitTest(el: HTMLElement, rect: DOMRect): { occluded: boolean; occludedBy: string | null } {
  const top = hitTestOccluder(el, rect);
  return null === top
    ? { occluded: false, occludedBy: null }
    : { occluded: true, occludedBy: refs.refFor(top) };
}

/**
 * Click-like geometry honesty: scroll an off-viewport target into view, then hit-test the click
 * point. Synthetic dispatch always reaches the target regardless — this is purely so the agent
 * learns when the target is off-screen or visually blocked instead of getting a false "it worked".
 */
export function clickGeometry(el: HTMLElement): ClickGeometry {
  if (typeof el.getBoundingClientRect !== 'function') return NO_GEOMETRY;
  let rect = el.getBoundingClientRect();
  if (!isMeasurable(rect)) return NO_GEOMETRY;
  let scrolledIntoView = false;
  if (isOffViewport(el, rect) && 'function' === typeof el.scrollIntoView) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    scrolledIntoView = true;
    rect = el.getBoundingClientRect();
  }
  return { ...hitTest(el, rect), scrolledIntoView };
}

export function firePointer(
  el: Element,
  type: string,
  relatedTarget: EventTarget | null = null,
): void {
  if ('function' === typeof PointerEvent) {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, relatedTarget }));
  } else {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget }));
  }
}

/** Enter/leave pointer events are non-bubbling per spec; keep them so to avoid double-firing. */
export function firePointerNonBubbling(
  el: Element,
  type: string,
  relatedTarget: EventTarget | null = null,
): void {
  if ('function' === typeof PointerEvent) {
    el.dispatchEvent(new PointerEvent(type, { bubbles: false, cancelable: true, relatedTarget }));
  } else {
    el.dispatchEvent(new MouseEvent(type, { bubbles: false, cancelable: true, relatedTarget }));
  }
}

function makeDataTransfer(data: unknown): DataTransfer | null {
  if (typeof DataTransfer !== 'function') return null;
  const dt = new DataTransfer();
  // data: { mime, value } or [{ mime, value }, …]
  const entries = Array.isArray(data) ? data : data !== undefined ? [data] : [];
  for (const entry of entries) {
    if ('object' === typeof entry && entry !== null) {
      const e = entry as { mime?: unknown; value?: unknown };
      if ('string' === typeof e.mime && 'string' === typeof e.value) dt.setData(e.mime, e.value);
    }
  }
  return dt;
}

/**
 * Pointer-based drag (dnd-kit / react-beautiful-dnd) + best-effort HTML5 DnD. Async: yields a
 * frame between phases so React commits state between steps (fixes stale-closure handlers).
 */
export async function dragElement(
  source: HTMLElement,
  target: HTMLElement | null,
  data: unknown,
): Promise<boolean> {
  const dest = target ?? source;
  const fire = (el: Element, type: string): void => {
    if ('function' === typeof PointerEvent && type.startsWith('pointer')) {
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
    } else {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  };
  fire(source, 'pointerdown');
  fire(source, 'mousedown');
  await nativeFrame();
  fire(dest, 'pointermove');
  fire(dest, 'mousemove');
  await nativeFrame();
  fire(dest, 'pointerup');
  fire(dest, 'mouseup');

  let dropPrevented = false;
  if ('function' === typeof DragEvent) {
    const dataTransfer = makeDataTransfer(data);
    const init: DragEventInit = { bubbles: true, cancelable: true };
    if (dataTransfer !== null) init.dataTransfer = dataTransfer;
    source.dispatchEvent(new DragEvent('dragstart', init));
    await nativeFrame();
    dest.dispatchEvent(new DragEvent('dragenter', init));
    dest.dispatchEvent(new DragEvent('dragover', init));
    await nativeFrame();
    dropPrevented = !dest.dispatchEvent(new DragEvent('drop', init));
    source.dispatchEvent(new DragEvent('dragend', init));
  }
  return dropPrevented;
}
