/**
 * A state assertion that NAMES its store should read only that path, not every store.
 *
 * Follow-up to the truncation fix in 60a13e20, which made the read CORRECT. This makes it CHEAP.
 * `reticle_state` already has a scoped mode that selects the path out of the RAW store in-page, before
 * the transport cap — the read tool's own comment is the argument:
 *
 *   > Forward path/depth so a CURRENT browser SDK scopes the read IN-PAGE, before the transport — the
 *   > value never gets size-truncated in transit.
 *
 * The predicate path never learned that. When `store` is named, nothing around it needs the other
 * stores, so a whole-store read only pays for a payload it throws away and risks a cap that a scoped
 * read would never trip. So: a named store reads scoped, in one round trip.
 *
 * The unnamed case genuinely needs the wide read (it is how the path's store is discovered) and is
 * left exactly as it was — covered by predicate-store-narrowing.test.ts.
 *
 * One property to preserve: a scoped read answers `found:false` for both "no such store" and "no such
 * path". Those are different facts and stay distinguishable here, or the message regresses while the
 * payload improves.
 */

import { describe, expect, it } from 'vitest';
import { ReticleCommand, type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { evaluatePredicate } from './predicate.js';
import type { PredicateSession } from './predicate.js';

interface ScopedReply {
  store?: string;
  path?: string;
  found?: boolean;
  value?: unknown;
  truncation?: Record<string, unknown>;
  availableKeys?: string[];
  storeNames: string[];
}

/**
 * A session whose SDK actually honours the scoped read: given {store, path} it selects in-page and
 * returns only the value, the way a current browser SDK does. Records every read so a test can assert
 * that a named assertion made ONE scoped call, not a whole-store read.
 */
class ScopedStores implements PredicateSession {
  readonly reads: Record<string, unknown>[] = [];
  constructor(private readonly registered: Record<string, Record<string, unknown>>) {}
  elapsed(): number {
    return 0;
  }
  command(name: string, args?: Record<string, unknown>): Promise<CommandResult> {
    if (name !== ReticleCommand.STATE_READ) {
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
    }
    const a = args ?? {};
    this.reads.push(a);
    const storeNames = Object.keys(this.registered);
    const store = 'string' === typeof a['store'] ? a['store'] : undefined;
    const path = 'string' === typeof a['path'] ? a['path'] : undefined;
    // Scoped mode: the SDK walks `path` into the named store and returns just that.
    if (store !== undefined && path !== undefined) {
      const bag = this.registered[store];
      const has = bag !== undefined && Object.prototype.hasOwnProperty.call(bag, path);
      const reply: ScopedReply = {
        store,
        path,
        found: has,
        value: has ? bag[path] : undefined,
        storeNames,
        ...(has ? {} : { availableKeys: bag ? Object.keys(bag) : [] }),
      };
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: reply });
    }
    // Whole-store read (unnamed path only reaches here).
    return Promise.resolve({
      kind: 'command_result',
      id: 'x',
      ok: true,
      result: { stores: this.registered, storeNames },
    });
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
}

const APP = { app: { view: 'deployments', tab: 'overview' } };

describe('a named store reads scoped, not whole', () => {
  it('makes exactly one scoped read carrying the path, never a whole-store read', async () => {
    const session = new ScopedStores(APP);
    const r = await evaluatePredicate(session, {
      kind: 'state',
      store: 'app',
      path: 'view',
      equals: 'deployments',
    });
    expect(r.pass).toBe(true);
    expect(session.reads).toHaveLength(1);
    expect(session.reads[0]).toMatchObject({ store: 'app', path: 'view' });
  });

  it('resolves the small asserted value even when a sibling would blow the whole-store cap', async () => {
    // The Atlas shape: `pendingDispatch` is tiny, `rows` beside it is huge. A whole-store read would
    // truncate and, before the fix, compare against "[TRUNCATED]". The scoped read never sees `rows`,
    // so the assertion that is TRUE is reported true — in one round trip, with nothing to re-read.
    const session = new ScopedStores({
      atlas: { rows: 'huge...', pendingDispatch: ['shp_000001'] },
    });
    const r = await evaluatePredicate(session, {
      kind: 'state',
      store: 'atlas',
      path: 'pendingDispatch',
      equals: { $contains: 'shp_000001' },
    });
    expect(r.pass).toBe(true);
    expect(r.inconclusive).toBeUndefined();
    expect(session.reads).toHaveLength(1);
  });

  it('keeps "no such store" distinct from "no such path"', async () => {
    const missingStore = await evaluatePredicate(new ScopedStores(APP), {
      kind: 'state',
      store: 'nope',
      path: 'view',
    });
    expect(missingStore.pass).toBe(false);
    expect(missingStore.assertion).toBe('state.store-missing');
    expect(missingStore.failureReason).toContain("no store named 'nope'");

    const missingPath = await evaluatePredicate(new ScopedStores(APP), {
      kind: 'state',
      store: 'app',
      path: 'absent',
    });
    expect(missingPath.pass).toBe(false);
    expect(missingPath.assertion).toBe('state.path-missing');
    expect(missingPath.failureReason).toContain("store 'app'");
  });

  it('is INCONCLUSIVE, not a failure, when even the scoped value is truncated', async () => {
    const session = new ScopedStores(APP);
    // Force a truncated scoped reply for the named read.
    const truncating: PredicateSession = {
      elapsed: () => 0,
      command: (name: string) =>
        name === ReticleCommand.STATE_READ
          ? Promise.resolve({
              kind: 'command_result',
              id: 'x',
              ok: true,
              result: {
                store: 'app',
                path: 'view',
                found: true,
                value: '[TRUNCATED]',
                truncation: { truncatedValues: 1, note: 'caps fired' },
                storeNames: ['app'],
              },
            } satisfies CommandResult)
          : Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} }),
      eventsSince: () => [],
      onEvent: () => () => undefined,
    };
    void session;
    const r = await evaluatePredicate(truncating, {
      kind: 'state',
      store: 'app',
      path: 'view',
      equals: 'deployments',
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('truncat');
  });

  it('reports a genuine mismatch as a failure, not truncation', async () => {
    const r = await evaluatePredicate(new ScopedStores(APP), {
      kind: 'state',
      store: 'app',
      path: 'view',
      equals: 'settings',
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
    expect(r.assertion).toBe('state.equals');
  });
});
