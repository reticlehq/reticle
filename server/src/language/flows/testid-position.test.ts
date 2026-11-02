import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FlowStepTool,
  ReticleCommand,
  type CommandResult,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { compileActStep } from './replay.js';
import { recordedStepToFlowStep } from './flows.js';
import { Replayable, replayability } from './flow-replayable.js';
import { runTestidStep } from './flow-replay.js';
import type { FlowReplaySession } from './flow-replay.js';

/**
 * #2135: a page renders one component eight times, each copy with `data-testid="input-value"`. A step
 * on the third copy was saved as `{ testid, of: 8 }` with no position, so every replay stopped on it as
 * ambiguous, on the unchanged build: 8 of 10 flows on a date-range page could never replay. A role
 * anchor already keeps its place among namesakes; a test id now does the same.
 */

const act = (res: Record<string, unknown>): FlowStep =>
  recordedStepToFlowStep(compileActStep({ ref: 'e5', action: 'click', args: {} }, res));

describe('a step on a shared test id keeps its position', () => {
  it('records which of the shared elements it acted on', () => {
    const step = act({ testid: 'input-value', testidOf: 8, testidNth: 2 });
    expect(step.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'input-value', of: 8, nth: 2 });
  });

  it('is replayable once it knows its position', () => {
    const step = act({ testid: 'input-value', testidOf: 8, testidNth: 2 });
    const flow = { name: 'f', version: 2, startPath: '/', steps: [step] } as unknown as FlowFile;
    expect(replayability(flow)).toEqual({ status: Replayable.YES });
  });
});

/** A session whose page has `count` elements with the test id, refs e1..eN, and records each act. */
function pageWith(count: number): { session: FlowReplaySession; acted: string[] } {
  const acted: string[] = [];
  const session: FlowReplaySession = {
    command: (name, args): Promise<CommandResult> => {
      if (ReticleCommand.QUERY === name) {
        const elements = Array.from({ length: count }, (_, i) => ({ ref: `e${String(i + 1)}` }));
        return Promise.resolve({
          kind: 'command_result',
          id: 'q',
          ok: true,
          result: { elements },
        } as unknown as CommandResult);
      }
      acted.push(String(args?.['ref']));
      return Promise.resolve({
        kind: 'command_result',
        id: 'a',
        ok: true,
        result: { ok: true, effect: {} },
      } as unknown as CommandResult);
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
  return { session, acted };
}

const stepOn = (nth: number): FlowStep => ({
  tool: FlowStepTool.ACT,
  anchor: { kind: AnchorKind.TESTID, value: 'input-value', of: 3, nth },
  action: ActionType.CLICK,
  args: {},
});

describe('a replay of a step on a shared test id', () => {
  it('acts on the recorded position while the page has as many matches', async () => {
    const { session, acted } = pageWith(3);
    const result = await runTestidStep(session, stepOn(1), 0, 'input-value', new Set(), false, () =>
      Promise.resolve(),
    );
    expect(result.ok).toBe(true);
    expect(acted).toEqual(['e2']);
  });

  it('stays ambiguous, and acts on nothing, when the number of matches changed', async () => {
    const { session, acted } = pageWith(4);
    const result = await runTestidStep(session, stepOn(1), 0, 'input-value', new Set(), false, () =>
      Promise.resolve(),
    );
    expect(result.ok).toBe(false);
    expect(result.drift?.ambiguous).toBe(true);
    expect(acted).toEqual([]);
  });
});
