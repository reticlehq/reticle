/**
 * A sequence sub-step whose anchor matches several live elements is DRIFT on its first look too.
 *
 * Found by replaying recorded flows on a phone-number input: a country picker renders every country
 * from one JSX line, so the recorded click on "Germany" was anchored by component and source with no
 * position, and about 240 elements matched it. The single-step runners report that as drift (see
 * `replay-ambiguous-component-anchor.test.ts`); the sequence runner's first look took `refs[0]`, so
 * the replay clicked another country and the step's own check failed on a correct app. A false fail
 * is a false verdict: the replay acted on an element the recording did not mean, then blamed the app.
 */
import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  DriftReason,
  FlowStepTool,
  ReticleCommand,
  asString,
  type CommandResult,
  type FlowStep,
} from '@reticlehq/core';
import { runSequenceStep } from './flow-step-runners.js';
import type { FlowReplaySession } from './flow-replay.js';

const SOURCE = { file: 'src/PhoneInput/PhoneInput.tsx', line: 182, column: 14 };

/** A page where the anchor matches `count` elements; it records what was dispatched. */
function pageWith(count: number): FlowReplaySession & { dispatched: string[][] } {
  const dispatched: string[][] = [];
  return {
    dispatched,
    command: (name, args = {}): Promise<CommandResult> => {
      if (ReticleCommand.QUERY === name) {
        const elements = Array.from({ length: count }, (_, i) => ({ ref: `e-${String(i)}` }));
        return Promise.resolve({
          kind: 'command_result',
          id: 'q',
          ok: true,
          result: { elements },
        } as unknown as CommandResult);
      }
      if (ReticleCommand.ACT_SEQUENCE === name || ReticleCommand.ACT === name) {
        const steps = Array.isArray(args['steps'])
          ? (args['steps'] as Record<string, unknown>[])
          : [args];
        dispatched.push(steps.map((s) => asString(s['ref']) ?? ''));
        return Promise.resolve({
          kind: 'command_result',
          id: 'a',
          ok: true,
          result: { steps: [] },
        } as unknown as CommandResult);
      }
      return Promise.resolve({
        kind: 'command_result',
        id: 'x',
        ok: true,
        result: {},
      } as CommandResult);
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

function sequence(anchor: FlowStep['anchor']): [FlowStep, FlowStep[]] {
  const sub: FlowStep = { tool: FlowStepTool.ACT, anchor, action: ActionType.CLICK, args: {} };
  return [{ tool: FlowStepTool.ACT_SEQUENCE, anchor, args: {} }, [sub]];
}

async function replay(page: FlowReplaySession, anchor: FlowStep['anchor']) {
  const [step, subs] = sequence(anchor);
  return await runSequenceStep(page, step, 0, subs, false, () => Promise.resolve());
}

describe('a sequence sub-step whose anchor matches several elements', () => {
  it('drifts instead of acting on the first match', async () => {
    const page = pageWith(3);
    const result = await replay(page, {
      kind: AnchorKind.COMPONENT,
      component: 'PhoneInput',
      source: SOURCE,
    });
    expect(result.ok).toBe(false);
    expect(result.drift?.reasonKind).toBe(DriftReason.ANCHOR_AMBIGUOUS);
    expect(page.dispatched).toEqual([]);
  });

  it('still acts on an anchor that matches exactly one element', async () => {
    const page = pageWith(1);
    const result = await replay(page, {
      kind: AnchorKind.COMPONENT,
      component: 'PhoneInput',
      source: SOURCE,
    });
    expect(result.drift).toBeUndefined();
    expect(page.dispatched.flat()).toEqual(['e-0']);
  });
});
