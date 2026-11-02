import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  DriftReason,
  FlowStepTool,
  ReplayStatus,
  ReticleCommand,
  type CommandResult,
  type FlowStep,
} from '@reticlehq/core';
import { runSequenceStep, unreachableTargetResult } from './flow-step-runners.js';
import type { FlowReplaySession } from './flow-replay.js';

/*
 * A click no person could make decides nothing, in a sequence as in a single step (#2113).
 *
 * A modal's error alert had a dismiss button that a stylesheet rule made ignore the pointer. A single
 * act step on it ended unreachable. Recorded inside a sequence, the same click passed: the runner did
 * not read the sub-steps' effects, and synthetic dispatch ran the handler that no pointer could reach.
 */
function pageWhereTheClickIs(effect: Record<string, unknown>): FlowReplaySession {
  return {
    command: (name): Promise<CommandResult> => {
      const result =
        ReticleCommand.QUERY === name
          ? {
              elements: [{ ref: 'e1', role: 'button', name: 'Dismiss', states: [], visible: true }],
            }
          : { ok: true, count: 1, effects: [effect], steps: [{ ref: 'e1', action: 'click' }] };
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result,
      } as CommandResult);
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

const anchor = { kind: AnchorKind.ROLE, role: 'button', name: 'Dismiss' } as const;
const sub = { tool: FlowStepTool.ACT, anchor, action: ActionType.CLICK, args: {} } as FlowStep;
const step = { tool: FlowStepTool.ACT_SEQUENCE, anchor, steps: [sub] } as FlowStep;
const run = (effect: Record<string, unknown>) =>
  runSequenceStep(pageWhereTheClickIs(effect), step, 0, [sub], false, () => Promise.resolve());

describe('an unreachable target inside a sequence', () => {
  it('does not pass when the click point is covered', async () => {
    const result = await run({ dispatched: true, occluded: true, occludedBy: 'div[role=alert]' });
    expect(result.ok).toBe(false);
    expect(result.drift?.reasonKind).toBe(DriftReason.TARGET_UNREACHABLE);
  });

  it('makes the flow unverifiable, as a single step does', async () => {
    const result = await run({ dispatched: true, occluded: true, occludedBy: 'div[role=alert]' });
    expect(unreachableTargetResult('dismiss', [result])?.status).toBe(ReplayStatus.UNVERIFIABLE);
  });

  it('still passes a click a person could make', async () => {
    const result = await run({ dispatched: true });
    expect(result.ok).toBe(true);
    expect(result.drift).toBeUndefined();
  });
});
