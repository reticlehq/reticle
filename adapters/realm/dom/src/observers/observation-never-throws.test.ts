/**
 * One rule, stated once for every patched native: OBSERVING MUST NEVER BREAK THE APP.
 *
 * Each of these observers replaces a function the customer's code calls. Most of them built their
 * event payload — redacting, serialising, reading the DOM — INSIDE that replacement and BEFORE
 * calling the original. So anything that threw during observation did not surface as an SDK error:
 * the WebSocket frame never sent, `console.log` threw in the app's own code, `window.open` never
 * opened, the store's notify loop unwound inside zustand, `xhr.send` never sent.
 *
 * `storage.ts` had it right all along — the app's write happens first, outside the guard. These tests
 * hold every other site to the same contract, using a throwing `emit` to stand in for "any part of
 * the observation threw", which is the only failure the app can ever be exposed to.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installConsole } from './console.js';
import { installDialogs } from './dialogs.js';
import { installContextOpen } from './context-open.js';
import { installRoute } from './route.js';
import { installDownload } from './download.js';
import { installStoreState } from './state.js';
import { installNetwork } from './network.js';
import { asSyntheticInput } from '../actions/synthetic/synthetic-input.js';
import { registerStore, unregisterStore } from '../registry/stores.js';
import { captureMethod } from '../patching/capture-method.js';
import type { Emit, Teardown } from './types.js';

/**
 * `console` and `window` as plain slot maps.
 *
 * The test has to READ and WRITE these slots (stand a recorder in for the real method, put it back),
 * and it has to CALL the wrapper the observer installed. Going through a generic index access is how
 * this repo says "I am handling a stored function value on purpose" — the same distinction
 * `capture-method.ts` exists to make — and it keeps `no-console` pointed at real logging rather than
 * at a test that is exercising the patch.
 */
type SlotMap = Record<string, (...args: unknown[]) => unknown>;

/** Stands in for every way observation can fail: redaction, serialisation, transport. */
const hostileEmit: Emit = () => {
  throw new Error('observation exploded');
};

/**
 * The same, but inert until the observer is installed.
 *
 * `installNetwork` legitimately emits during install (the wrapped-fetch blind spot), and an install
 * that throws is already `guard()`'s job in install-all. What these tests are about is the patched
 * native afterwards, in the app's own call stack.
 */
function armAfterInstall(): { emit: Emit; arm: () => void } {
  let armed = false;
  return {
    emit: () => {
      if (armed) throw new Error('observation exploded');
    },
    arm: () => {
      armed = true;
    },
  };
}

