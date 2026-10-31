/**
 * The init script that keeps a page's early console errors for the SDK.
 *
 * The defect: a page that logged an error while it loaded (before the SDK installed) passed "no
 * console errors" on every replay, because the error was gone before anything listened.
 */
import { RETICLE_EARLY_CAPTURE } from '@reticlehq/core';
import { afterEach, describe, expect, it } from 'vitest';
import { queueEarlyConsole } from './lease-page-error.js';

interface FakeWindow {
  console: Record<'error' | 'warn', (...args: unknown[]) => void>;
  listeners: Map<string, (event: unknown) => void>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  dispatchEvent(event: unknown): boolean;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  ErrorEvent: new (type: string, init: Record<string, unknown>) => unknown;
  PromiseRejectionEvent: new (type: string, init: Record<string, unknown>) => unknown;
  [key: string]: unknown;
}

/** A copy of an event, as the page's own constructors would make one. */
class Copied {
  constructor(
    readonly type: string,
    readonly init: Record<string, unknown>,
  ) {}
}

function fakeWindow(): {
  win: FakeWindow;
  printed: unknown[][];
  dispatched: unknown[];
  tick: () => void;
} {
  const printed: unknown[][] = [];
  const dispatched: unknown[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  let timer: (() => void) | undefined;
  const win: FakeWindow = {
    console: { error: (...args) => printed.push(args), warn: (...args) => printed.push(args) },
    listeners,
    addEventListener: (type, listener) => listeners.set(type, listener),
    dispatchEvent: (event) => {
      dispatched.push(event);
      return true;
    },
    setInterval: (fn) => {
      timer = fn;
      return 1;
    },
    clearInterval: () => {
      timer = undefined;
    },
    ErrorEvent: Copied,
    PromiseRejectionEvent: Copied,
  };
  (globalThis as { window?: unknown }).window = win;
  return { win, printed, dispatched, tick: () => timer?.() };
}

const ARG = { key: RETICLE_EARLY_CAPTURE, limit: 2, pollMs: 50, maxPolls: 3 };

describe('queueEarlyConsole', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('keeps an early console error and still prints it', () => {
    const { win, printed } = fakeWindow();
    queueEarlyConsole(ARG);
    win.console.error('htmx:syntax:error');
    expect(printed).toEqual([['htmx:syntax:error']]);
    expect(win[RETICLE_EARLY_CAPTURE]).toEqual({
      queue: [{ method: 'error', args: ['htmx:syntax:error'] }],
      dropped: 0,
    });
  });

  it('keeps window error events', () => {
    const { win } = fakeWindow();
    queueEarlyConsole(ARG);
    const event = { type: 'error' };
    win.listeners.get('error')?.(event);
    expect(win[RETICLE_EARLY_CAPTURE]).toEqual({ queue: [{ event }], dropped: 0 });
  });

  it('counts what the bound did not keep', () => {
    const { win } = fakeWindow();
    queueEarlyConsole(ARG);
    for (const n of [1, 2, 3]) {
      win.console.warn(n);
    }
    expect(win[RETICLE_EARLY_CAPTURE]).toMatchObject({ dropped: 1 });
  });

  it('stops keeping once the queue is closed', () => {
    const { win, printed } = fakeWindow();
    queueEarlyConsole(ARG);
    win[RETICLE_EARLY_CAPTURE] = null;
    win.console.error('after connect');
    expect(win[RETICLE_EARLY_CAPTURE]).toBeNull();
    expect(printed).toEqual([['after connect']]);
  });
});

/*
 * The replay. The script itself hands the queue to the SDK once the SDK has wrapped the console:
 * each queued call goes through the console again and each queued event is dispatched again, so the
 * SDK's own handlers report them. The SDK needs no code for this, so a page that Reticle does not
 * drive (every page of every user) downloads nothing for it.
 */
describe('queueEarlyConsole hands the queue to the SDK', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  /** What the SDK does when it installs: wrap the console and record what passes through. */
  const installSdk = (win: FakeWindow): unknown[][] => {
    const seen: unknown[][] = [];
    for (const method of ['error', 'warn'] as const) {
      const inner = win.console[method];
      win.console[method] = (...args: unknown[]) => {
        seen.push([method, ...args]);
        inner(...args);
      };
    }
    return seen;
  };

  it('replays the queue through the wrapped console once the SDK installs, then stops', () => {
    const { win, dispatched, tick } = fakeWindow();
    queueEarlyConsole(ARG);
    win.console.error('htmx:syntax:error', 7);
    win.listeners.get('error')?.({ message: 'early throw', filename: 'app.js', lineno: 3 });
    tick();
    expect(win[RETICLE_EARLY_CAPTURE]).not.toBeNull();
    const seen = installSdk(win);
    tick();
    expect(seen).toEqual([['error', 'htmx:syntax:error', 7]]);
    expect(dispatched).toEqual([
      new Copied('error', { message: 'early throw', filename: 'app.js', lineno: 3 }),
    ]);
    expect(win[RETICLE_EARLY_CAPTURE]).toBeNull();
    win.console.error('later');
    expect(seen.at(-1)).toEqual(['error', 'later']);
    expect(seen).toHaveLength(2);
  });

  it('declares, through the console, the entries the bound did not keep', () => {
    const { win, tick } = fakeWindow();
    queueEarlyConsole(ARG);
    for (const n of [1, 2, 3, 4]) {
      win.console.warn(n);
    }
    const seen = installSdk(win);
    tick();
    expect(seen.at(-1)).toEqual(['warn', 'reticle: 2 early console entries were not kept']);
  });

  it('stops waiting when no SDK installs, and replays nothing', () => {
    const { win, printed, tick } = fakeWindow();
    queueEarlyConsole(ARG);
    win.console.error('lonely');
    for (const _ of [1, 2, 3, 4]) {
      tick();
    }
    expect(win[RETICLE_EARLY_CAPTURE]).toBeNull();
    expect(printed).toEqual([['lonely']]);
  });
});
