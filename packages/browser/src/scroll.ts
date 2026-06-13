import { refs } from './refs.js';

/** N5 SCROLLFIND: outcome of one container scroll — enough for the server to drive a find loop. */
export interface ScrollResult {
  /** scrollTop actually moved (false ⇒ already at the end / not scrollable). */
  scrolled: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** At (or within 1px of) the bottom — no more rows to reveal by scrolling down. */
  atEnd: boolean;
}

const FALLBACK_STEP_PX = 400;
const VIEWPORT_FRACTION = 0.8;

/** The nearest scrollable ancestor of `el` (inclusive), else the document scrolling element. */
function nearestScrollable(el: Element): Element {
  let cur: Element | null = el;
  while (cur !== null && cur !== document.body) {
    const oy = getComputedStyle(cur).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight) return cur;
    cur = cur.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * N5 SCROLLFIND: scroll the container of `ref` (or the document) down by `dy` (default ~one
 * viewport) so a virtualized list mounts its next window of rows. Sets scrollTop directly and
 * fires a `scroll` event so onScroll-based virtualizers recompute, then reports the new position
 * and whether it moved / reached the end. Pure DOM, no Iris-event side effects.
 */
export function scrollContainer(ref: string | undefined, dy: number | undefined): ScrollResult {
  const base = ref !== undefined ? refs.resolve(ref) : null;
  const target =
    base instanceof Element
      ? nearestScrollable(base)
      : (document.scrollingElement ?? document.documentElement);

  const step = dy ?? (Math.round(target.clientHeight * VIEWPORT_FRACTION) || FALLBACK_STEP_PX);
  const before = target.scrollTop;
  target.scrollTop = before + step;
  target.dispatchEvent(new Event('scroll', { bubbles: false }));
  const after = target.scrollTop;

  return {
    scrolled: after !== before,
    scrollTop: after,
    scrollHeight: target.scrollHeight,
    clientHeight: target.clientHeight,
    atEnd: after + target.clientHeight >= target.scrollHeight - 1,
  };
}
