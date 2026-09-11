/**
 * A misspelled predicate key used to WEAKEN the assertion instead of failing.
 *
 * Found by driving `reticle_act_and_wait` over real MCP against bench-app:
 *
 *   until: { kind: 'route', path: '/nowhere-xyz' }
 *   -> verdict.expected: "a route change to ANY route"
 *
 * The `path` was stripped. It failed only because nothing navigated at all — had the click changed
 * the route to anything whatsoever, this would have PASSED while the assertion was false.
 *
 * `path` is not an exotic typo: the `state` predicate, in the same discriminated union, spells its
 * field `path`. The `route` predicate spells it `pathname`. An agent that learned one and applied it
 * to the other gets a check that cannot fail.
 *
 * And it generalises. Five predicate kinds have ALL-optional fields, so stripping the only key the
 * agent supplied leaves a tautology:
 *
 *   { kind: 'net',    url: '/api/x' }   -> "any network call at all"
 *   { kind: 'signal', data: {...} }     -> "any signal named X"
 *   { kind: 'console', message: 'x' }   -> "any console line"
 *
 * This is the path that now counts as a `verification_completed`, so a silent weakening here does
 * not just mislead one agent — it inflates the number we publish.
 *
 * Fix: reject unknown keys, and accept the three confusable spellings as aliases so a rejection is
 * not simply a different dead end.
 */

import { describe, expect, it } from 'vitest';
import { PredicateSchema } from './predicate-eval.js';
import { evalRoute } from './predicate-route.js';
import { EventType, type ReticleEvent } from '@reticlehq/core';

