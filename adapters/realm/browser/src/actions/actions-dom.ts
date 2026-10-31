import { refs } from '@/dom/addressing/refs.js';
import { readTestId } from '@/dom/addressing/testid-attr.js';
import { getAccessibleName, getRole } from '@/dom/a11y.js';
import { hitTestOccluder } from '@/dom/occlusion.js';
import { devOverlayName } from '@/dom/dom-ignore.js';
import { nativeFrame } from '@/timers/native/native-timers.js';
import { asSyntheticInput } from './synthetic/synthetic-input.js';
import type { ActionTarget } from '@/dom/realm.js';
import { ClickButton, clickButtonFromArgs } from '@reticlehq/core';
import { type ModifierFlags, pressModifiers } from './actions-press.js';

interface ClickGeometry {
  occluded: boolean;
  occludedBy: string | null;
  scrolledIntoView: boolean;
  /** What covers the target, in words: its test id, else its role and name, else its tag. */
  occluderName?: string;
  /** The target is laid out with no size: there is nothing for a pointer to land on. */
  noSize?: true;
  /** Still outside the viewport after it was scrolled into view. */
  offViewport?: true;
}
export const NO_GEOMETRY: ClickGeometry = {
  occluded: false,
  occludedBy: null,
  scrolledIntoView: false,
};

/**
 * Construct a mouse event with the target document's window, preserving the caller's flags.
 *
 * `view` is what a handler reads to reach the window the event happened in — `event.view.scrollTo`,
 * `event.view.getComputedStyle`, `event.view.addEventListener('mouseup', …)` to follow a drag. It
 * was omitted from every synthetic event this file dispatches, so those handlers saw `null` and a
 * control that worked under a real pointer did nothing under a driven one.
 *
 * `el.ownerDocument.defaultView`, not the global `window`, because the target may live in an iframe
 * and an event carrying the PARENT's window is a different lie from carrying none. It is spread
 * LAST so no call site can pass a `view` of its own: the guarantee is structural rather than a rule
 * every dispatch site in this package has to remember, which is what it was for one commit and
 * what made the same expression appear eleven times.
 */
export function mouseEventFor(el: Element, type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { ...init, view: el.ownerDocument.defaultView });
}

/**
 * The same, as a POINTER event where the environment has one.
 *
 * `PointerEvent` is absent on older WebKit and in some embedded webviews, where a mouse event is the
 * documented fallback — and the fallback needs the window just as much, which is the half that used
 * to be written out twice per call site and so was the half that drifted. Pointer-only members left
 * in `init` are ignored by `MouseEventInit`, so one construction serves both.
 */
function pointerEventFor(el: Element, type: string, init: PointerEventInit): MouseEvent {
  const full = { ...init, view: el.ownerDocument.defaultView };
  return 'function' === typeof PointerEvent
    ? new PointerEvent(type, full)
    : new MouseEvent(type, full);
}

/** `buttons` bitmask for the primary button: 1 while held, 0 once released. */
const BUTTON_HELD = 1;
const BUTTON_RELEASED = 0;

/** What a click carries besides its place: the keys held down and the button pressed. */
export interface ClickInput {
  modifiers: ModifierFlags;
  button: ClickButton;
}

