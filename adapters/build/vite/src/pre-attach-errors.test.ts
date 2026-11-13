/**
 * #1540: the inline buffer that keeps what a page raised before the SDK attached.
 *
 * It runs before every other script on the page, so it is run here as the page runs it: the real
 * source, evaluated in a fresh context with a window-shaped global.
 */
import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import { RETICLE_EARLY_CAPTURE, RETICLE_PRE_ATTACH_ERRORS } from '@reticlehq/core';
import { PRE_ATTACH_ERRORS_LIMIT, PRE_ATTACH_ERRORS_SOURCE } from './pre-attach-errors.js';

type Listener = (event: unknown) => void;

interface FakePage {
  global: Record<string, unknown>;
  fire(type: string, event: unknown): void;
  listeners: Map<string, Listener[]>;
  printed: unknown[][];
}

function fakePage(extra: Record<string, unknown> = {}): FakePage {
  const listeners = new Map<string, Listener[]>();
  const printed: unknown[][] = [];
  const global: Record<string, unknown> = {
    console: {
      error: (...args: unknown[]): void => {
        printed.push(args);
      },
    },
    addEventListener: (type: string, listener: Listener): void => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type: string, listener: Listener): void => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    ...extra,
  };
  global['globalThis'] = global;
  return {
    global,
    listeners,
    printed,
    fire: (type, event) => {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
  };
}

interface Buffer {
  queue: unknown[];
  dropped: number;
  open: boolean;
  close: () => void;
}

function run(page: FakePage): Buffer | undefined {
  runInNewContext(PRE_ATTACH_ERRORS_SOURCE, page.global);
  return page.global[RETICLE_PRE_ATTACH_ERRORS] as Buffer | undefined;
}

function logError(page: FakePage, ...args: unknown[]): void {
  (page.global['console'] as { error: (...a: unknown[]) => void }).error(...args);
}

describe('the pre-attach error buffer (#1540)', () => {
  it('keeps error events, rejections and console.error calls, and still prints them', () => {
    const page = fakePage();
    const buffer = run(page);
    const failed = { type: 'error', target: 'script' };
    const rejected = { type: 'unhandledrejection', reason: 'no' };
    page.fire('error', failed);
    page.fire('unhandledrejection', rejected);
    logError(page, 'htmx:syntax:error', 42);

    expect(buffer?.open).toBe(true);
    expect(buffer?.queue).toEqual([
      { event: failed },
      { event: rejected },
      { args: ['htmx:syntax:error', 42] },
    ]);
    expect(page.printed).toEqual([['htmx:syntax:error', 42]]);
  });

  it('stops keeping and stops listening once the SDK closes it', () => {
    const page = fakePage();
    const buffer = run(page);
    page.fire('error', { type: 'error' });
    buffer?.close();
    page.fire('error', { type: 'error' });
    logError(page, 'after attach');

    expect(buffer?.open).toBe(false);
    expect(buffer?.queue).toEqual([]);
    expect(page.listeners.get('error')).toEqual([]);
    expect(page.listeners.get('unhandledrejection')).toEqual([]);
    // The console.error wrapper stays in the chain and only calls through.
    expect(page.printed).toEqual([['after attach']]);
  });

  it('keeps the first errors up to its limit and counts the rest', () => {
    const page = fakePage();
    const buffer = run(page);
    for (let i = 0; i < PRE_ATTACH_ERRORS_LIMIT + 7; i += 1) {
      page.fire('error', { i });
    }
    expect(buffer?.queue).toHaveLength(PRE_ATTACH_ERRORS_LIMIT);
    expect(buffer?.queue[0]).toEqual({ event: { i: 0 } });
    expect(buffer?.dropped).toBe(7);
  });

  it('does not install on a page Reticle drives, which has its own early capture', () => {
    const page = fakePage({ [RETICLE_EARLY_CAPTURE]: { queue: [], dropped: 0 } });
    expect(run(page)).toBeUndefined();
    expect(page.listeners.size).toBe(0);
  });

  it('installs once when the page runs it twice', () => {
    const page = fakePage();
    const first = run(page);
    run(page);
    expect(page.global[RETICLE_PRE_ATTACH_ERRORS]).toBe(first);
    expect(page.listeners.get('error')).toHaveLength(1);
  });

  it('never throws into the page, even with no console', () => {
    const page = fakePage({ console: undefined });
    const buffer = run(page);
    page.fire('error', { type: 'error' });
    expect(buffer?.queue).toHaveLength(1);
  });
});
