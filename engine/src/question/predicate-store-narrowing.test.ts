/**
 * An `unknown` verdict is a verification that did not happen, so it has to be earned.
 *
 * Found by driving the bench app. Clicking a nav button and asserting
 * `{kind:'state', path:'view', equals:'deployments'}` came back `verified:"unknown"` —
 * "multiple stores (__reticle_renders, app, queries); name one with `store`" — while the SAME
 * response body carried `stateDiffs: [{path:'view', from:'overview', to:'deployments'}]`. Reticle
 * had the answer and declined to give it.
 *
 * Refusing over an ambiguity that is not actually ambiguous is the expensive half of this. Of the
 * three stores only `app` has a `view` path at all; the other two are a render meter and a query
 * cache, and one of them is registered by Reticle itself. So the agent is asked to disambiguate
 * between one real candidate and two that could never match, pays a round trip to find that out,
 * and in the meantime the verdict is `unknown` — which is not a pass, and is reported to the user
 * as a drive that proved nothing.
 *
 * The rule this pins: ambiguity is about the PATH, not the store count.
 *
 *   - exactly one store has the path -> read it, no refusal
 *   - two or more have it            -> genuinely ambiguous, still inconclusive, and now it names
 *                                       the stores that actually collide rather than every store
 *   - none has it                    -> a real finding about the app, not a question about the
 *                                       call: the assertion cannot hold in any registered store.
 *                                       Reported as a failure, exactly as the single-store case
 *                                       already was.
 *
 * The last one is the branch to be careful with, so it is stated rather than left implicit: it
 * turns a non-answer into a `no`. That is the same verdict a named store has always produced for a
 * missing path, and a wrong `no` is visible and arguable in a way a silent `unknown` is not.
 */

import { describe, expect, it } from 'vitest';
import { ReticleCommand, type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { evaluatePredicate } from './predicate.js';
import type { PredicateSession } from './predicate.js';

/** Minimal session that answers STATE_READ with a fixed set of stores. */
class Stores implements PredicateSession {
  constructor(private readonly stores: Record<string, unknown>) {}
  elapsed(): number {
    return 0;
  }
  command(name: string): Promise<CommandResult> {
    if (name === ReticleCommand.STATE_READ) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'x',
        ok: true,
        result: { stores: this.stores, storeNames: Object.keys(this.stores) },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
}

/** The bench app's real shape: one meaningful store and two that cannot match. */
const BENCH = {
  __reticle_renders: { App: 4 },
  app: { view: 'deployments', auth: { email: 'admin@reticle.dev' } },
  queries: { 'deployments.list': { status: 'success' } },
};

describe('a store is chosen by which one HAS the path', () => {
  it('reads the only store carrying the path instead of refusing', async () => {
    // The exact call that came back `unknown` against the running bench app.
    const r = await evaluatePredicate(new Stores(BENCH), {
      kind: 'state',
      path: 'view',
      equals: 'deployments',
    });
    expect(r.pass).toBe(true);
    expect(r.inconclusive).toBeUndefined();
    expect((r.evidence as { store?: string }).store).toBe('app');
  });

  it('still refuses when two stores really do carry the same path', async () => {
    // Nothing here can pick a winner, and guessing would be the false-green version of this fix.
    const r = await evaluatePredicate(new Stores({ a: { view: 'x' }, b: { view: 'y' } }), {
      kind: 'state',
      path: 'view',
      equals: 'x',
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('multiple stores');
  });

  it('names only the colliding stores, not every registered one', async () => {
    // The old message listed all three bench stores, so the reader could not tell which of them
    // were real candidates. Two of the three could never have matched.
    const r = await evaluatePredicate(new Stores({ ...BENCH, other: { view: 'z' } }), {
      kind: 'state',
      path: 'view',
    });
    expect(r.inconclusive).toContain('app');
    expect(r.inconclusive).toContain('other');
    expect(r.inconclusive).not.toContain('queries');
    expect(r.inconclusive).not.toContain('__reticle_renders');
  });

  it('calls it a failure, not a question, when no store has the path', async () => {
    const r = await evaluatePredicate(new Stores(BENCH), { kind: 'state', path: 'nope' });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
    expect(r.assertion).toBe('state.path-missing');
  });

  it('an explicitly named store is still read verbatim, ambiguity or not', async () => {
    // Narrowing must never override what the caller asked for — including asking for a store where
    // the path is absent, which stays the failure it has always been.
    const named = await evaluatePredicate(new Stores(BENCH), {
      kind: 'state',
      store: 'queries',
      path: 'view',
    });
    expect(named.pass).toBe(false);
    expect(named.assertion).toBe('state.path-missing');
  });

  it('leaves the no-stores-at-all case alone', async () => {
    const r = await evaluatePredicate(new Stores({}), { kind: 'state', path: 'view' });
    expect(r.inconclusive).toBe('no registered store to read state from');
  });
});
