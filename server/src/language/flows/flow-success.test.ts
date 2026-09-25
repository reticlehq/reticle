import { describe, expect, it } from 'vitest';
import { EventType, type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { assertSuccess, dynamicTestids } from './flow-success.js';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import type { FlowReplaySession } from './flow-replay.js';

/** Minimal session: scripted events drive signal/net predicates; QUERY answers element presence. */
function session(events: ReticleEvent[], elementPresent = true): FlowReplaySession {
  return {
    command: (name): Promise<CommandResult> =>
      Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: 'query' === name ? { elements: elementPresent ? [{ ref: 'e1' }] : [] } : {},
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

describe('assertSuccess — green only when the consequence holds', () => {
  it('passes when the success signal fires', async () => {
    const r = await assertSuccess(
      session([sig('checkout-done')]),
      { kind: 'signal', name: 'checkout-done' },
      NONE,
      waitForPredicate,
      FAST,
    );
    expect(r.pass).toBe(true);
  });

  it('FAILS when the success signal never fires (broken Pay-now: steps green, consequence absent)', async () => {
    const r = await assertSuccess(
      session([]),
      { kind: 'signal', name: 'checkout-done' },
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
      { kind: 'element', query: { testid: 'cap' } },
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
      (
        await assertSuccess(
          filtering,
          { kind: 'signal', name: 'done' },
          NONE,
          waitForPredicate,
          0,
          0,
        )
      ).pass,
    ).toBe(true);
    // floor 20 (this replay started after the stale signal) → excluded, so it FAILS.
    expect(
      (
        await assertSuccess(
          filtering,
          { kind: 'signal', name: 'done' },
          NONE,
          waitForPredicate,
          0,
          20,
        )
      ).pass,
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
