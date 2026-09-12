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

/**
 * A sub-step's expectation has to be checked after ITS OWN action, not after the whole batch.
 *
 * Replay dispatched a recorded sequence as one `act_sequence` and then walked every sub-step's
 * `expect` at the end. So "click Pay, and the receipt appears" passed when the receipt was put there
 * by a LATER sub-step — the assertion was true by the time anybody looked, and the order that made
 * it a claim about this action was gone.
 *
 * That is a false green in the exact mechanism the sequence grade counts as proof: the flow's grade
 * says it can go red, and on this shape it could not. The live act path never had the problem,
 * because each step is dispatched and asserted before the next one runs — this is replay catching up
 * to it.
 *
 * What this does NOT claim to fix: an element that was already on screen before the sequence began.
 * Presence is presence, and no ordering makes "it is here" into "this click put it here" — that is
 * what a consequence-grade expectation is for.
 */

const RECEIPT = 'receipt';

/** A session where `receipt` only exists once `n` actions have been dispatched. */
function sessionAppearingAfter(n: number): {
  session: FlowReplaySession;
  dispatches: () => number;
} {
  let dispatched = 0;
  const session: FlowReplaySession = {
    command: (name: string, args: Record<string, unknown> = {}) => {
      if (ReticleCommand.QUERY === name) {
        const wanted = args['value'];
        const present = RECEIPT !== wanted || dispatched >= n;
        return Promise.resolve({
          kind: 'command_result',
          id: 'q',
          ok: true,
          result: { elements: present ? [{ ref: 'e1' }] : [] },
        } as unknown as CommandResult);
      }
      if (ReticleCommand.ACT_SEQUENCE === name) {
        dispatched += (args['steps'] as unknown[]).length;
      }
      return Promise.resolve({ kind: 'command_result', id: 'a', ok: true } as CommandResult);
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
  return { session, dispatches: () => dispatched };
}

function sub(testid: string, expectTestid?: string): FlowStep {
  return {
    tool: FlowStepTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value: testid },
    action: ActionType.CLICK,
    args: {},
    ...(expectTestid === undefined ? {} : { expect: { element: { testid: expectTestid } } }),
  };
}

const parent: FlowStep = {
  tool: FlowStepTool.ACT_SEQUENCE,
  anchor: { kind: AnchorKind.TESTID, value: 'checkout' },
  args: {},
};

const run = (subs: FlowStep[], session: FlowReplaySession): Promise<unknown> =>
  runSequenceStep(session, parent, 0, subs, false, () => Promise.resolve());

describe('when a sub-step declares what its own action should make true', () => {
  it('fails when only a LATER sub-step makes the expectation true', async () => {
    // Sub-step 0 claims the receipt; nothing produces it until both actions have run.
    const { session } = sessionAppearingAfter(2);
    const result = (await run([sub('pay', RECEIPT), sub('close')], session)) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  it('passes when the declaring sub-step is the one that makes it true', async () => {
    const { session } = sessionAppearingAfter(1);
    const result = (await run([sub('pay', RECEIPT), sub('close')], session)) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it('stops the sequence at the failing sub-step rather than driving the rest', async () => {
    // The live path stops at the first unmet expectation. Replay carrying on would act on a screen
    // the flow has already proved it does not understand.
    const { session, dispatches } = sessionAppearingAfter(2);
    await run([sub('pay', RECEIPT), sub('close')], session);
    expect(dispatches()).toBe(1);
  });

  it('still dispatches a sequence that declares nothing as ONE batch', async () => {
    // The per-sub-step walk costs a round trip each, and a sequence with no expectations gains
    // nothing from it. Only a flow that declared something pays.
    let batches = 0;
    const session: FlowReplaySession = {
      command: (name: string) => {
        if (ReticleCommand.QUERY === name) {
          return Promise.resolve({
            kind: 'command_result',
            id: 'q',
            ok: true,
            result: { elements: [{ ref: 'e1' }] },
          } as unknown as CommandResult);
        }
        if (ReticleCommand.ACT_SEQUENCE === name) batches += 1;
        return Promise.resolve({ kind: 'command_result', id: 'a', ok: true } as CommandResult);
      },
      eventsSince: () => [],
      onEvent: () => () => undefined,
      elapsed: () => 0,
    };
    await run([sub('pay'), sub('close')], session);
    expect(batches).toBe(1);
  });
});
