import { describe, expect, it } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import type { ToolDeps } from './tools.js';
import {
  DEFAULT_MAX_STEPS,
  FINISH_TOOL,
  type ModelDriver,
  type ModelTurn,
} from '@/features/harness/harness.js';
import {
  exploreApp,
  harnessAvailable,
  maxStepsFromEnv,
  reconcileFlows,
  MSG_NO_HARNESS_KEY,
  MSG_NO_JEV_KEY,
} from './harness-explore.js';

/** One completed flow-save call, as the loop records it. */
const saveCall = (args: Record<string, unknown>, result: unknown, isError = false) => ({
  name: 'reticle_flow_save',
  args,
  result,
  isError,
});

/** A flow store that answers a list, which is the only part of `deps` exploring reads. */
function depsWithFlows(...lists: readonly string[][]): ToolDeps {
  let call = 0;
  return {
    flows: {
      list: () => {
        const answer = lists[Math.min(call, lists.length - 1)] ?? [];
        call += 1;
        return Promise.resolve([...answer]);
      },
    },
  } as unknown as ToolDeps;
}

function finishing(summary: string): ModelDriver {
  return {
    turn: (): Promise<ModelTurn> =>
      Promise.resolve({
        text: '',
        calls: [{ id: '1', name: FINISH_TOOL.name, args: { summary } }],
      }),
  };
}

describe('exploring an app', () => {
  it('reports the flows that now exist and did not before', async () => {
    const result = await exploreApp(
      depsWithFlows(['login'], ['login', 'checkout']),
      {},
      { driver: finishing('drove checkout') },
    );

    expect(result.savedFlows).toEqual(['checkout']);
    expect(result.drive.summary).toBe('drove checkout');
  });

  it('believes the disk and not the model about what was saved', async () => {
    const result = await exploreApp(
      depsWithFlows(['login'], ['login']),
      {},
      { driver: finishing('I saved a flow called checkout') },
    );

    // The model said it saved one. Nothing appeared. The answer is what is on disk.
    expect(result.savedFlows).toEqual([]);
  });

  it('refuses to invent a driver when no model is configured', async () => {
    await expect(exploreApp(depsWithFlows([]), {})).rejects.toThrow(MSG_NO_HARNESS_KEY);
  });

  it('is available exactly when a key is set', () => {
    expect(harnessAvailable({})).toBe(false);
    expect(harnessAvailable({ [ReticleEnv.HARNESS_KEY]: 'sk-x' })).toBe(true);
  });
});

describe('the step budget', () => {
  it('defaults when unset', () => {
    expect(maxStepsFromEnv({})).toBe(DEFAULT_MAX_STEPS);
  });

  it('is a budget somebody can actually change', () => {
    expect(maxStepsFromEnv({ [ReticleEnv.HARNESS_MAX_STEPS]: '8' })).toBe(8);
  });

  it('ignores a value that would drive nothing, rather than reporting a run over an untouched app', () => {
    expect(maxStepsFromEnv({ [ReticleEnv.HARNESS_MAX_STEPS]: '0' })).toBe(DEFAULT_MAX_STEPS);
    expect(maxStepsFromEnv({ [ReticleEnv.HARNESS_MAX_STEPS]: 'lots' })).toBe(DEFAULT_MAX_STEPS);
  });
});

/**
 * The defect: a before/after name diff cannot see a flow being written over.
 *
 * A second drive of the same app records the same journeys under the same names, so `savedFlows`
 * came back empty and the tool told its caller that nothing was recorded and nothing would replay —
 * about a flow sitting on disk with ten steps in it. A false "nothing was verified" is the same
 * class of mistake as a false "everything passed", and this product does not get to make either.
 */
