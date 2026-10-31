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
  [key: string]: unknown;
}

function fakeWindow(): { win: FakeWindow; printed: unknown[][] } {
  const printed: unknown[][] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const win: FakeWindow = {
    console: { error: (...args) => printed.push(args), warn: (...args) => printed.push(args) },
    listeners,
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  (globalThis as { window?: unknown }).window = win;
  return { win, printed };
}

const ARG = { key: RETICLE_EARLY_CAPTURE, limit: 2 };

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

  it('stops keeping once the SDK has read the queue', () => {
    const { win, printed } = fakeWindow();
    queueEarlyConsole(ARG);
    win[RETICLE_EARLY_CAPTURE] = null;
    win.console.error('after connect');
    expect(win[RETICLE_EARLY_CAPTURE]).toBeNull();
    expect(printed).toEqual([['after connect']]);
  });
});
