import { type ElementDescriptor, type ElementGeometry, type ElementQuery } from '@reticlehq/core';
import { isVisible, visibleBounds, visibilityInfoMemo } from './a11y.js';

type Box = ElementGeometry['box'];

/**
 * Measure geometry for the described elements (#1539), on when a predicate asserts on it.
 * `overlaps` carries the other element's query when the predicate names one.
 */
export interface GeometryAsk {
  overlaps?: ElementQuery;
}

/** Positive-area intersection: boxes that only touch at an edge do not overlap. */
export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Attach the measured geometry (#1539) to a descriptor. `overlapTarget` is the first visible
 * match of the overlaps query besides the measured element, when the predicate named one;
 * its box rides along with the measurement.
 */
export function attachGeometry(
  base: ElementDescriptor,
  el: Element,
  visMemo: Map<Element, boolean>,
  overlapTarget: Element | undefined,
): ElementDescriptor {
  const measured = measureGeometry(el, visMemo);
  if (overlapTarget !== undefined) {
    const otherRect = overlapTarget.getBoundingClientRect();
    const other = {
      x: otherRect.x,
      y: otherRect.y,
      width: otherRect.width,
      height: otherRect.height,
    };
    measured.overlap = { intersects: boxesIntersect(measured.box, other), box: other };
  }
  return { ...base, geometry: measured };
}

/**
 * Stamp geometry on one described element (#1539). The overlaps target is resolved per
 * element with the measured element excluded: an overlaps query that also matches the
 * measured element would otherwise intersect the box with itself, and `intersects` could
 * never be false.
 */
export function attachElementGeometry(
  base: ElementDescriptor,
  el: Element,
  geometry: GeometryAsk | undefined,
  visMemo: Map<Element, boolean>,
  findCandidates: (query: ElementQuery) => { candidates: Element[] },
): ElementDescriptor {
  if (geometry === undefined) return base;
  const target = resolveOverlapTarget(geometry.overlaps, el, visMemo, findCandidates);
  return attachGeometry(base, el, visMemo, target);
}

/**
 * The overlap target for an overlaps ask: the first visible candidate in document order,
 * excluding the measured element. Candidates arrive hidden or not, and measuring against
 * a hidden twin's box would grade the wrong element. Undefined when the query matched
 * nothing visible besides the measured element, which the engine grades inconclusive
 * rather than as boxes not intersecting (#1539).
 *
 * Takes the finder instead of importing the query module: the query module imports this one,
 * and the indirection keeps that edge one-way.
 */
function resolveOverlapTarget(
  overlaps: ElementQuery | undefined,
  measured: Element,
  visMemo: Map<Element, boolean>,
  findCandidates: (query: ElementQuery) => { candidates: Element[] },
): Element | undefined {
  if (undefined === overlaps) return undefined;
  return findCandidates(overlaps).candidates.find(
    (candidate) => candidate !== measured && isVisible(candidate, visMemo),
  );
}

/**
 * The geometry an element predicate can assert on (#1539), measured in the page.
 *
 * `fullyInViewport` reuses the clipping walk `visibleBounds` already does: the surviving region
 * must be the whole box, and the box must sit inside the window. A partially clipped or
 * partially off-screen element is the responsive-layout failure these checks exist to catch,
 * and `inViewport` (any part showing) cannot tell it from fully on screen.
 *
 * `textClipped` reads the same fact a reader hits: content beyond the client box on an axis
 * whose overflow clips (`hidden` or `clip`), or `text-overflow: ellipsis` beside an overflow
 * that clips on the inline axis. The amounts are pixels of content with nowhere to go.
 *
 * Lives here rather than in `a11y.ts`: that file is at the 1000-line cap, and this is the
 * geometry feature's own module.
 */
function measureGeometry(el: Element, memo?: Map<Element, boolean>): ElementGeometry {
  const view = el.ownerDocument.defaultView;
  const viewport = { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 };
  const rect = el.getBoundingClientRect();
  const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const clipped = visibleBounds(el, visibilityInfoMemo(memo), rect);
  const withinViewport =
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= viewport.width &&
    box.y + box.height <= viewport.height;
  // `visibleBounds` answers undefined when nothing clips the element, null when it is hidden
  // outright, and the surviving region otherwise. Only the first and third shapes can be whole.
  const uncut =
    clipped === undefined
      ? true
      : null === clipped
        ? false
        : clipped.left <= box.x &&
          clipped.top <= box.y &&
          clipped.right >= box.x + box.width &&
          clipped.bottom >= box.y + box.height;
  const fullyInViewport = withinViewport && uncut && box.width > 0 && box.height > 0;

  // `textClipped` measures the element's own box, not always an ancestor that clips:
  // overflow does not apply to an inline box, so a `<span>` inside a truncated `<div>` must be
  // read at the div. The span's own widths are 0 while its text is cut off. A block element
  // is read at its own box only: a short `<li>` inside an `overflow-x: hidden` carousel is
  // not clipped just because the carousel's whole list overflows (#1539).
  const clip = nearestClippingBox(el);
  // `text-overflow: ellipsis` has no effect without an overflow that clips, so it counts as
  // a clip only beside `hidden` or `clip` on the axis.
  const clipsX =
    null !== clip &&
    ('hidden' === clip.style.overflowX ||
      'clip' === clip.style.overflowX ||
      ('ellipsis' === clip.style.textOverflow &&
        ('hidden' === clip.style.overflowX || 'clip' === clip.style.overflowX)));
  const clipsY =
    null !== clip && ('hidden' === clip.style.overflowY || 'clip' === clip.style.overflowY);
  const clippedX =
    null === clip || !clipsX ? 0 : Math.max(0, clip.box.scrollWidth - clip.box.clientWidth);
  const clippedY =
    null === clip || !clipsY ? 0 : Math.max(0, clip.box.scrollHeight - clip.box.clientHeight);
  return {
    box,
    viewport,
    fullyInViewport,
    textClipped: clippedX > 0 || clippedY > 0,
    clippedX,
    clippedY,
  };
}

/** Whether a box's own overflow clips its content on either axis (#1539). */
function clipsContent(style: CSSStyleDeclaration): boolean {
  return (
    'hidden' === style.overflowX ||
    'clip' === style.overflowX ||
    'hidden' === style.overflowY ||
    'clip' === style.overflowY ||
    ('ellipsis' === style.textOverflow &&
      ('hidden' === style.overflowX || 'clip' === style.overflowX))
  );
}

/**
 * The box whose widths `textClipped` reads, starting at `el` itself. The walk goes up only
 * through boxes that have no box of their own: overflow does not apply to an inline box, and
 * `display: contents` has no box at all, so a `truncate` span's own widths read 0 while the
 * box around it cuts the text. The first real box on the walk decides. Return it when it
 * clips, and return null when it does not: a block that fits inside a clipping parent is
 * not clipped by that parent, so the walk must not read the parent's overflow as the
 * element's own (#1539). Null means nothing is cut and the amounts stay 0.
 */
function nearestClippingBox(el: Element): { box: Element; style: CSSStyleDeclaration } | null {
  const view = el.ownerDocument.defaultView;
  let current: Element | null = el;
  while (null !== current) {
    const style = null === view ? null : view.getComputedStyle(current);
    const display = style?.display ?? '';
    if (null !== style && 'inline' !== display && 'contents' !== display) {
      return clipsContent(style) ? { box: current, style } : null;
    }
    current = current.parentElement;
  }
  return null;
}
