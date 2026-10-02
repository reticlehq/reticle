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
    if (only === undefined) return host;
    // A spacer is a single child that fills (or over-fills) the scroll area.
    if (only.offsetHeight < host.scrollHeight * 0.9) return host;
    host = only;
  }
  return host;
}

/** How many rows a container is holding space for but has not rendered. 0 when it is not virtualized. */
export function unmountedRowsIn(container: HTMLElement): number {
  const scrollHeight = container.scrollHeight;
  const clientHeight = container.clientHeight;
  if (clientHeight <= 0 || scrollHeight < clientHeight * MIN_SCROLL_RATIO) return 0;

  const host = rowHost(container);
  const rows = Array.from(host.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
  if (rows.length < 2) return 0;

  let top = Infinity;
  let bottom = 0;
  let totalHeight = 0;
  for (const row of rows) {
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowTop < top) top = rowTop;
    if (rowBottom > bottom) bottom = rowBottom;
    totalHeight += row.offsetHeight;
  }
  // Space the container reserved and left empty: above the first row plus below the last.
  const empty = Math.max(0, top) + Math.max(0, scrollHeight - bottom);
  if (empty < scrollHeight * UNMOUNTED_RATIO) return 0;

  const averageRow = totalHeight / rows.length;
  if (averageRow <= 0) return 0;
  return Math.round(empty / averageRow);
}

/** Total unmounted rows across every scroll container on the page. */
export function countUnmountedRows(): number {
  let total = 0;
  for (const element of document.querySelectorAll<HTMLElement>('*')) {
    // Cheap gate first: only elements that actually scroll are worth measuring.
    if (element.scrollHeight <= element.clientHeight) continue;
    total += unmountedRowsIn(element);
  }
  return total;
}
