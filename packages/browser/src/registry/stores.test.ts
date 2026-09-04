import { describe, it, expect, vi } from 'vitest';
import * as nativeConsole from '../timers/native-console.js';
import {
  registerStore,
  unregisterStore,
  storeNames,
  readStores,
  subscribableStores,
} from './stores.js';

describe('store registry — passing the STORE auto-wires change diffs', () => {
  it('accepts a Zustand/Redux-shaped store and wires BOTH getState and subscribe', () => {
    // The dormant-feature fix: registerStore('app', useApp) must make STATE_CHANGE automatic. Passing
    // only a getter (the old form) leaves the app on pull-only reads, which is what shipped before.
    let listener: (() => void) | undefined;
    const store = {
      getState: () => ({ count: 1 }),
      subscribe: (fn: () => void) => {
        listener = fn;
        return () => (listener = undefined);
      },
    };
    registerStore('ws_store', store);
    expect(readStores('ws_store')).toEqual({ ws_store: { count: 1 } });
    const subs = subscribableStores().filter(([n]) => 'ws_store' === n);
    expect(subs).toHaveLength(1); // ← auto-subscribed, no 3rd argument needed
    subs[0]?.[2](() => undefined);
    expect(listener).toBeDefined(); // the store's own subscribe was used
    unregisterStore('ws_store');
  });

  it('accepts a CALLABLE Zustand-style hook (function carrying getState/subscribe)', () => {
    // Regression: Zustand's create returns a callable hook, so a real store is typeof 'function'.
    // An object-only guard silently fell through to the getter path and left STATE_CHANGE dormant —
    // caught only by driving a live app, never by an object-shaped fixture.
    let subscribed = false;
    const useApp = Object.assign(() => ({ count: 0 }), {
      getState: () => ({ count: 7 }),
      subscribe: (_fn: () => void) => {
        subscribed = true;
        return () => undefined;
      },
    });
    registerStore('ws_zustand', useApp);
    expect(readStores('ws_zustand')).toEqual({ ws_zustand: { count: 7 } });
    const subs = subscribableStores().filter(([n]) => 'ws_zustand' === n);
    expect(subs).toHaveLength(1);
    subs[0]?.[2](() => undefined);
    expect(subscribed).toBe(true);
    unregisterStore('ws_zustand');
  });

  it('a plain getter still registers (back-compat) but is NOT auto-subscribed', () => {
    registerStore('ws_getter', () => ({ count: 1 }));
    expect(readStores('ws_getter')).toEqual({ ws_getter: { count: 1 } });
    expect(subscribableStores().filter(([n]) => 'ws_getter' === n)).toHaveLength(0);
    unregisterStore('ws_getter');
  });
});

describe('store registry', () => {
  it('registers a store and reads it back', () => {
    registerStore('ws_a', () => ({ items: 3 }));
    expect(readStores()).toMatchObject({ ws_a: { items: 3 } });
    expect(storeNames()).toContain('ws_a');
    unregisterStore('ws_a');
  });

  it('filters to a single store by name; unknown name yields empty', () => {
    registerStore('ws_b', () => 1);
    registerStore('ws_c', () => 2);
    expect(readStores('ws_b')).toEqual({ ws_b: 1 });
    expect(readStores('nope')).toEqual({});
    unregisterStore('ws_b');
    unregisterStore('ws_c');
  });

  it('isolates a throwing getter as an __error; other stores still read', () => {
    registerStore('ws_bad', () => {
      throw new Error('boom');
    });
    registerStore('ws_ok', () => 42);
    const out = readStores();
    expect(out['ws_bad']).toEqual({ __error: 'boom' });
    expect(out['ws_ok']).toBe(42);
    unregisterStore('ws_bad');
    unregisterStore('ws_ok');
  });

  it('returns redacted, JSON-safe state for secrets, BigInt, and cycles', () => {
    // BigInt(2), not 2n: the browser package compiles to ES2017 for webpack 4 (issue #680),
    // and BigInt literals need ES2020. Same runtime value; tests do not ship.
    const state: Record<string, unknown> = { password: 'secret', count: BigInt(2) };
    state['self'] = state;
    registerStore('ws_safe', () => state);
    const out = readStores('ws_safe');
    expect(out['ws_safe']).toEqual({
      password: '[REDACTED]',
      count: '2',
      self: '[CIRCULAR]',
    });
    expect(() => JSON.stringify(out)).not.toThrow();
    unregisterStore('ws_safe');
  });

  it('unregisterStore removes it', () => {
    registerStore('ws_d', () => 0);
    expect(storeNames()).toContain('ws_d');
    unregisterStore('ws_d');
    expect(storeNames()).not.toContain('ws_d');
  });
});

