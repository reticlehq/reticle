/**
 * A replay that never reached a step decided nothing, so it is not a failure.
 *
 * Seen from the dashboard: "Run again" on a saved flow whose step 1 needs a task the fresh page did
 * not have. The anchor `toggle-3` was not found, nothing was clicked, and the pushed run read FAIL,
 * so Runs and the Inbox showed a failure for a journey that was never tested. A step that ran and
 * whose expectation did not hold is still a failure.
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
  RunFlowStatus,
  asRef,
  asString,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { staleTargetResult } from './flow-step-runners.js';
import { mapReplayToFlowResult } from '@/judgement/runs/artifact/replay-mapping.js';

/** A page where only the testids in `present` exist; every act on them runs. */
function page(present: readonly string[], survivors: readonly string[] = []): FlowReplaySession {
  return {
    command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
      const testid = asString(args['value']) ?? '';
      const result =
        ReticleCommand.QUERY === name
          ? {
              elements: present.includes(testid)
                ? [
                    {
                      ref: asRef(`e-${testid}`),
                      role: 'button',
                      name: testid,
                      states: [],
                      visible: true,
                    },
                  ]
                : [],
              hint: {
                route: '/',
                presentTestids: [...present, ...survivors],
                knownEmptyState: false,
              },
            }
          : ReticleCommand.ACT === name
            ? { dispatched: true, settled: true }
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
  name: 'complete-new-task',
  createdAt: 0,
  steps: [
    {
      tool: ReticleTool.ACT,
      anchor: { kind: AnchorKind.TESTID, value: 'toggle-3' },
      action: ActionType.CLICK,
      args: {},
      expect: { kind: 'element', query: { testid: 'task-3-done' } },
    },
  ],
};

async function graded(present: readonly string[]) {
  const steps = await replayFlow(page(present), FLOW, waitForPredicate, 60);
  return { steps, result: staleTargetResult(FLOW.name, steps) };
}

describe('a replay whose step 1 control is not on the page', () => {
  it('is not proved, naming the step it did not reach and why', async () => {
    const { steps, result } = await graded([]);
    expect(steps[0]?.drift?.reasonKind).toBe(DriftReason.TESTID_NOT_FOUND);
    expect(result?.status).toBe(ReplayStatus.UNVERIFIABLE);
    expect(result?.unverifiable?.reason).toContain('did not reach step 1');
    expect(result?.unverifiable?.reason).toContain('testid "toggle-3" not found');
  });

  it('syncs as a skipped flow that keeps the step index and the reason code', async () => {
    const { result } = await graded([]);
    const synced = result === undefined ? undefined : mapReplayToFlowResult(result, 1);
    expect(synced?.status).toBe(RunFlowStatus.SKIPPED);
    expect(synced?.failureReason).toContain('did not reach step 1');
    expect(synced?.stepResults?.[0]).toMatchObject({
      step: 0,
      ok: false,
      drift: DriftReason.TESTID_NOT_FOUND,
    });
  });
});

describe('a step 1 control that was renamed', () => {
  it('stays drift, so heal can rebind it to the one close survivor', async () => {
    const steps = await replayFlow(page([], ['toggle-30']), FLOW, waitForPredicate, 60);
    expect(steps[0]?.drift?.nearest).toBe('toggle-30');
    expect(staleTargetResult(FLOW.name, steps)).toBeUndefined();
  });

  it('is not proved when several controls are equally close (other rows, not a rename)', async () => {
    const steps = await replayFlow(page([], ['toggle-1', 'toggle-2']), FLOW, waitForPredicate, 60);
    expect(steps[0]?.drift?.ambiguous).toBe(true);
    expect(staleTargetResult(FLOW.name, steps)?.status).toBe(ReplayStatus.UNVERIFIABLE);
  });
});

describe('a replay whose step ran and whose expectation did not hold', () => {
  it('stays a failure', async () => {
    const { steps, result } = await graded(['toggle-3']);
    expect(steps[0]?.drift?.reasonKind).toBe(DriftReason.EXPECT_ELEMENT_NOT_FOUND);
    expect(result).toBeUndefined();
  });
});

describe('a control that is missing after earlier steps acted', () => {
  it('stays drift, because the steps before it put the page there', async () => {
    const twoSteps: FlowFile = {
      ...FLOW,
      steps: [
        {
          tool: ReticleTool.ACT,
          anchor: { kind: AnchorKind.TESTID, value: 'add-task' },
          action: ActionType.CLICK,
          args: {},
        },
        ...FLOW.steps,
      ],
    };
    const steps = await replayFlow(page(['add-task']), twoSteps, waitForPredicate, 60);
    expect(steps[1]?.drift?.reasonKind).toBe(DriftReason.TESTID_NOT_FOUND);
    expect(staleTargetResult(twoSteps.name, steps)).toBeUndefined();
  });
});

/*
 * The other reading of the same miss (#2061): the replay loaded the start page itself, nothing
 * redirected, and the control the journey starts with is not there. That is an app without the
 * feature, which a caller can ask to see as a failure. Without the request it stays not proved.
 */
describe('a missing step 1 control when the caller requires the start control', () => {
  it('stays drift, so the flow fails', async () => {
    const steps = await replayFlow(page([]), FLOW, waitForPredicate, 60);
    expect(staleTargetResult(FLOW.name, steps, { startControlRequired: true })).toBeUndefined();
    expect(steps[0]?.drift?.reasonKind).toBe(DriftReason.TESTID_NOT_FOUND);
  });

  it('is still not proved when the caller did not ask', async () => {
    const steps = await replayFlow(page([]), FLOW, waitForPredicate, 60);
    expect(staleTargetResult(FLOW.name, steps, {})?.status).toBe(ReplayStatus.UNVERIFIABLE);
  });
});
