/**
 * Rows a scroll container has reserved space for but has NOT rendered.
 *
 * `BlindSpotKind.VIRTUALIZED_UNMOUNTED` has had a label on the server since it was defined and
 * nothing ever emitted it — a declared blind spot that could not fire, shaped exactly like the most
 * common data-heavy UI there is. Measured on a 10,000-row console: 29 rows in the DOM, and a verdict
 * that reported full coverage. An assertion like "no shipment is held" was a claim about 29 rows,
 * delivered as a claim about all of them.
 *
 * The detector measures EMPTY RESERVED SPACE rather than guessing from child counts. A virtualizer
 * sizes its scroll area for the whole list and renders only a window, so the area above the first
 * child and below the last is space the container has promised and not filled. An ordinary list —
 * even one with large gaps or margins between rows — spans its own scroll height, so it measures
 * zero and never reports.
 */

import { isElement } from './realm.js';

/** Below this, the empty space is padding or a sticky header rather than a virtualized remainder. */
const UNMOUNTED_RATIO = 0.25;

/** A container has to be meaningfully scrollable before "what is not rendered" is even a question. */
const MIN_SCROLL_RATIO = 1.2;

/**
 * Virtualizers usually put one full-height SPACER inside the scroller and position rows absolutely
 * inside it, so the scroller's own children are just that spacer. Descend through it to reach the
 * rows — without this the spacer measures as filling the container and nothing is ever detected.
 */
function rowHost(container: HTMLElement): HTMLElement {
  let host = container;
  for (let depth = 0; depth < 3; depth += 1) {
    const children = Array.from(host.children).filter(
      (c): c is HTMLElement => c instanceof HTMLElement,
    );
    const only = 1 === children.length ? children[0] : undefined;
    if (only === undefined) {
      return host;
    }
    // A spacer is a single child that fills (or over-fills) the scroll area.
    if (only.offsetHeight < host.scrollHeight * 0.9) {
      return host;
    }
    host = only;
  }
  return host;
}

/** How many rows a container is holding space for but has not rendered. 0 when it is not virtualized. */
export function unmountedRowsIn(container: HTMLElement): number {
  const scrollHeight = container.scrollHeight;
  const clientHeight = container.clientHeight;
  if (clientHeight <= 0 || scrollHeight < clientHeight * MIN_SCROLL_RATIO) {
    return 0;
  }

  const host = rowHost(container);
  const rows = Array.from(host.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
  if (rows.length < 2) {
    return 0;
  }

  let top = Infinity;
  let bottom = 0;
  let totalHeight = 0;
  // offsetTop belongs to the row's offsetParent, which may be outside an ordinary scroller.
  // Convert viewport rectangles back to layout units before adding the border and scroll offset.
  const bounds = container.getBoundingClientRect();
  const scaleY =
    container.offsetHeight > 0 && bounds.height > 0 ? bounds.height / container.offsetHeight : 1;
  for (const row of rows) {
    const rowTop =
      (row.getBoundingClientRect().top - bounds.top) / scaleY -
      container.clientTop +
      container.scrollTop;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowTop < top) {
      top = rowTop;
    }
    if (rowBottom > bottom) {
      bottom = rowBottom;
    }
    totalHeight += row.offsetHeight;
  }
  // Space the container reserved and left empty: above the first row plus below the last.
  const empty = Math.max(0, top) + Math.max(0, scrollHeight - bottom);
  if (empty < scrollHeight * UNMOUNTED_RATIO) {
    return 0;
  }

  const averageRow = totalHeight / rows.length;
  if (averageRow <= 0) {
    return 0;
  }
  return Math.round(empty / averageRow);
}

/**
 * Every scroll container on the page that holds space for rows it has not rendered, with its count.
 *
 * One enumerator feeds the blind-spot count and the containment proof below. The two then agree on
 * which containers are virtualized: a container the count includes is a container the proof tests.
 */
function virtualized(): { container: HTMLElement; unmounted: number }[] {
  const found: { container: HTMLElement; unmounted: number }[] = [];
  for (const element of document.querySelectorAll<HTMLElement>('*')) {
    // Cheap gate first: only elements that actually scroll are worth measuring.
    if (element.scrollHeight <= element.clientHeight) {
      continue;
    }
    const unmounted = unmountedRowsIn(element);
    if (unmounted > 0) {
      found.push({ container: element, unmounted });
    }
  }
  return found;
}

/** Total unmounted rows across every scroll container on the page. */
export function countUnmountedRows(): number {
  let total = 0;
  for (const { unmounted } of virtualized()) {
    total += unmounted;
  }
  return total;
}

/**
 * The next node up the tree that a query searches: the parent node, the host of a shadow root, or
 * the frame element of a document. Null at the top document, and at a frame the page cannot read.
 */
function composedParent(node: Node): Node | null {
  if (null !== node.parentNode) {
    return node.parentNode;
  }
  // `host` exists on a ShadowRoot and not on a Document. Read the property as
  // `parentAcrossShadowBoundary` does: `instanceof ShadowRoot` is false for a root from a frame.
  const host: unknown = (node as Partial<ShadowRoot>).host;
  if (isElement(host)) {
    return host;
  }
  try {
    return (node as Partial<Document>).defaultView?.frameElement ?? null;
  } catch {
    // The parent page has another origin and refuses the read. The walk stops at this document.
    return null;
  }
}

/** Whether `node` is `ancestor` or is below it, through shadow roots and same-origin frames. */
function isWithin(node: Node, ancestor: Node): boolean {
  for (let current: Node | null = node; null !== current; current = composedParent(current)) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `roots` and `matches` are clear of every virtualized container the blind spot counts.
 *
 * True only when each root is not inside a virtualized container and does not contain one, and no
 * match is inside one. A row that such a container did not render would be below the container, so
 * it cannot be below a root that is clear of the container. A query that searches only those roots
 * then cannot match an unmounted row (#2298). With no virtualized container on the page, the answer
 * is true.
 */
export function clearOfVirtualized(
  roots: readonly Element[],
  matches: readonly Element[],
): boolean {
  return virtualized().every(
    ({ container }) =>
      roots.every((root) => !isWithin(root, container) && !isWithin(container, root)) &&
      matches.every((el) => !isWithin(el, container)),
  );
}
