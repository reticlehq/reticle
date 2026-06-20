import { nativeSetTimeout } from '../timers/native-timers.js';

/**
 * Synthetic-cursor + click effects — the visible "the agent is acting here" motion. Pure DOM helpers
 * extracted from presenter.ts so the controller stays under the size cap; each is a no-op when its
 * element is absent (the panel may not be mounted). Behavior is unchanged from the inlined methods.
 */

/** Fly the synthetic cursor to a viewport point and show it. */
export function moveCursor(cursor: HTMLElement | undefined, x: number, y: number): void {
  if (cursor === undefined) return;
  cursor.setAttribute('data-on', '1');
  cursor.style.transform = `translate(${String(x)}px, ${String(y)}px)`;
}

/** Briefly draw the green focus ring around an element's box, then fade it. */
export function ringAround(ring: HTMLElement | undefined, rect: DOMRect): void {
  if (ring === undefined) return;
  ring.style.left = `${String(rect.left - 4)}px`;
  ring.style.top = `${String(rect.top - 4)}px`;
  ring.style.width = `${String(rect.width + 8)}px`;
  ring.style.height = `${String(rect.height + 8)}px`;
  ring.setAttribute('data-on', '1');
  nativeSetTimeout(() => ring.setAttribute('data-on', '0'), 700);
}

/** Spawn a one-shot click ripple at a viewport point (self-removing). */
export function spawnRipple(root: HTMLElement | undefined, x: number, y: number): void {
  if (root === undefined) return;
  const r = document.createElement('div');
  r.setAttribute('data-iris-ripple', '');
  r.style.left = `${String(x)}px`;
  r.style.top = `${String(y)}px`;
  root.appendChild(r);
  nativeSetTimeout(() => r.remove(), 520);
}

/** Pace for the human so an action is watchable, not instant. */
export function pace(ms: number): Promise<void> {
  return new Promise((res) => nativeSetTimeout(res, ms));
}
