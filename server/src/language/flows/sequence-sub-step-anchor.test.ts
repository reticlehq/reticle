import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FlowStepTool,
  ReticleCommand,
  type CommandResult,
  type FlowStep,
} from '@reticlehq/core';
import { runSequenceStep } from './flow-step-runners.js';
import type { FlowReplaySession } from './flow-replay.js';

/*
 * A sub-step of a sequence finds its control by the same rule as a single step (#2084).
 *
 * An import form had a nameless file input and several named buttons. The recording saved the file
 * input as a role `button` with no name, which means "the nameless button". Sub-steps took the first
 * button of any name, so the upload went to "Save" and was refused on a working app.
 */
function pageWith(elements: { ref: string; name?: string }[]): {
  session: FlowReplaySession;
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  const session: FlowReplaySession = {
    command: (name, args): Promise<CommandResult> => {
      if (ReticleCommand.QUERY === name) {
        return Promise.resolve({
          kind: 'command_result',
          id: 'q',
          ok: true,
          result: { elements },
        } as unknown as CommandResult);
      }
      sent.push(args ?? {});
      return Promise.resolve({
        kind: 'command_result',
        id: 'a',
        ok: true,
        result: { steps: [{ ok: true }], count: 1 },
      } as unknown as CommandResult);
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
  return { session, sent };
}

const sequenceOf = (anchor: FlowStep['anchor']): { step: FlowStep; subs: FlowStep[] } => {
  const sub = { tool: FlowStepTool.ACT, anchor, action: ActionType.CLICK, args: {} } as FlowStep;
  return {
    step: { tool: FlowStepTool.ACT_SEQUENCE, anchor, steps: [sub] },
    subs: [sub],
  };
};

const refsSent = (sent: Record<string, unknown>[]): unknown[] =>
  sent.flatMap((args) => ((args['steps'] ?? []) as { ref?: unknown }[]).map((s) => s.ref));

describe('a sequence sub-step resolves like a single step', () => {
  it('a nameless role anchor takes the nameless control, not the first of the role', async () => {
    const { session, sent } = pageWith([{ ref: 'e1', name: 'Save' }, { ref: 'e2' }]);
    const { step, subs } = sequenceOf({ kind: AnchorKind.ROLE, role: 'button' });
    await runSequenceStep(session, step, 0, subs, false, () => Promise.resolve());
    expect(refsSent(sent)).toEqual(['e2']);
  });

  it('a recorded position picks that one of the namesakes', async () => {
    const { session, sent } = pageWith([
      { ref: 'e1', name: 'Edit' },
      { ref: 'e2', name: 'Edit' },
      { ref: 'e3', name: 'Edit' },
    ]);
    const { step, subs } = sequenceOf({
      kind: AnchorKind.ROLE,
      role: 'link',
      name: 'Edit',
      nth: 1,
      of: 3,
    });
    await runSequenceStep(session, step, 0, subs, false, () => Promise.resolve());
    expect(refsSent(sent)).toEqual(['e2']);
  });
});
