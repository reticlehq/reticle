import { describe, expect, it } from 'vitest';
import { EventType, type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { assertSuccess, successToPredicate, dynamicTestids } from './flow-success.js';
import { waitForPredicate } from '../events/predicate.js';
import type { FlowReplaySession } from './flow-replay.js';

/** Minimal session: scripted events drive signal/net predicates; QUERY answers element presence. */
function session(events: ReticleEvent[], elementPresent = true): FlowReplaySession {
  return {
    command: (name): Promise<CommandResult> =>
      Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: name === 'query' ? { elements: elementPresent ? [{ ref: 'e1' }] : [] } : {},
      } as CommandResult),
    eventsSince: () => events,
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

const FAST = 40;
const NONE = new Set<string>();
const sig = (name: string): ReticleEvent => ({
  t: 1,
  type: EventType.SIGNAL,
  sessionId: 's',
  data: { name },
});

describe('successToPredicate', () => {
  it('compiles a signal success', () => {
    expect(successToPredicate({ signal: 'order:placed' }, NONE)).toEqual({
      kind: 'signal',
      name: 'order:placed',
    });
  });

  it('skips a dynamic-marked element testid (presence-only → vacuously met)', () => {
    expect(
      successToPredicate({ element: { testid: 'caption' } }, new Set(['caption'])),
    ).toBeUndefined();
  });

  it('combines multiple fields with allOf', () => {
    const p = successToPredicate({ signal: 's', net: { urlContains: '/api' } }, NONE);
    expect(p?.kind).toBe('allOf');
  });

  it('a net WITHOUT count stays a bare presence predicate (wait-until-true)', () => {
    expect(successToPredicate({ net: { urlContains: '/api/deploy' } }, NONE)).toEqual({
      kind: 'net',
      urlContains: '/api/deploy',
    });
  });

  it('net.count gates on `settled` so a double-submit cannot pass on the first transient match', () => {
    // The cardinality read must happen AFTER the network quiets, else exact count:1 is satisfied the
    // instant the first request lands (before a duplicate). settled + net is the post-settle gate.
    expect(
      successToPredicate({ net: { method: 'POST', urlContains: '/api/deploy', count: 1 } }, NONE),
    ).toEqual({
      kind: 'allOf',
      predicates: [
        { kind: 'settled' },
        { kind: 'net', method: 'POST', urlContains: '/api/deploy', count: 1 },
      ],
    });
  });

  it('console.absent gates on `settled` (a clean-console assertion is post-settle)', () => {
    // Same post-settle reasoning as net.count: an absent assertion is satisfied at the first poll
    // (no error yet) before the action's error fires, so it must be read only after the page quiets.
    expect(successToPredicate({ console: { level: 'error', absent: true } }, NONE)).toEqual({
      kind: 'allOf',
      predicates: [{ kind: 'settled' }, { kind: 'console', level: 'error', absent: true }],
    });
  });

  it('a console PRESENCE assertion (no absent) stays a bare wait-until-true predicate', () => {
    expect(successToPredicate({ console: { level: 'warn' } }, NONE)).toEqual({
      kind: 'console',
      level: 'warn',
    });
  });

  it('a state INVARIANT (hold:true) gates on `settled` so a side-effect leak cannot pass early', () => {
    // Without the gate, "deployments.0.status == live" is true the instant replay starts (before a
    // blast-radius side-effect moves it), so a wait-until-true read passes. settled forces post-settle.
    expect(
      successToPredicate(
        { state: { store: 'app', path: 'deployments.0.status', equals: 'live', hold: true } },
        NONE,
      ),
    ).toEqual({
      kind: 'allOf',
      predicates: [
        { kind: 'settled' },
        { kind: 'state', store: 'app', path: 'deployments.0.status', equals: 'live' },
      ],
    });
  });

  it('compiles a state-truth success end-condition', () => {
    expect(
      successToPredicate(
        { state: { store: 'app', path: 'deployments.0.status', equals: 'live' } },
        NONE,
      ),
    ).toEqual({ kind: 'state', store: 'app', path: 'deployments.0.status', equals: 'live' });
  });

  it('compiles a presence-only state success (no equals → assert the path resolves)', () => {
    expect(successToPredicate({ state: { path: 'cart.items' } }, NONE)).toEqual({
      kind: 'state',
      path: 'cart.items',
    });
  });
});

describe('assertSuccess — green only when the consequence holds', () => {
  it('passes when the success signal fires', async () => {
    const r = await assertSuccess(
      session([sig('checkout-done')]),
      { signal: 'checkout-done' },
      NONE,
      waitForPredicate,
      FAST,
    );
    expect(r.pass).toBe(true);
  });

  it('FAILS when the success signal never fires (broken Pay-now: steps green, consequence absent)', async () => {
    const r = await assertSuccess(
      session([]),
      { signal: 'checkout-done' },
      NONE,
      waitForPredicate,
      FAST,
    );
    expect(r.pass).toBe(false);
  });

  it('is vacuously met when no success is declared', async () => {
    const r = await assertSuccess(session([]), undefined, NONE, waitForPredicate, FAST);
    expect(r.pass).toBe(true);
  });

  it('is vacuously met when the only success field is dynamic-skipped', async () => {
    const r = await assertSuccess(
      session([]),
      { element: { testid: 'cap' } },
      new Set(['cap']),
      waitForPredicate,
      FAST,
    );
    expect(r.pass).toBe(true);
  });

  it('honors the since floor: a success signal from a PRIOR replay does not fake a pass', async () => {
    // A success signal fired at t=10 (a previous replay / the pre-heal drift replay's prefix).
    const filtering: FlowReplaySession = {
      command: () => Promise.resolve({ kind: 'command_result', id: 'q', ok: true, result: {} }),
      eventsSince: (cursor: number) =>
        [{ t: 10, type: EventType.SIGNAL, sessionId: 's', data: { name: 'done' } }].filter(
          (e) => e.t >= cursor,
        ),
      onEvent: () => () => undefined,
      elapsed: () => 1000,
    };
    // floor 0 (whole buffer) → the stale signal matches (legacy behavior).
    expect(
      (await assertSuccess(filtering, { signal: 'done' }, NONE, waitForPredicate, 0, 0)).pass,
    ).toBe(true);
    // floor 20 (this replay started after the stale signal) → excluded, so it FAILS.
    expect(
      (await assertSuccess(filtering, { signal: 'done' }, NONE, waitForPredicate, 0, 20)).pass,
    ).toBe(false);
  });
});

describe('dynamicTestids', () => {
  it('collects testid anchors from flow.dynamic', () => {
    const set = dynamicTestids({
      version: 1,
      name: 'f',
      createdAt: 0,
      steps: [],
      dynamic: [{ kind: 'testid', value: 'cap' }],
    });
    expect(set.has('cap')).toBe(true);
  });
});
