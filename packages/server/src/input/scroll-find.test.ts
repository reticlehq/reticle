import { describe, expect, it } from 'vitest';
import { ReticleCommand, type CommandResult } from '@reticlehq/core';
import { scrollToFind, type ScrollFindSession } from './scroll-find.js';

interface Script {
  /** Number of scrolls after which QUERY starts matching (0 = already visible). */
  foundAtScroll?: number;
  /** Scroll count at/after which SCROLL reports atEnd. */
  atEndAtScroll?: number;
  /** Scroll count at/after which SCROLL reports scrolled:false (can't move). */
  scrolledFalseAt?: number;
}

function fakeSession(script: Script): { session: ScrollFindSession; scrollArgs: unknown[] } {
  let scrolls = 0;
  const scrollArgs: unknown[] = [];
  const ok = (result: unknown): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
  const session: ScrollFindSession = {
    command: (name, args) => {
      if (name === ReticleCommand.QUERY) {
        const found = script.foundAtScroll !== undefined && scrolls >= script.foundAtScroll;
        return ok({ elements: found ? [{ ref: 'e1', desc: 'Row 500' }] : [] });
      }
      if (name === ReticleCommand.SCROLL) {
        scrolls += 1;
        scrollArgs.push(args);
        return ok({
          scrolled: !(script.scrolledFalseAt !== undefined && scrolls >= script.scrolledFalseAt),
          atEnd: script.atEndAtScroll !== undefined && scrolls >= script.atEndAtScroll,
          scrollTop: scrolls * 100,
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
    const { session } = fakeSession({ foundAtScroll: 0 });
    const r = await scrollToFind(session, Q);
    expect(r.found).toBe(true);
    expect(r.scrolls).toBe(0);
    expect(r.element).toEqual({ ref: 'e1', desc: 'Row 500' });
  });

  it('2: scrolls until the virtualized row mounts, then returns it', async () => {
    const { session } = fakeSession({ foundAtScroll: 3 });
    const r = await scrollToFind(session, Q, { maxScrolls: 10 });
    expect(r.found).toBe(true);
    expect(r.scrolls).toBe(3);
    expect(r.exhausted).toBe(false);
  });

  it('3: reaching the list end stops the search and marks exhausted', async () => {
    const { session } = fakeSession({ atEndAtScroll: 2 });
    const r = await scrollToFind(session, Q, { maxScrolls: 10 });
    expect(r.found).toBe(false);
    expect(r.exhausted).toBe(true);
    expect(r.scrolls).toBe(2);
  });

  it('4: a container that cannot move (scrolled:false) is exhausted immediately', async () => {
    const { session } = fakeSession({ scrolledFalseAt: 1 });
    const r = await scrollToFind(session, Q, { maxScrolls: 10 });
    expect(r.found).toBe(false);
    expect(r.exhausted).toBe(true);
    expect(r.scrolls).toBe(1);
  });

  it('5: spending the scroll budget (not the end) reports exhausted:false', async () => {
    const { session } = fakeSession({}); // never found, never at end
    const r = await scrollToFind(session, Q, { maxScrolls: 4 });
    expect(r.found).toBe(false);
    expect(r.scrolls).toBe(4);
    expect(r.exhausted).toBe(false); // more rows may exist — raising maxScrolls could help
  });

  it('6: forwards the container ref to each SCROLL command', async () => {
    const { session, scrollArgs } = fakeSession({ foundAtScroll: 2 });
    await scrollToFind(session, { ...Q, container: 'e9' }, { maxScrolls: 10 });
    expect(scrollArgs.every((a) => (a as { ref?: string }).ref === 'e9')).toBe(true);
    expect(scrollArgs.length).toBe(2);
  });
});
