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
  open: boolean;
  drain: (
    onError: (event: unknown) => void,
    onRejection: (event: unknown) => void,
    onConsole: (method: string, args: unknown[]) => void,
    dropped: (count: number) => void,
  ) => void;
}

/** One call the buffer made into the SDK's handlers, with the dropped count it set before it. */
interface Handed {
  to: 'error' | 'rejection' | 'console';
  what: unknown;
  dropped: number | undefined;
}

function run(page: FakePage): Buffer | undefined {
  runInNewContext(PRE_ATTACH_ERRORS_SOURCE, page.global);
  return page.global[RETICLE_PRE_ATTACH_ERRORS] as Buffer | undefined;
}

/** Drain the buffer the way the SDK's console observer does, and record what it handed over. */
function drain(buffer: Buffer | undefined): { handed: Handed[] } {
  const handed: Handed[] = [];
  let dropped: number | undefined;
  buffer?.drain(
    (event) => handed.push({ to: 'error', what: event, dropped }),
    (event) => handed.push({ to: 'rejection', what: event, dropped }),
    (method, args) => handed.push({ to: 'console', what: [method, args], dropped }),
    (count) => {
      dropped = count;
    },
  );
  return { handed };
}

function logError(page: FakePage, ...args: unknown[]): void {
  (page.global['console'] as { error: (...a: unknown[]) => void }).error(...args);
}

describe('the pre-attach error buffer (#1540)', () => {
  it('hands each kept entry to the matching SDK handler, in order', () => {
    const page = fakePage();
    const buffer = run(page);
    const failed = { type: 'error', target: 'script' };
    const rejected = { type: 'unhandledrejection', reason: 'no' };
    page.fire('error', failed);
    page.fire('unhandledrejection', rejected);
    logError(page, 'htmx:syntax:error', 42);
    // It still prints: the buffer only listens.
    expect(page.printed).toEqual([['htmx:syntax:error', 42]]);

    expect(drain(buffer).handed).toEqual([
      { to: 'error', what: failed, dropped: 0 },
      { to: 'rejection', what: rejected, dropped: 0 },
      { to: 'console', what: ['error', ['htmx:syntax:error', 42]], dropped: 0 },
    ]);
  });

  it('stops keeping and listening when drained, and a second drain hands over nothing', () => {
    const page = fakePage();
    const buffer = run(page);
    page.fire('error', { type: 'error' });
    expect(drain(buffer).handed).toHaveLength(1);
    page.fire('error', { type: 'error' });
    logError(page, 'after attach');

    expect(buffer?.open).toBe(false);
    expect(page.listeners.get('error')).toEqual([]);
    expect(page.listeners.get('unhandledrejection')).toEqual([]);
    expect(drain(buffer)).toEqual({ handed: [] });
    // The console.error wrapper stays in the chain and only calls through.
    expect(page.printed).toEqual([['after attach']]);
  });

  it('drains an empty buffer without calling any handler', () => {
    const buffer = run(fakePage());
    expect(drain(buffer).handed).toEqual([]);
    expect(buffer?.open).toBe(false);
  });

  it('keeps the first errors up to its limit and declares the rest on the first entry', () => {
    const page = fakePage();
    const buffer = run(page);
    for (let i = 0; i < PRE_ATTACH_ERRORS_LIMIT + 7; i += 1) {
      page.fire('error', { i });
    }
    const { handed } = drain(buffer);
    expect(handed).toHaveLength(PRE_ATTACH_ERRORS_LIMIT);
    expect(handed[0]).toEqual({ to: 'error', what: { i: 0 }, dropped: 7 });
    expect(handed[1]?.dropped).toBe(0);
  });

  it('goes on with the next entry when an SDK handler throws', () => {
    const page = fakePage();
    const buffer = run(page);
    page.fire('error', { type: 'error' });
    logError(page, 'second');
    const seen: unknown[] = [];
    buffer?.drain(
      () => {
        throw new Error('handler failed');
      },
      () => undefined,
      (_method, args) => seen.push(args),
      () => undefined,
    );
    expect(seen).toEqual([['second']]);
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
    expect(drain(buffer).handed).toHaveLength(1);
  });
});