describe('a predicate key that is not real is refused, never dropped', () => {
  it('route { path } no longer degrades to "any route change"', () => {
    const parsed = PredicateSchema.parse({ kind: 'route', path: '/checkout' });
    expect(
      parsed,
      "path is the state predicate's spelling — accept it, do not silently drop it",
    ).toMatchObject({ kind: 'route', pathname: '/checkout' });
  });

  it('net { url } no longer degrades to "any network call"', () => {
    expect(PredicateSchema.parse({ kind: 'net', url: '/api/orders' })).toMatchObject({
      kind: 'net',
      urlContains: '/api/orders',
    });
  });

  it('signal { data } no longer degrades to "any signal with that name"', () => {
    expect(
      PredicateSchema.parse({ kind: 'signal', name: 'order:placed', data: { id: 1 } }),
    ).toMatchObject({ kind: 'signal', name: 'order:placed', dataMatches: { id: 1 } });
  });

  it('signal { count } survives the parse instead of being rejected as an unknown key', () => {
    // The strict union drops nothing silently, so a field the evaluator reads has to be declared
    // here too — otherwise the cardinality assertion never reaches it and the call returns nothing.
    expect(PredicateSchema.parse({ kind: 'signal', name: 'order:placed', count: 1 })).toMatchObject(
      { kind: 'signal', name: 'order:placed', count: 1 },
    );
  });

  /**
   * Reported from the field, and the reasoning behind the mistake is sound:
   *
   * > reticle_assert route predicate rejected urlContains (unrecognized_keys) while net predicate
   * > accepts urlContains. Skill examples use route without documenting fields; I assumed parallel
   * > URL filters. Need: which field names a route change after login?
   *
   * The agent had just learned `net { urlContains }` and applied the same word to `route`, which
   * spells it `contains`. Unlike the cases above this one FAILED rather than silently weakening —
   * strictness caught it — but a rejection with no valid-field list is still a dead end, and the
   * agent burned a `reticle_tools` round trip to recover. `reticle_tools` is re-called on 33% of its
   * uses, which is what "I do not know the grammar" looks like from the outside.
   *
   * The alias is semantically honest, not just convenient: route's `contains` matches the WHOLE
   * route — path + query + fragment — so "the URL contains this" is exactly what it does.
   */
  it('route { urlContains } is accepted, because net spells the same idea that way', () => {
    expect(PredicateSchema.parse({ kind: 'route', urlContains: '/dashboard' })).toMatchObject({
      kind: 'route',
      contains: '/dashboard',
    });
  });

  it('route { url } too — the shorter spelling net also accepts', () => {
    expect(PredicateSchema.parse({ kind: 'route', url: '?redirect=' })).toMatchObject({
      kind: 'route',
      contains: '?redirect=',
    });
  });

  /**
   * Reported from the field by analogy with net { urlContains }: the reporter spells console
   * substring matching `textContains`, and a rejection with no verdict costs the agent a
   * `reticle_tools` round trip to recover. The alias is applied in
   * `z.preprocess(applyPredicateAliases, …)` at schema parse time, so this is asserted through
   * PredicateSchema; calling evaluatePredicate directly would take an already-typed predicate and
   * pass for a reason unrelated to aliasing.
   */
  it("console { textContains } is accepted, because that is the reporter's spelling", () => {
    expect(PredicateSchema.parse({ kind: 'console', textContains: 'no-op' })).toMatchObject({
      kind: 'console',
      contains: 'no-op',
    });
  });

  it("a key that is nobody's spelling is rejected, not stripped", () => {
    // The agent gets a schema error naming the key. Before, it got a green.
    expect(() => PredicateSchema.parse({ kind: 'route', pathnmae: '/checkout' })).toThrow();
    expect(() => PredicateSchema.parse({ kind: 'signal', naem: 'x' })).toThrow();
    expect(() => PredicateSchema.parse({ kind: 'console', message: 'boom' })).toThrow();
  });

  it('an explicit canonical key wins over its alias, so nothing existing changes meaning', () => {
    expect(
      PredicateSchema.parse({ kind: 'route', pathname: '/real', path: '/ignored' }),
    ).toMatchObject({ pathname: '/real' });
  });

  it('every real predicate still parses untouched', () => {
    const ok = [
      { kind: 'element', query: { testid: 'submit' } },
      { kind: 'text', contains: 'Deploy' },
      { kind: 'net', urlContains: '/api/x', status: 200, count: 1 },
      { kind: 'route', pathname: '/a' },
      { kind: 'route', contains: 'checkout' },
      { kind: 'console', level: 'error', absent: true },
      { kind: 'animation', name: 'fade', completed: true },
      { kind: 'signal', name: 's', dataMatches: { a: 1 } },
      { kind: 'state', store: 'app', path: 'cart.total', equals: 2 },
      { kind: 'settled', quietMs: 300 },
      { kind: 'not', predicate: { kind: 'route', pathname: '/a' } },
      { kind: 'allOf', predicates: [{ kind: 'settled' }, { kind: 'route', contains: 'x' }] },
      { kind: 'anyOf', predicates: [{ kind: 'signal', name: 's' }] },
    ];
    for (const p of ok) expect(() => PredicateSchema.parse(p), JSON.stringify(p)).not.toThrow();
  });

  it('the alias works nested inside a combinator too', () => {
    expect(
      PredicateSchema.parse({ kind: 'allOf', predicates: [{ kind: 'route', path: '/deep' }] }),
    ).toMatchObject({ predicates: [{ pathname: '/deep' }] });
  });

  it('and what the stripped form actually did: pass on ANY navigation', () => {
    // Not asserted — evaluated. This is the green the live MCP session would have received:
    // `{ kind: 'route', path: '/nowhere' }` parsed to a bare `{ kind: 'route' }`, and a bare route
    // predicate is satisfied by any route change whatsoever.
    const navigated: ReticleEvent[] = [
      { t: 1, type: EventType.ROUTE_CHANGE, sessionId: 's', data: { pathname: '/deployments' } },
    ];
    expect(evalRoute(navigated, { kind: 'route' }).pass, 'the tautology').toBe(true);
    expect(evalRoute(navigated, { kind: 'route', pathname: '/nowhere' }).pass).toBe(false);
  });

  it('`since` is real on every EVENT-based kind, not just net/console', () => {
    // Found by strictness, in our own e2e battery: next-blur-clock-test asserted
    //   { kind: 'signal', name: 'field:committed', dataMatches: {...}, since }
    // with `since` taken from the blur's own result — and it was dropped, so "the signal fired AFTER
    // the blur" was really "at any point in the window". `since` is an event-time floor and means the
    // same thing for every kind that reads the event stream.
    for (const p of [
      { kind: 'signal', name: 's', since: 5 },
      { kind: 'route', pathname: '/a', since: 5 },
      { kind: 'animation', name: 'fade', since: 5 },
    ]) {
      expect(() => PredicateSchema.parse(p), JSON.stringify(p)).not.toThrow();
    }
    // element/text read the live DOM, not the event window — `since` there would mean nothing, so it
    // stays refused rather than accepted and ignored.
    expect(() =>
      PredicateSchema.parse({ kind: 'element', query: { testid: 'x' }, since: 5 }),
    ).toThrow();
  });
});

/**
 * The union went strict; the query object nested inside it did not.
 *
 * Reported from the field: `{ kind: 'element', query: { css: "a[href='...']" } }` PARSED, `css` was
 * stripped, `{}` survived, and the verdict read "no element matched {}" — a claim that the element is
 * absent from a page where it was plainly present. That is the same silent weakening the union above
 * fixed, except it lands as a false RED instead of a false green: an agent that trusts it goes off and
 * "fixes" code that was already correct.
 */
describe('an unknown key inside `element.query` is refused too', () => {
  it('names the key instead of degrading the query to {}', () => {
    expect(() =>
      PredicateSchema.parse({ kind: 'element', query: { css: "a[href='/pricing']" } }),
    ).toThrow(/css/);
  });

  it('and inside the nested `source` anchor', () => {
    expect(() =>
      PredicateSchema.parse({
        kind: 'element',
        query: { source: { file: 'App.tsx', line: 4, col: 2 } },
      }),
    ).toThrow(/col/);
  });

  it('lifting flat query fields still parses once the query is strict', () => {
    // `liftElementQuery` moves the flat spellings into `query`; every field it moves must be one the
    // strict schema accepts, or the convenience becomes a rejection.
    expect(
      PredicateSchema.parse({ kind: 'element', role: 'button', name: 'Deploy' }),
    ).toMatchObject({ kind: 'element', query: { role: 'button', name: 'Deploy' } });
  });
});
