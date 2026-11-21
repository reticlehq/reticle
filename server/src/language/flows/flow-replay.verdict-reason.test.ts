/**
 * Every `reticle_flow_replay` verdict names the clause that decided it (#2205).
 *
 * `reticle_assert` and `reticle_act_and_wait` answer with `verifiedReason`. A replay answered with a
 * status only, so a caller that reads the reason to choose its next step got nothing, and the
 * `verification_completed` event for a replay had no `reason` to group by.
 */
import { describe, expect, it } from 'vitest';
import {
  ContradictionKind,
  ReplayStatus,
  ReticleTool,
  VerifiedReason,
  type Contradiction,
  type FlowReplayResult,
} from '@reticlehq/core';
import { DocumentLostDuringReplay } from './flow-replay.js';
import { lostDocumentResult } from './flow-replay-run.js';
import { replayVerifiedReason, withReplayReason } from './flow-result.js';
import { verificationOf } from '@/telemetry/verification-of.js';
import { SUCCESS_STEP_TOOL } from './flow-success.js';
import { Verified } from '@reticlehq/core';

const REASONS: readonly string[] = Object.values(VerifiedReason);

const replay = (status: ReplayStatus, extra: Partial<FlowReplayResult> = {}): FlowReplayResult => ({
  name: 'checkout',
  status,
  steps: [],
  ...extra,
});

const disagreement: Contradiction = {
  kind: ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
  claim: 'the order was placed',
  counter: 'POST /api/order -> 500',
  detail: 'the page moved on after the request failed',
};

describe('a replay verdict carries its reason', () => {
  it('gives every replay status a reason from the shared set', () => {
    for (const status of Object.values(ReplayStatus)) {
      const answer = withReplayReason(replay(status));
      expect(REASONS, `status ${status}`).toContain(answer.verifiedReason);
    }
  });

  it('a clean replay of a flow that can fail is proved', () => {
    expect(replayVerifiedReason(replay(ReplayStatus.OK))).toBe(VerifiedReason.PROVED);
  });

  it('a clean replay of a flow that asserts nothing declared nothing', () => {
    const cannotFail = replay(ReplayStatus.OK, { unverifiable: { reason: 'asserts nothing' } });
    expect(replayVerifiedReason(cannotFail)).toBe(VerifiedReason.NOTHING_DECLARED);
  });

  it('a clean replay whose channels disagreed is contradicted, on a step or across steps', () => {
    const onStep = replay(ReplayStatus.OK, {
      steps: [{ step: 0, anchor: 'pay', ok: true, contradictions: [disagreement] }],
    });
    const acrossSteps = replay(ReplayStatus.OK, { crossStep: [disagreement] });
    expect(replayVerifiedReason(onStep)).toBe(VerifiedReason.CONTRADICTED);
    expect(replayVerifiedReason(acrossSteps)).toBe(VerifiedReason.CONTRADICTED);
  });

  it('a drift is a declared consequence that did not hold', () => {
    expect(replayVerifiedReason(replay(ReplayStatus.DRIFT))).toBe(VerifiedReason.ASSERTION_FAILED);
  });

  it('an error and an ungraded run were never evaluated', () => {
    expect(replayVerifiedReason(replay(ReplayStatus.ERROR))).toBe(VerifiedReason.INCONCLUSIVE);
    expect(replayVerifiedReason(replay(ReplayStatus.UNVERIFIABLE))).toBe(
      VerifiedReason.INCONCLUSIVE,
    );
  });

  it('a replay that lost its document says the observation was lost', () => {
    const lost = lostDocumentResult('checkout', new DocumentLostDuringReplay([], 1));
    expect(withReplayReason(lost).verifiedReason).toBe(VerifiedReason.OBSERVATION_LOST);
  });

  it('keeps the reason a replay path already named', () => {
    const named = replay(ReplayStatus.UNVERIFIABLE, {
      verifiedReason: VerifiedReason.OBSERVATION_LOST,
    });
    expect(withReplayReason(named).verifiedReason).toBe(VerifiedReason.OBSERVATION_LOST);
  });

  it('the verification event for each replay status has a reason', () => {
    for (const status of Object.values(ReplayStatus)) {
      const answer: Record<string, unknown> = { ...withReplayReason(replay(status)) };
      const sent = verificationOf(ReticleTool.FLOW_REPLAY, answer, 10);
      expect(REASONS, `status ${status}`).toContain(sent?.reason);
    }
  });
});

/* Review on #2241: a reason must not contradict what happened, or the verdict sent beside it. */
describe('a replay reason agrees with the evidence', () => {
  // The flow's `success` row was evaluated and did not hold: that is a failed assertion.
  it('a success condition that did not hold is assertion_failed, not inconclusive', () => {
    const failedSuccess = replay(ReplayStatus.ERROR, {
      steps: [
        { step: 0, anchor: 'pay', ok: true },
        {
          step: 1,
          tool: SUCCESS_STEP_TOOL,
          anchor: 'order:placed',
          ok: false,
          error: 'flow.success not satisfied',
        },
      ],
      error: { code: ReplayStatus.ERROR, message: 'flow.success not satisfied' },
    });
    expect(replayVerifiedReason(failedSuccess)).toBe(VerifiedReason.ASSERTION_FAILED);
  });

  it('an action that did not run stays inconclusive', () => {
    const failedAction = replay(ReplayStatus.ERROR, {
      steps: [{ step: 0, anchor: 'pay', ok: false, error: 'command act timed out' }],
    });
    expect(replayVerifiedReason(failedAction)).toBe(VerifiedReason.INCONCLUSIVE);
  });

  // decideVerified decides `contradicted` before `nothing_declared`; replay uses the same order.
  it('a contradiction outranks a flow that asserts nothing', () => {
    const both = replay(ReplayStatus.OK, {
      unverifiable: { reason: 'asserts nothing' },
      crossStep: [disagreement],
    });
    expect(replayVerifiedReason(both)).toBe(VerifiedReason.CONTRADICTED);
  });

  it.each([
    [VerifiedReason.PROVED, replay(ReplayStatus.OK), Verified.YES, true],
    [
      VerifiedReason.CONTRADICTED,
      replay(ReplayStatus.OK, { crossStep: [disagreement] }),
      Verified.NO,
      true,
    ],
    [
      VerifiedReason.NOTHING_DECLARED,
      replay(ReplayStatus.OK, { unverifiable: { reason: 'asserts nothing' } }),
      Verified.UNKNOWN,
      true,
    ],
    [VerifiedReason.ASSERTION_FAILED, replay(ReplayStatus.DRIFT), Verified.NO, false],
    [VerifiedReason.INCONCLUSIVE, replay(ReplayStatus.ERROR), Verified.UNKNOWN, false],
  ])(
    'the event for a %s replay sends a verdict that agrees with it',
    (reason, r, verified, passed) => {
      const sent = verificationOf(ReticleTool.FLOW_REPLAY, { ...withReplayReason(r) }, 10);
      expect(sent).toMatchObject({ reason, verified, passed });
    },
  );

  // A green that a channel refuted is the false green this product catches.
  it('a contradicted replay counts as a false green caught', () => {
    const r = withReplayReason(replay(ReplayStatus.OK, { crossStep: [disagreement] }));
    expect(verificationOf(ReticleTool.FLOW_REPLAY, { ...r }, 10)?.falseGreenCaught).toBe(true);
  });
});