const teardowns: Teardown[] = [];
afterEach(() => {
  for (const t of teardowns.splice(0)) t();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
const install = (teardown: Teardown): void => {
  teardowns.push(teardown);
};

describe('observation never escapes into the app', () => {
  it('a log still reaches the real console', () => {
    const slots = console as unknown as SlotMap;
    const seen: unknown[][] = [];
    const original = captureMethod(slots, 'log');
    slots['log'] = (...args: unknown[]): void => {
      seen.push(args);
    };
    try {
      install(installConsole(hostileEmit));
      const patched = captureMethod(slots, 'log');
      expect(() => patched('hello', { a: 1 })).not.toThrow();
      expect(seen).toEqual([['hello', { a: 1 }]]);
    } finally {
      for (const t of teardowns.splice(0)) t();
      slots['log'] = original;
    }
  });

  it('a native dialog still answers the app', () => {
    install(installDialogs(hostileEmit));
    let answered: unknown;
    expect(() => {
      answered = asSyntheticInput(() => window.confirm('delete everything?'));
    }).not.toThrow();
    expect(answered).toBe(false);
  });

  it('window.open still opens the context and returns its handle', () => {
    const slots = window as unknown as SlotMap;
    const sentinel = {} as Window;
    const original = captureMethod(slots, 'open');
    slots['open'] = () => sentinel;
    try {
      install(installContextOpen(hostileEmit));
      let returned: unknown;
      expect(() => {
        returned = window.open('https://accounts.example.test/', '_blank');
      }).not.toThrow();
      expect(returned).toBe(sentinel);
    } finally {
      for (const t of teardowns.splice(0)) t();
      slots['open'] = original;
    }
  });

  it("history.pushState still navigates the app's router", () => {
    install(installRoute(hostileEmit));
    expect(() => {
      history.pushState({}, '', '/observed-route');
    }).not.toThrow();
    expect(location.pathname).toBe('/observed-route');
  });

  it("a download anchor's click still fires", () => {
    // jsdom has no object-URL API; the observer needs a real one to have a blob to report at all.
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => 'blob:test/hostile',
    });
    install(installDownload(hostileEmit, { capturePreview: true }));
    const url = URL.createObjectURL(new Blob(['a,b\n1,2'], { type: 'text/csv' }));
    const anchor = document.createElement('a');
    anchor.setAttribute('download', 'report.csv');
    anchor.href = url;
    let clicked = false;
    anchor.addEventListener('click', (e) => {
      e.preventDefault();
      clicked = true;
    });
    document.body.append(anchor);
    expect(() => anchor.click()).not.toThrow();
    expect(clicked).toBe(true);
  });

  it("a store's own notify loop finishes", () => {
    let state = { count: 0 };
    const listeners = new Set<() => void>();
    const store = {
      getState: () => state,
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    registerStore('hostile-emit-store', store);
    try {
      install(installStoreState(hostileEmit));
      let appListenerRan = false;
      listeners.add(() => {
        appListenerRan = true;
      });
      state = { count: 1 };
      expect(() => {
        for (const l of listeners) l();
      }).not.toThrow();
      expect(appListenerRan).toBe(true);
    } finally {
      unregisterStore('hostile-emit-store');
    }
  });

  it('fetch still resolves with the response', async () => {
    const response = { status: 200, ok: true, headers: { get: () => null } } as unknown as Response;
    vi.stubGlobal('fetch', () => Promise.resolve(response));
    const { emit, arm } = armAfterInstall();
    install(installNetwork(emit));
    arm();
    await expect(fetch('/api/things')).resolves.toBe(response);
  });

  it('xhr.send still sends', () => {
    const sent: unknown[] = [];
    class FakeXhr {
      responseType = '';
      open(): void {
        /* recorded by the patch */
      }
      send(body?: unknown): void {
        sent.push(body);
      }
      addEventListener(): void {
        /* completion is not what this test is about */
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { emit, arm } = armAfterInstall();
    install(installNetwork(emit));
    arm();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/save');
    expect(() => xhr.send('{"a":1}')).not.toThrow();
    expect(sent).toEqual(['{"a":1}']);
  });

  it("a WebSocket's frame still leaves the page", () => {
    const sent: unknown[] = [];
    class FakeSocket {
      readonly url: string;
      constructor(url: string) {
        this.url = url;
      }
      send(data: unknown): void {
        sent.push(data);
      }
      addEventListener(): void {
        /* inbound frames are not what this test is about */
      }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    const { emit, arm } = armAfterInstall();
    install(installNetwork(emit, { captureBodies: true }));
    arm();
    let socket: WebSocket | undefined;
    expect(() => {
      socket = new WebSocket('wss://api.example.test/live');
    }).not.toThrow();
    expect(() => socket?.send('ping')).not.toThrow();
    expect(sent).toEqual(['ping']);
  });

  it('an EventSource still constructs', () => {
    class FakeSource {
      constructor(readonly url: string) {}
      addEventListener(): void {
        /* inbound frames are not what this test is about */
      }
    }
    vi.stubGlobal('EventSource', FakeSource);
    const { emit, arm } = armAfterInstall();
    install(installNetwork(emit, { captureBodies: true }));
    arm();
    expect(() => new EventSource('https://api.example.test/stream')).not.toThrow();
  });
});
