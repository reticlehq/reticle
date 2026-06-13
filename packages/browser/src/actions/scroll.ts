import { refs } from '../dom/refs.js';

/** Outcome of one container scroll — enough for the server to drive a find loop. */
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
 * Scroll the container of `ref` (or the document) down by `dy` (default ~one viewport) so a
 * virtualized list mounts its next window of rows. If `fraction` (0–1) is supplied, jumps
 * directly to that fraction of scrollHeight instead of stepping — enables bisection for large
 * lists where a specific row index is known (targetIndex / totalCount = fraction).
 */
export function scrollContainer(
  ref: string | undefined,
  dy: number | undefined,
  fraction?: number,
): ScrollResult {
  const base = ref !== undefined ? refs.resolve(ref) : null;
  const target =
    base instanceof Element
      ? nearestScrollable(base)
      : (document.scrollingElement ?? document.documentElement);

  const before = target.scrollTop;
  if (fraction !== undefined && fraction >= 0 && fraction <= 1) {
    target.scrollTop = Math.round(target.scrollHeight * fraction);
  } else {
    const step = dy ?? (Math.round(target.clientHeight * VIEWPORT_FRACTION) || FALLBACK_STEP_PX);
    target.scrollTop = before + step;
  }
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
