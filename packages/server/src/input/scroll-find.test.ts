import { describe, expect, it } from 'vitest';
import { ReticleCommand, type CommandResult } from '@reticlehq/core';
import { scrollToFind, type ScrollFindSession } from './scroll-find.js';

/**
 * A fake that behaves like a real virtualized container measured in viewport-pages, because the
 * search now walks BOTH directions and a counter-based fake cannot express "the target is above
 * the position the search started from". `pages` is the scrollable height in viewports; the list
 * starts at `startPage`; the target row mounts only when scrollTop sits on `targetPage` (a target
 * outside `[0, pages]` is genuinely absent). Fraction jumps round to a page, dy moves one page per
 * 0.8-viewport step like the browser-side default.
 */
interface ListScript {
  pages: number;
  startPage: number;
  /** Page the target mounts on; -1 means the row does not exist anywhere in the list. */
  targetPage: number;
  /** The container cannot scroll at all (nothing to scroll, e.g. an unscrollable document). */
  unscrollable?: boolean;
}

function fakeSession(script: ListScript): { session: ScrollFindSession; scrollArgs: unknown[] } {
  let page = script.startPage;
  const scrollArgs: unknown[] = [];
  const ok = (result: unknown): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
  const CLIENT_HEIGHT = 400;
  const session: ScrollFindSession = {
    command: (name, args) => {
      if (name === ReticleCommand.QUERY) {
        const found = true !== script.unscrollable && page === script.targetPage;
        return ok({ elements: found ? [{ ref: 'e1', desc: 'Row' }] : [] });
      }
      if (name === ReticleCommand.SCROLL) {
        scrollArgs.push(args);
        const fraction = (args as { fraction?: number }).fraction;
        const dy = (args as { dy?: number }).dy;
        if (true === script.unscrollable) {
          return ok({ scrolled: false, atEnd: false, scrollTop: 0, clientHeight: CLIENT_HEIGHT });
        }
        if ('number' === typeof fraction) {
          page = Math.min(script.pages, Math.round(script.pages * fraction));
        } else {
          const before = page;
          page = Math.max(0, Math.min(script.pages, page + Math.sign(dy ?? 1)));
          const last = { scrolled: page !== before };
          return ok({
            ...last,
            atEnd: page >= script.pages,
            scrollTop: page * CLIENT_HEIGHT,
            clientHeight: CLIENT_HEIGHT,
          });
        }
        return ok({
          scrolled: true,
          atEnd: page >= script.pages,
          scrollTop: page * CLIENT_HEIGHT,
          clientHeight: CLIENT_HEIGHT,
        });
      }
      return ok({});
    },
  };
  return { session, scrollArgs };
}

const Q = { by: 'testid', value: 'row-500' };

