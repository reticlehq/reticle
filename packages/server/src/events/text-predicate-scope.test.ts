import { describe, it, expect } from 'vitest';
import type { CommandResult, ElementQuery, MatchResult } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';

/**
 * Regression for #399: the `text` predicate could not be scoped to a subtree, so a match
 * anywhere in the document satisfied it — a word present in a background tab AND in the dialog
 * that just opened made `act_and_wait` return `already_true` for an action that did the right thing.
 *
 * `text` is evaluated through the same `evalElement`/MATCH path as `element`, and `ElementQuery`
 * already carries `scope`; the TEXT branch simply dropped it. These tests pin that it now forwards.
 */
describe('text predicate scope (#399)', () => {
  /** A session that records the MATCH query it was handed and only matches when scoped as asked. */
  function scopedSession(matchWhenScopedTo: string | undefined): {
    session: PredicateSession;
    lastQuery: () => ElementQuery | undefined;
  } {
    let seen: ElementQuery | undefined;
    const session = {
      eventsSince: () => [],
      elapsed: () => 0,
      onEvent: () => () => undefined,
      command: (_name: string, args: Record<string, unknown> = {}): Promise<CommandResult> => {
        const query = args.query as ElementQuery;
        seen = query;
        const inScope = query.scope === matchWhenScopedTo;
        const result: MatchResult = inScope
          ? { matched: true, count: 1, elements: [] }
          : { matched: false, count: 0, elements: [] };
        return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
      },
    } as unknown as PredicateSession;
    return { session, lastQuery: () => seen };
  }

  it('forwards scope into the MATCH query so the search is confined to a subtree', async () => {
    const { session, lastQuery } = scopedSession('[role="dialog"]');
    const r = await evaluatePredicate(session, {
      kind: 'text',
      contains: 'Floor',
      scope: '[role="dialog"]',
    });
    expect(r.pass).toBe(true);
    // The bug was that scope never reached the query; pin that it now does, alongside the text.
    expect(lastQuery()?.scope).toBe('[role="dialog"]');
    expect(lastQuery()?.text).toBe('Floor');
  });

  it('a scoped text predicate does NOT pass on a match outside its scope', async () => {
    // The session only matches when scoped to the dialog. A predicate scoped elsewhere must fail,
    // which is the whole point: "Floor" in a background tab no longer satisfies the dialog assertion.
    const { session } = scopedSession('[role="dialog"]');
    const r = await evaluatePredicate(session, {
      kind: 'text',
      contains: 'Floor',
      scope: '#background-tab',
    });
    expect(r.pass).toBe(false);
  });

  it('stays page-wide when no scope is given (unchanged behaviour)', async () => {
    const { session, lastQuery } = scopedSession(undefined);
    const r = await evaluatePredicate(session, { kind: 'text', contains: 'Floor' });
    expect(r.pass).toBe(true);
    expect(lastQuery()?.scope).toBeUndefined();
  });
});
