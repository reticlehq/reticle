import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  DriftReason,
  FLOW_FILE_VERSION,
  ReplayStatus,
  RUN_TEXT_MAX,
  RunFlowResultSchema,
  RunFlowStatus,
  type FlowFile,
  type FlowReplayResult,
} from '@reticlehq/core';
import { mapReplayToFlowResult, runFlowStatusOf } from './replay-mapping.js';

const replay = (status: ReplayStatus, extra?: Partial<FlowReplayResult>): FlowReplayResult => ({
  name: 'checkout',
  status,
  steps: [],
  ...extra,
});

describe('runFlowStatusOf', () => {
  it('OK → PASS, DRIFT and ERROR → FAIL, UNVERIFIABLE → SKIPPED', () => {
    expect(runFlowStatusOf(ReplayStatus.OK)).toBe(RunFlowStatus.PASS);
    expect(runFlowStatusOf(ReplayStatus.DRIFT)).toBe(RunFlowStatus.FAIL);
    expect(runFlowStatusOf(ReplayStatus.ERROR)).toBe(RunFlowStatus.FAIL);
    expect(runFlowStatusOf(ReplayStatus.UNVERIFIABLE)).toBe(RunFlowStatus.SKIPPED);
  });
});

describe('mapReplayToFlowResult', () => {
  it('a passing replay maps to PASS with no failureReason', () => {
    const r = mapReplayToFlowResult(replay(ReplayStatus.OK), 12);
    expect(r.status).toBe(RunFlowStatus.PASS);
    expect(r.durationMs).toBe(12);
    expect(r.failureReason).toBeUndefined();
  });

  // A replay that could not run (unsupplied secret, unmet precondition) comes back status OK with no
  // steps. Mapped to PASS, `reticle gate` counted a flow that exercised nothing as covering its files.
  it('a replay that ran nothing is SKIPPED with its reason, never PASS', () => {
    const r = mapReplayToFlowResult(
      replay(ReplayStatus.OK, { unverifiable: { reason: 'set RETICLE_SECRET_PASSWORD' } }),
      3,
    );
    expect(r.status).toBe(RunFlowStatus.SKIPPED);
    expect(r.failureReason).toBe('set RETICLE_SECRET_PASSWORD');
  });

  it('an unverifiable replay maps to SKIPPED with failureReason preserved', () => {
    const r = mapReplayToFlowResult(
      replay(ReplayStatus.UNVERIFIABLE, {
        unverifiable: { reason: 'precondition unmet' },
      }),
      10,
    );
    expect(r.status).toBe(RunFlowStatus.SKIPPED);
    expect(r.failureReason).toBe('precondition unmet');
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

  it('surfaces the oracle label when the replay asserted a success consequence', () => {
    const r = mapReplayToFlowResult(
      replay(ReplayStatus.OK, {
        steps: [
          { step: 0, tool: 'reticle_act', anchor: 'login-submit', ok: true },
          { step: 1, tool: 'success', anchor: 'auth:granted', ok: true },
        ],
      }),
      9,
    );
    expect(r.status).toBe(RunFlowStatus.PASS);
    expect(r.oracle).toBe('auth:granted');
  });

  it('leaves oracle undefined for an action-only (smoke) replay', () => {
    const r = mapReplayToFlowResult(
      replay(ReplayStatus.OK, {
        steps: [{ step: 0, tool: 'reticle_act', anchor: 'nav-compose', ok: true }],
      }),
      4,
    );
    expect(r.oracle).toBeUndefined();
  });
});

describe('what a synced run carries so a teammate can replay it', () => {
  const flow: FlowFile = {
    version: FLOW_FILE_VERSION,
    name: 'checkout',
    createdAt: 0,
    startPath: '/cart',
    steps: [{ tool: 'act', anchor: { kind: AnchorKind.TESTID, value: 'pay' }, page: '/cart' }],
  };

  it("carries each step's result and the pages it ran on and led to", () => {
    const r = mapReplayToFlowResult(
      replay(ReplayStatus.DRIFT, {
        steps: [
          { step: 0, anchor: 'pay', ok: true, page: '/cart', endPage: '/done' },
          {
            step: 1,
            anchor: 'receipt',
            ok: false,
            drift: {
              reasonKind: DriftReason.TESTID_NOT_FOUND,
              reason: 'gone',
              anchor: 'receipt',
              nearest: null,
            },
          },
        ],
      }),
      5,
      flow,
    );
    expect(r.stepResults).toEqual([
      { step: 0, anchor: 'pay', ok: true, page: '/cart', endPage: '/done' },
      { step: 1, anchor: 'receipt', ok: false, drift: DriftReason.TESTID_NOT_FOUND },
    ]);
    expect(r.recording).toEqual({ startPath: '/cart', steps: flow.steps });
  });

  it('stays bounded: long text is clipped, a huge recording is omitted and says so', () => {
    const huge: FlowFile = {
      ...flow,
      steps: Array.from({ length: 2000 }, (_, i) => ({
        tool: 'act',
        anchor: { kind: AnchorKind.TESTID, value: `row-${String(i)}-${'x'.repeat(40)}` },
      })),
    };
    const r = mapReplayToFlowResult(
      replay(ReplayStatus.ERROR, {
        steps: [{ step: 0, anchor: 'a', ok: false, error: 'e'.repeat(5000) }],
      }),
      5,
      huge,
    );
    expect(r.stepResults?.[0]?.error?.length).toBe(RUN_TEXT_MAX);
    expect(r.recording).toBeUndefined();
    expect(r.recordingOmitted).toBe(true);
    expect(RunFlowResultSchema.safeParse(r).success).toBe(true);
  });
});
