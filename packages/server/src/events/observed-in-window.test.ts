/**
 * "It didn't happen" is not a diagnosis. What DID happen is.
 *
 * The testid miss now names the testids that are present (see testid-near-miss). The same gap sat in
 * the two predicates the product most wants agents to assert on:
 *
 *   { kind:'signal', name:'no-such-signal' } -> "signal 'no-such-signal' never fired in the window"
 *   { kind:'net', urlContains:'/no-such' }   -> "no matching network call in the window"
 *
 * Both true, both dead ends. A typo'd signal name and a wrong path look identical to "the app is
 * broken", and the agent has no way to tell them apart without another round trip it does not know
 * to make. `{ kind:'state' }` already does this right — it answers a bad path with
 * "multiple stores (__reticle_renders, app, queries); name one with `store`".
 *
 * This matters more now: putting act_and_wait on the verification path means far more assertions,
 * so these two failures go from rare to routine.
 */

import { describe, expect, it } from 'vitest';
import { describeObserved } from './observed-in-window.js';

describe('describeObserved', () => {
  it('names what WAS seen, so a typo is one step from fixed', () => {
    expect(describeObserved('signals', ['todos:loaded', 'todos:saved'])).toBe(
      'signals seen in this window: todos:loaded, todos:saved',
    );
  });

  it('says the window was EMPTY rather than listing nothing', () => {
    // "no signals fired at all" and "the one you asked for didn't" call for different fixes: the
    // first says the action did nothing, the second says you named it wrong.
    expect(describeObserved('signals', [])).toBe('no signals at all in this window');
    // And it must read correctly for the other noun too — "no calls at all fired" does not.
    expect(describeObserved('calls', [])).toBe('no calls at all in this window');
  });

  it('de-duplicates — ten identical calls are one fact', () => {
    expect(describeObserved('calls', ['GET /api/a', 'GET /api/a', 'GET /api/b'])).toContain(
      'GET /api/a, GET /api/b',
    );
  });

  it('caps the list so a chatty window cannot flood the failure', () => {
    const many = Array.from({ length: 100 }, (_, i) => `GET /api/${String(i)}`);
    const text = describeObserved('calls', many);
    expect(text.length).toBeLessThan(500);
    expect(text).toMatch(/more/);
  });
});
