/**
 * A saved drag keeps the drop target as a ref from the page it was recorded on.
 * A ref dies on the next load, so replay drags nowhere. The target is saved the
 * same way the source is, and replay resolves it on the page in front of it.
 */

import { describe, expect, it } from 'vitest';
import {
  ActionType,
  FLOW_FILE_VERSION,
  FlowFileSchema,
  QueryBy,
  ReticleCommand,
  asRef,
  asString,
  type CommandResult,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { compileActStep } from './replay.js';
import { recordedStepToFlowStep } from './flows.js';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';

const FAST = 60;

class FakeSession implements FlowReplaySession {
  readonly acts: Record<string, unknown>[] = [];
  constructor(private readonly testids: readonly string[] = []) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      const value = asString(args['value']) ?? '';
      const elements = this.testids.includes(value)
        ? [{ ref: asRef(`e-${value}`), role: 'button', name: value, states: [], visible: true }]
        : [];
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: {
          elements,
          hint: { route: '/', presentTestids: [...this.testids], knownEmptyState: false },
        },
      });
    }
    if (name === ReticleCommand.ACT) this.acts.push(args);
    return Promise.resolve({ kind: 'command_result', id: 'a', ok: true, result: {} });
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
  beginAction(): void {}
  finishAction(): void {}
}

function saved(steps: FlowStep[]): FlowFile {
  return FlowFileSchema.parse(
    JSON.parse(JSON.stringify({ version: FLOW_FILE_VERSION, name: 'move', createdAt: 0, steps })),
  );
}

describe('a recorded drag on a fresh page', () => {
  it('resolves the drop target from its anchor, not the ref it was recorded with', async () => {
    const recorded = compileActStep(
      { ref: 'e1', action: ActionType.DRAG, args: { toRef: 'e2' } },
      { testid: 'card', drop: { testid: 'bin' } },
    );
    const flowStep = recordedStepToFlowStep(recorded);
    const file = saved([flowStep]);

    expect(JSON.stringify(file)).not.toContain('e2');
    expect(flowStep.args).toEqual({ to: { by: QueryBy.TESTID, value: 'bin' } });

    const session = new FakeSession(['card', 'bin']);
    const steps = await replayFlow(session, file, waitForPredicate, FAST);

    expect(steps[0]?.ok).toBe(true);
    expect(session.acts).toEqual([
      { ref: 'e-card', action: ActionType.DRAG, args: { toRef: 'e-bin' } },
    ]);
  });
});
