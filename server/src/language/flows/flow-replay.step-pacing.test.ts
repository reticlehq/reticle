/**
 * Replay waits for the page to go quiet before each step, as a person does.
 *
 * An htmx app swapped a table row for a new one that held the "Resume" button, and bound that button
 * only in its settle task, a moment later. Replay clicked "Resume" as soon as the "Pause" request
 * came back, inside that moment, so the click did nothing and a correct build failed. On a busy
 * machine the moment is longer, so the false fail came when many replays ran at once and not alone.
 */
import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  PredicateKind,
  ReticleCommand,
  ReticleTool,
  asRef,
  asString,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession, type WaitForSignal } from './flow-replay.js';

/** A row with one toggle button. A new button acts only after the page's settle work has run. */
function row(settles: boolean) {
  let paused = false;
  let bound = true;
  const fired: string[] = [];
  const session: FlowReplaySession = {
    command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
      let result: unknown = { dispatched: true };
      if (ReticleCommand.QUERY === name) {
        const label = paused ? 'Resume' : 'Pause';
        const wanted = asString(args['name']) ?? asString(args['value']);
        result = {
          elements:
            wanted === undefined || wanted === label
              ? [{ ref: asRef('e-1'), role: 'button', name: label, states: [], visible: true }]
              : [],
          hint: { route: '/', presentTestids: [], knownEmptyState: false },
        };
      } else if (ReticleCommand.ACT === name && bound) {
        fired.push(paused ? 'resume' : 'pause');
        paused = !paused;
        // The response swaps the row in. Its new button is not bound until the page settles.
        bound = false;
      }
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
  const waitForSignal: WaitForSignal = (_s, predicate) => {
    if (PredicateKind.SETTLED === predicate.kind) {
      bound = bound || settles;
      return Promise.resolve({ pass: settles });
    }
    const name = PredicateKind.SIGNAL === predicate.kind ? (predicate.name ?? '') : '';
    return Promise.resolve({ pass: fired.includes(name) });
  };
  return { session, waitForSignal, fired };
}

const step = (name: string) => ({
  tool: ReticleTool.ACT,
  anchor: { kind: AnchorKind.ROLE, role: 'button', name },
  action: ActionType.CLICK,
  args: {},
  expect: { kind: PredicateKind.SIGNAL, name: name.toLowerCase() },
});

const flow: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: 'pause-and-resume',
  createdAt: 0,
  steps: [step('Pause'), step('Resume')],
};

describe('replay pacing between steps', () => {
  it('waits for the page to settle before the next step, so a re-rendered control is bound', async () => {
    const { session, waitForSignal, fired } = row(true);
    const results = await replayFlow(session, flow, waitForSignal, 60);
    expect(fired).toEqual(['pause', 'resume']);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
  });

  it('still runs the next step when the page never goes quiet', async () => {
    // A page that polls or animates forever is not quiet. The wait is a courtesy, never a verdict.
    const { session, waitForSignal } = row(false);
    const results = await replayFlow(session, flow, waitForSignal, 60);
    expect(results).toHaveLength(2);
    expect(results[1]?.drift).toBeDefined();
  });
});

/*
 * After the last step, too. A sort header updates its `aria-sort` at once and fetches the rows after,
 * so the last step's expect held while that fetch was still in flight. Replay ended there, and the
 * whole-journey check called the request "never settled": a correct app replayed `unknown`.
 */
describe('replay pacing after the last step', () => {
  it('waits for the page to go quiet once more before the journey is judged', async () => {
    const { session, waitForSignal } = row(true);
    const asked: string[] = [];
    const counting: WaitForSignal = (s, predicate, ms, since) => {
      asked.push(predicate.kind);
      return waitForSignal(s, predicate, ms, since);
    };
    await replayFlow(session, flow, counting, 60);
    // Before step 2, and after step 2.
    expect(asked.filter((k) => PredicateKind.SETTLED === k)).toHaveLength(2);
    expect(asked.at(-1)).toBe(PredicateKind.SETTLED);
  });
});
