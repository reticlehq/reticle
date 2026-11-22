/**
 * `scroll`: the content of a scroll area is moved, by its scroll bar or by a key.
 */
import { ActKind, Delivery } from '../driver.js';
import { UiRole } from '../ui-node.js';
import { see } from './seen.js';
import type { SelectContext } from './select.js';

/** Room for an effect that comes up to a second late, and then the quiet time after it. */
const SETTLE_MS = 1500;
/** How far one `dy` scroll moves the bar: a tenth of its range. */
const SCROLL_STEP = 0.1;
/** Said in the answer of a scroll that was done with a key, because there was no scroll bar. */
const SCROLL_BY_KEY = 'key';
/** Said in the answer of a scroll that was done with the real wheel. */
const SCROLL_BY_WHEEL = 'wheel';
/** Lines of the wheel for a place (the end or the start), and for one move. */
const WHEEL_TO_END = 40;
const WHEEL_STEP = 5;
/** The most turns of the wheel to an end: 10 turns of 40 lines. */
const WHEEL_TURNS_TO_END = 10;

/** The key that does what a scroll asks: the end or the start for a place, a page for a move. */
function scrollKeyFor(fraction: unknown, dy: unknown): string | undefined {
  if ('number' === typeof fraction) {
    return fraction >= 0.5 ? 'End' : 'Home';
  }
  if ('number' === typeof dy && dy !== 0) {
    return dy > 0 ? 'PageDown' : 'PageUp';
  }
  return undefined;
}

/**
 * Scrolls the scroll area that holds an element, by moving its scroll bar. No wheel event is
 * sent: a wheel event does not reach an application that is not in front, and it would use the
 * pointer of the person at the machine.
 *
 * `fraction` is the place of the bar, 0 to 1. `dy` moves the bar one step in its direction; the
 * realm does not know the height of the content, so it cannot scroll by pixels, and it says so.
 */
/** The point on the screen, "x,y", where the wheel turns. Set by the realm, from `args.point`. */
export const WHEEL_AT = 'wheelAt';

export async function scrollBy(
  ctx: Pick<SelectContext, 'driver' | 'refs' | 'drive'>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const given = args['ref'];
  const ref = 'string' === typeof given ? given : undefined;
  // Neither how far nor where to: the wheel turned 0 lines, or the bar was set to its own place,
  // and the answer said that it scrolled.
  if (
    'number' !== typeof args['fraction'] &&
    !('number' === typeof args['dy'] && 0 !== args['dy'])
  ) {
    throw new Error(
      'a scroll needs args.dy (a number of pixels: more than 0 goes down, less than 0 goes up) or args.fraction (a place from 0, the top, to 1, the end).',
    );
  }
  const read = await ctx.driver.read();
  const seen = see(read.root);
  const key = ref === undefined ? undefined : ctx.refs.keyOf(ref);
  if (ref !== undefined && !seen.some((s) => s.key === key)) {
    throw new Error(`ref '${ref}' no longer resolves to an element`);
  }
  // The first vertical bar that is in the element's own line of parents, or the first of all.
  const bars = seen.filter(
    (s) =>
      s.node.role === UiRole.SCROLLBAR &&
      s.node.frame !== undefined &&
      s.node.frame[3] > s.node.frame[2],
  );
  const bar =
    key === undefined
      ? bars[0]
      : bars
          .filter((b) => b.parentKey !== undefined && `${key}/`.startsWith(`${b.parentKey}/`))
          .at(-1);
  const fraction = args['fraction'];
  const dy = args['dy'];
  // With the foreground, the real wheel over the element, as a person scrolls. A list of a web
  // view (Discord's servers) has no bar and takes no key: "Add a Server" stayed under the edge.
  const over = seen.find((s) => s.key === key);
  if (true === args['foreground'] && over !== undefined && ref !== undefined) {
    let lines = 0;
    if ('number' === typeof fraction) {
      lines = fraction >= 0.5 ? WHEEL_TO_END : -WHEEL_TO_END;
    } else if ('number' === typeof dy && dy !== 0) {
      lines = Math.sign(dy) * WHEEL_STEP;
    }
    // At a point of the picture when one is given: "lines,x,y". Else over the element.
    const at = 'string' === typeof args[WHEEL_AT] ? `,${args[WHEEL_AT]}` : '';
    const turn = async (): Promise<boolean> =>
      (
        await ctx.drive(over, ref, ActKind.WHEEL, `${String(lines)}${at}`, {
          delivery: Delivery.FOREGROUND,
          budgetMs: SETTLE_MS,
        })
      ).changes.length > 0;
    // To an end, the wheel turns until nothing moves, as a hand does: one turn did not reach the
    // end of the 300 channels of Discord. A turn that moves nothing says the end is reached.
    const toEnd = 'number' === typeof fraction;
    let turns = 1;
    const moved = await turn();
    let atEnd = !moved;
    for (let last = moved; toEnd && last && turns < WHEEL_TURNS_TO_END; turns += 1) {
      last = await turn();
      atEnd = !last;
    }
    // Declared: the caller asked for a place or for pixels, and got lines of the wheel.
    return {
      scrolled: moved,
      by: SCROLL_BY_WHEEL,
      lines: lines * turns,
      ...(toEnd ? { atEnd } : {}),
    };
  }
  if (bar === undefined) {
    // A page in a Chromium browser has no scroll bar in its tree. A key scrolls it, also when
    // the browser is not in front. The key goes to the element, or to the page, or to the window.
    const target =
      seen.find((s) => s.key === key) ??
      seen.find((s) => s.node.role === UiRole.DOCUMENT) ??
      seen[0];
    const scrollKey = scrollKeyFor(fraction, dy);
    if (target === undefined || scrollKey === undefined) {
      throw new Error('there is no scroll bar to move for this element');
    }
    const keyed = await ctx.drive(target, ctx.refs.refFor(target.key), ActKind.KEY, scrollKey, {
      delivery: Delivery.DIRECT,
      budgetMs: SETTLE_MS,
    });
    // Declared: the caller asked for a place or for pixels, and got one key. The place of the
    // content after the key is not known, so no `fraction` and no `atEnd` are given.
    return { scrolled: keyed.changes.length > 0, by: SCROLL_BY_KEY, key: scrollKey };
  }
  const now = Number(bar.node.value ?? '0');
  let to = now;
  if ('number' === typeof fraction) {
    to = fraction;
  } else if ('number' === typeof dy && dy !== 0) {
    to = now + Math.sign(dy) * SCROLL_STEP;
  }
  to = Math.min(1, Math.max(0, to));
  const { changes } = await ctx.drive(bar, ctx.refs.refFor(bar.key), ActKind.SET, String(to), {
    // A person scrolls with a wheel over the content, not by a click on the bar, and the bar
    // of a modern scroll area is not drawn until then. So no reach check is made on the bar.
    delivery: Delivery.DIRECT,
    budgetMs: SETTLE_MS,
  });
  return {
    scrolled: changes.length > 0,
    atEnd: 0 === to || 1 === to,
    fraction: to,
    // Declared, because the caller asked for pixels and got a step.
    ...('number' === typeof dy && 'number' !== typeof fraction
      ? { stepInsteadOfPixels: SCROLL_STEP }
      : {}),
  };
}
