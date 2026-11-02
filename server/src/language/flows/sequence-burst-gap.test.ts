import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FlowStepSchema,
  FlowStepTool,
  ReticleCommand,
  ReticleTool,
  type CommandResult,
  type FlowStep,
} from '@reticlehq/core';
import { compileSequenceStep } from './replay.js';
import { recordedStepToFlowStep } from './flows.js';
import { runSequenceStep } from './flow-step-runners.js';
import type { FlowReplaySession } from './flow-replay.js';

/**
 * #2130: an act_sequence driven with `burst` (a fixed gap between steps, no settle) verified live, and
 * its saved flow failed on the same unchanged build. The flow kept the steps and `timeout_ms` but not
 * the gap, so replay sent the steps as one batch with the default settle: a different pace. A page
 * whose behaviour depends on timing (a slideshow, a debounce, a race) then answered differently.
 */

describe('a recorded sequence keeps its burst gap', () => {
  const resolved = { steps: [{ testid: 'play' }, { testid: 'pause' }] };
  const args = {
    steps: [
      { ref: 'e1', action: 'click' },
      { ref: 'e2', action: 'click' },
    ],
    burst: 350,
  };

  it('compiles the gap into the recorded step and the flow step', () => {
    const recorded = compileSequenceStep(args, resolved);
    expect(recorded.burstMs).toBe(350);
    const step = recordedStepToFlowStep(recorded);
    expect(step.burstMs).toBe(350);
    expect(FlowStepSchema.parse(step).burstMs).toBe(350);
  });

  it('records no gap when the sequence had none', () => {
    const recorded = compileSequenceStep({ steps: args.steps }, resolved);
    expect(recorded.burstMs).toBeUndefined();
    expect(recordedStepToFlowStep(recorded).burstMs).toBeUndefined();
  });
});

/** A session on a fake clock: every element is found at once, and every command takes no time. */
function clockedSession(): {
  session: FlowReplaySession;
  sleep: (ms: number) => Promise<void>;
  sends: { at: number; steps: { args: Record<string, unknown> }[] }[];
} {
  let now = 0;
  const sends: { at: number; steps: { args: Record<string, unknown> }[] }[] = [];
  const session: FlowReplaySession = {
    command: (name, args): Promise<CommandResult> => {
      if (ReticleCommand.QUERY === name) {
        return Promise.resolve({
          kind: 'command_result',
          id: 'q',
          ok: true,
          result: { elements: [{ ref: 'e1' }] },
        } as unknown as CommandResult);
      }
      const steps = (args?.['steps'] ?? []) as { args: Record<string, unknown> }[];
      sends.push({ at: now, steps });
      return Promise.resolve({
        kind: 'command_result',
        id: 'a',
        ok: true,
        result: { ok: true, count: steps.length, effects: [], steps: [] },
      } as unknown as CommandResult);
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => now,
  };
  const sleep = (ms: number): Promise<void> => {
    now += ms;
    return Promise.resolve();
  };
  return { session, sleep, sends };
}

const click = (value: string): FlowStep => ({
  tool: FlowStepTool.ACT,
  anchor: { kind: AnchorKind.TESTID, value },
  action: ActionType.CLICK,
  args: {},
});

describe('a replayed sequence keeps the pace it was recorded at', () => {
  const subs = [click('play'), click('pause'), click('next')];
  const sequence = (burstMs?: number): FlowStep => ({
    tool: ReticleTool.ACT_SEQUENCE,
    anchor: { kind: AnchorKind.TESTID, value: 'play' },
    steps: subs,
    ...(burstMs === undefined ? {} : { burstMs }),
  });

  it('dispatches each sub-step one gap after the one before, with no settle', async () => {
    const { session, sleep, sends } = clockedSession();
    const result = await runSequenceStep(session, sequence(300), 0, subs, false, sleep);

    expect(result.ok).toBe(true);
    expect(sends.map((s) => s.at)).toEqual([0, 300, 600]);
    expect(sends.every((s) => 1 === s.steps.length)).toBe(true);
    expect(sends.every((s) => 0 === s.steps[0]?.args['settleMs'])).toBe(true);
  });

  it('still sends a sequence with no gap as one batch with the default settle', async () => {
    const { session, sleep, sends } = clockedSession();
    const result = await runSequenceStep(session, sequence(), 0, subs, false, sleep);

    expect(result.ok).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.steps).toHaveLength(3);
    expect(sends[0]?.steps.some((s) => 'settleMs' in s.args)).toBe(false);
  });
});