describe('scrollToFind', () => {
  it('1: an already-visible element is found with zero scrolls', async () => {
    const { session } = fakeSession({ pages: 5, startPage: 2, targetPage: 2 });
    const r = await scrollToFind(session, Q);
    expect(r.found).toBe(true);
    expect(r.scrolls).toBe(0);
    expect(r.element).toEqual({ ref: 'e1', desc: 'Row' });
  });

  it('2: scrolls down until the virtualized row mounts, then returns it', async () => {
    const { session } = fakeSession({ pages: 8, startPage: 0, targetPage: 3 });
    const r = await scrollToFind(session, Q, { maxScrolls: 20 });
    expect(r.found).toBe(true);
    expect(r.exhausted).toBe(false);
  });

  it('3: a row ABOVE a bottomed list is found by turning upward (#505)', async () => {
    // The field report: the list sat at its end, the retained-but-unmounted row was above it, and
    // downward-only search answered exhausted on the first step. Upward must find it instead.
    const { session } = fakeSession({ pages: 9, startPage: 9, targetPage: 4 });
    const r = await scrollToFind(session, Q, { maxScrolls: 40 });
    expect(r.found).toBe(true);
    expect(r.scrolls).toBeGreaterThan(1);
  });

  it('4: bisection overshoot recovers by refining back upward (#505)', async () => {
    // Jump lands past the target; walking down hits the end; the upward pass then finds it rather
    // than reporting exhausted at the bottom.
    const { session } = fakeSession({ pages: 10, startPage: 0, targetPage: 2 });
    const r = await scrollToFind(
      session,
      { ...Q, targetIndex: 9, totalCount: 10 },
      { maxScrolls: 40 },
    );
    expect(r.found).toBe(true);
  });

  it('5: a genuinely absent row is exhausted only after BOTH directions are spent', async () => {
    const { session } = fakeSession({ pages: 4, startPage: 0, targetPage: -1 });
    const r = await scrollToFind(session, Q, { maxScrolls: 40 });
    expect(r.found).toBe(false);
    expect(r.exhausted).toBe(true);
  });

  it('6: spending the scroll budget mid-list reports exhausted:false', async () => {
    // Budget too small to reach either end: more rows may exist, so exhaustion would be a lie.
    const { session } = fakeSession({ pages: 30, startPage: 0, targetPage: -1 });
    const r = await scrollToFind(session, Q, { maxScrolls: 4 });
    expect(r.found).toBe(false);
    expect(r.scrolls).toBe(4);
    expect(r.exhausted).toBe(false);
  });

  it('6b: the upward pass gets the caller budget again, not the remainder (#505)', async () => {
    const { session } = fakeSession({ pages: 10, startPage: 0, targetPage: -1 });
    const r = await scrollToFind(session, Q, { maxScrolls: 12 });
    expect(r.found).toBe(false);
    expect(r.exhausted).toBe(true);
  });

  it('7: forwards the container ref to every SCROLL command (including the reset)', async () => {
    const { session, scrollArgs } = fakeSession({ pages: 6, startPage: 0, targetPage: 2 });
    await scrollToFind(session, { ...Q, container: 'e9' }, { maxScrolls: 20 });
    expect(scrollArgs.every((a) => 'e9' === (a as { ref?: string }).ref)).toBe(true);
    expect((scrollArgs[0] as { fraction?: number }).fraction).toBe(0);
  });

  it('8: upward steps carry a negative dy (#505)', async () => {
    // Bisection overshoots to page 8; target is at page 4. The downward pass hits the end, the
    // upward pass walks back. Bisection suppresses the reset-to-top so the turnaround still fires.
    const { session, scrollArgs } = fakeSession({ pages: 10, startPage: 0, targetPage: 4 });
    await scrollToFind(session, { ...Q, targetIndex: 8, totalCount: 10 }, { maxScrolls: 40 });
    const dys = scrollArgs.map((a) => (a as { dy?: number }).dy);
    expect(dys.some((d) => d !== undefined && d < 0)).toBe(true);
  });

  it('9: notes that the document would not scroll when nothing ever moved', async () => {
    const { session } = fakeSession({ pages: 0, startPage: 0, targetPage: -1, unscrollable: true });
    const r = await scrollToFind(session, Q, { maxScrolls: 10 });
    expect(r.found).toBe(false);
    expect(r.exhausted).toBe(true);
    expect(r.note).toContain('scroll container');
  });

  it('10: keeps the note off when a container is explicitly given', async () => {
    const { session } = fakeSession({ pages: 0, startPage: 0, targetPage: -1, unscrollable: true });
    const r = await scrollToFind(session, { ...Q, container: 'e9' }, { maxScrolls: 10 });
    expect(r.note).toBeUndefined();
  });

  it('11: keeps the note off when both directions genuinely scrolled', async () => {
    const { session } = fakeSession({ pages: 4, startPage: 0, targetPage: -1 });
    const r = await scrollToFind(session, Q, { maxScrolls: 40 });
    expect(r.exhausted).toBe(true);
    expect(r.note).toBeUndefined();
  });

  it('12: the reset-to-top enables finding an element above the initial scroll position', async () => {
    // startPage=4 means the list is scrolled mid-way; target is at page 1 (above). Without the
    // reset to top, the downward scan would never find it — the reset puts us at page 0, then
    // linear scan walks down to page 1.
    const { session, scrollArgs } = fakeSession({ pages: 8, startPage: 4, targetPage: 1 });
    const r = await scrollToFind(session, Q, { maxScrolls: 20 });
    expect(r.found).toBe(true);
    expect((scrollArgs[0] as { fraction?: number }).fraction).toBe(0);
  });
});
