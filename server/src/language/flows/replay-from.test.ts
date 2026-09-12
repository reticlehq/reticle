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
 * Resuming a flow at the step that broke.
 *
 * Fix the first break, run again from there, and find the second break the first one was hiding —
 * that is what turns one run into a cascade. There is no state to restore and no snapshot to take:
 * the prefix is re-driven, which at a measured ~27ms a step is cheap enough that resume needs no
 * machinery at all.
 *
 * The prefix is SETUP, so its results are not reported. The one thing that must never be silent is a
 * prefix step that FAILS — the resume then never reached the step it was asked to resume from, and
 * swallowing that would report the run as starting where it did not.
 */
const FAST = 60;

function el(ref: string, testid: string): ElementDescriptor {
  return { ref: asRef(ref), role: 'button', name: testid, states: [], visible: true };
}

class FakeSession implements FlowReplaySession {
  readonly acted: string[] = [];
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
    if (name === ReticleCommand.ACT) {
      this.acted.push(asString(args['ref']) ?? '');
      return Promise.resolve({ kind: 'command_result', id: 'a', ok: true, result: {} });
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

function step(value: string): FlowStep {
  return {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value },
    action: ActionType.CLICK,
    args: {},
  };
}

function flow(values: string[]): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps: values.map(step) };
}

const ALL = new Set(['one', 'two', 'three', 'four']);

describe('replaying from a step', () => {
  it('re-drives the prefix but reports only from the resume point', async () => {
    const session = new FakeSession(ALL);
    const results = await replayFlow(
      session,
      flow(['one', 'two', 'three', 'four']),
      waitForPredicate,
      FAST,
      false,
      undefined,
      { from: 2 },
    );

    // Every step really ran — the app has to be in the state step 2 expects.
    expect(session.acted).toEqual(['e-one', 'e-two', 'e-three', 'e-four']);
    // Only the resumed part is reported, and it keeps its real indices.
    expect(results.map((r) => r.step)).toEqual([2, 3]);
  });

  it('reports a prefix step that FAILED — the resume never reached its start', async () => {
    // "two" is gone, so the journey cannot be re-driven to step 3 at all.
    const session = new FakeSession(new Set(['one', 'three', 'four']));
    const results = await replayFlow(
      session,
      flow(['one', 'two', 'three', 'four']),
      waitForPredicate,
      FAST,
      false,
      undefined,
      { from: 3 },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.step).toBe(1);
    expect(results[0]?.ok).toBe(false);
  });

  it('is unchanged when no resume point is given', async () => {
    const session = new FakeSession(ALL);
    const results = await replayFlow(session, flow(['one', 'two']), waitForPredicate, FAST);
    expect(results.map((r) => r.step)).toEqual([0, 1]);
  });
});
