/**
 * Finding a row a windowed list has not rendered — and saying so when we have not.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 * `react-window` and friends render only the rows on screen. A query walks the DOM, so it is looking
 * at a fraction of the list and answers "no match" for a row that exists. An agent reads that as
 * "the element is not there" and moves on — a FALSE NEGATIVE manufactured by the tool rather than
 * found in the app, which is the failure this product exists to refuse.
 *
 * The remedy already existed as `reticle_scroll_to`, and that was the other half of the problem: it
 * is not advertised on the default surface, so the agent that needed it could not see it and had no
 * way to learn it existed. A capability reachable only by already knowing about it is not reachable.
 *
 * The SCROLLING half lives in `portal/input/scroll-find.ts`, because it drives the page and this
 * directory must not reach into `input/` — doing so completed a mutual pair, and two directories
 * that need each other cannot be read, moved or tested apart. Shaping an answer and scrolling a list
 * are different jobs anyway; the guard made that visible before it was a habit.
 *
 * ── WHY OPT-IN, NOT AUTOMATIC ───────────────────────────────────────────────────────────────────
 * `reticle_look` promises "Reads only — nothing here changes the app". Scrolling moves the viewport
 * and mounts rows, so folding it in silently would rescue the miss by quietly breaking the guarantee
 * — trading a false negative for an unannounced side effect on a tool whose whole contract is that
 * it has none. Instead: the default stays a pure read, a miss says WHAT IT SEARCHED, and the search
 * that scrolls is one flag away on the same advertised tool.
 *
 * That ordering matters. The note is what removes the false negative; the flag is only what makes
 * the note actionable.
 */

import { asNumber } from '@reticlehq/core';
import { paginateQueryResult } from '@/surface/tools/read/query-paginate.js';

/**
 * Said on a miss, and ONLY on a miss.
 *
 * Unconditional rather than guessing whether this page has a windowed list: deciding that would cost
 * a round trip to measure scroll containers, and a guess dressed as a fact is what the rest of this
 * file is about. The sentence is true of every miss — a query searched the rendered nodes — so it
 * informs without claiming to know why nothing matched.
 */
export const RENDERED_ONLY_NOTE =
  'Searched the RENDERED nodes only. A windowed list (react-window and similar) mounts just the rows ' +
  'on screen, so a row that exists off-screen does not match. Scroll the list with ' +
  'reticle_act { action: "scroll" } and search again.';

/** Only the fields this module reads off a query result. */
interface QueryShaped {
  elements?: unknown;
  count?: unknown;
  note?: unknown;
}

/**
 * Attach the note when a query matched nothing.
 *
 * Leaves an existing `note` alone: the read path already uses that field to explain a capped or
 * truncated result, and overwriting it would replace a fact about THIS answer with a general remark.
 */
export function noteRenderedOnly(result: unknown): unknown {
  if (typeof result !== 'object' || null === result) return result;
  const shaped = result as QueryShaped;
  const matched = Array.isArray(shaped.elements)
    ? shaped.elements.length
    : 'number' === typeof shaped.count
      ? shaped.count
      : undefined;
  if (0 !== matched) return result;
  if ('string' === typeof shaped.note && shaped.note.length > 0) return result;
  return { ...result, note: RENDERED_ONLY_NOTE };
}

/**
 * Everything that turns a raw query answer into this tool's answer: paginate, note a miss, cost it.
 *
 * One function rather than three nested calls at the call site. The order is not arbitrary — the
 * note is attached AFTER pagination, so "nothing matched" means nothing matched on the page rather
 * than nothing survived the page limit, and the size cost is measured last because it measures what
 * is actually sent by the CALLER — `withSizeCost` is applied there, not here, because this directory
 * is a pure leaf that reaches nothing, and the reach guard is right to keep it that way.
 */
export function shapeQueryResult(result: unknown, args: Record<string, unknown>): unknown {
  const paginated = paginateQueryResult(
    result,
    asNumber(args['limit']),
    true === args['count_only'],
  );
  return noteRenderedOnly(paginated);
}
