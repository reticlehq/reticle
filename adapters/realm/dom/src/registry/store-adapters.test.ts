import { describe, expect, it, vi } from 'vitest';
import {
  tanstackQueryStore,
  jotaiStore,
  xstateStore,
  valtioStore,
  mobxStore,
  pushStore,
  recoilStore,
  svelteStore,
  piniaStore,
} from './store-adapters.js';

/** A fake matching the shape of TanStack Query's cache surface (getAll + subscribe). */
function fakeQueryClient(queries: unknown[]) {
  const listeners = new Set<() => void>();
  return {
    client: {
      getQueryCache: () => ({
        getAll: () => queries as never,
        subscribe: (l: () => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      }),
    },
    emit: () => {
      for (const l of listeners) l();
    },
    listenerCount: () => listeners.size,
  };
}

describe('tanstackQueryStore', () => {
  const query = {
    queryKey: ['deployments', 42],
    state: {
      status: 'success',
      fetchStatus: 'idle',
      dataUpdatedAt: 1700,
      error: null,
      data: { name: 'api' },
    },
    isStale: () => true,
  };

  it('keys each query by its joined query key', () => {
    const { client } = fakeQueryClient([query]);
    const state = tanstackQueryStore(client).getState() as Record<string, unknown>;
    expect(Object.keys(state)).toEqual(['deployments/42']);
  });

  it('carries freshness, not just the value — the whole point of reading the cache', () => {
    // A stale-cache bug renders a plausible number and fires NO request. Only isStale/fetchStatus/
    // dataUpdatedAt let an agent assert the UI read from FRESH data rather than merely correct-looking
    // data, which is the assertion neither a screenshot nor a network log can make.
    const { client } = fakeQueryClient([query]);
    const state = tanstackQueryStore(client).getState() as Record<string, Record<string, unknown>>;
    expect(state['deployments/42']).toMatchObject({
      status: 'success',
      fetchStatus: 'idle',
      isStale: true,
      dataUpdatedAt: 1700,
      error: null,
      data: { name: 'api' },
    });
  });

  it('flattens an error to its message so the payload stays serializable', () => {
    const failing = {
      queryKey: ['x'],
      state: { status: 'error', error: { message: 'boom' } },
      isStale: () => false,
    };
    const { client } = fakeQueryClient([failing]);
    const state = tanstackQueryStore(client).getState() as Record<string, Record<string, unknown>>;
    expect(state['x']?.['error']).toBe('boom');
  });

  it('subscribes to the cache and unsubscribes cleanly', () => {
    const { client, emit, listenerCount } = fakeQueryClient([query]);
    const listener = vi.fn();
    const unsub = tanstackQueryStore(client).subscribe(listener);
    emit();
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    expect(listenerCount()).toBe(0);
    emit();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('follows a REBUILT QueryClient instead of answering from the old cache', () => {
    // Strict Mode double effects, a provider remount and HMR all rebuild the client. An adapter that
    // captured the cache once would keep serving a store the app no longer reads — a stale-data bug
    // inside the tool whose entire purpose is catching stale data.
    let current = fakeQueryClient([query]).client.getQueryCache();
    const client = { getQueryCache: () => current };
    expect(Object.keys(tanstackQueryStore(client).getState() as object)).toEqual([
      'deployments/42',
    ]);

    const replacement = {
      queryKey: ['users'],
      state: { status: 'success', data: [] },
      isStale: () => false,
    };
    current = fakeQueryClient([replacement]).client.getQueryCache();
    expect(Object.keys(tanstackQueryStore(client).getState() as object)).toEqual(['users']);
  });

  it('an empty cache reads as an empty object, never undefined', () => {
    const { client } = fakeQueryClient([]);
    expect(tanstackQueryStore(client).getState()).toEqual({});
  });
});

describe('jotaiStore', () => {
  function fakeJotai() {
    const values = new Map<object, unknown>();
    const subs = new Map<object, Set<() => void>>();
    return {
      store: {
        get: (atom: object) => values.get(atom),
        sub: (atom: object, l: () => void) => {
          const set = subs.get(atom) ?? new Set();
          set.add(l);
          subs.set(atom, set);
          return () => set.delete(l);
        },
      },
      set: (atom: object, v: unknown) => values.set(atom, v),
      emit: (atom: object) => {
        for (const l of subs.get(atom) ?? []) l();
      },
      subCount: (atom: object) => (subs.get(atom) ?? new Set()).size,
    };
  }

  it('reads every named atom into one object', () => {
    const jotai = fakeJotai();
    const cart = {},
      user = {};
    jotai.set(cart, ['apple']);
    jotai.set(user, { id: 1 });
    const state = jotaiStore(jotai.store, { cart, user }).getState();
    expect(state).toEqual({ cart: ['apple'], user: { id: 1 } });
  });

  it('one listener fires for a change to ANY named atom', () => {
    const jotai = fakeJotai();
    const a = {},
      b = {};
    const listener = vi.fn();
    jotaiStore(jotai.store, { a, b }).subscribe(listener);
    jotai.emit(a);
    jotai.emit(b);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe detaches from every atom, not just the first', () => {
    const jotai = fakeJotai();
    const a = {},
      b = {};
    const unsub = jotaiStore(jotai.store, { a, b }).subscribe(vi.fn());
    unsub();
    expect(jotai.subCount(a)).toBe(0);
    expect(jotai.subCount(b)).toBe(0);
  });
});

describe('xstateStore', () => {
  it('adapts a subscription OBJECT into an unsubscribe function', () => {
    const unsubscribe = vi.fn();
    const actor = {
      getSnapshot: () => ({ value: 'idle' }),
      subscribe: () => ({ unsubscribe }),
    };
    const store = xstateStore(actor);
    expect(store.getState()).toEqual({ value: 'idle' });
    store.subscribe(vi.fn())();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('valtioStore', () => {
  it('snapshots through the passed-in functions rather than importing valtio', () => {
    const proxy = { count: 1 };
    const unsub = vi.fn();
    const store = valtioStore(
      proxy,
      (p) => ({ ...p }),
      () => unsub,
    );
    expect(store.getState()).toEqual({ count: 1 });
    expect(store.subscribe(vi.fn())).toBe(unsub);
  });
});

describe('mobxStore', () => {
  it('reads through toJS and subscribes through reaction', () => {
    const observable = { total: 5 };
    const dispose = vi.fn();
    const reaction = vi.fn(() => dispose);
    const store = mobxStore(observable, (v) => ({ ...v }), reaction);
    expect(store.getState()).toEqual({ total: 5 });
    expect(store.subscribe(vi.fn())).toBe(dispose);
    expect(reaction).toHaveBeenCalledTimes(1);
  });
});

describe('pushStore (React Context / useState — no readable store exists)', () => {
  it('reads the latest pushed value', () => {
    const { store, push } = pushStore({ n: 0 });
    push({ n: 7 });
    expect(store.getState()).toEqual({ n: 7 });
  });

  it('notifies subscribers on every push, so STATE_CHANGE diffs fire', () => {
    const { store, push } = pushStore(null);
    const listener = vi.fn();
    store.subscribe(listener);
    push(1);
    push(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops notifications', () => {
    const { store, push } = pushStore(null);
    const listener = vi.fn();
    store.subscribe(listener)();
    push(1);
    expect(listener).not.toHaveBeenCalled();
  });
});

/** A fake shaped like a Recoil `Snapshot`: getLoadable returns a `{state, contents}` Loadable. */
function fakeRecoil(values: Map<object, { state: string; contents: unknown }>) {
  const listeners = new Set<() => void>();
  return {
    snapshot: () => ({
      getLoadable: (atom: object) => values.get(atom) ?? { state: 'hasValue', contents: undefined },
    }),
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (): void => {
      for (const l of listeners) l();
    },
    listenerCount: (): number => listeners.size,
  };
}

describe('recoilStore', () => {
  it('projects each named atom from the current snapshot', () => {
    const cart = {},
      user = {};
    const recoil = fakeRecoil(
      new Map([
        [cart, { state: 'hasValue', contents: { items: 2 } }],
        [user, { state: 'hasValue', contents: 'ada' }],
      ]),
    );
    const state = recoilStore({ cart, user }, recoil.snapshot, recoil.subscribe).getState();
    expect(state).toEqual({
      cart: { status: 'hasValue', value: { items: 2 }, error: null },
      user: { status: 'hasValue', value: 'ada', error: null },
    });
  });

  it('re-reads the snapshot on every getState, so a new transaction is visible', () => {
    const atom = {};
    const values = new Map([[atom, { state: 'hasValue', contents: 1 }]]);
    const recoil = fakeRecoil(values);
    const store = recoilStore({ n: atom }, recoil.snapshot, recoil.subscribe);
    values.set(atom, { state: 'hasValue', contents: 2 });
    expect(store.getState()).toEqual({ n: { status: 'hasValue', value: 2, error: null } });
  });

  it('reports a PENDING async atom as pending rather than as a value', () => {
    // `getValue()` on a loading Loadable THROWS the pending promise. Reading `.state` instead is
    // what keeps one async selector from taking down the whole state read.
    const atom = {};
    const recoil = fakeRecoil(
      new Map([[atom, { state: 'loading', contents: Promise.resolve(1) }]]),
    );
    const state = recoilStore({ q: atom }, recoil.snapshot, recoil.subscribe).getState();
    expect(state).toEqual({ q: { status: 'loading', value: null, error: null } });
  });

  it('reports an ERRORED atom as an error, never as an absent value', () => {
    const atom = {};
    const recoil = fakeRecoil(
      new Map([[atom, { state: 'hasError', contents: new Error('boom') }]]),
    );
    const state = recoilStore({ q: atom }, recoil.snapshot, recoil.subscribe).getState();
    expect(state).toEqual({ q: { status: 'hasError', value: null, error: 'boom' } });
  });

  it('fires the listener on a transaction and detaches on unsubscribe', () => {
    const recoil = fakeRecoil(new Map());
    const listener = vi.fn();
    const unsub = recoilStore({}, recoil.snapshot, recoil.subscribe).subscribe(listener);
    recoil.emit();
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    recoil.emit();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(recoil.listenerCount()).toBe(0);
  });
});

/** A hand-rolled Svelte readable: `subscribe` calls back synchronously, then on every `set`. */
function fakeSvelteStore<T>(initial: T) {
  const runs = new Set<(value: T) => void>();
  let value = initial;
  return {
    store: {
      subscribe: (run: (value: T) => void): (() => void) => {
        runs.add(run);
        run(value); // the Svelte store contract: immediate + synchronous
        return () => runs.delete(run);
      },
    },
    set: (next: T): void => {
      value = next;
      for (const run of runs) run(value);
    },
    runCount: (): number => runs.size,
  };
}

describe('svelteStore', () => {
  it('pulls the current value through a transient subscription — the same trick svelte/store `get` uses', () => {
    const svelte = fakeSvelteStore({ count: 1 });
    expect(svelteStore(svelte.store).getState()).toEqual({ count: 1 });
  });

  it('leaves no subscription behind after a read, so the adapter needs no teardown', () => {
    const svelte = fakeSvelteStore(0);
    const store = svelteStore(svelte.store);
    store.getState();
    store.getState();
    expect(svelte.runCount()).toBe(0);
  });

  it('reads the LIVE value after a set, not a cached one', () => {
    const svelte = fakeSvelteStore(1);
    const store = svelteStore(svelte.store);
    expect(store.getState()).toBe(1);
    svelte.set(9);
    expect(store.getState()).toBe(9);
  });

  it('swallows the immediate call, so registering a store is not reported as a state change', () => {
    // Svelte calls back synchronously on subscribe. Forwarding that would emit a STATE_CHANGE for a
    // change that never happened — a diff of nothing that a {kind:"state"} predicate could satisfy.
    const svelte = fakeSvelteStore(1);
    const listener = vi.fn();
    svelteStore(svelte.store).subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('fires on every set after the first', () => {
    const svelte = fakeSvelteStore(1);
    const listener = vi.fn();
    svelteStore(svelte.store).subscribe(listener);
    svelte.set(2);
    svelte.set(3);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe detaches', () => {
    const svelte = fakeSvelteStore(1);
    const listener = vi.fn();
    svelteStore(svelte.store).subscribe(listener)();
    svelte.set(2);
    expect(listener).not.toHaveBeenCalled();
    expect(svelte.runCount()).toBe(0);
  });

  it('delivers the FIRST change of a store that never called back synchronously', () => {
    // The registration callback is swallowed by POSITION (it arrives during the subscribe call), not
    // by count. A store that calls back late — an RxJS Observable that is not a BehaviorSubject, the
    // same store getState warns about — has no registration callback to drop, so swallowing "the
    // first one" ate a real change instead: no STATE_CHANGE, and a {kind:"state"} assertion left
    // with nothing to match. A silently missed state change is the false green this project exists
    // to prevent.
    let emit: ((value: unknown) => void) | undefined;
    const lazy = {
      subscribe: (run: (value: unknown) => void): (() => void) => {
        emit = run; // deliberately NOT called here
        return () => undefined;
      },
    };
    const listener = vi.fn();
    svelteStore(lazy, vi.fn()).subscribe(listener);
    expect(listener).not.toHaveBeenCalled();

    emit?.('the first real change');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('accepts a subscribe that returns an {unsubscribe} object, not only a function', () => {
    const unsubscribe = vi.fn();
    const store = svelteStore({
      subscribe: (run: (value: unknown) => void) => {
        run('v');
        return { unsubscribe };
      },
    });
    expect(store.getState()).toBe('v');
    store.subscribe(vi.fn())();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('warns once when a store breaks the synchronous-first-call contract instead of reading empty', () => {
    // No synchronous call ⇒ getState can only answer `undefined`, which is indistinguishable from a
    // store legitimately holding `undefined`. Say so rather than let it read as empty state.
    const warn = vi.fn();
    const lazy = { subscribe: (): (() => void) => () => undefined };
    const store = svelteStore(lazy, warn);
    expect(store.getState()).toBeUndefined();
    store.getState();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/** A fake shaped like a Pinia store: a `$state` object plus `$subscribe(cb, options)`. */
function fakePinia(initial: Record<string, unknown>) {
  const listeners = new Set<() => void>();
  const options: Array<{ detached?: boolean; flush?: string }> = [];
  const state = { ...initial };
  return {
    store: {
      $state: state,
      $subscribe: (
        callback: (mutation: unknown, state: Record<string, unknown>) => void,
        opts?: { detached?: boolean; flush?: string },
      ): (() => void) => {
        options.push(opts ?? {});
        const run = (): void => callback({ type: 'direct' }, state);
        listeners.add(run);
        return () => listeners.delete(run);
      },
    },
    mutate: (key: string, value: unknown): void => {
      state[key] = value;
      for (const l of listeners) l();
    },
    optionsUsed: (): Array<{ detached?: boolean; flush?: string }> => options,
    listenerCount: (): number => listeners.size,
  };
}

describe('piniaStore', () => {
  it('reads $state live, so a mutation is visible without re-registering', () => {
    const pinia = fakePinia({ n: 1 });
    const store = piniaStore(pinia.store);
    expect(store.getState()).toEqual({ n: 1 });
    pinia.mutate('n', 2);
    expect(store.getState()).toEqual({ n: 2 });
  });

  it('fires the listener on a mutation', () => {
    const pinia = fakePinia({ n: 1 });
    const listener = vi.fn();
    piniaStore(pinia.store).subscribe(listener);
    pinia.mutate('n', 2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe detaches', () => {
    const pinia = fakePinia({ n: 1 });
    const listener = vi.fn();
    piniaStore(pinia.store).subscribe(listener)();
    pinia.mutate('n', 2);
    expect(listener).not.toHaveBeenCalled();
    expect(pinia.listenerCount()).toBe(0);
  });

  it('subscribes detached and sync — a remount must not silence it, and a diff must not land late', () => {
    // `detached` keeps the subscription alive across the component that happened to register the
    // store; `sync` puts the notification inside the action's attribution window instead of a tick
    // after it, where the causal summary would no longer link the change to the click that caused it.
    const pinia = fakePinia({ n: 1 });
    piniaStore(pinia.store).subscribe(vi.fn());
    expect(pinia.optionsUsed()[0]).toEqual({ detached: true, flush: 'sync' });
  });
});
