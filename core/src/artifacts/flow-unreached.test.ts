import { describe, expect, it } from 'vitest';
import { unreachedRoutes } from '../index.js';

/**
 * The third coverage number, and the one that answers a different question.
 *
 * `steps`/`declared` say how much of what a run DROVE it proved. Neither says anything about what it
 * never touched — and a suite that replays four flows perfectly across two routes, on an app with
 * eleven, is not "all green" in any sense a person means it.
 *
 * Known routes come from what the app has been SEEN to have across every past run, so this is the
 * one coverage figure that grows as the app is explored rather than as the suite is written.
 */
describe('routes this run never reached', () => {
  it('names a known route no flow visited', () => {
    expect(unreachedRoutes(['/', '/orders', '/billing'], ['/', '/orders'])).toEqual(['/billing']);
  });

  it('is empty when every known route was visited', () => {
    expect(unreachedRoutes(['/', '/orders'], ['/orders', '/'])).toEqual([]);
  });

  it('ignores a visited route nobody had recorded as known', () => {
    // Visiting somewhere new is not a coverage gap — it is the opposite. The number counts what is
    // known and untouched, never what is touched and unknown.
    expect(unreachedRoutes(['/'], ['/', '/brand-new'])).toEqual([]);
  });

  it('is empty when nothing is known yet, rather than claiming everything is unreached', () => {
    // A fresh project has learned no routes. Reporting "0 of 0 unreached" is honest; inventing a
    // gap from an empty ledger would make every first run look incomplete.
    expect(unreachedRoutes([], ['/'])).toEqual([]);
  });

  it('does not count the same route twice, however often it was learned', () => {
    expect(unreachedRoutes(['/billing', '/billing'], [])).toEqual(['/billing']);
  });

  it('keeps the order routes were learned in, so the list is stable between runs', () => {
    expect(unreachedRoutes(['/z', '/a', '/m'], [])).toEqual(['/z', '/a', '/m']);
  });
});