describe('reconciling what a drive left behind', () => {
  it('counts a brand new flow as saved', () => {
    const result = reconcileFlows(
      new Set(['sign-in']),
      ['sign-in', 'checkout'],
      [saveCall({ flowName: 'checkout' }, { name: 'checkout' })],
    );
    expect(result.savedFlows).toEqual(['checkout']);
    expect(result.rewroteFlows).toEqual([]);
  });

  it('counts a flow that already existed and was written again', () => {
    const result = reconcileFlows(
      new Set(['sign-in']),
      ['sign-in'],
      [saveCall({ flowName: 'sign-in' }, { name: 'sign-in' })],
    );
    expect(result.savedFlows).toEqual([]);
    expect(result.rewroteFlows).toEqual(['sign-in']);
  });

  it('does not count a rewrite the store cannot confirm', () => {
    const result = reconcileFlows(
      new Set(['sign-in']),
      ['sign-in'],
      [saveCall({ flowName: 'checkout' }, { name: 'checkout' })],
    );
    expect(result.rewroteFlows).toEqual([]);
  });

  it('does not count a save that failed', () => {
    const result = reconcileFlows(
      new Set(['sign-in']),
      ['sign-in'],
      [saveCall({ flowName: 'sign-in' }, { error: 'no active recording' }, true)],
    );
    expect(result.rewroteFlows).toEqual([]);
  });

  it('follows saveAs, which is what names the file', () => {
    const result = reconcileFlows(
      new Set(['sign-in']),
      ['sign-in'],
      [saveCall({ flowName: 'rec-1', saveAs: 'sign-in' }, undefined)],
    );
    expect(result.rewroteFlows).toEqual(['sign-in']);
  });

  it('reports a rewrite once, however many times it was written', () => {
    const result = reconcileFlows(
      new Set(['sign-in']),
      ['sign-in'],
      [
        saveCall({ flowName: 'sign-in' }, { name: 'sign-in' }),
        saveCall({ flowName: 'sign-in' }, { name: 'sign-in' }),
      ],
    );
    expect(result.rewroteFlows).toEqual(['sign-in']);
  });
});

/**
 * Naming a driver is how a comparison attributes its result, so the two failure modes that would
 * make that attribution a lie are the ones pinned here: silently substituting another driver, and
 * reporting a name that is not the one that drove.
 */
describe('choosing which model drives', () => {
  const JEV_ENV = { JEV_API_KEY: 'j' };
  const BOTH = { JEV_API_KEY: 'j', ANTHROPIC_API_KEY: 'a' };

  it('defaults to anthropic when both are configured', async () => {
    const result = await exploreApp(depsWithFlows([]), BOTH, { maxSteps: 1 });
    expect(result.driverName).toBe('anthropic');
  });

  it('uses jev when it is the only one configured', async () => {
    const result = await exploreApp(depsWithFlows([]), JEV_ENV, { maxSteps: 1 });
    expect(result.driverName).toBe('jev');
  });

  it('honours a per-call request over the daemon default', async () => {
    const result = await exploreApp(depsWithFlows([]), BOTH, { maxSteps: 1, driverName: 'jev' });
    expect(result.driverName).toBe('jev');
  });

  it('honours the environment when no call names one', async () => {
    const result = await exploreApp(
      depsWithFlows([]),
      { ...BOTH, RETICLE_HARNESS_DRIVER: 'jev' },
      { maxSteps: 1 },
    );
    expect(result.driverName).toBe('jev');
  });

  /** A substitution here would let an A/B measure the same driver twice and call it a comparison. */
  it('refuses a named driver it cannot build rather than substituting the other', async () => {
    await expect(
      exploreApp(depsWithFlows([]), { ANTHROPIC_API_KEY: 'a' }, { maxSteps: 1, driverName: 'jev' }),
    ).rejects.toThrow(MSG_NO_JEV_KEY);
  });

  it('refuses a driver it has never heard of', async () => {
    await expect(
      exploreApp(depsWithFlows([]), BOTH, { maxSteps: 1, driverName: 'gpt' }),
    ).rejects.toThrow('Unknown harness driver');
  });

  it('calls an injected driver custom, because it is not ours to name', async () => {
    const result = await exploreApp(depsWithFlows([]), {}, { driver: finishing('') });
    expect(result.driverName).toBe('custom');
  });
});
