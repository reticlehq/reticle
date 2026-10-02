/**
 * A request that has not come back yet is a BLIND SPOT, not a signal that never fired.
 *
 * Reported from the field: a replayed step declaring `expect.net` against a slow endpoint came back
 * as `signal_not_observed`, which reads as "the thing you asserted never happened" and sends a
 * reader hunting a feature that works. The live verdict path already draws this distinction — a
 * named request still on the wire when the budget ends is not graded as a failed assertion — and
 * the replay path simply never asked the question.
 */

import { describe, expect, it } from 'vitest';
import { DriftReason, EventType, type ReticleEvent } from '@reticlehq/core';
import { assertStepExpect } from './flow-replay.js';
import type { FlowReplaySession, WaitForSignal } from './flow-replay-types.js';

const BUDGET_MS = 10;

/** A step window holding exactly the events a test hands it — nothing else replay reads here. */
function sessionWith(events: ReticleEvent[]): FlowReplaySession {
  return {
    command: () => Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} }),
    eventsSince: () => events,
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

function netPending(method: string, url: string, id: string): ReticleEvent {
  return {
    type: EventType.NET_PENDING,
    t: 0,
    data: { id, method, url, initiator: 'fetch' },
  } as unknown as ReticleEvent;
}

/** The budget ran out: whatever the window holds, the predicate is not satisfied. */
const missed: WaitForSignal = () =>
  Promise.resolve({ pass: false, failureReason: 'no request matching /api/save' });

describe('a net expect whose request is still on the wire', () => {
  it('is reported as in flight, not as a signal that never fired', async () => {
    const drift = await assertStepExpect(
      sessionWith([netPending('POST', 'https://app.test/api/save', 'r-1')]),
      { kind: 'net', urlContains: '/api/save', method: 'POST' },
      missed,
      BUDGET_MS,
      0,
    );
    expect(drift?.reasonKind).toBe(DriftReason.NET_STILL_IN_FLIGHT);
    expect(drift?.reason).toContain('POST https://app.test/api/save');
  });

  it('an unrelated open request does not pardon one that never started', async () => {
    const drift = await assertStepExpect(
      sessionWith([netPending('GET', 'https://app.test/api/poll', 'r-2')]),
      { kind: 'net', urlContains: '/api/save', method: 'POST' },
      missed,
      BUDGET_MS,
      0,
    );
    expect(drift?.reasonKind).toBe(DriftReason.SIGNAL_NOT_OBSERVED);
  });

  it('a signal expect is unaffected', async () => {
    const drift = await assertStepExpect(
      sessionWith([netPending('POST', 'https://app.test/api/save', 'r-3')]),
      { kind: 'signal', name: 'order:placed' },
      missed,
      BUDGET_MS,
      0,
    );
    expect(drift?.reasonKind).toBe(DriftReason.SIGNAL_NOT_OBSERVED);
  });
});
