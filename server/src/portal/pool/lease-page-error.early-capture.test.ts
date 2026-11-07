/**
 * The init script that keeps a page's early console errors for the SDK.
 *
 * The defect: a page that logged an error while it loaded (before the SDK installed) passed "no
 * console errors" on every replay, because the error was gone before anything listened.
 */
import { RETICLE_EARLY_CAPTURE } from '@reticlehq/core';
import { afterEach, describe, expect, it } from 'vitest';
import { queueEarlyConsole } from './lease-page-error.js';

type Listener = (event: unknown) => void;

interface FakeWindow {
  console: Record<'error' | 'warn', (...args: unknown[]) => void>;
  listeners: Map<string, Listener[]>;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  dispatchEvent(event: unknown): boolean;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  Event: new (type: string) => unknown;
  ErrorEvent: new (type: string, init: Record<string, unknown>) => unknown;
  PromiseRejectionEvent: new (type: string, init: Record<string, unknown>) => unknown;
  [key: string]: unknown;
}

/** A copy of an event, as the page's own constructors would make one. */
class Copied {
  stopped = false;
  constructor(
    readonly type: string,
    readonly init: Record<string, unknown> = {},
  ) {}
  stopPropagation(): void {
    this.stopped = true;
  }
}

/** The first `error` listener on the window: the one the init script installs. */
function keptListener(win: FakeWindow): Listener | undefined {
  return win.listeners.get('error')?.[0];
}

function fakeWindow(): {
  win: FakeWindow;
  printed: unknown[][];
  dispatched: unknown[];
  tick: () => void;
} {
  const printed: unknown[][] = [];
  const dispatched: unknown[] = [];
  const listeners = new Map<string, Listener[]>();
  let timer: (() => void) | undefined;
  const win: FakeWindow = {
    console: { error: (...args) => printed.push(args), warn: (...args) => printed.push(args) },
    listeners,
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type, listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== listener),
      );
    },
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
    Event: Copied,
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
    keptListener(win)?.(event);
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
    keptListener(win)?.({ message: 'early throw', filename: 'app.js', lineno: 3 });
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

/*
 * A `<script>` or `<img>` that fails to load dispatches a plain `Event` on its element, and the
 * element is the only thing that names the URL. The replay copied it into an empty `ErrorEvent` on
 * `window`, so `verify` reported `{ message: "", source: "", line: 0 }` and lost the URL (#2220).
 */
describe('queueEarlyConsole replays a failed resource load from its element', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  /**
   * An element in the page. Its dispatch runs the window's capture listeners first, then its own
   * handler, unless a window listener stopped the event.
   */
  const fakeElement = (win: FakeWindow, connected: boolean) => {
    const ownHandler: unknown[] = [];
    const element = {
      tagName: 'SCRIPT',
      isConnected: connected,
      getAttribute: (name: string) => ('src' === name ? '/src/missing-entry.ts' : null),
      dispatchEvent: (event: Copied) => {
        for (const listener of win.listeners.get('error') ?? []) {
          listener(Object.assign(event, { target: element }));
        }
        if (!event.stopped) {
          ownHandler.push(event);
        }
        return true;
      },
    };
    return { element, ownHandler };
  };

  /** What the SDK does when it installs: wrap the console, and listen for errors on `window`. */
  const installSdk = (win: FakeWindow): unknown[] => {
    const seen: unknown[] = [];
    win.console.error = () => undefined;
    win.addEventListener('error', (event) => seen.push(event));
    return seen;
  };

  it('sends the event again from the element, so the SDK can read the tag and the URL', () => {
    const { win, dispatched, tick } = fakeWindow();
    queueEarlyConsole(ARG);
    const { element } = fakeElement(win, true);
    keptListener(win)?.({ type: 'error', target: element });
    const seen = installSdk(win);
    tick();
    expect(dispatched).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'error', init: {}, target: element });
  });

  it('does not run the page own handler on the element a second time', () => {
    const { win, tick } = fakeWindow();
    queueEarlyConsole(ARG);
    const { element, ownHandler } = fakeElement(win, true);
    keptListener(win)?.({ type: 'error', target: element });
    installSdk(win);
    tick();
    expect(ownHandler).toEqual([]);
    win.console.error('later');
    expect(win.listeners.get('error')).toHaveLength(2);
  });

  it('copies the event to window when the element left the page', () => {
    const { win, dispatched, tick } = fakeWindow();
    queueEarlyConsole(ARG);
    const { element } = fakeElement(win, false);
    keptListener(win)?.({ type: 'error', target: element });
    installSdk(win);
    tick();
    expect(dispatched).toEqual([new Copied('error', {})]);
  });
});
