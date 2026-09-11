import { describe, expect, it } from 'vitest';
import { ActionType } from '@reticlehq/core';
import type { Page } from 'playwright';
import {
  boxCenter,
  capturePage,
  CdpRealInputProvider,
  isPointerAction,
  selectPage,
} from './real-input.js';

/** Records the options each page.screenshot call receives and returns minimal PNG bytes. */
function recordingPage(calls: Record<string, unknown>[]): Page {
  return {
    screenshot: (opts: Record<string, unknown>) => {
      calls.push(opts);
      return Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    },
  } as unknown as Page;
}

describe('real-input pure helpers', () => {
  it('boxCenter returns the geometric center in CSS px', () => {
    expect(boxCenter({ x: 10, y: 20, width: 100, height: 40 })).toEqual({ cx: 60, cy: 40 });
  });

  it('boxCenter handles a box at the origin', () => {
    expect(boxCenter({ x: 0, y: 0, width: 200, height: 100 })).toEqual({ cx: 100, cy: 50 });
  });

  it('boxCenter handles negative offsets (scrolled above viewport)', () => {
    expect(boxCenter({ x: -40, y: -20, width: 80, height: 40 })).toEqual({ cx: 0, cy: 0 });
  });

  it('isPointerAction is true for hover/click/dblclick/drag', () => {
    for (const action of [
      ActionType.HOVER,
      ActionType.CLICK,
      ActionType.DBLCLICK,
      ActionType.DRAG,
    ]) {
      expect(isPointerAction(action)).toBe(true);
    }
  });

  it('isPointerAction is false for keyboard/value actions', () => {
    for (const action of [
      ActionType.FILL,
      ActionType.TYPE,
      ActionType.FOCUS,
      ActionType.BLUR,
      ActionType.CHECK,
      ActionType.UNCHECK,
      ActionType.SELECT,
      ActionType.SUBMIT,
      ActionType.PRESS,
      ActionType.SCROLL_INTO_VIEW,
    ]) {
      expect(isPointerAction(action)).toBe(false);
    }
  });
});

describe('capturePage suppresses Reticle chrome for deterministic baselines', () => {
  it('hides the Reticle dev overlay and disables animations during a full-page capture', async () => {
    const calls: Record<string, unknown>[] = [];
    const bytes = await capturePage(recordingPage(calls), { fullPage: true });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(calls).toHaveLength(1);
    const opts = calls[0] ?? {};
    expect(String(opts['style'])).toContain('data-reticle-overlay');
    expect(String(opts['style'])).toContain('display:none');
    expect(opts['animations']).toBe('disabled');
    expect(opts['fullPage']).toBe(true);
  });

  it('forwards an explicit clip while still hiding the overlay', async () => {
    const calls: Record<string, unknown>[] = [];
    const clip = { x: 1, y: 2, width: 3, height: 4 };
    await capturePage(recordingPage(calls), { clip });
    const opts = calls[0] ?? {};
    expect(opts['clip']).toEqual(clip);
    expect(String(opts['style'])).toContain('data-reticle-overlay');
    expect(opts['fullPage']).toBeUndefined();
  });
});

/**
 * Which driven page a session corresponds to — and when to refuse rather than guess.
 *
 * This existed as "exact URL match, else first page whose URL matches once the query string is
 * stripped". That fallback is unsound when the query string is the ONLY thing distinguishing two
 * pages, which is exactly how the benchmark fixture selects a bug (`?reticle-bug=paint-filter`).
 * The observable result was a visual diff reporting "0.00% changed, matched" for a page whose pixels
 * demonstrably differ — a FALSE GREEN in the visual layer, produced by screenshotting the wrong page
 * and comparing it to itself.
 *
 * A loose match is still worth keeping: an app that pushState's to /overview genuinely has a page
 * whose URL no longer equals the session's. But it is only safe when it is UNAMBIGUOUS. Two
 * candidates means we do not know, and "I do not know" must not render as a matching screenshot.
 */
