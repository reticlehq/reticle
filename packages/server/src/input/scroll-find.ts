import { IrisCommand, SCROLL_FIND_DEFAULTS, type CommandResult } from '@syrin/iris-protocol';
import { asRecord } from '../tools/tools-helpers.js';

/** The slice of Session scroll-to-find needs — so tests inject a fake without a live browser. */
export interface ScrollFindSession {
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
}

export interface ScrollFindQuery {
  by: string;
  value: string;
  name?: string;
  /** Ref of the scrollable list container; omit to scroll the document. */
  container?: string;
}

export interface ScrollFindResult {
  found: boolean;
  /** The first matching element descriptor (when found). */
  element?: Record<string, unknown>;
  /** How many viewport scrolls were performed. */
  scrolls: number;
  /**
   * true ⇒ stopped because the list reached its end / could not scroll (raising maxScrolls won't
   * help). false ⇒ stopped at the maxScrolls budget (more rows may exist further down).
   */
  exhausted: boolean;
}

/** One query for the target; returns the first matching element descriptor or undefined. */
async function queryFirst(
  session: ScrollFindSession,
  q: ScrollFindQuery,
): Promise<Record<string, unknown> | undefined> {
  const res = await session.command(IrisCommand.QUERY, {
    by: q.by,
    value: q.value,
    ...(q.name !== undefined ? { name: q.name } : {}),
  });
  const elements = asRecord(res.result)['elements'];
  if (Array.isArray(elements) && elements.length > 0) return asRecord(elements[0]);
  return undefined;
}

/**
 * Reveal an element that a windowed/virtualized list has not mounted yet. Queries
 * once (it may already be visible), then scrolls the container ~one viewport at a time, re-querying
 * after each, until the element appears, the list ends, or the maxScrolls budget is spent. Pure
 * orchestration over the session command seam — fully unit-testable with a fake.
 */
export async function scrollToFind(
  session: ScrollFindSession,
  q: ScrollFindQuery,
  opts: { maxScrolls?: number } = {},
): Promise<ScrollFindResult> {
  const max = opts.maxScrolls ?? SCROLL_FIND_DEFAULTS.MAX_SCROLLS;

  const first = await queryFirst(session, q);
  if (first !== undefined) return { found: true, element: first, scrolls: 0, exhausted: false };

  let scrolls = 0;
  for (let i = 0; i < max; i += 1) {
    const sr = await session.command(
      IrisCommand.SCROLL,
      q.container !== undefined ? { ref: q.container } : {},
    );
    scrolls += 1;
    const data = asRecord(sr.result);

    const hit = await queryFirst(session, q);
    if (hit !== undefined) return { found: true, element: hit, scrolls, exhausted: false };

    // Reached the bottom or the container would not move — no more rows to reveal.
    if (data['atEnd'] === true || data['scrolled'] === false) {
      return { found: false, scrolls, exhausted: true };
    }
  }
  return { found: false, scrolls, exhausted: false }; // spent the budget; more may lie further down
}
