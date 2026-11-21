/**
 * A drive whose write request was blocked is not auto-saved as a flow (#2321).
 *
 * Reported from the field: an agent blocked a POST outside Reticle (its own interception) and drove
 * Save, so nothing was written. Session teardown saved the drive as a flow. The flow kept the click
 * and not the block, so its next replay sent the real POST, which is exactly what the agent had
 * avoided. From the page, a blocked write is a write request that failed at the network level:
 * `status: 0` with an error. Such a step is marked like a step run against mocks, and its journey
 * is left out of the auto-save.
 */
import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { driveFlowsFrom } from '@/memory/journal/drive-flow.js';
import { captureAct, wroteIn, WriteOutcome } from './replay.js';
import type { RecordedStep } from './recording/tape/recordings.js';

function request(data: Record<string, unknown>): ReticleEvent {
  return { type: EventType.NET_REQUEST, t: 1, data } as unknown as ReticleEvent;
}

const blockedPost = request({
  method: 'POST',
  url: 'http://localhost:3000/api/orders',
  status: 0,
  ok: false,
  error: 'TypeError: Failed to fetch',
});
const sentPost = request({
  method: 'POST',
  url: 'http://localhost:3000/api/orders',
  status: 201,
  ok: true,
});

/** Record one act the way the act tools do, and return the step the tape received. */
function recorded(wrote: WriteOutcome | undefined): RecordedStep {
  const steps: RecordedStep[] = [];
  captureAct(
    { active: () => [], capture: (step) => steps.push(step) },
    { ref: 'e4', action: 'click', until: { kind: 'route', path: '/orders/1' } },
    { ok: true, role: 'button', name: 'Save' },
    '/orders/new',
    'tab-1',
    wrote,
  );
  const [step] = steps;
  if (step === undefined) {
    throw new Error('nothing was captured');
  }
  return step;
}

describe('a write request that failed at the network level', () => {
  it('reads as blocked, not as an ordinary write', () => {
    expect(wroteIn([blockedPost])).toBe(WriteOutcome.BLOCKED);
    expect(wroteIn([sentPost])).toBe(WriteOutcome.SENT);
    expect(wroteIn([])).toBeUndefined();
  });

  it('keeps the step marked as a write, so a replay still names it', () => {
    expect(recorded(WriteOutcome.BLOCKED).writes).toBe(true);
  });

  it('keeps its journey out of the session-end auto-save', () => {
    const step = recorded(WriteOutcome.BLOCKED);
    const { programs, outcome } = driveFlowsFrom({ steps: [{ ...step, route: '/orders/new' }] });
    expect(programs, 'a flow was saved that would send the blocked POST for real').toEqual([]);
    expect(outcome.mockedSteps).toBe(1);
  });

  it('still auto-saves a journey whose write went through', () => {
    const step = recorded(WriteOutcome.SENT);
    const { programs } = driveFlowsFrom({ steps: [{ ...step, route: '/orders/new' }] });
    expect(programs).toHaveLength(1);
  });
});
