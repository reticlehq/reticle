import { describe, expect, it } from 'vitest';
import {
  asRef,
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  ReticleCommand,
  ReticleTool,
  asString,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';

/**
 * A sub-step's declared consequence has to be ENFORCED, not merely saved.
 *
 * `classifyFlowAssertions` already walks act_sequence sub-steps and counts an expect on either
 * level, and the file states the invariant in its own words: "this function and what replay
 * enforces must move together. If one ever describes more than the other, the difference is a false
 * green or a lost verification."
 *
 * Replay enforced the TOP-LEVEL expect only. So a sequence whose sub-step declared a consequence was
 * graded `asserted` by the classifier and checked by nothing — a flow that could not go red, wearing
 * the grade that says it could.
 */
const FAST = 60;

function el(ref: string, testid: string): ElementDescriptor {
  return { ref: asRef(ref), role: 'button', name: testid, states: [], visible: true };
}

class FakeSession implements FlowReplaySession {
  constructor(private readonly present: Set<string>) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      const value = asString(args['value']) ?? '';
      const elements = this.present.has(value) ? [el(`e-${value}`, value)] : [];
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: {
          elements,
          hint: { route: '/', presentTestids: [...this.present], knownEmptyState: false },
        },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(): never[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 0;
  }
}

function sub(value: string, expectTestid?: string): FlowStep {
  const s: FlowStep = {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value },
    action: ActionType.CLICK,
    args: {},
  };
  if (expectTestid !== undefined) s.expect = { element: { testid: expectTestid } };
  return s;
}

function sequenceFlow(subs: FlowStep[]): FlowFile {
  return {
    version: FLOW_FILE_VERSION,
    name: 'f',
    createdAt: 0,
    steps: [
      {
        tool: ReticleTool.ACT_SEQUENCE,
        anchor: subs[0]?.anchor ?? { kind: AnchorKind.TESTID, value: 'x' },
        steps: subs,
      },
    ],
  };
}

describe('a sequence sub-step`s declared consequence is enforced on replay', () => {
  it('goes RED when a sub-step`s expect.element does not hold', async () => {
    // Both controls resolve and both clicks fire. The consequence "receipt" never appears, and that
    // is the whole point of having declared it.
    const session = new FakeSession(new Set(['email', 'confirm']));
    const steps = await replayFlow(
      session,
      sequenceFlow([sub('email'), sub('confirm', 'receipt')]),
      waitForPredicate,
      FAST,
    );

    expect(steps[0]?.ok).toBe(false);
    expect(steps[0]?.drift?.anchor).toBe('receipt');
  });

  it('stays green when every declared consequence holds', async () => {
    const session = new FakeSession(new Set(['email', 'confirm', 'receipt']));
    const steps = await replayFlow(
      session,
      sequenceFlow([sub('email'), sub('confirm', 'receipt')]),
      waitForPredicate,
      FAST,
    );

    expect(steps[0]?.ok).toBe(true);
  });

  it('is unaffected when no sub-step declared anything', async () => {
    const session = new FakeSession(new Set(['email', 'confirm']));
    const steps = await replayFlow(
      session,
      sequenceFlow([sub('email'), sub('confirm')]),
      waitForPredicate,
      FAST,
    );

    expect(steps[0]?.ok).toBe(true);
  });
});
