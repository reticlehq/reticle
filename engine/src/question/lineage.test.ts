/**
 * Where did this value come from — with the join's confidence on the face of it.
 *
 * The prior art (`firatorhan/sentinel`'s `get_lineage`) picks "the most recent action whose payload
 * contains this value", then "an API call whose type matches". That is CORRELATION, and for a
 * devtool a human reads it is fine — the human discounts it.
 *
 * Reticle's output is consumed by an agent that acts on it, so a plausible causal chain presented as
 * fact is the false-green shape this project exists to refuse. Everything below is about that
 * distinction and not about the join, which is deliberately simple:
 *
 * - a state path that changed is OBSERVED;
 * - "this signal caused it" is INFERRED, and says so;
 * - several candidates are NAMED, never narrowed to the most recent;
 * - no candidate says the value was not seen to pass through one, and reaches for nothing.
 */

import { describe, expect, it } from 'vitest';
import { EventAttribution, EventType, type ReticleEvent } from '@reticlehq/core';
import { traceLineage } from './lineage.js';

const state = (t: number, path: string, value: unknown): ReticleEvent =>
  ({ type: EventType.STATE_CHANGE, t, data: { path, value } }) as unknown as ReticleEvent;
const signal = (t: number, name: string): ReticleEvent =>
  ({ type: EventType.SIGNAL, t, data: { name } }) as unknown as ReticleEvent;
const net = (t: number, method: string, url: string, status: number): ReticleEvent =>
  ({ type: EventType.NET_REQUEST, t, data: { method, url, status } }) as unknown as ReticleEvent;
/**
 * The event as the SDK stamps it while a driven action is active: `actionId` plus the tier that
 * link is worth. Set together, exactly as `core/messages.ts` says they are.
 */
const stamped = (e: ReticleEvent, actionId: string): ReticleEvent => ({
  ...e,
  actionId,
  attribution: EventAttribution.WINDOW,
});

describe('traceLineage — what was observed', () => {
  it('finds the state change that set the value, and marks it observed', () => {
    const out = traceLineage([state(100, 'user.profile.name', 'Alice')], {
      path: 'user.profile.name',
    });
    expect(out.found).toBe(true);
    expect(out.chain[0]?.observed).toBe(true);
    expect(out.chain[0]?.text).toContain('user.profile.name');
  });

  it('says plainly when the path never changed, rather than returning an empty chain', () => {
    // An empty answer reads as "no lineage"; the truth is "this path was never seen to change",
    // which is a different thing an agent should act on differently.
    const out = traceLineage([state(100, 'cart.total', 3)], { path: 'user.name' });
    expect(out.found).toBe(false);
    expect(String(out.note)).toMatch(/never seen to change|no state change/i);
  });

  it('narrows on value when one is given, because a path can change more than once', () => {
    const events = [state(100, 'status', 'loading'), state(200, 'status', 'ready')];
    const out = traceLineage(events, { path: 'status', value: 'ready' });
    expect(out.chain[0]?.text).toContain('ready');
  });
});

describe('traceLineage — what was inferred, and how it says so', () => {
  it('names a single preceding signal as LIKELY, never as fact', () => {
    const out = traceLineage([signal(90, 'USER_FETCH_SUCCESS'), state(100, 'user.name', 'Alice')], {
      path: 'user.name',
    });
    const link = out.chain[1];
    expect(link?.observed, 'a join is not an observation').toBe(false);
    expect(link?.text).toContain('USER_FETCH_SUCCESS');
    expect(link?.text).toMatch(/likely/i);
  });

  it('names EVERY candidate when the join is ambiguous, and resolves none of them', () => {
    // The prior art picks the most recent. That is the decision this tool exists not to make.
    const out = traceLineage(
      [
        signal(80, 'PROFILE_LOADED'),
        signal(90, 'USER_FETCH_SUCCESS'),
        state(100, 'user.name', 'A'),
      ],
      { path: 'user.name' },
    );
    const link = out.chain[1];
    expect(link?.candidates).toEqual(['PROFILE_LOADED', 'USER_FETCH_SUCCESS']);
    expect(link?.text).toMatch(/2 candidates|ambiguous/i);
    // The failure mode: quietly picking one and presenting it as the answer.
    expect(link?.text).not.toMatch(/^← USER_FETCH_SUCCESS$/);
  });

  it('reaches for nothing when no signal preceded the change', () => {
    const out = traceLineage([state(100, 'user.name', 'Alice')], { path: 'user.name' });
    expect(out.chain).toHaveLength(1);
    expect(String(out.note)).toMatch(/not seen to pass through/i);
  });

  it('does not attribute a signal that fired AFTER the value changed', () => {
    // Causality runs one way. A later signal cannot have produced an earlier value.
    const out = traceLineage(
      [state(100, 'user.name', 'Alice'), signal(150, 'USER_FETCH_SUCCESS')],
      { path: 'user.name' },
    );
    expect(out.chain).toHaveLength(1);
  });

  it('carries the request behind the signal, also as an inference', () => {
    const out = traceLineage(
      [
        net(50, 'GET', '/api/user/1', 200),
        signal(90, 'USER_FETCH_SUCCESS'),
        state(100, 'user.name', 'A'),
      ],
      { path: 'user.name' },
    );
    expect(out.chain).toHaveLength(3);
    expect(out.chain[2]?.observed).toBe(false);
    expect(out.chain[2]?.text).toContain('/api/user/1');
  });
});

