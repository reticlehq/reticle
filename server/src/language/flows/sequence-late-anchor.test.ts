import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  DriftReason,
  FlowStepTool,
  ReticleCommand,
  type CommandResult,
  type FlowStep,
  type FlowStepResult,
} from '@reticlehq/core';
import { runSequenceStep } from './flow-step-runners.js';
import type { FlowReplaySession } from './flow-replay.js';

/**
 * A saved sequence whose later sub-step targets something an earlier sub-step renders (#1523).
 *
 * Live, each sub-step is resolved after the one before it ran, so clicking "Edit" and then the
 * "Cancel" its form shows passes. Replay resolved every anchor before running any of them, so the
 * later anchor did not exist yet and the flow drifted on its first replay with nothing run.
 *
 * The page below starts with the testids in `initial`. Clicking a testid named in `reveals` adds
 * the testids it maps to.
 */

function revealingPage(
  initial: readonly string[],
  reveals: Readonly<Record<string, readonly string[]>>,
): { session: FlowReplaySession; performed: string[] } {
  const present = new Set(initial);
  const performed: string[] = [];
  const session: FlowReplaySession = {
    command: (name: string, args: Record<string, unknown> = {}) => {
      if (ReticleCommand.QUERY === name) {
        const value = String(args['value']);
        return Promise.resolve({
          kind: 'command_result',
          id: 'q',
          ok: true,
          result: { elements: present.has(value) ? [{ ref: `r:${value}` }] : [] },
        } as unknown as CommandResult);
      }
      if (ReticleCommand.ACT_SEQUENCE === name) {
        for (const step of args['steps'] as { ref: string }[]) {
          const testid = step.ref.slice('r:'.length);
          if (!present.has(testid)) {
            return Promise.resolve({
              kind: 'command_result',
              id: 'a',
              ok: false,
              error: `ref '${step.ref}' no longer resolves to an element`,
            } as CommandResult);
          }
          performed.push(testid);
          for (const shown of reveals[testid] ?? []) present.add(shown);
        }
      }
      return Promise.resolve({ kind: 'command_result', id: 'a', ok: true } as CommandResult);
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
  return { session, performed };
}

function sub(testid: string, expectTestid?: string): FlowStep {
  return {
    tool: FlowStepTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value: testid },
    action: ActionType.CLICK,
    args: {},
    ...(expectTestid === undefined
      ? {}
      : { expect: { kind: 'element', query: { testid: expectTestid } } }),
  };
}

const parent: FlowStep = {
  tool: FlowStepTool.ACT_SEQUENCE,
  anchor: { kind: AnchorKind.TESTID, value: 'edit' },
  args: {},
};

const run = (subs: FlowStep[], session: FlowReplaySession): Promise<FlowStepResult> =>
  runSequenceStep(session, parent, 2, subs, false, () => Promise.resolve());

describe('a sub-step can target what an earlier sub-step renders', () => {
  it('replays a sequence that declares nothing', async () => {
    const { session, performed } = revealingPage(['edit'], { edit: ['cancel'] });
    const result = await run([sub('edit'), sub('cancel')], session);
    expect(result.ok).toBe(true);
    expect(performed).toEqual(['edit', 'cancel']);
  });

  it('replays a sequence whose sub-steps declare their expectations', async () => {
    const { session, performed } = revealingPage(['edit'], { edit: ['form', 'cancel'] });
    const result = await run([sub('edit', 'form'), sub('cancel')], session);
    expect(result.ok).toBe(true);
    expect(performed).toEqual(['edit', 'cancel']);
  });

  it('resolves a later sub-step only after the ones before it ran', async () => {
    const { session, performed } = revealingPage(['open'], {
      open: ['edit'],
      edit: ['cancel'],
    });
    const result = await run([sub('open'), sub('edit'), sub('cancel')], session);
    expect(result.ok).toBe(true);
    expect(performed).toEqual(['open', 'edit', 'cancel']);
  });
});

describe('drift is reported at the sub-step that really could not be found', () => {
  it('runs the sub-steps before it, then names it', async () => {
    const { session, performed } = revealingPage(['edit'], { edit: ['cancel'] });
    const result = await run([sub('edit'), sub('ghost')], session);
    expect(result.ok).toBe(false);
    expect(performed).toEqual(['edit']);
    expect(result.anchor).toContain('sub-step 1');
    expect(result.drift?.reasonKind).toBe(DriftReason.TESTID_NOT_FOUND);
  });

  it('runs nothing when the first sub-step is missing', async () => {
    const { session, performed } = revealingPage(['cancel'], {});
    const result = await run([sub('edit'), sub('cancel')], session);
    expect(result.ok).toBe(false);
    expect(performed).toEqual([]);
    expect(result.anchor).toContain('sub-step 0');
  });
});

/*
 * A sequence is often a whole recorded journey, so the score needs to know how far it got: the
 * sub-steps whose action ran and whose check held, of how many.
 */
describe('a sequence reports how many sub-steps it completed', () => {
  it('all of them when it passes', async () => {
    const { session } = revealingPage(['edit'], { edit: ['form', 'cancel'] });
    const result = await run([sub('edit', 'form'), sub('cancel')], session);
    expect(result.subSteps).toEqual({ passed: 2, total: 2 });
  });

  it('the ones before the sub-step whose check failed', async () => {
    const { session } = revealingPage(['open'], { open: ['edit'], edit: ['cancel'] });
    const result = await run(
      [sub('open', 'edit'), sub('edit', 'never-shown'), sub('cancel')],
      session,
    );
    expect(result.ok).toBe(false);
    expect(result.subSteps).toEqual({ passed: 1, total: 3 });
  });
});
