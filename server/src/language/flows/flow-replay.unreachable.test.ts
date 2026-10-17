/**
 * A replayed step on a target a person could not reach is undecided, as a live act is (night 7b).
 *
 * Night 7a made act_and_wait and act steps answer `unknown` on a covered, 0×0 or off-screen target:
 * synthetic dispatch reaches it, so the consequence can hold where no person could have caused it.
 * Flow replay graded the same click with the old rule, and `nav-deployments-occluded` replayed green.
 */
import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  DriftReason,
  FLOW_FILE_VERSION,
  ReplayStatus,
  ReticleCommand,
  ReticleTool,
  asRef,
  asString,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { partialStatus, replayFlow, type FlowReplaySession } from './flow-replay.js';
import { replayVerdictEffect } from './flow-result.js';
import { unreachableTargetResult } from './flow-step-runners.js';

/** One testid resolves; the act on it reports `effect`. */
function session(effect: Record<string, unknown>): FlowReplaySession {
  return {
    command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
      const testid = asString(args['value']) ?? '';
      const result =
        ReticleCommand.QUERY === name
          ? {
              elements: [
                {
                  ref: asRef(`e-${testid}`),
                  role: 'link',
                  name: testid,
                  states: [],
                  visible: true,
                },
              ],
            }
          : ReticleCommand.ACT === name
            ? { dispatched: true, settled: true, effect }
            : {};
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

const FLOW: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: 'open-deployments',
  createdAt: 0,
  steps: [
    {
      tool: ReticleTool.ACT,
      anchor: { kind: AnchorKind.TESTID, value: 'nav-deployments' },
      action: ActionType.CLICK,
      args: {},
    },
  ],
};

async function replay(effect: Record<string, unknown>) {
  const steps = await replayFlow(session(effect), FLOW, waitForPredicate, 60);
  return { steps, verified: replayVerdictEffect(FLOW.name, partialStatus(steps), false).verified };
}

describe('a replayed click a person could not have made', () => {
  it('is undecided when the target is covered, naming what covers it', async () => {
    const { steps, verified } = await replay({ occluded: true, occluderName: 'div' });
    expect(steps[0]?.drift?.reasonKind).toBe(DriftReason.TARGET_UNREACHABLE);
    expect(steps[0]?.drift?.reason).toContain('covered by div');
    expect(verified).toBe('unknown');
  });

  it('is undecided when the target has no size, or stayed off screen', async () => {
    expect((await replay({ noSize: true })).verified).toBe('unknown');
    expect((await replay({ scrolledIntoView: true, offViewport: true })).verified).toBe('unknown');
  });

  it('still passes on a target a person could click', async () => {
    const { steps, verified } = await replay({});
    expect(steps[0]?.drift).toBeUndefined();
    expect(verified).toBe('yes');
  });
});

// Live (night 7b): the suite read that drift as a failed flow, "Reticle result: failed", a false no.
describe('a replay stopped on a click no person could make', () => {
  it('is undecided as a whole, giving the cause, never a failed flow', async () => {
    const { steps } = await replay({ occluded: true, occluderName: 'div' });
    const result = unreachableTargetResult(FLOW.name, steps);
    expect(result?.status).toBe(ReplayStatus.UNVERIFIABLE);
    expect(result?.unverifiable?.reason).toContain('covered by div');
  });

  it('leaves a replay a person could have made as it was', async () => {
    const { steps } = await replay({});
    expect(unreachableTargetResult(FLOW.name, steps)).toBeUndefined();
  });
});