describe('traceLineage renders a block a reader can scan', () => {
  it('reads top-down from the value to its cause', () => {
    const out = traceLineage(
      [
        net(50, 'GET', '/api/user/1', 200),
        signal(90, 'USER_FETCH_SUCCESS'),
        state(100, 'user.name', 'Alice'),
      ],
      { path: 'user.name' },
    );
    const text = out.chain.map((l) => l.text).join('\n');
    expect(text.indexOf('user.name')).toBeLessThan(text.indexOf('USER_FETCH_SUCCESS'));
    expect(text.indexOf('USER_FETCH_SUCCESS')).toBeLessThan(text.indexOf('/api/user/1'));
  });
});

describe('traceLineage reads the attribution the SDK already stamped', () => {
  // Every event observed while a driven action is active carries that action's id, at `window`
  // tier — the same tier, already computed, already labelled, and narrower than a fresh five-second
  // look-back. The tool used to read only the look-back. These pin what changes when it reads both.

  it('does not offer a candidate stamped with a DIFFERENT act as ambiguity for this one', () => {
    // Five seconds spans several driven acts. Two signals in the window, but the change carries
    // `a7` and one of the signals carries `a6`: the ambiguity was never real — "timing alone cannot
    // choose" is true, and the stamp already had. Reporting two candidates here manufactures an
    // ambiguity the tool is holding the resolution to.
    const out = traceLineage(
      [
        stamped(signal(80, 'PREVIOUS_CLICK_DONE'), 'a6'),
        stamped(signal(90, 'CART_UPDATED'), 'a7'),
        stamped(state(100, 'cart.total', 1499), 'a7'),
      ],
      { path: 'cart.total' },
    );
    const link = out.chain[1];
    expect(link?.text).toContain('CART_UPDATED');
    expect(link?.text).not.toContain('PREVIOUS_CLICK_DONE');
    expect(link?.candidates, 'one candidate is not an ambiguity').toBeUndefined();
  });

  it('keeps an UNSTAMPED candidate — the stamp rules out, it never rules in', () => {
    // A request fired just before dispatch carries no stamp, and its response can land inside the
    // act. The stamp proves an event belongs to ANOTHER act; it cannot prove an unstamped one is
    // unrelated. So the look-back still applies to unstamped candidates, and this stays ambiguous.
    const out = traceLineage(
      [
        signal(85, 'PREFETCH_DONE'),
        stamped(signal(90, 'CART_UPDATED'), 'a7'),
        stamped(state(100, 'cart.total', 1499), 'a7'),
      ],
      { path: 'cart.total' },
    );
    expect(out.chain[1]?.candidates).toEqual(['PREFETCH_DONE', 'CART_UPDATED']);
  });

  it('names the act a stamped change is attributed to when no signal fired, instead of "not in evidence"', () => {
    // The common case, not the edge case: `reticle.signal()` is a call the APP must make, so on
    // most apps no signal ever fires. The tool then said the cause was "not in evidence" — a
    // factual claim, and false whenever the change carries the id of the act Reticle dispatched.
    // The cause IS in evidence, at window tier, which is the only tier there is.
    const out = traceLineage([stamped(state(100, 'cart.total', 1499), 'a7')], {
      path: 'cart.total',
    });
    expect(out.chain).toHaveLength(2);
    const link = out.chain[1];
    expect(link?.kind).toBe('act');
    expect(link?.observed, 'window tier is a heuristic, not an observation').toBe(false);
    expect(link?.text).toContain('a7');
    expect(link?.text).toMatch(/window/i);
    expect(String(out.note)).not.toMatch(/not in evidence/i);
  });

  it('carries the request behind a driven change through the act, filtered by the same stamp', () => {
    const out = traceLineage(
      [
        stamped(net(40, 'POST', '/api/previous', 200), 'a6'),
        stamped(net(60, 'POST', '/api/cart/add', 200), 'a7'),
        stamped(state(100, 'cart.total', 1499), 'a7'),
      ],
      { path: 'cart.total' },
    );
    expect(out.chain).toHaveLength(3);
    expect(out.chain[1]?.kind).toBe('act');
    expect(out.chain[2]?.kind).toBe('net');
    expect(out.chain[2]?.text).toContain('/api/cart/add');
    expect(out.chain[2]?.text).not.toContain('/api/previous');
  });

  it('leaves an ambient change exactly as it was — the look-back is the right tool for that', () => {
    // No stamp on the change means nothing was driving, so there is nothing to filter by and
    // nothing to attribute to. This is the case `CAUSE_WINDOW_MS` fits, and it is unchanged.
    const out = traceLineage([stamped(signal(90, 'SOMEONE_ELSES'), 'a6'), state(100, 'x', 1)], {
      path: 'x',
    });
    expect(out.chain[1]?.text).toContain('SOMEONE_ELSES');
    const bare = traceLineage([state(100, 'x', 1)], { path: 'x' });
    expect(bare.chain).toHaveLength(1);
    expect(String(bare.note)).toMatch(/not seen to pass through/i);
  });
});
