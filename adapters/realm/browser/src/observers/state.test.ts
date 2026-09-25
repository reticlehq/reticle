import { describe, it, expect, afterEach } from 'vitest';
import { BlindSpotKind, EventType } from '@reticlehq/core';
import { diffState, installStoreState } from './state.js';
import { registerStore, unregisterStore } from '@/registry/stores.js';

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

/** Minimal Zustand/Redux-shaped store. */
function fakeStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: (): T => state,
    setState: (next: T): void => {
      state = next;
      for (const l of listeners) l();
    },
    subscribe: (l: () => void): (() => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

describe('diffState', () => {
  it('reports only the top-level keys whose value changed', () => {
    const changes = diffState({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
    expect(changes).toEqual([
      { path: 'b', old: 2, new: 3 },
      { path: 'c', old: undefined, new: 4 },
    ]);
  });

  it('treats a non-object state as a single path', () => {
    expect(diffState(1, 2)).toEqual([{ path: '', old: 1, new: 2 }]);
    expect(diffState(5, 5)).toEqual([]);
  });
});

describe('installStoreState', () => {
  afterEach(() => {
    unregisterStore('cart');
    unregisterStore('late');
  });

  /*
   * One failed emit must not turn into permanent duplicate reporting.
   *
   * The baseline the diff runs against was advanced AFTER the emit loop, inside the same
   * `observeSafely` that swallows a throw. So a single emit that threw left `last` pointing at a
   * state the store had long moved past, and every later notify diffed against that stale baseline
   * and re-sent the whole changed value again. For a store holding a list, that is the entire list
   * on every subsequent change, forever.
   *
   * Seen in a real app's journal: one store path accounted for 97% of every state event, and the
   * same `old` hash appeared across long runs of events while the new value kept moving. This is
   * the mechanism that produces exactly that signature. (Duplicate live subscriptions would produce
   * it too; that one is not proven here, and this fix is correct either way.)
   */
  it('advances its baseline even when an emit throws', () => {
    const events: Captured[] = [];
    let explode = true;
    const teardown = installStoreState((type, data) => {
      if (explode && EventType.STATE_CHANGE === type) {
        explode = false;
        throw new Error('transport refused this one');
      }
      events.push({ type, data });
    });

    const store = fakeStore<{ items: number[] }>({ items: [1] });
    registerStore('cart', store);
    store.setState({ items: [1, 2] }); // this emit throws and is lost
    store.setState({ items: [1, 2, 3] }); // only THIS change should be reported

    const changes = events.filter((e) => EventType.STATE_CHANGE === e.type);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.data['old']).toEqual([1, 2]);
    expect(changes[0]?.data['value']).toEqual([1, 2, 3]);
    teardown();
  });

  it('observes a store registered AFTER install (the real app ordering)', () => {
    // Regression: the SDK installs observers during connect, but apps call registerStore after —
    // so enumerating once at install subscribed to nothing and STATE_CHANGE never fired in any real app.
    const events: Captured[] = [];
    const teardown = installStoreState((type, data) => events.push({ type, data }));

    const store = fakeStore<{ count: number }>({ count: 1 });
    registerStore('late', store); // registered AFTER installStoreState
    store.setState({ count: 2 });

    const changes = events.filter((e) => e.type === EventType.STATE_CHANGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.data).toMatchObject({ name: 'late', path: 'count', old: 1, value: 2 });

    teardown();
    store.setState({ count: 3 });
    expect(events.filter((e) => e.type === EventType.STATE_CHANGE)).toHaveLength(1);
  });

  it('emits STATE_CHANGE path diffs when a subscribed store mutates', () => {
    const store = fakeStore<{ count: number; token?: string }>({ count: 1 });
    registerStore('cart', store.getState, store.subscribe);
    const events: Captured[] = [];
    const teardown = installStoreState((type, data) => events.push({ type, data }));

    store.setState({ count: 2 });
    teardown();
    store.setState({ count: 3 }); // after teardown → ignored

    const changes = events.filter((e) => e.type === EventType.STATE_CHANGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.data).toMatchObject({ name: 'cart', path: 'count', old: 1, value: 2 });
  });

  it('rebinds to a re-registered store instance (HMR) and drops the dead one', () => {
    // HMR replaces the store INSTANCE under the same name. The old `seen` guard skipped it, leaving the
    // subscription bound to the dead getter forever while the live store stayed invisible until reload.
    const events: Captured[] = [];
    const teardown = installStoreState((type, data) => events.push({ type, data }));

    const oldStore = fakeStore<{ count: number }>({ count: 1 });
    registerStore('cart', oldStore.getState, oldStore.subscribe);
    oldStore.setState({ count: 2 }); // fires from the first instance

    const newStore = fakeStore<{ count: number }>({ count: 10 });
    registerStore('cart', newStore.getState, newStore.subscribe); // HMR: same name, new instance
    newStore.setState({ count: 11 }); // must fire — the new store is now the live one
    oldStore.setState({ count: 3 }); // must NOT fire — the dead subscription was dropped

    teardown();
    const changes = events.filter((e) => e.type === EventType.STATE_CHANGE);
    expect(changes).toHaveLength(2);
    expect(changes[0]?.data).toMatchObject({ name: 'cart', old: 1, value: 2 });
    expect(changes[1]?.data).toMatchObject({ name: 'cart', old: 10, value: 11 });
  });

  it('redacts a credential-bearing changed path', () => {
    const store = fakeStore<Record<string, unknown>>({ token: 'old' });
    registerStore('cart', store.getState, store.subscribe);
    const events: Captured[] = [];
    const teardown = installStoreState((type, data) => events.push({ type, data }));

    store.setState({ token: 'new-secret' });
    teardown();

    const change = events.find((e) => e.type === EventType.STATE_CHANGE);
    expect(change?.data['value']).toBe('[REDACTED]');
    expect(JSON.stringify(change?.data)).not.toContain('secret');
  });
});

/**
 * "The store did not change" and "nothing was watching the store" are the same empty `stateDiffs`
 * unless the SDK says which one it is — and the second is the common case, because the generated
 * capabilities file registers nothing until someone edits it. So the absence is DECLARED.
 */
describe('installStoreState declares an unwatched state channel', () => {
  afterEach(() => {
    unregisterStore('cart');
  });

  const spots = (events: Captured[]): Captured[] =>
    events.filter(
      (e) => e.type === EventType.BLIND_SPOT && e.data['kind'] === BlindSpotKind.UNWATCHED_STATE,
    );

  it('reports the blind spot when no subscribable store is registered, and clears it when one is', () => {
    const events: Captured[] = [];
    const teardown = installStoreState((type, data) => events.push({ type, data }));
    expect(spots(events).map((e) => e.data['count'])).toEqual([1]);

    const store = fakeStore<{ count: number }>({ count: 1 });
    registerStore('cart', store);
    teardown();

    // Count 0 — the channel is live now, and a blind spot that never clears is a permanent lie.
    expect(spots(events).map((e) => e.data['count'])).toEqual([1, 0]);
  });

  it('says nothing when a subscribable store was already registered at install', () => {
    const store = fakeStore<{ count: number }>({ count: 1 });
    registerStore('cart', store);
    const events: Captured[] = [];
    const teardown = installStoreState((type, data) => events.push({ type, data }));
    teardown();
    expect(spots(events)).toEqual([]);
  });

  it('reports it for a store registered as a bare GETTER — readable, but silent', () => {
    // The other half of the same false negative: a getter-registered store can be read on demand and
    // will never emit a STATE_CHANGE, so its causal summary is empty exactly like an unwatched app's.
    const store = fakeStore<{ count: number }>({ count: 1 });
    registerStore('cart', store.getState);
    const events: Captured[] = [];
    const teardown = installStoreState((type, data) => events.push({ type, data }));
    teardown();
    expect(spots(events).map((e) => e.data['count'])).toEqual([1]);
  });
});

/**
 * A cache re-emitting a value it already had is not a state change.
 *
 * `diffState` compares by reference, which is right for Zustand and Redux (they replace the changed
 * key's reference) and wrong for a query cache: TanStack Query re-emits an unchanged entry under a
 * NEW object on every refetch. Those accumulate until the daemon throws
 * `Cannot create a string longer than 0x1fffffe8 characters` -- V8's 512 MB string ceiling -- and
 * the only two tools that produce a verdict stop working for the rest of the session (#985).
 */
describe('identical re-emissions do not become events', () => {
  afterEach(() => {
    unregisterStore('queries');
  });

  it('drops a new object reference carrying the same value', () => {
    const store = fakeStore<{ data: { rows: number[] } }>({ data: { rows: [1, 2, 3] } });
    registerStore('queries', store.getState, store.subscribe);
    const events: Captured[] = [];
    const teardown = installStoreState((type, data) => events.push({ type, data }));

    // What a refetch does: a fresh object, deep-equal to the one it replaces.
    for (let i = 0; i < 50; i += 1) store.setState({ data: { rows: [1, 2, 3] } });
    teardown();

    expect(events.filter((e) => e.type === EventType.STATE_CHANGE)).toHaveLength(0);
  });

  it('still reports a change the reader can see', () => {
    const store = fakeStore<{ data: { rows: number[] } }>({ data: { rows: [1, 2, 3] } });
    registerStore('queries', store.getState, store.subscribe);
    const events: Captured[] = [];
    const teardown = installStoreState((type, data) => events.push({ type, data }));

    store.setState({ data: { rows: [1, 2, 3] } }); // identical -> dropped
    store.setState({ data: { rows: [1, 2, 4] } }); // different -> reported
    teardown();

    const changes = events.filter((e) => e.type === EventType.STATE_CHANGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.data).toMatchObject({ name: 'queries', path: 'data' });
  });

  it('reports a change from a value to undefined', () => {
    // `JSON.stringify(undefined)` is `undefined`, so a naive string compare would call this equal
    // to any other unserialisable value. Removing a key is a real change and must survive.
    const store = fakeStore<{ data?: number }>({ data: 1 });
    registerStore('queries', store.getState, store.subscribe);
    const events: Captured[] = [];
    const teardown = installStoreState((type, data) => events.push({ type, data }));

    store.setState({});
    teardown();

    expect(events.filter((e) => e.type === EventType.STATE_CHANGE)).toHaveLength(1);
  });

  it('never coalesces a redacted path, where both sides present as the same token', () => {
    // `project` collapses every credential to `[REDACTED]`, so a rotated secret presents
    // identically on both sides. Coalescing on the presented form would drop the one change nobody
    // can afford to miss.
    const store = fakeStore<{ token: string }>({ token: 'secret-one' });
    registerStore('queries', store.getState, store.subscribe);
    const events: Captured[] = [];
    const teardown = installStoreState((type, data) => events.push({ type, data }));

    store.setState({ token: 'secret-two' });
    teardown();

    const changes = events.filter((e) => e.type === EventType.STATE_CHANGE);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.data).toMatchObject({
      path: 'token',
      old: '[REDACTED]',
      value: '[REDACTED]',
    });
  });
});
