/**
 * A step whose consequence could not be DECIDED is not a step whose consequence failed.
 *
 * Reported from the field: a text check passed when the flow was driven, then came back on replay as
 * drift ("failed"), with the reason "the page's SDK did not return the whole text". The text sat in a
 * panel with its own scroll area, below that panel's fold, and the app was correct. The predicate had
 * already said "inconclusive"; replay read only `pass: false` and called it a consequence that did
 * not hold. A correct app reported as failed is a false verdict.
 */
import { describe, expect, it } from 'vitest';
import { DriftReason, ReplayStatus, type FlowStepResult } from '@reticlehq/core';
import { assertStepExpect } from './flow-replay.js';
import { staleTargetResult } from './flow-step-runners.js';
import type { FlowReplaySession, WaitForSignal } from './flow-replay-types.js';

const BUDGET_MS = 10;
const CUT_SHORT =
  'the page\'s SDK did not return the whole text of {"text":"Kalyani Nagar"}, so a property of it was not decided';

const session: FlowReplaySession = {
  command: () => Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} }),
  eventsSince: () => [],
  onEvent: () => () => undefined,
  elapsed: () => 0,
};

const undecided: WaitForSignal = () =>
  Promise.resolve({ pass: false, failureReason: CUT_SHORT, inconclusive: CUT_SHORT });
const failed: WaitForSignal = () =>
  Promise.resolve({ pass: false, failureReason: 'no element has text "Kalyani Nagar"' });

describe('a step expect the page could not decide', () => {
  it('is reported as undecided, with the reason, not as a consequence that did not hold', async () => {
    const drift = await assertStepExpect(
      session,
      { kind: 'text', contains: 'Kalyani Nagar' },
      undecided,
      BUDGET_MS,
      0,
    );
    expect(drift?.reasonKind).toBe(DriftReason.EXPECT_UNDECIDED);
    expect(drift?.reason).toContain('did not return the whole text');
  });

  it('a decided miss is still a failure', async () => {
    const drift = await assertStepExpect(
      session,
      { kind: 'text', contains: 'Kalyani Nagar' },
      failed,
      BUDGET_MS,
      0,
    );
    expect(drift?.reasonKind).toBe(DriftReason.SIGNAL_NOT_OBSERVED);
  });
});

function step(index: number, reasonKind?: DriftReason): FlowStepResult {
  if (reasonKind === undefined) {
    return { step: index, tool: 'reticle_act', anchor: `a${String(index)}`, ok: true };
  }
  return {
    step: index,
    tool: 'reticle_act',
    anchor: `a${String(index)}`,
    ok: false,
    drift: { reasonKind, reason: 'r', anchor: `a${String(index)}`, nearest: null },
  };
}

describe('the replay of a flow with an undecided step', () => {
  it('is unverifiable, not drift', () => {
    const result = staleTargetResult('f', [step(0), step(1, DriftReason.EXPECT_UNDECIDED)]);
    expect(result?.status).toBe(ReplayStatus.UNVERIFIABLE);
    expect(result?.unverifiable?.reason).toContain('step 1');
  });

  it('stays drift when another step really failed', () => {
    const result = staleTargetResult('f', [
      step(0, DriftReason.EXPECT_UNDECIDED),
      step(1, DriftReason.SIGNAL_NOT_OBSERVED),
    ]);
    expect(result).toBeUndefined();
  });
});
