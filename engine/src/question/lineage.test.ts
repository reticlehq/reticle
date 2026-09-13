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
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { traceLineage } from './lineage.js';

const state = (t: number, path: string, value: unknown): ReticleEvent =>
  ({ type: EventType.STATE_CHANGE, t, data: { path, value } }) as unknown as ReticleEvent;
const signal = (t: number, name: string): ReticleEvent =>
  ({ type: EventType.SIGNAL, t, data: { name } }) as unknown as ReticleEvent;
const net = (t: number, method: string, url: string, status: number): ReticleEvent =>
  ({ type: EventType.NET_REQUEST, t, data: { method, url, status } }) as unknown as ReticleEvent;

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
