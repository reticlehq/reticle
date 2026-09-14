import { refs } from '../dom/addressing/refs.js';

/** Outcome of one container scroll — enough for the server to drive a find loop. */
interface ScrollResult {
  /** the container actually moved (false ⇒ already at the end / not scrollable). */
  scrolled: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** At (or within 1px of) the bottom — no more rows to reveal by scrolling down. */
  atEnd: boolean;
  /** At (or within 1px of) the top — nothing above to scroll BACK to. */
  atStart: boolean;
  /** The horizontal axis, reported for the same reason `inspect` reports it: clipping happens here too. */
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  atLeftEnd: boolean;
  atRightEnd: boolean;
}

const FALLBACK_STEP_PX = 400;
const VIEWPORT_FRACTION = 0.8;

/**
 * The nearest scrollable ancestor of `el` (inclusive), else the document scrolling element.
 *
 * Either axis counts. Looking only at `overflowY` walked straight past a horizontally-scrolling
 * container — a wide table, a carousel — and scrolled the page behind it instead, which looks like
 * "the scroll did nothing" and is really "something else moved".
 */
function nearestScrollable(el: Element, axis: 'x' | 'y'): Element {
  let cur: Element | null = el;
  while (cur !== null && cur !== document.body) {
    const style = getComputedStyle(cur);
    const overflow = 'x' === axis ? style.overflowX : style.overflowY;
    const scrollable =
      'x' === axis ? cur.scrollWidth > cur.clientWidth : cur.scrollHeight > cur.clientHeight;
    if (('auto' === overflow || 'scroll' === overflow) && scrollable) return cur;
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
  /** Horizontal delta. Negative scrolls LEFT, as negative `dy` scrolls back up. */
  dx?: number,
): ScrollResult {
  const base = ref !== undefined ? refs.resolve(ref) : null;
  return scrollFrom(base instanceof Element ? base : undefined, dy, fraction, dx);
}

/**
 * The same scroll, addressed by ELEMENT rather than by ref.
 *
 * The action dispatcher already holds the element; making it hand back a ref so this could resolve
 * one again was a round trip through an attribute that is not always present — and when it was
 * absent the scroll silently retargeted the DOCUMENT, which moves something and therefore looks
 * like it worked.
 */
export function scrollFrom(
  base: Element | undefined,
  dy: number | undefined,
  fraction?: number,
  dx?: number,
): ScrollResult {
  const axis: 'x' | 'y' =
    dx !== undefined && dx !== 0 && (dy === undefined || 0 === dy) ? 'x' : 'y';
  const target =
    base !== undefined
      ? nearestScrollable(base, axis)
      : (document.scrollingElement ?? document.documentElement);

  const before = target.scrollTop;
  const beforeLeft = target.scrollLeft;
  if (fraction !== undefined && fraction >= 0 && fraction <= 1) {
    target.scrollTop = Math.round(target.scrollHeight * fraction);
  } else {
    // A NEGATIVE dy scrolls back up, and that is the whole reason this signature grew. The default
    // step is still forward, so nothing about the existing "reveal the next window" call changes —
    // but a page could previously be walked in one direction only, and whatever scrolled past was
    // unreachable without reloading.
    if (dx !== undefined && dx !== 0) target.scrollLeft = beforeLeft + dx;
    if (dx === undefined || (dy !== undefined && 0 !== dy)) {
      const step = dy ?? (Math.round(target.clientHeight * VIEWPORT_FRACTION) || FALLBACK_STEP_PX);
      target.scrollTop = before + step;
    }
  }
  target.dispatchEvent(new Event('scroll', { bubbles: false }));
  const after = target.scrollTop;
  const afterLeft = target.scrollLeft;

  return {
    scrolled: after !== before || afterLeft !== beforeLeft,
    scrollTop: after,
    scrollHeight: target.scrollHeight,
    clientHeight: target.clientHeight,
    atEnd: after + target.clientHeight >= target.scrollHeight - 1,
    atStart: after <= 1,
    scrollLeft: afterLeft,
    scrollWidth: target.scrollWidth,
    clientWidth: target.clientWidth,
    atLeftEnd: afterLeft <= 1,
    atRightEnd: afterLeft + target.clientWidth >= target.scrollWidth - 1,
  };
}
