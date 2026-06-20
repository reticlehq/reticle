import { describe, expect, it } from 'vitest';
import { ReplayStatus, RunFlowStatus, type FlowReplayResult } from '@syrin/iris-protocol';
import { mapReplayToFlowResult, runFlowStatusOf } from './replay-mapping.js';

const replay = (status: ReplayStatus, extra?: Partial<FlowReplayResult>): FlowReplayResult => ({
  name: 'checkout',
  status,
  steps: [],
  ...extra,
});

describe('runFlowStatusOf', () => {
  it('OK → PASS, DRIFT and ERROR → FAIL', () => {
    expect(runFlowStatusOf(ReplayStatus.OK)).toBe(RunFlowStatus.PASS);
    expect(runFlowStatusOf(ReplayStatus.DRIFT)).toBe(RunFlowStatus.FAIL);
    expect(runFlowStatusOf(ReplayStatus.ERROR)).toBe(RunFlowStatus.FAIL);
  });
});

describe('mapReplayToFlowResult', () => {
  it('a passing replay maps to PASS with no failureReason', () => {
    const r = mapReplayToFlowResult(replay(ReplayStatus.OK), 12);
    expect(r.status).toBe(RunFlowStatus.PASS);
    expect(r.durationMs).toBe(12);
    expect(r.failureReason).toBeUndefined();
  });

  it('a drift lifts whatChanged into failureReason', () => {
    const r = mapReplayToFlowResult(
      replay(ReplayStatus.DRIFT, {
        decision: {
          verdict: 'drift',
          summary: 'drifted',
          whatChanged: 'anchor gone',
          nextAction: 'rebind',
        },
      }),
      5,
    );
    expect(r.status).toBe(RunFlowStatus.FAIL);
    expect(r.failureReason).toBe('anchor gone');
  });

  it('an error with no decision falls back to the error message', () => {
    const r = mapReplayToFlowResult(
      replay(ReplayStatus.ERROR, { error: { code: 'e', message: 'boom' } }),
      0,
    );
    expect(r.status).toBe(RunFlowStatus.FAIL);
    expect(r.failureReason).toBe('boom');
  });
});