describe('registerStore — rejects non-callable, non-StoreLike sources', () => {
  it('rejects {subscribe} without getState: warns about the missing getState, does not register', () => {
    const warn = vi.spyOn(nativeConsole, 'nativeWarn').mockImplementation(() => undefined);
    const svelteish = {
      subscribe: (_fn: () => void) => () => undefined,
      set: () => undefined,
    };
    registerStore('svelte-bad', svelteish as unknown as Parameters<typeof registerStore>[1]);
    expect(storeNames()).not.toContain('svelte-bad');
    expect(warn).toHaveBeenCalledOnce();
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('svelte-bad');
    expect(msg).toContain('getState');
    warn.mockRestore();
  });

  it('rejects a plain object with no subscribe and no getState', () => {
    const warn = vi.spyOn(nativeConsole, 'nativeWarn').mockImplementation(() => undefined);
    registerStore('bad-obj', { foo: 1 } as unknown as Parameters<typeof registerStore>[1]);
    expect(storeNames()).not.toContain('bad-obj');
    expect(warn).toHaveBeenCalledOnce();
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('bad-obj');
    expect(msg).not.toContain('has subscribe but no getState');
    warn.mockRestore();
  });
});

/**
 * A store registered with only a getter is READABLE but SILENT: reticle_state can read it on demand,
 * yet nothing ever emits a STATE_CHANGE, so causal summaries show no state diff and a state predicate
 * can never observe it updating. That is indistinguishable from "the app changed nothing" — a false
 * negative with no error attached, and the exact gap a now-deleted pre/post snapshot module was written
 * to paper over at the cost of two extra round-trips per action. Warning once at registration is free
 * and fixes the cause rather than the symptom.
 */
describe('silent store registration', () => {
  it('warns when a store is registered without any way to observe changes', () => {
    const warn = vi.spyOn(nativeConsole, 'nativeWarn').mockImplementation(() => undefined);
    registerStore('getter-only', () => ({ count: 1 }));
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('getter-only');
    warn.mockRestore();
  });

  it('does NOT warn when a subscribe function is supplied', () => {
    const warn = vi.spyOn(nativeConsole, 'nativeWarn').mockImplementation(() => undefined);
    registerStore(
      'observable',
      () => ({ count: 1 }),
      () => () => undefined,
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns ONCE per store — a repeat on every HMR cycle or remount is just noise', () => {
    const warn = vi.spyOn(nativeConsole, 'nativeWarn').mockImplementation(() => undefined);
    registerStore('remounted', () => ({ n: 1 }));
    registerStore('remounted', () => ({ n: 2 }));
    registerStore('remounted', () => ({ n: 3 }));
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("stays silent for Reticle's OWN read-only store — telling a user to fix our code is absurd", () => {
    // @reticlehq/react registers a render-stats getter the app developer never wrote and cannot change.
    const warn = vi.spyOn(nativeConsole, 'nativeWarn').mockImplementation(() => undefined);
    registerStore('__reticle_renders', () => ({ commits: 0 }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does NOT warn for a store-like object, which carries its own subscribe', () => {
    const warn = vi.spyOn(nativeConsole, 'nativeWarn').mockImplementation(() => undefined);
    registerStore('zustand-like', {
      getState: () => ({ count: 1 }),
      subscribe: () => () => undefined,
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