export const PLAIN_CLICK: ClickInput = {
  modifiers: { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
  button: ClickButton.LEFT,
};

/** `MouseEvent.button` and the `buttons` bit for each button a click can use. */
const BUTTON_CODES: Readonly<Record<ClickButton, { button: number; bit: number }>> = {
  [ClickButton.LEFT]: { button: 0, bit: 1 },
  [ClickButton.RIGHT]: { button: 2, bit: 2 },
  [ClickButton.MIDDLE]: { button: 1, bit: 4 },
};

/** The modifiers and button a click asks for. Call `clickInputProblem` first: this assumes valid args. */
export function clickInputOf(args: Record<string, unknown>): ClickInput {
  return {
    modifiers: pressModifiers(args),
    button: clickButtonFromArgs(args) ?? ClickButton.LEFT,
  };
}

/**
 * One pointer or mouse event at a point, with the button state a real pointer would report.
 *
 * Each field breaks a standard library pattern when missing: without coordinates a geometry-based
 * collision resolver sees a zero delta (and a canvas hit-tests nothing); without `buttons: 1` the
 * usual "was the mouse released?" guard bails out mid-drag. A `mouse*` type stays a MouseEvent even
 * where PointerEvent exists: the pair is the point. `enter`/`leave` do not bubble, as a real
 * pointer's would not.
 */
function fireAt(
  el: Element,
  type: string,
  at: Point,
  buttons: number,
  related?: EventTarget | null,
  detail = 0,
  input: ClickInput = PLAIN_CLICK,
): boolean {
  const init = {
    bubbles: !(type.endsWith('enter') || type.endsWith('leave')),
    cancelable: true,
    detail,
    clientX: at.x,
    clientY: at.y,
    screenX: at.x,
    screenY: at.y,
    buttons,
    button: BUTTON_CODES[input.button].button,
    ...input.modifiers,
    ...(related !== undefined ? { relatedTarget: related } : {}),
  };
  return el.dispatchEvent(
    type.startsWith('pointer')
      ? pointerEventFor(el, type, { ...init, pointerId: 1, isPrimary: true })
      : mouseEventFor(el, type, init),
  );
}

/**
 * Full click as a real user produces it: pointerdown -> mousedown -> focus -> pointerup -> mouseup
 * -> click. A bare `click` event skips pointer- and focus-gated handlers. Returns the click event's
 * `defaultPrevented` so the probe is unchanged. Focus only moves for focusable targets (tabIndex>=0),
 * so a plain <div> click still reports focusMoved=null.
 */
export async function fireClickSequence(
  el: ActionTarget,
  hold?: { ms: number; sleep: (ms: number) => Promise<void>; now: () => number },
  detail?: number,
  input: ClickInput = PLAIN_CLICK,
): Promise<{ prevented: boolean; heldMs: number }> {
  const doc = el.ownerDocument;
  const from: EventTarget = doc.activeElement ?? doc.body;
  // Where a real mouse would be, and which button is down. A canvas or SVG app hit-tests its own
  // shapes from clientX/Y and ignores a pointer with no id; a click at (0,0) with no pointerId landed
  // on nothing, and one path passed anyway (#1003). Drag already sent all of this.
  const at = centreOf(el);
  const d = detail ?? 0;
  const held = BUTTON_CODES[input.button].bit;
  const isLeft = ClickButton.LEFT === input.button;
  let notPrevented = true;
  asSyntheticInput(() => fireAt(el, 'pointerdown', at, held, from, d, input));
  asSyntheticInput(() => fireAt(el, 'mousedown', at, held, undefined, d, input));
  if (ClickButton.RIGHT === input.button) {
    notPrevented = asSyntheticInput(() => fireAt(el, 'contextmenu', at, held, undefined, d, input));
  }
  if (el.tabIndex >= 0 && 'function' === typeof el.focus) {
    el.focus();
  }
  // The gap that makes hold-to-confirm driveable. With down and up synchronous, a control whose
  // contract is "the button is down for N ms" cannot be expressed at all — it cancels its own
  // confirm on a mouseup arriving milliseconds later. `drag` splits the pair the same way.
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
  asSyntheticInput(() => fireAt(el, 'pointerup', at, BUTTON_RELEASED, from, d, input));
  asSyntheticInput(() => fireAt(el, 'mouseup', at, BUTTON_RELEASED, undefined, d, input));
  // Marked as Reticle's own so the annotator's capture-phase listener lets it through. Without it,
  // the click is swallowed whole in annotate mode while still reporting `dispatched: true`.
  // A browser sends `click` for the primary button only; any other button gets `auxclick`.
  const clicked = asSyntheticInput(() =>
    fireAt(el, isLeft ? 'click' : 'auxclick', at, BUTTON_RELEASED, undefined, d, input),
  );
  // A right click reports its `contextmenu`, the event an app cancels to show its own menu.
  if (ClickButton.RIGHT !== input.button) {
    notPrevented = clicked;
  }
  return { prevented: !notPrevented, heldMs };
}

/** A box has layout we can reason about (jsdom returns an all-zero box — nothing to hit-test). */
function isMeasurable(rect: DOMRect): boolean {
  return rect.width > 0 || rect.height > 0;
}

/**
 * Scroll an element into view at once. A bare `scrollIntoView()` follows the page's CSS
 * `scroll-behavior`, and `smooth` makes it an animation: the call returns with the element still
 * off screen, so the next reading judges a button that is about to arrive as outside the viewport.
 */
export function scrollIntoViewNow(el: Element, options: ScrollIntoViewOptions = {}): void {
  el.scrollIntoView({ ...options, behavior: 'instant' });
}

/** The center of `rect` falls outside the visible viewport. */
export function isOffViewport(el: Element, rect: DOMRect): boolean {
  const win = el.ownerDocument.defaultView;
  if (null === win) {
    return false;
  }
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return cx < 0 || cy < 0 || cx > win.innerWidth || cy > win.innerHeight;
}

/** Hit-test the center: occluded iff the top NON-Reticle element is a foreign subtree (not target/ancestor/descendant). */
function hitTest(
  el: ActionTarget,
  rect: DOMRect,
): { occluded: boolean; occludedBy: string | null; occluderName?: string } {
  const top = hitTestOccluder(el, rect);
  return null === top
    ? { occluded: false, occludedBy: null }
    : {
        occluded: true,
        occludedBy: refs.refFor(top),
        occluderName: devOverlayName(top) ?? nameOf(top),
      };
}

/** An element in words a person can find it by: its test id, else role and name, else its tag. */
function nameOf(el: Element): string {
  const testid = readTestId(el);
  if (testid !== null && testid.length > 0) {
    return `[data-testid="${testid}"]`;
  }
  const name = getAccessibleName(el).trim();
  return name.length > 0 ? `${getRole(el)} "${name.slice(0, 40)}"` : el.tagName.toLowerCase();
}

/** Laid out (the page has layout) with a box of no area: a pointer has nowhere to land. */
function hasNoSize(el: ActionTarget): boolean {
  if (typeof el.getClientRects !== 'function') {
    return false;
  }
  const rects = Array.from(el.getClientRects());
  return rects.length > 0 && rects.every((r) => 0 === r.width || 0 === r.height);
}

/**
 * Click-like geometry honesty: scroll an off-viewport target into view, then hit-test the click
 * point. Synthetic dispatch always reaches the target regardless — this is purely so the agent
 * learns when the target is off-screen or visually blocked instead of getting a false "it worked".
 */
export function clickGeometry(el: ActionTarget): ClickGeometry {
  if (typeof el.getBoundingClientRect !== 'function') {
    return NO_GEOMETRY;
  }
  let rect = el.getBoundingClientRect();
  if (!isMeasurable(rect)) {
    return hasNoSize(el) ? { ...NO_GEOMETRY, noSize: true } : NO_GEOMETRY;
  }
  let scrolledIntoView = false;
  if (isOffViewport(el, rect) && 'function' === typeof el.scrollIntoView) {
    scrollIntoViewNow(el, { block: 'center', inline: 'center' });
    scrolledIntoView = true;
    rect = el.getBoundingClientRect();
  }
  const stillOff = scrolledIntoView && isOffViewport(el, rect);
  return { ...hitTest(el, rect), scrolledIntoView, ...(stillOff ? { offViewport: true } : {}) };
}

export function firePointer(
  el: Element,
  type: string,
  relatedTarget: EventTarget | null = null,
): void {
  asSyntheticInput(() =>
    el.dispatchEvent(pointerEventFor(el, type, { bubbles: true, cancelable: true, relatedTarget })),
  );
}

/** Enter/leave pointer events are non-bubbling per spec; keep them so to avoid double-firing. */
export function firePointerNonBubbling(
  el: Element,
  type: string,
  relatedTarget: EventTarget | null = null,
): void {
  asSyntheticInput(() =>
    el.dispatchEvent(
      pointerEventFor(el, type, { bubbles: false, cancelable: true, relatedTarget }),
    ),
  );
}

function makeDataTransfer(data: unknown): DataTransfer | null {
  if (typeof DataTransfer !== 'function') {
    return null;
  }
  const dt = new DataTransfer();
  // data: { mime, value } or [{ mime, value }, …]
  const entries = Array.isArray(data) ? data : data !== undefined ? [data] : [];
  for (const entry of entries) {
    if ('object' === typeof entry && entry !== null) {
      const e = entry as { mime?: unknown; value?: unknown };
      if ('string' === typeof e.mime && 'string' === typeof e.value) {
        dt.setData(e.mime, e.value);
      }
    }
  }
  return dt;
}

interface Point {
  x: number;
  y: number;
}

/**
 * How many intermediate moves a drag emits.
 *
 * Enough to cross any realistic `activationConstraint: { distance: N }` while a sensor is watching,
 * and few enough that a drag stays a handful of frames rather than an animation.
 */
const DRAG_STEPS = 5;

/** The centre of an element in client coordinates — what a real pointer would be over. */
function centreOf(el: ActionTarget): Point {
  const box = el.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** A point `t` of the way from `a` to `b`, rounded — pointer coordinates are integers in practice. */
function lerp(a: Point, b: Point, t: number): Point {
  return { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) };
}

/**
 * Pointer-based drag (dnd-kit / react-beautiful-dnd) + best-effort HTML5 DnD. Async: yields a
 * frame between phases so React commits state between steps (fixes stale-closure handlers).
 *
 * Dispatches along a PATH with real client coordinates and a held button. Without those a
 * geometry-based library resolves the drop target as the source, so the action reports success over
 * an app that did not change — a false green produced by the tool rather than caught by it.
 */
export async function dragElement(
  source: ActionTarget,
  target: ActionTarget | null,
  data: unknown,
): Promise<boolean> {
  const dest = target ?? source;
  const from = centreOf(source);
  const to = centreOf(dest);
  /** Is this path point inside an element's box? Rects are cached; jsdom reports zeros otherwise. */
  const sourceRect = source.getBoundingClientRect();
  const destRect = target !== null ? dest.getBoundingClientRect() : null;
  const crosses = (rect: DOMRect, p: Point): boolean =>
    p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;

  fireAt(source, 'pointerdown', from, BUTTON_HELD);
  fireAt(source, 'mousedown', from, BUTTON_HELD);
  await nativeFrame();
  // A path, not a jump. `activationConstraint: { distance: N }` is the standard way to keep a
  // draggable card clickable, and a sensor only starts a drag once it has SEEN the pointer travel
  // that far — which a single move from A to B never shows it.
  //
  // The crossing announces itself: the first step outside the source fires out/leave on it, and
  // the first step inside the destination fires over/enter on it, both with the button still held.
  // Without these, React never synthesises `onMouseEnter` on the destination (it derives that from
  // delegated `mouseover`/`mouseout`), so drag-to-select grids never extend their selection.
  let leftSource = false;
  let enteredDest = false;
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    const at = lerp(from, to, step / DRAG_STEPS);
    if (!leftSource && !crosses(sourceRect, at)) {
      leftSource = true;
      // relatedTarget is the element the pointer crossed TO/FROM; React's enter/leave synthesis
      // reads it off the delegated over/out pair to know which boundary was crossed.
      fireAt(source, 'pointerout', at, BUTTON_HELD, dest);
      fireAt(source, 'mouseout', at, BUTTON_HELD, dest);
      fireAt(source, 'pointerleave', at, BUTTON_HELD, dest);
      fireAt(source, 'mouseleave', at, BUTTON_HELD, dest);
    }
    if (leftSource && !enteredDest && destRect !== null && crosses(destRect, at)) {
      enteredDest = true;
      fireAt(dest, 'pointerover', at, BUTTON_HELD, source);
      fireAt(dest, 'mouseover', at, BUTTON_HELD, source);
      fireAt(dest, 'pointerenter', at, BUTTON_HELD, source);
      fireAt(dest, 'mouseenter', at, BUTTON_HELD, source);
    }
    fireAt(dest, 'pointermove', at, BUTTON_HELD);
    fireAt(dest, 'mousemove', at, BUTTON_HELD);
    await nativeFrame();
  }
  // A short hop whose sampled steps never land inside the destination box still crossed into it;
  // announce the arrival rather than silently skipping the pair.
  if (!enteredDest && destRect !== null) {
    fireAt(dest, 'pointerover', to, BUTTON_HELD, source);
    fireAt(dest, 'mouseover', to, BUTTON_HELD, source);
    fireAt(dest, 'pointerenter', to, BUTTON_HELD, source);
    fireAt(dest, 'mouseenter', to, BUTTON_HELD, source);
  }
  fireAt(dest, 'pointerup', to, BUTTON_RELEASED);
  fireAt(dest, 'mouseup', to, BUTTON_RELEASED);

  let dropPrevented = false;
  if ('function' === typeof DragEvent) {
    const dataTransfer = makeDataTransfer(data);
    const init: DragEventInit = { bubbles: true, cancelable: true };
    if (dataTransfer !== null) {
      init.dataTransfer = dataTransfer;
    }
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

/**
 * A TOUCH tap, as a touch device actually delivers it.
 *
 * Not a click under another name, and the difference is not cosmetic. A handler bound to
 * `touchstart`, or one that branches on `event.pointerType === 'touch'`, never runs for a mouse
 * click — so mobile-web behaviour, swipe affordances and touch-only controls could not be driven at
 * all, and an agent asked to check them had no honest answer.
 *
 * The sequence is the one a browser sends: pointerdown(touch) → touchstart → touchend → pointerup →
 * click. The trailing click matters — a touch device synthesises one, and an app that only listens
 * for `click` must still work under a tap, which is exactly the thing worth verifying.
 *
 * `holdMs` makes it a LONG PRESS: the gesture behind a context menu, a reorder handle, a
 * press-and-hold reveal. Measured and returned like the mouse hold, for the same reason — a caller
 * needs to tell "held 1200" from "held 1204" when the app's own threshold is 1200.
 */
export async function fireTapSequence(
  el: ActionTarget,
  hold: { ms: number; sleep: (ms: number) => Promise<void>; now: () => number } | undefined,
): Promise<{ prevented: boolean; heldMs: number }> {
  const touches = touchListFor(el);
  firePointerTouch(el, 'pointerdown');
  asSyntheticInput(() => el.dispatchEvent(makeTouchEvent('touchstart', touches)));
  if (el.tabIndex >= 0 && 'function' === typeof el.focus) {
    el.focus();
  }
  let heldMs = 0;
  if (hold !== undefined && hold.ms > 0) {
    const started = hold.now();
    await hold.sleep(hold.ms);
    heldMs = hold.now() - started;
  }
  asSyntheticInput(() => el.dispatchEvent(makeTouchEvent('touchend', [])));
  firePointerTouch(el, 'pointerup');
  const clicked = asSyntheticInput(() =>
    el.dispatchEvent(mouseEventFor(el, 'click', { bubbles: true, cancelable: true })),
  );
  return { prevented: !clicked, heldMs };
}

/** A pointer event that says it came from a FINGER — the discriminator a touch handler reads. */
function firePointerTouch(el: Element, type: string): void {
  asSyntheticInput(() =>
    el.dispatchEvent(
      pointerEventFor(el, type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        isPrimary: true,
        width: 23,
        height: 23,
      }),
    ),
  );
}

/**
 * One `Touch` at the element's centre, when the environment has the constructors.
 *
 * jsdom has `TouchEvent` but not always `Touch`, and a browser that lacks both still gets the
 * pointer half above. Degrading to an empty list is correct rather than lazy: `touches` is
 * documented as possibly empty (it IS empty on `touchend`), so a handler that reads it defensively
 * behaves the same, and one that does not would have thrown on a real touchend too.
 */
function touchListFor(el: ActionTarget): Touch[] {
  if ('function' !== typeof Touch || 'function' !== typeof el.getBoundingClientRect) {
    return [];
  }
  const rect = el.getBoundingClientRect();
  try {
    return [
      new Touch({
        identifier: 0,
        target: el,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    ];
  } catch {
    return [];
  }
}

function makeTouchEvent(type: string, touches: Touch[]): Event {
  if ('function' === typeof TouchEvent) {
    try {
      return new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches,
        targetTouches: touches,
        changedTouches: touches,
      });
    } catch {
      // fall through to a plain Event: the TYPE is what a touchstart listener is bound to.
    }
  }
  return new Event(type, { bubbles: true, cancelable: true });
}

/** Containers whose `data-state="closed"` means "on its way out": a menu or popup animating shut. */
const POPUP_ROLES = new Set(['menu', 'menubar', 'listbox', 'dialog', 'alertdialog', 'tooltip']);
const CLOSED_STATE = 'closed';

/**
 * Refuse an act aimed inside a popup that is closing. A Radix menu keeps its items mounted while it
 * animates shut, marked `data-state="closed"`; a click meant for the next menu landed on an item of
 * the closing one and reassigned an issue nobody had asked to change. The element itself is not
 * checked, only what holds it: a trigger carries `data-state="closed"` while its menu is shut, and
 * clicking it is how the menu opens.
 */
export function assertNotLeaving(el: Element): void {
  for (let up = el.parentElement; up !== null; up = up.parentElement) {
    if (CLOSED_STATE !== up.getAttribute('data-state')) {
      continue;
    }
    if (!POPUP_ROLES.has(up.getAttribute('role') ?? '')) {
      continue;
    }
    throw new Error(
      `'${up.getAttribute('role') ?? 'popup'}' holding this element is closing (data-state="closed"), ` +
        'so a person could not click it: look again once it has gone and act on what is open',
    );
  }
}