describe('selectPage — correlate a session to a driven page, or refuse', () => {
  const pages = (...urls: string[]): { url(): string }[] => urls.map((u) => ({ url: () => u }));

  it('prefers an exact URL match, query string included', () => {
    const list = pages('http://app/', 'http://app/?reticle-bug=paint-filter');
    expect(selectPage(list, 'http://app/?reticle-bug=paint-filter')?.url()).toBe(
      'http://app/?reticle-bug=paint-filter',
    );
  });

  it('falls back to a stripped match when it is the only candidate (pushState case)', () => {
    const list = pages('http://app/overview');
    expect(selectPage(list, 'http://app/overview?session=x')?.url()).toBe('http://app/overview');
  });

  it('REFUSES when the stripped match is ambiguous — two pages differing only by query', () => {
    const list = pages(
      'http://app/?reticle-bug=paint-filter',
      'http://app/?reticle-bug=paint-invert',
    );
    // Neither is an exact match for a third URL on the same path; both strip to the same thing.
    expect(selectPage(list, 'http://app/?reticle-bug=something-else')).toBeUndefined();
  });

  it('returns undefined when nothing is close', () => {
    expect(selectPage(pages('http://other/'), 'http://app/')).toBeUndefined();
  });

  it('an exact match wins even when other pages would strip to the same path', () => {
    const list = pages('http://app/?a=1', 'http://app/?b=2', 'http://app/?c=3');
    expect(selectPage(list, 'http://app/?b=2')?.url()).toBe('http://app/?b=2');
  });
});

/**
 * Wire-level network detail on the ATTACH path, not just the launched one.
 *
 * `attachNetworkDetail` was wired only in LaunchedRealInputProvider — the `reticle drive` path where
 * the daemon opens its own browser. CdpRealInputProvider, which attaches to a browser someone else
 * started, never attached it. So the authoritative request body (the one thing an in-page fetch
 * wrapper structurally cannot get, because anything patching fetch earlier mutates after we read)
 * was available only if Reticle happened to own the browser.
 *
 * That is the wrong axis to gate it on: whether we LAUNCHED the browser says nothing about whether we
 * can see its network. Both providers speak CDP.
 *
 * Attaching per page and only once matters — #pageFor resolves a page on every call, so a naive
 * attach would add a listener per action and emit each response N times.
 */
describe('CdpRealInputProvider attaches network detail', () => {
  const fakePage = (
    url: string,
  ): { url(): string; on: (e: string, h: unknown) => void; handlers: unknown[] } => {
    const handlers: unknown[] = [];
    return { url: () => url, on: (_e, h) => handlers.push(h), handlers };
  };

  const providerWith = (
    pages: ReturnType<typeof fakePage>[],
    onNetworkDetail?: (d: unknown) => void,
  ) =>
    new CdpRealInputProvider({
      cdpUrl: 'http://127.0.0.1:9222',
      connect: () =>
        Promise.resolve({
          contexts: () => [{ pages: () => pages }],
          close: () => Promise.resolve(),
        } as never),
      ...(onNetworkDetail === undefined ? {} : { onNetworkDetail }),
    });

  it('attaches a response listener to the correlated page', async () => {
    const page = fakePage('http://app/');
    const provider = providerWith([page], () => undefined);
    await provider.isAvailableFor('http://app/');
    expect(page.handlers.length).toBe(1);
  });

  it('reconnects when the cached browser reports it is no longer connected', async () => {
    // The dead-handle bug: on a CDP drop the provider kept returning the corpse and the drive path
    // went silently unavailable until a restart. It must re-dial when isConnected() goes false.
    let connects = 0;
    let live = true;
    const page = fakePage('http://app/');
    const provider = new CdpRealInputProvider({
      cdpUrl: 'http://127.0.0.1:9222',
      connect: () => {
        connects += 1;
        return Promise.resolve({
          isConnected: () => live,
          contexts: () => [{ pages: () => [page] }],
          close: () => Promise.resolve(),
        } as never);
      },
    });
    expect(await provider.isAvailableFor('http://app/')).toBe(true);
    expect(connects).toBe(1);
    // second call while still live reuses the cached browser
    await provider.isAvailableFor('http://app/');
    expect(connects).toBe(1);
    // the CDP connection drops; the next call must re-dial rather than hand back the dead handle
    live = false;
    await provider.isAvailableFor('http://app/');
    expect(connects).toBe(2);
  });

  it('attaches ONCE per page, however many times the page is resolved', async () => {
    const page = fakePage('http://app/');
    const provider = providerWith([page], () => undefined);
    await provider.isAvailableFor('http://app/');
    await provider.isAvailableFor('http://app/');
    await provider.isAvailableFor('http://app/');
    expect(page.handlers.length).toBe(1);
  });

  it('does nothing when no callback was supplied — the feature stays opt-in', async () => {
    const page = fakePage('http://app/');
    const provider = providerWith([page]);
    await provider.isAvailableFor('http://app/');
    expect(page.handlers.length).toBe(0);
  });
});
